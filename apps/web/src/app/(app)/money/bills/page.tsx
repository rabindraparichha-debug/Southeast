import Link from 'next/link';
import { formatPaise, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { MONEY_ROLES } from '@/lib/roles';
import { BILLING_SHORT, BILLING_TONE, addMonths, isMonth, monthLabel, type MonthlyBill, type MonthlyBills } from '@/lib/money';
import { Alert, Badge, Card, LinkButton, PageHeader } from '@/components/ui';
import { PrintButton } from '@/components/print-button';

const signed = (p: number) => (p === 0 ? '—' : p > 0 ? `+${formatPaise(p)}` : formatPaise(p));
const closing = (b: MonthlyBill) =>
  b.billing_mode === 'monthly'
    ? b.closing_paise < 0 ? `${formatPaise(-b.closing_paise)} due` : b.closing_paise > 0 ? `${formatPaise(b.closing_paise)} advance` : 'settled'
    : b.closing_meals < 0 ? `${-b.closing_meals} meals owed` : `${b.closing_meals} meals left`;

// Bills for one month (monthly_bills): one line per customer with activity or a balance. Each line
// opens the customer's printable statement, which has the WhatsApp share link.
export default async function BillsPage({ searchParams }: PageProps<'/money/bills'>) {
  const { kitchen } = await requireKitchen(MONEY_ROLES);
  const sp = await searchParams;
  const today = istDate();
  const month = isMonth(sp.month) ? sp.month : today.slice(0, 7);
  const show = sp.show === 'all' ? 'all' : 'due';
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('monthly_bills', { p_kitchen: kitchen.kitchenId, p_month: `${month}-01` });
  const all = (data as unknown as MonthlyBills | null)?.bills ?? [];
  const due = all.filter((b) => (b.amount_due_paise ?? 0) > 0);
  const rows = show === 'all' ? all : due;
  const totalDue = due.reduce((t, b) => t + (b.amount_due_paise ?? 0), 0);
  const totalCharged = all.reduce((t, b) => t + b.charged_paise, 0);
  const totalPaid = all.reduce((t, b) => t + b.paid_paise, 0);
  const prev = addMonths(`${month}-01`, -1).slice(0, 7);
  const next = addMonths(`${month}-01`, 1).slice(0, 7);
  const q = (m: string, s = show) => `/money/bills?month=${m}${s === 'all' ? '&show=all' : ''}`;

  return (
    <>
      <PageHeader
        title={`Bills · ${monthLabel(month)}`}
        subtitle={`Meals ${formatPaise(totalCharged)} · paid ${formatPaise(totalPaid)} · ${due.length} monthly customer${due.length === 1 ? '' : 's'} with ${formatPaise(totalDue)} due`}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <LinkButton href={q(prev)} variant="secondary">← {monthLabel(prev)}</LinkButton>
            {next <= today.slice(0, 7) && <LinkButton href={q(next)} variant="secondary">{monthLabel(next)} →</LinkButton>}
            <PrintButton />
          </div>
        }
      />
      {error && <Alert>{friendlyError(error)}</Alert>}
      <div className="mb-4 flex w-fit gap-1 rounded-lg bg-ink-100 p-1 text-sm print:hidden">
        <Link href={q(month, 'due')} className={`rounded-md px-3 py-1 ${show === 'due' ? 'bg-white font-medium shadow-sm' : 'text-ink-600'}`}>Amount due ({due.length})</Link>
        <Link href={q(month, 'all')} className={`rounded-md px-3 py-1 ${show === 'all' ? 'bg-white font-medium shadow-sm' : 'text-ink-600'}`}>Everyone ({all.length})</Link>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm" data-testid="bills-table">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-3 py-2">Customer</th>
              <th className="hidden px-3 py-2 text-right md:table-cell">Opening</th>
              <th className="hidden px-3 py-2 text-right sm:table-cell">Meals</th>
              <th className="hidden px-3 py-2 text-right md:table-cell">Charged</th>
              <th className="hidden px-3 py-2 text-right md:table-cell">Paid</th>
              <th className="hidden px-3 py-2 text-right lg:table-cell">Credits / refunds / adjust</th>
              <th className="px-3 py-2 text-right">Closing</th>
              <th className="px-3 py-2 print:hidden" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((b) => (
              <tr key={b.customer_id} className="break-inside-avoid">
                <td className="px-3 py-2">
                  <Link href={`/customers/${b.customer_id}`} className="font-medium hover:text-brand-700">{b.name}</Link>
                  <span className="ml-2"><Badge tone={BILLING_TONE[b.billing_mode]}>{BILLING_SHORT[b.billing_mode]}</Badge></span>
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{signed(b.opening_paise)}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{b.meals}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{formatPaise(b.charged_paise)}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{formatPaise(b.paid_paise)}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums lg:table-cell">
                  {[b.credit_paise ? `+${formatPaise(b.credit_paise)}` : '', b.refund_paise ? `−${formatPaise(b.refund_paise)}` : '', b.adjust_paise ? signed(b.adjust_paise) : '']
                    .filter(Boolean).join(' · ') || '—'}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${(b.amount_due_paise ?? 0) > 0 ? 'font-semibold text-red-700' : ''}`}>{closing(b)}</td>
                <td className="px-3 py-2 text-right print:hidden">
                  <Link href={`/print/statement/${b.customer_id}?month=${month}`} className="text-brand-700 hover:underline">Bill</Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-ink-500">
                  {show === 'due' ? 'No monthly customer has anything due for this month.' : 'No money activity this month.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <p className="mt-3 text-xs text-ink-500">
        A meal counts in the month it is served. Closing includes anything unpaid from earlier months. Prepaid customers are shown in meals.
      </p>
    </>
  );
}
