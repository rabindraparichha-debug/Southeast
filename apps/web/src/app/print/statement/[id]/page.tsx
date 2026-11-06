import { notFound } from 'next/navigation';
import { formatPaise, formatPhone, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { MONEY_ROLES } from '@/lib/roles';
import { whatsappUrl } from '@/lib/whatsapp';
import {
  BILLING_LABEL, addMonths, isFullPhone, isMonth, monthLabel, statementLineLabel, type CustomerStatement, type StatementLine,
} from '@/lib/money';
import { PrintButton } from '@/components/print-button';

const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const signed = (p: number) => (p > 0 ? `+${formatPaise(p)}` : formatPaise(p));
/** Rupee balance in words: "₹1,200 due", "₹300 advance", "₹0". */
const rupeeBalance = (p: number) => (p < 0 ? `${formatPaise(-p)} due` : p > 0 ? `${formatPaise(p)} advance` : '₹0');
const mealBalance = (m: number) => (m < 0 ? `${-m} owed` : String(m));

// Monthly statement for one customer (D-115, item 21): every ledger row of the month with a running
// balance; opening + rows = closing. A meal belongs to the month of its service date. Printable, and
// the owner or manager can send the summary to the customer on WhatsApp from their own phone.
export default async function StatementPage({ params, searchParams }: PageProps<'/print/statement/[id]'>) {
  const { id } = await params;
  const sp = await searchParams;
  const { kitchen } = await requireKitchen(MONEY_ROLES);
  const today = istDate();
  const month = isMonth(sp.month) ? sp.month : today.slice(0, 7);
  const supabase = await createClient();
  const [{ data, error }, { data: k }] = await Promise.all([
    supabase.rpc('customer_statement', { p_customer: id, p_month: `${month}-01` }),
    supabase.from('kitchens').select('name, address, area, city, fssai_no').eq('id', kitchen.kitchenId).single(),
  ]);
  if (error?.message === 'not_found') notFound();
  const st = data as unknown as CustomerStatement | null;
  if (!error && st && st.customer.kitchen_id !== kitchen.kitchenId) notFound();

  const prev = addMonths(`${month}-01`, -1).slice(0, 7);
  const next = addMonths(`${month}-01`, 1).slice(0, 7);
  const nav = (
    <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
      <a href={`/customers/${id}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200">← Customer</a>
      <a href={`/print/statement/${id}?month=${prev}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200">← {monthLabel(prev)}</a>
      {next <= today.slice(0, 7) && (
        <a href={`/print/statement/${id}?month=${next}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200">{monthLabel(next)} →</a>
      )}
      <PrintButton />
    </div>
  );
  if (error || !st) {
    return (
      <>
        {nav}
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">{friendlyError(error) || 'Could not load the statement.'}</p>
      </>
    );
  }

  const monthly = st.customer.billing_mode === 'monthly';
  const t = st.totals;
  const name = st.customer.name;
  const share = [
    `Namaskar ${name}, your ${monthLabel(month)} statement from ${st.kitchen_name}:`,
    st.opening.paise !== 0 && monthly ? `Previous balance: ${rupeeBalance(st.opening.paise)}.` : '',
    t.meals_charged ? `${t.meals_charged} meal${t.meals_charged === 1 ? '' : 's'}: ${formatPaise(t.charged_paise)}.` : 'No meals this month.',
    t.paid_paise ? `Paid: ${formatPaise(t.paid_paise)}.` : '',
    t.credit_paise ? `Free meals: ${formatPaise(t.credit_paise)}.` : '',
    monthly
      ? st.amount_due_paise > 0 ? `Amount due: ${formatPaise(st.amount_due_paise)}.` : `Balance: ${rupeeBalance(st.closing.paise)}.`
      : `Meals left: ${mealBalance(st.closing.meals)}${st.amount_due_paise > 0 ? ` (due ${formatPaise(st.amount_due_paise)})` : ''}.`,
    'Thank you!',
  ].filter(Boolean).join(' ');

  const summary: [string, string][] = [
    ['Opening balance', monthly ? rupeeBalance(st.opening.paise) : `${mealBalance(st.opening.meals)} meals`],
    [`Meals (${t.meals_charged})`, formatPaise(-t.charged_paise)],
    ['Paid', signed(t.paid_paise)],
    ...(t.credit_meals || t.credit_paise ? [[`Free meals (${t.credit_meals})`, signed(t.credit_paise)] as [string, string]] : []),
    ...(t.refund_paise ? [['Refunded', formatPaise(-t.refund_paise)] as [string, string]] : []),
    ...(t.voided_paise ? [['Voided payments', formatPaise(-t.voided_paise)] as [string, string]] : []),
    ...(t.adjust_paise ? [['Adjustments', signed(t.adjust_paise)] as [string, string]] : []),
    ['Closing balance', monthly ? rupeeBalance(st.closing.paise) : `${mealBalance(st.closing.meals)} meals`],
  ];
  const amountCell = (l: StatementLine) => (l.amount_paise ? signed(l.amount_paise) : '—');

  return (
    <>
      {nav}
      {isFullPhone(st.customer.phone) && (
        <div className="mb-4 print:hidden">
          <a href={whatsappUrl(st.customer.phone, share)} target="_blank" rel="noreferrer" data-testid="statement-share"
             className="inline-flex items-center rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
            Send on WhatsApp
          </a>
          <p className="mt-1 text-xs text-ink-500">Opens WhatsApp on your phone with the summary; attach a photo or PDF of this page if the customer wants the details.</p>
        </div>
      )}

      <article className="rounded-xl p-4 ring-1 ring-ink-200 sm:p-6 print:p-0 print:ring-0" data-testid="statement">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">{k?.name ?? st.kitchen_name}</h1>
            <p className="text-xs text-ink-500">{[k?.address, k?.area, k?.city].filter(Boolean).join(', ')}</p>
            {k?.fssai_no && <p className="text-xs text-ink-500">FSSAI {k.fssai_no}</p>}
          </div>
          <div className="sm:text-right">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Statement</h2>
            <p className="text-sm font-medium">{monthLabel(month)}</p>
            <p className="text-xs text-ink-500">{shortDate(st.from)} – {shortDate(st.to)}</p>
          </div>
        </header>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-ink-100 pt-4">
          <div className="text-sm">
            <div className="font-medium">{name}</div>
            <div className="text-ink-500">{formatPhone(st.customer.phone)} · {BILLING_LABEL[st.customer.billing_mode]}</div>
          </div>
          <div className="sm:text-right">
            <div className="text-xs text-ink-500">{monthly ? 'Amount due' : st.amount_due_paise > 0 ? 'Owed meals, value' : 'Meals left'}</div>
            <div className={`text-2xl font-semibold ${st.amount_due_paise > 0 ? 'text-red-700' : ''}`} data-testid="statement-due">
              {monthly || st.amount_due_paise > 0 ? formatPaise(st.amount_due_paise) : st.closing.meals}
            </div>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          {summary.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2 border-b border-ink-100 py-1 sm:block sm:border-0">
              <dt className="text-ink-500">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>

        <table className="mt-5 w-full table-fixed text-sm">
          <thead className="border-b border-ink-200 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="w-14 py-1.5 pr-2 sm:w-16">Date</th>
              <th className="py-1.5 pr-2">Item</th>
              {!monthly && <th className="w-12 py-1.5 pr-2 text-right sm:w-14">Meals</th>}
              <th className="w-20 py-1.5 pr-2 text-right">Amount</th>
              <th className="hidden w-28 py-1.5 text-right sm:table-cell print:table-cell">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {st.lines.map((l) => (
              <tr key={l.entry_id} className="break-inside-avoid align-top">
                <td className="py-1.5 pr-2 text-ink-600">{shortDate(l.date)}</td>
                <td className="break-words py-1.5 pr-2">{statementLineLabel(l)}</td>
                {!monthly && <td className="py-1.5 pr-2 text-right tabular-nums">{l.meals > 0 ? `+${l.meals}` : l.meals || '—'}</td>}
                <td className="py-1.5 pr-2 text-right tabular-nums">{amountCell(l)}</td>
                <td className="hidden py-1.5 text-right tabular-nums text-ink-600 sm:table-cell print:table-cell">{monthly ? rupeeBalance(l.balance_paise) : mealBalance(l.balance_meals)}</td>
              </tr>
            ))}
            {st.lines.length === 0 && (
              <tr><td colSpan={monthly ? 4 : 5} className="py-6 text-center text-ink-500">Nothing this month.</td></tr>
            )}
          </tbody>
        </table>
        <p className="mt-4 text-xs text-ink-500">
          {monthly
            ? 'Meals are charged at their own price on the day they are served. Please pay the amount due to the kitchen.'
            : 'Prepaid meals: unused meals are refunded at the price paid when a subscription is cancelled.'}
        </p>
      </article>
    </>
  );
}
