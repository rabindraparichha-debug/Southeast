import Link from 'next/link';
import { formatPaise, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import type { Office, OfficeStatement } from '@/lib/p5';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { OfficeForm } from './office-form';

// Office plans (P6): many eaters, one delivery stop, one billing contact who pays for everyone.
// Staff see the list (contact masked, no billing); the owner edits and gets the monthly statement.
export default async function OfficesPage({ searchParams }: PageProps<'/customers/offices'>) {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const isOwner = kitchen.role === 'owner';
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data, error }, { data: k }] = await Promise.all([
    supabase.rpc('offices_list', { p_kitchen: kitchen.kitchenId }),
    supabase.from('kitchens').select('lat, lng').eq('id', kitchen.kitchenId).single(),
  ]);
  const offices = (data ?? []) as unknown as Office[];
  const { data: billable } = isOwner
    ? await supabase.from('customers').select('id, name').eq('kitchen_id', kitchen.kitchenId).is('deleted_at', null).is('payer_customer_id', null).order('name')
    : { data: null };

  const editId = typeof sp.edit === 'string' ? sp.edit : null;
  const editing = offices.find((o) => o.id === editId) ?? null;
  const statementId = typeof sp.statement === 'string' ? sp.statement : null;
  const month = typeof sp.month === 'string' && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : istDate().slice(0, 7);
  const statement = isOwner && statementId
    ? await supabase.rpc('office_statement', { p_office: statementId, p_month: `${month}-01` })
    : null;
  const st = statement?.data as unknown as OfficeStatement | null;

  return (
    <>
      <PageHeader title="Offices" subtitle="Office lunches: every member’s tiffin goes to one stop, and the office’s billing contact pays for all."
        actions={<Link href="/customers" className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50 print:hidden">← Customers</Link>} />
      {error && <Alert>{friendlyError(error)}</Alert>}

      {statementId && isOwner && (
        <Card title={st ? `Statement · ${st.office.name} · ${st.month}` : 'Statement'} className="mb-6"
          actions={
            <form className="flex flex-wrap items-center gap-2 print:hidden">
              <input type="hidden" name="statement" value={statementId} />
              <input type="month" name="month" defaultValue={month} aria-label="Month" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
              <button className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-ink-200">Show</button>
              <PrintButton />
            </form>
          }>
          {statement?.error ? <Alert>{friendlyError(statement.error)}</Alert> : st && (
            <>
              <p className="mb-3 text-sm text-ink-600">Billed to <strong>{st.office.billing_customer_name}</strong>. Meals are charged at each member’s plan price.</p>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
                    <tr><th className="py-2 pr-3">Member</th><th className="py-2 pr-3 text-right">Meals</th><th className="py-2 pr-3 text-right">Amount</th><th className="py-2 pr-3 text-right">Credits</th><th className="py-2 pr-3 text-right">Paid</th><th className="py-2 text-right">Balance (meals)</th></tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {st.members.map((m) => (
                      <tr key={m.customer_id}>
                        <td className="py-2 pr-3"><Link href={`/customers/${m.customer_id}`} className="hover:text-brand-700">{m.name}</Link></td>
                        <td className="py-2 pr-3 text-right">{m.meals}</td>
                        <td className="py-2 pr-3 text-right">{formatPaise(m.amount_paise)}</td>
                        <td className="py-2 pr-3 text-right">{m.credit_meals || ''}</td>
                        <td className="py-2 pr-3 text-right">{formatPaise(m.paid_paise)}</td>
                        <td className={`py-2 text-right ${m.balance_meals < 0 ? 'font-semibold text-red-700' : ''}`}>{m.balance_meals}</td>
                      </tr>
                    ))}
                    {!st.members.length && <tr><td colSpan={6} className="py-4 text-center text-ink-500">No members yet. Add customers to this office from their page.</td></tr>}
                  </tbody>
                  <tfoot className="border-t border-ink-200 font-semibold">
                    <tr><td className="py-2 pr-3">Total</td><td className="py-2 pr-3 text-right">{st.totals.meals}</td><td className="py-2 pr-3 text-right">{formatPaise(st.totals.amount_paise)}</td><td /><td className="py-2 pr-3 text-right">{formatPaise(st.totals.paid_paise)}</td><td className="py-2 text-right">{st.totals.balance_meals}</td></tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2 print:hidden">
        <Card title={`Offices (${offices.length})`}>
          <ul className="divide-y divide-ink-100 text-sm" data-testid="offices-list">
            {offices.map((o) => (
              <li key={o.id} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{o.name}</span>
                  <Badge>{o.members} member{o.members === 1 ? '' : 's'}</Badge>
                  {!o.active && <Badge tone="gray">Inactive</Badge>}
                </div>
                <div className="text-ink-500">{[o.line1, o.landmark, o.area].filter(Boolean).join(', ') || 'No address'}</div>
                {(o.contact_name || o.contact_phone) && <div className="text-ink-500">Contact: {[o.contact_name, o.contact_phone].filter(Boolean).join(' · ')}</div>}
                {isOwner && o.billing_customer_name && <div className="text-ink-500">Billed to {o.billing_customer_name}</div>}
                {isOwner && (
                  <div className="flex gap-3 pt-1">
                    <Link href={`/customers/offices?edit=${o.id}`} className="text-brand-700 hover:underline">Edit</Link>
                    <Link href={`/customers/offices?statement=${o.id}&month=${month}`} className="text-brand-700 hover:underline">Monthly statement</Link>
                  </div>
                )}
              </li>
            ))}
            {!offices.length && <li className="py-3 text-ink-500">No offices yet.</li>}
          </ul>
        </Card>
        {isOwner && (
          <OfficeForm key={editing?.id ?? 'new'} kitchenId={kitchen.kitchenId} office={editing} billable={billable ?? []}
            center={k?.lat && k?.lng ? { lat: k.lat, lng: k.lng } : null} />
        )}
      </div>
    </>
  );
}
