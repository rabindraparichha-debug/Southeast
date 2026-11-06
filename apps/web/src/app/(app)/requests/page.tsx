import Link from 'next/link';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { LEAD_ROLES } from '@/lib/roles';
import type { ChangeRequestRow } from '@/lib/money';
import { Alert, PageHeader } from '@/components/ui';
import { RequestList, type Choice } from './request-list';

// Change requests riders record at the door ("skip tomorrow", "new address"). Nothing changes until
// the owner or a manager approves here; approval runs the normal schedule-change path (preview
// first), so the slot cutoff decides what is charged at the time of approval (D-117, D-146).
export default async function RequestsPage({ searchParams }: PageProps<'/requests'>) {
  const { kitchen } = await requireKitchen(LEAD_ROLES);
  const showAll = (await searchParams).status === 'all';
  const supabase = await createClient();
  // p_status null lists every request (newest first, waiting ones on top).
  const { data, error } = await supabase.rpc('change_requests_list', {
    p_kitchen: kitchen.kitchenId, p_status: (showAll ? null : 'pending') as string, p_limit: 100,
  });
  const rows = data as unknown as ChangeRequestRow[] | null;
  const list = rows ?? [];

  // What the approver may need to pick: the plan (customer with several live plans) and, for an
  // address request, which saved address to deliver to.
  const ids = [...new Set(list.filter((r) => r.status === 'pending').map((r) => r.customer_id))];
  const [{ data: subs }, { data: addrs }] = ids.length
    ? await Promise.all([
        supabase.from('subscriptions').select('id, customer_id, status, plan:plans(name)').in('customer_id', ids).neq('status', 'cancelled'),
        supabase.from('addresses').select('id, customer_id, label, line1, area, landmark, is_default').in('customer_id', ids).order('is_default', { ascending: false }),
      ])
    : [{ data: [] }, { data: [] }];
  const plans: Record<string, Choice[]> = {};
  for (const s of subs ?? []) (plans[s.customer_id] ??= []).push({ id: s.id, label: s.plan?.name ?? 'Plan' });
  const addresses: Record<string, Choice[]> = {};
  for (const a of addrs ?? []) {
    (addresses[a.customer_id] ??= []).push({
      id: a.id,
      label: `${a.label || [a.line1, a.landmark, a.area].filter(Boolean).join(', ') || 'Address'}${a.is_default ? ' (default)' : ''}`,
    });
  }

  return (
    <>
      <PageHeader
        title="Rider requests"
        subtitle="Customers tell riders at the door. Check each request, then approve or reject it. Nothing changes until you approve."
        actions={
          <div className="flex gap-1 rounded-lg bg-ink-100 p-1 text-sm">
            <Link href="/requests" className={`rounded-md px-3 py-1 ${showAll ? 'text-ink-600' : 'bg-white font-medium shadow-sm'}`}>Waiting</Link>
            <Link href="/requests?status=all" className={`rounded-md px-3 py-1 ${showAll ? 'bg-white font-medium shadow-sm' : 'text-ink-600'}`}>All</Link>
          </div>
        }
      />
      {error && <Alert>{friendlyError(error)}</Alert>}
      <RequestList rows={list} plans={plans} addresses={addresses} />
    </>
  );
}
