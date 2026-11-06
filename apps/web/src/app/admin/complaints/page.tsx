import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime } from '@/lib/public';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { CATEGORY_LABEL, type EscalationQueue, type EscalationStatus } from './types';

export const metadata: Metadata = { title: 'Escalated complaints · Admin' };

const TABS: { value: EscalationStatus; label: string }[] = [
  { value: 'escalated', label: 'Escalated' },
  { value: 'open', label: 'All open' },
  { value: 'resolved', label: 'Resolved (30 days)' },
];

// The Terms promise: if the kitchen does not reply within 2 hours, our team steps in (D-132).
export default async function EscalationsPage({ searchParams }: PageProps<'/admin/complaints'>) {
  await requireAdmin();
  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status: EscalationStatus = TABS.some((t) => t.value === raw) ? (raw as EscalationStatus) : 'escalated';
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_escalations', { p_status: status, p_limit: 200 });
  const q = (data as unknown as EscalationQueue | null) ?? { complaints: [], team: [] };

  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <PageHeader title="Complaints" subtitle="Complaints a kitchen did not answer within 2 hours come here. Call, take one, hand it on, or resolve it." />
      <nav className="mb-4 flex gap-2 text-sm">
        {TABS.map((t) => (
          <Link key={t.value} href={`/admin/complaints?status=${t.value}`}
            className={`rounded-lg px-3 py-1.5 font-medium ${t.value === status ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-ink-100'}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {error && <Alert>{error.message}</Alert>}
      <Card className="p-0">
        {q.complaints.length ? (
          <ul className="divide-y divide-ink-100 text-sm">
            {q.complaints.map((c) => (
              <li key={c.id}>
                <Link href={`/admin/complaints/${c.id}`} className="block p-4 hover:bg-ink-50">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink-900">{c.kitchen.name} · {CATEGORY_LABEL[c.category] ?? c.category}</span>
                    <span className="flex items-center gap-2">
                      {c.assigned_to ? <Badge tone="blue">{c.assigned_to.name}</Badge> : c.status !== 'resolved' && <Badge tone="amber">Nobody yet</Badge>}
                      <Badge tone={c.status === 'resolved' ? 'green' : c.status === 'escalated' ? 'red' : 'gray'}>{c.status}</Badge>
                    </span>
                  </div>
                  {c.description && <p className="mt-1 line-clamp-2 text-ink-700">{c.description}</p>}
                  <p className="mt-1 text-xs text-ink-500">
                    {c.customer.name} · {c.channel} · opened {istDateTime(c.created_at)}
                    {c.escalated_at ? ` · escalated ${istDateTime(c.escalated_at)}` : ''}
                    {c.status !== 'resolved' ? ` · ${c.hours_open} h open` : c.resolved_by ? ` · resolved by ${c.resolved_by}` : ''}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-6 text-center text-sm text-ink-500">
            {status === 'escalated' ? 'Nothing escalated. Kitchens are replying within 2 hours.' : 'Nothing here.'}
          </p>
        )}
      </Card>
    </main>
  );
}
