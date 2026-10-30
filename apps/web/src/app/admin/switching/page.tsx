import type { Metadata } from 'next';
import { formatPaise } from '@tiffin/core';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime } from '@/lib/public';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { FlagToggle, SwitchDecision } from './switch-actions';

export const metadata: Metadata = { title: 'Kitchen switching · Admin' };

type SwitchRequest = {
  id: string; status: 'requested' | 'approved' | 'rejected' | 'cancelled'; customer_id: string; customer_name: string; phone_masked: string;
  from_kitchen: string; to_kitchen: string; to_plan: string; price_per_meal_paise: number; reason: string | null; balance_meals: number;
  effective_date: string | null; decision_note: string | null; created_at: string; decided_at: string | null;
};
const STATUSES = ['requested', 'approved', 'rejected', 'cancelled'] as const;
const TONE = { requested: 'blue', approved: 'green', rejected: 'red', cancelled: 'gray' } as const;

// Kitchen switching at the same price (P6). Built switched off; the flag stays OFF until legal clears it.
export default async function AdminSwitchingPage({ searchParams }: PageProps<'/admin/switching'>) {
  await requireAdmin();
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === sp.status) ?? 'requested';
  const supabase = await createClient();
  const { data: flag } = await supabase.from('platform_settings').select('enabled, updated_at').eq('key', 'kitchen_switching').maybeSingle();
  const enabled = Boolean(flag?.enabled);
  const { data, error } = enabled ? await supabase.rpc('admin_switch_requests', { p_status: status }) : { data: null, error: null };
  const requests = (data ?? []) as unknown as SwitchRequest[];

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader title="Admin · Kitchen switching" subtitle="Platform customers ask to move to another kitchen at the same price per meal. Unused meals at the old kitchen are refunded through the normal cancel path." />
      <Card title="Feature switch" className="mb-6">
        <Alert tone="amber">Keep this OFF until legal has cleared kitchen switching. While it is off, customers don’t see it and every switch call is refused.</Alert>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Badge tone={enabled ? 'green' : 'gray'}>{enabled ? 'ON' : 'OFF'}</Badge>
          {flag?.updated_at && <span className="text-xs text-ink-500">Last changed {istDateTime(flag.updated_at)}</span>}
          <FlagToggle enabled={enabled} />
        </div>
      </Card>

      {enabled && (
        <Card title="Switch requests" actions={
          <div className="flex flex-wrap gap-1">
            {STATUSES.map((s) => (
              <a key={s} href={`/admin/switching?status=${s}`} className={`rounded-lg px-3 py-1.5 text-sm capitalize ring-1 ${s === status ? 'bg-ink-800 text-white ring-ink-800' : 'ring-ink-200'}`}>{s}</a>
            ))}
          </div>
        }>
          {error && <Alert>{error.message}</Alert>}
          <ul className="divide-y divide-ink-100 text-sm">
            {requests.map((r) => (
              <li key={r.id} className="space-y-1.5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.customer_name}</span>
                  <span className="text-ink-500">{r.phone_masked}</span>
                  <Badge tone={TONE[r.status]}>{r.status}</Badge>
                </div>
                <div>{r.from_kitchen} → <strong>{r.to_kitchen}</strong> · {r.to_plan} at {formatPaise(r.price_per_meal_paise)}/meal · {r.balance_meals} meals left</div>
                {r.reason && <div className="text-ink-600">“{r.reason}”</div>}
                <div className="text-xs text-ink-500">
                  Asked {istDateTime(r.created_at)}
                  {r.decided_at && ` · decided ${istDateTime(r.decided_at)}`}
                  {r.effective_date && ` · from ${r.effective_date}`}
                  {r.decision_note && ` · ${r.decision_note}`}
                </div>
                {r.status === 'requested' && <SwitchDecision id={r.id} />}
              </li>
            ))}
            {!requests.length && !error && <li className="py-3 text-ink-500">No {status} requests.</li>}
          </ul>
        </Card>
      )}
    </main>
  );
}
