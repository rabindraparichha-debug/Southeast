import Link from 'next/link';
import { addDays, formatPaise, formatServiceDate, istDate, isIsoDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { MONEY_ROLES, isLead } from '@/lib/roles';
import { BILLING_SHORT, BILLING_TONE, monthLabel, type MonthlyBills } from '@/lib/money';
import { Badge, Card, LinkButton, PageHeader, Stat } from '@/components/ui';
import { METHOD_LABEL, PaymentStatus, RefundStatus } from '@/components/payment-badges';
import { MoneyActions } from './money-actions';
import { CsvExports } from './csv-exports';

type Report = {
  collected_paise: number; by_method: Record<string, number>; by_day: { date: string; paise: number }[];
  refunded_paise: number; refunds_pending_paise: number; pending_cash_paise: number; dues_paise: number; dues_customers: number;
  liability_paise: number; customers: number; monthly_customers: number; prepaid_customers: number;
  whatsapp_opt_in: number; live_subscriptions: number; autopay_subscriptions: number;
};

const pct = (n: number, d: number) => (d ? `${Math.round((n * 100) / d)}%` : '—');

// Owner and manager: everything, with actions (confirm rider cash, pay refunds). Accountant: read-only.
export default async function MoneyPage({ searchParams }: PageProps<'/money'>) {
  const { kitchen } = await requireKitchen(MONEY_ROLES);
  const canWrite = isLead(kitchen.role);
  const sp = await searchParams;
  const today = istDate();
  const from = isIsoDate(sp.from) ? sp.from : `${today.slice(0, 8)}01`;
  const to = isIsoDate(sp.to) ? sp.to : today;
  const month = `${today.slice(0, 7)}-01`;
  const supabase = await createClient();

  const [{ data: reportRaw }, { data: pending }, { data: refunds }, { data: dues }, { data: recent }, { data: billsRaw }] = await Promise.all([
    supabase.rpc('money_report', { p_kitchen: kitchen.kitchenId, p_from: from, p_to: to }),
    supabase.from('payments').select('id, amount_paise, meals, created_at, note, customer:customers(id, name)')
      .eq('kitchen_id', kitchen.kitchenId).eq('status', 'pending').order('created_at'),
    supabase.from('refunds').select('id, meals, amount_paise, status, payment_id, created_at, customer:customers(id, name)')
      .eq('kitchen_id', kitchen.kitchenId).in('status', ['pending', 'processing', 'failed']).order('created_at'),
    supabase.rpc('dues_list', { p_kitchen: kitchen.kitchenId }),
    supabase.from('payments').select('id, method, status, amount_paise, meals, created_at, paid_at, void_reason, customer:customers(id, name)')
      .eq('kitchen_id', kitchen.kitchenId).order('created_at', { ascending: false }).limit(25),
    supabase.rpc('monthly_bills', { p_kitchen: kitchen.kitchenId, p_month: month }),
  ]);
  const r = reportRaw as unknown as Report;
  const bills = (billsRaw as unknown as MonthlyBills | null)?.bills ?? [];
  const billsDue = bills.filter((b) => (b.amount_due_paise ?? 0) > 0);
  const billsDueTotal = billsDue.reduce((t, b) => t + (b.amount_due_paise ?? 0), 0);
  const monthlyDues = (dues ?? []).filter((d) => d.billing_mode === 'monthly');
  const prepaidDues = (dues ?? []).filter((d) => d.billing_mode !== 'monthly');

  return (
    <>
      <PageHeader
        title="Money"
        subtitle={`${formatServiceDate(from)} – ${formatServiceDate(to)}${canWrite ? '' : ' · read only'}`}
        actions={
          <form className="flex flex-wrap items-end gap-2 print:hidden">
            <input type="date" name="from" defaultValue={from} aria-label="From" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <input type="date" name="to" defaultValue={to} aria-label="To" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <button className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-ink-200">Show</button>
            <LinkButton href={`/money?from=${addDays(today, -6)}&to=${today}`} variant="ghost">Last 7 days</LinkButton>
            <LinkButton href="/print/register" variant="secondary">Print register</LinkButton>
          </form>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Collected" value={formatPaise(r.collected_paise)}
          hint={Object.entries(r.by_method).map(([m, v]) => `${METHOD_LABEL[m] ?? m} ${formatPaise(v)}`).join(' · ') || 'No payments'} />
        <Stat label="Outstanding dues" value={formatPaise(r.dues_paise)} hint={`${r.dues_customers} customer(s)`} />
        <Stat label="Advances held (liability)" value={formatPaise(r.liability_paise)} hint="Monthly advances plus unused prepaid meals" />
        <Stat label="Refunds" value={formatPaise(r.refunded_paise)} hint={r.refunds_pending_paise ? `${formatPaise(r.refunds_pending_paise)} still to pay` : 'None pending'} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Stat label="Customers by billing" value={`${r.monthly_customers ?? 0} monthly · ${r.prepaid_customers ?? 0} prepaid`} hint={canWrite ? 'Change one customer from their Money card' : undefined} />
        <Stat label="Customers on WhatsApp" value={pct(r.whatsapp_opt_in, r.customers)} hint={`${r.whatsapp_opt_in} of ${r.customers}`} />
        <Stat label="Subscriptions on autopay" value={pct(r.autopay_subscriptions, r.live_subscriptions)} hint={`${r.autopay_subscriptions} of ${r.live_subscriptions} (UPI Autopay comes later)`} />
      </div>

      <Card className="mt-6" title={`Bills for ${monthLabel(month)}`}
        actions={<LinkButton href={`/money/bills?month=${month.slice(0, 7)}`} variant="secondary">All bills</LinkButton>}>
        <p className="text-sm text-ink-600" data-testid="bills-summary">
          {billsDue.length
            ? <><strong>{billsDue.length}</strong> monthly customer{billsDue.length === 1 ? ' has' : 's have'} <strong>{formatPaise(billsDueTotal)}</strong> due (this month and anything unpaid from before). Open a bill to print it{canWrite ? ' or send it on WhatsApp' : ''}.</>
            : 'No monthly customer owes anything this month yet.'}
        </p>
        {billsDue.length > 0 && (
          <ul className="mt-3 divide-y divide-ink-100 text-sm">
            {billsDue.sort((a, b) => (b.amount_due_paise ?? 0) - (a.amount_due_paise ?? 0)).slice(0, 5).map((b) => (
              <li key={b.customer_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/customers/${b.customer_id}`} className="font-medium hover:text-brand-700">{b.name}</Link>
                <span className="flex items-center gap-3">
                  <span>{b.meals} meals · <strong>{formatPaise(b.amount_due_paise ?? 0)}</strong> due</span>
                  <Link href={`/print/statement/${b.customer_id}?month=${month.slice(0, 7)}`} className="text-brand-700 hover:underline">Bill</Link>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 border-t border-ink-100 pt-3 print:hidden">
          <CsvExports kitchenId={kitchen.kitchenId} from={from} to={to} />
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title={`Cash collected by riders (${pending?.length ?? 0})`}>
          {pending?.length ? (
            <ul className="divide-y divide-ink-100 text-sm">
              {pending.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><Link href={`/customers/${p.customer?.id}`} className="font-medium hover:text-brand-700">{p.customer?.name}</Link> · {formatPaise(p.amount_paise)}</span>
                  {canWrite ? <MoneyActions kind="pending" id={p.id} /> : <Badge tone="amber">To confirm</Badge>}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-500">Nothing to confirm.</p>}
        </Card>

        <Card title={`Refunds to pay (${refunds?.length ?? 0})`}>
          {refunds?.length ? (
            <ul className="divide-y divide-ink-100 text-sm">
              {refunds.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><Link href={`/customers/${x.customer?.id}`} className="font-medium hover:text-brand-700">{x.customer?.name}</Link>{x.meals > 0 ? ` · ${x.meals} meals` : ''} · {formatPaise(x.amount_paise)}</span>
                  <span className="flex items-center gap-1.5"><RefundStatus status={x.status} />{canWrite && x.status !== 'processing' && <MoneyActions kind="refund" id={x.id} online={Boolean(x.payment_id)} />}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-500">No refunds waiting.</p>}
        </Card>

        <Card title={`Dues (khata) · ${formatPaise(r.dues_paise)}`}>
          {dues?.length ? (
            <>
              {monthlyDues.length > 0 && (
                <>
                  <h3 className="text-xs font-semibold uppercase text-ink-500">Monthly (pay later)</h3>
                  <ul className="mb-3 divide-y divide-ink-100 text-sm" data-testid="dues-monthly">
                    {monthlyDues.map((d) => (
                      <li key={d.customer_id} className="flex flex-wrap justify-between gap-2 py-2">
                        <Link href={`/customers/${d.customer_id}`} className="font-medium hover:text-brand-700">{d.customer_name}</Link>
                        <span><strong>{formatPaise(d.amount_owed_paise)}</strong> <span className="text-ink-500">since {formatServiceDate(d.since)}</span></span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {prepaidDues.length > 0 && (
                <>
                  <h3 className="text-xs font-semibold uppercase text-ink-500">Prepaid, meals owed</h3>
                  <ul className="divide-y divide-ink-100 text-sm">
                    {prepaidDues.map((d) => (
                      <li key={d.customer_id} className="flex flex-wrap justify-between gap-2 py-2">
                        <span className="flex items-center gap-2">
                          <Link href={`/customers/${d.customer_id}`} className="font-medium hover:text-brand-700">{d.customer_name}</Link>
                          <Badge tone={BILLING_TONE.prepaid}>{BILLING_SHORT.prepaid}</Badge>
                        </span>
                        <span>{d.meals_owed} meals · <strong>{formatPaise(d.amount_owed_paise)}</strong> <span className="text-ink-500">since {formatServiceDate(d.since)}</span></span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : <p className="text-sm text-ink-500">Nobody owes money.</p>}
          <p className="mt-3 text-xs text-ink-500">No reminders are sent automatically. Remind customers yourself when you collect.</p>
        </Card>

        <Card title="Collections by day">
          {r.by_day.length ? (
            <ul className="space-y-1 text-sm">
              {r.by_day.map((d) => <li key={d.date} className="flex justify-between"><span>{formatServiceDate(d.date)}</span><strong>{formatPaise(d.paise)}</strong></li>)}
            </ul>
          ) : <p className="text-sm text-ink-500">No payments in this period.</p>}
        </Card>
      </div>

      <Card title="Recent payments" className="mt-6 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase text-ink-500">
            <tr><th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Customer</th><th className="hidden py-2 pr-3 sm:table-cell">Method</th><th className="py-2 pr-3">Amount</th><th className="hidden py-2 pr-3 sm:table-cell">Meals</th><th className="py-2">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {(recent ?? []).map((p) => (
              <tr key={p.id}>
                <td className="py-2 pr-3 whitespace-nowrap">{new Date(p.paid_at ?? p.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}</td>
                <td className="py-2 pr-3"><Link href={`/customers/${p.customer?.id}`} className="hover:text-brand-700">{p.customer?.name}</Link></td>
                <td className="hidden py-2 pr-3 sm:table-cell">{METHOD_LABEL[p.method] ?? p.method}</td>
                <td className={`py-2 pr-3 ${p.status === 'voided' ? 'text-ink-500 line-through' : ''}`}>{formatPaise(p.amount_paise)}</td>
                <td className="hidden py-2 pr-3 sm:table-cell">{p.meals || '—'}</td>
                <td className="py-2">
                  <PaymentStatus status={p.status} />
                  {p.status === 'voided' && p.void_reason && <div className="text-xs text-ink-500">{p.void_reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
