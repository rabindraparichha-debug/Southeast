import Link from 'next/link';
import { addDays, formatPaise, formatServiceDate, istDate, isIsoDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Card, LinkButton, PageHeader, Stat } from '@/components/ui';
import { METHOD_LABEL, PaymentStatus, RefundStatus } from '@/components/payment-badges';
import { MoneyActions } from './money-actions';

type Report = {
  collected_paise: number; by_method: Record<string, number>; by_day: { date: string; paise: number }[];
  refunded_paise: number; refunds_pending_paise: number; pending_cash_paise: number; dues_paise: number; dues_customers: number;
  liability_paise: number; customers: number; whatsapp_opt_in: number; live_subscriptions: number; autopay_subscriptions: number;
};

const pct = (n: number, d: number) => (d ? `${Math.round((n * 100) / d)}%` : '—');

export default async function MoneyPage({ searchParams }: PageProps<'/money'>) {
  const { kitchen } = await requireKitchen(['owner']);
  const sp = await searchParams;
  const today = istDate();
  const from = isIsoDate(sp.from) ? sp.from : `${today.slice(0, 8)}01`;
  const to = isIsoDate(sp.to) ? sp.to : today;
  const supabase = await createClient();

  const [{ data: reportRaw }, { data: pending }, { data: refunds }, { data: dues }, { data: recent }] = await Promise.all([
    supabase.rpc('money_report', { p_kitchen: kitchen.kitchenId, p_from: from, p_to: to }),
    supabase.from('payments').select('id, amount_paise, meals, created_at, note, customer:customers(id, name)')
      .eq('kitchen_id', kitchen.kitchenId).eq('status', 'pending').order('created_at'),
    supabase.from('refunds').select('id, meals, amount_paise, status, payment_id, created_at, customer:customers(id, name)')
      .eq('kitchen_id', kitchen.kitchenId).in('status', ['pending', 'processing', 'failed']).order('created_at'),
    supabase.rpc('dues_list', { p_kitchen: kitchen.kitchenId }),
    supabase.from('payments').select('id, method, status, amount_paise, meals, created_at, paid_at, customer:customers(id, name)')
      .eq('kitchen_id', kitchen.kitchenId).order('created_at', { ascending: false }).limit(25),
  ]);
  const r = reportRaw as unknown as Report;

  return (
    <>
      <PageHeader
        title="Money"
        subtitle={`${formatServiceDate(from)} – ${formatServiceDate(to)}`}
        actions={
          <form className="flex flex-wrap items-end gap-2 print:hidden">
            <input type="date" name="from" defaultValue={from} className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <input type="date" name="to" defaultValue={to} className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
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
        <Stat label="Prepaid meals owed (liability)" value={formatPaise(r.liability_paise)} hint="Value of unused meals customers paid for" />
        <Stat label="Refunds" value={formatPaise(r.refunded_paise)} hint={r.refunds_pending_paise ? `${formatPaise(r.refunds_pending_paise)} still to pay` : 'None pending'} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Stat label="Customers on WhatsApp" value={pct(r.whatsapp_opt_in, r.customers)} hint={`${r.whatsapp_opt_in} of ${r.customers}`} />
        <Stat label="Subscriptions on autopay" value={pct(r.autopay_subscriptions, r.live_subscriptions)} hint={`${r.autopay_subscriptions} of ${r.live_subscriptions} (UPI Autopay comes later)`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title={`Cash collected by riders (${pending?.length ?? 0})`}>
          {pending?.length ? (
            <ul className="divide-y divide-ink-100 text-sm">
              {pending.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><Link href={`/customers/${p.customer?.id}`} className="font-medium hover:text-brand-700">{p.customer?.name}</Link> · {formatPaise(p.amount_paise)}</span>
                  <MoneyActions kind="pending" id={p.id} />
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
                  <span><Link href={`/customers/${x.customer?.id}`} className="font-medium hover:text-brand-700">{x.customer?.name}</Link> · {x.meals} meals · {formatPaise(x.amount_paise)}</span>
                  <span className="flex items-center gap-1.5"><RefundStatus status={x.status} />{x.status !== 'processing' && <MoneyActions kind="refund" id={x.id} online={Boolean(x.payment_id)} />}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-500">No refunds waiting.</p>}
        </Card>

        <Card title={`Dues (khata) · ${formatPaise(r.dues_paise)}`}>
          {dues?.length ? (
            <ul className="divide-y divide-ink-100 text-sm">
              {dues.map((d) => (
                <li key={d.customer_id} className="flex justify-between gap-2 py-2">
                  <Link href={`/customers/${d.customer_id}`} className="font-medium hover:text-brand-700">{d.customer_name}</Link>
                  <span>{d.meals_owed} meals · <strong>{formatPaise(d.amount_owed_paise)}</strong> <span className="text-ink-500">since {formatServiceDate(d.since)}</span></span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-500">Nobody owes money.</p>}
          <p className="mt-3 text-xs text-ink-500">Reminders go out on day 1, 3 and 7 (WhatsApp, once connected).</p>
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
            <tr><th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Customer</th><th className="py-2 pr-3">Method</th><th className="py-2 pr-3">Amount</th><th className="py-2 pr-3">Meals</th><th className="py-2">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {(recent ?? []).map((p) => (
              <tr key={p.id}>
                <td className="py-2 pr-3">{new Date(p.paid_at ?? p.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}</td>
                <td className="py-2 pr-3"><Link href={`/customers/${p.customer?.id}`} className="hover:text-brand-700">{p.customer?.name}</Link></td>
                <td className="py-2 pr-3">{METHOD_LABEL[p.method] ?? p.method}</td>
                <td className="py-2 pr-3">{formatPaise(p.amount_paise)}</td>
                <td className="py-2 pr-3">{p.meals}</td>
                <td className="py-2"><PaymentStatus status={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
