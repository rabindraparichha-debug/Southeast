import { addDays, formatPaise, formatPhone, istDate, isoDow, WEEKDAYS, isIsoDate } from '@tiffin/core';
import type { BillingMode } from '@tiffin/db';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PrintButton } from '@/components/print-button';

type RegisterRow = {
  customer_id: string;
  name: string;
  phone: string | null;
  area: string | null;
  landmark: string | null;
  billing_mode: BillingMode;
  balance_meals: number;
  balance_paise: number;
  marks: Record<string, { lunch?: string; dinner?: string }>;
};
type Register = { days: string[]; rows: RegisterRow[] };

// Weekly paper register for vendors who still like a notebook: who eats when, balance, dues,
// and an empty column to note cash received by hand. Built on the server in one call
// (register_sheet), so a big kitchen is never cut off at the API's 1,000-row limit.
export default async function RegisterPage({ searchParams }: PageProps<'/print/register'>) {
  const { kitchen } = await requireKitchen(['owner', 'manager', 'accountant']);
  const sp = await searchParams;
  const today = istDate();
  const monday = addDays(today, 1 - isoDow(today));
  const start = isIsoDate(sp.start) ? sp.start : monday;
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const supabase = await createClient();

  const { data } = await supabase.rpc('register_sheet', { p_kitchen: kitchen.kitchenId, p_start: start, p_days: 7 });
  const rows = ((data as unknown as Register | null)?.rows ?? []);
  const mark = (r: RegisterRow, d: string, slot: 'lunch' | 'dinner') => r.marks[d]?.[slot] ?? '';
  const balance = (r: RegisterRow) => {
    if (r.billing_mode === 'monthly') {
      return r.balance_paise < 0 ? `owes ${formatPaise(-r.balance_paise)}` : r.balance_paise > 0 ? `+${formatPaise(r.balance_paise)}` : '0';
    }
    return r.balance_meals < 0 ? `owes ${-r.balance_meals}` : String(r.balance_meals);
  };
  const owes = (r: RegisterRow) => (r.billing_mode === 'monthly' ? r.balance_paise < 0 : r.balance_meals < 0);

  return (
    <>
      <div className="mb-4 flex items-start justify-between print:mb-2">
        <div>
          <h1 className="text-lg font-semibold">{kitchen.kitchenName} · Register</h1>
          <p className="text-sm text-ink-500">Week of {new Date(`${start}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} · ✓ meal · S skipped · P paused · L late skip (charged) · upper row lunch, lower row dinner · balance in meals (prepaid) or rupees (monthly)</p>
        </div>
        <div className="flex gap-2 print:hidden">
          <a href={`/print/register?start=${addDays(start, -7)}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200">← Week</a>
          <a href={`/print/register?start=${addDays(start, 7)}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200">Week →</a>
          <PrintButton />
        </div>
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-ink-50">
            <th className="border border-ink-200 px-1.5 py-1 text-left">#</th>
            <th className="border border-ink-200 px-1.5 py-1 text-left">Customer</th>
            {days.map((d) => (
              <th key={d} className="border border-ink-200 px-1 py-1">{WEEKDAYS[isoDow(d) - 1]?.short} {d.slice(8)}</th>
            ))}
            <th className="border border-ink-200 px-1.5 py-1">Balance</th>
            <th className="border border-ink-200 px-1.5 py-1">Cash received</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={c.customer_id} className="break-inside-avoid">
              <td className="border border-ink-200 px-1.5 py-1 align-top">{i + 1}</td>
              <td className="border border-ink-200 px-1.5 py-1 align-top">
                <div className="font-medium">{c.name}</div>
                <div className="text-ink-500">{formatPhone(c.phone)} · {[c.landmark, c.area].filter(Boolean).join(', ')}</div>
              </td>
              {days.map((d) => (
                <td key={d} className="border border-ink-200 px-1 py-1 text-center align-top">
                  <div>{mark(c, d, 'lunch')}</div>
                  <div className="text-ink-500">{mark(c, d, 'dinner')}</div>
                </td>
              ))}
              <td className={`border border-ink-200 px-1.5 py-1 text-center align-top ${owes(c) ? 'font-semibold text-red-700' : ''}`}>{balance(c)}</td>
              <td className="w-24 border border-ink-200 px-1.5 py-1" />
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
