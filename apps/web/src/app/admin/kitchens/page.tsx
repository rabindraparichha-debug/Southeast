import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime } from '@/lib/public';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { StatusButtons } from '../status-buttons';
import { PayoutForm } from '../payout-form';
import { FssaiForm } from './fssai-form';
import type { AdminKitchen } from '../types';

export const metadata: Metadata = { title: 'Kitchens · Admin' };

const STATUS = {
  active: { label: 'Listed', tone: 'green' },
  draft: { label: 'Private', tone: 'gray' },
  suspended: { label: 'Suspended', tone: 'red' },
} as const;
const KYC_TONE: Record<string, 'gray' | 'green' | 'amber' | 'red'> = { not_started: 'gray', pending: 'amber', verified: 'green', rejected: 'red' };

// Every kitchen with its onboarding progress, adoption and the platform controls
// (listing status, FSSAI correction, Razorpay payout account).
export default async function AdminKitchensPage() {
  await requireAdmin();
  const supabase = await createClient();
  const [{ data, error }, { data: payouts }] = await Promise.all([
    supabase.rpc('admin_kitchens'),
    // admin_kitchens only says whether a linked account exists; the payout form needs the id itself.
    supabase.from('kitchen_payout_accounts').select('kitchen_id, razorpay_linked_account_id, kyc_status'),
  ]);
  const kitchens = (data ?? []) as unknown as AdminKitchen[];
  const payout = new Map((payouts ?? []).map((p) => [p.kitchen_id, p]));
  const live = kitchens.filter((k) => k.status === 'active').length;

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader title="Admin · Kitchens" subtitle={`${kitchens.length} kitchens · ${live} listed. Every change here is written to the audit log.`} />
      {error && <Alert>{error.message}</Alert>}
      <div className="space-y-4">
        {kitchens.map((k) => {
          const p = payout.get(k.id);
          const kyc = k.kyc_status ?? 'not_started';
          const pct = k.checklist_total ? Math.round((k.checklist_done / k.checklist_total) * 100) : 0;
          return (
            <Card key={k.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-ink-900">{k.name}</h2>
                    <Badge tone={STATUS[k.status].tone}>{STATUS[k.status].label}</Badge>
                    {k.open_complaints > 0 && <Badge tone="red">{k.open_complaints} open complaint{k.open_complaints === 1 ? '' : 's'}</Badge>}
                  </div>
                  <p className="text-sm text-ink-500">
                    {k.area ?? 'No area'} · joined {istDateTime(k.created_at)}
                    {k.status === 'active' && <> · <Link href={`/k/${k.slug}`} target="_blank" className="text-brand-700 hover:underline">Public page ↗</Link></>}
                  </p>
                </div>
                <StatusButtons kitchenId={k.id} status={k.status} hasFssai={Boolean(k.fssai_no)} />
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
                <div>
                  <dt className="text-xs text-ink-500">Onboarding</dt>
                  <dd>
                    <span className="font-medium">{k.checklist_done}/{k.checklist_total}</span>
                    <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-ink-100" role="progressbar" aria-label="Onboarding checklist"
                      aria-valuenow={k.checklist_done} aria-valuemin={0} aria-valuemax={k.checklist_total}>
                      <div className={`h-full ${pct === 100 ? 'bg-green-600' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
                    </div>
                  </dd>
                </div>
                <Fact label="Customers" value={k.customers} hint={`${k.whatsapp_pct ?? 0}% on WhatsApp · ${k.platform_customers} from platform`} />
                <Fact label="Live subscriptions" value={k.live_subscriptions} />
                <Fact label="Meals, 7 days" value={k.meals_7d.toLocaleString('en-IN')} />
                <Fact label="Last count lock" value={k.last_lock ? istDateTime(k.last_lock) : 'Never'} />
                <div>
                  <dt className="text-xs text-ink-500">Payout KYC</dt>
                  <dd className="flex items-center gap-1.5">
                    <Badge tone={KYC_TONE[kyc] ?? 'gray'}>{kyc.replace('_', ' ')}</Badge>
                    {k.linked_account && <span className="text-xs text-ink-500">linked</span>}
                  </dd>
                </div>
              </dl>

              <div className="mt-4 grid gap-4 border-t border-ink-100 pt-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-ink-600">
                    FSSAI {k.fssai_no ? <span className="font-mono text-ink-800">{k.fssai_no}</span> : <Badge tone="amber">Missing</Badge>}
                  </div>
                  <FssaiForm kitchenId={k.id} fssai={k.fssai_no} />
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-ink-600">Razorpay payout account</div>
                  <PayoutForm kitchenId={k.id} accountId={p?.razorpay_linked_account_id ?? null} kycStatus={p?.kyc_status ?? 'not_started'} />
                </div>
              </div>
            </Card>
          );
        })}
        {!kitchens.length && !error && <p className="text-sm text-ink-500">No kitchens yet.</p>}
      </div>
    </main>
  );
}

function Fact({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
      {hint && <dd className="text-xs text-ink-500">{hint}</dd>}
    </div>
  );
}
