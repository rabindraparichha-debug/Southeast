import { addDays, formatPhone, istDate, isoDow, WEEKDAYS, isIsoDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PrintButton } from '@/components/print-button';

// Weekly paper register for vendors who still like a notebook: who eats when, balance, dues,
// and an empty column to note cash received by hand.
export default async function RegisterPage({ searchParams }: PageProps<'/print/register'>) {
  const { kitchen } = await requireKitchen(['owner']);
  const sp = await searchParams;
  const today = istDate();
  const monday = addDays(today, 1 - isoDow(today));
  const start = isIsoDate(sp.start) ? sp.start : monday;
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const supabase = await createClient();

  const [{ data: customers }, { data: orders }, { data: balances }] = await Promise.all([
    supabase.from('customers_v').select('id, name, phone, area, landmark').eq('kitchen_id', kitchen.kitchenId).order('area').order('name'),
    supabase.from('meal_orders').select('customer_id, service_date, slot, status, charged, skip_reason, qty')
      .eq('kitchen_id', kitchen.kitchenId).gte('service_date', days[0]!).lte('service_date', days[6]!),
    supabase.from('customer_balances').select('customer_id, meals').eq('kitchen_id', kitchen.kitchenId),
  ]);
  const bal = new Map((balances ?? []).map((b) => [b.customer_id, b.meals ?? 0]));
  const mark = (cid: string, d: string, slot: 'lunch' | 'dinner') => {
    const o = (orders ?? []).find((x) => x.customer_id === cid && x.service_date === d && x.slot === slot);
    if (!o) return '';
    if (o.status === 'skipped') return o.charged ? 'L' : o.skip_reason === 'pause' ? 'P' : 'S';
    return o.qty > 1 ? `✓${o.qty}` : '✓';
  };
  const rows = (customers ?? []).filter((c) => (orders ?? []).some((o) => o.customer_id === c.id) || (bal.get(c.id!) ?? 0) !== 0);

  return (
    <>
      <div className="mb-4 flex items-start justify-between print:mb-2">
        <div>
          <h1 className="text-lg font-semibold">{kitchen.kitchenName} · Register</h1>
          <p className="text-sm text-ink-500">Week of {new Date(`${start}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} · ✓ meal · S skipped · P paused · L late skip (charged) · upper row lunch, lower row dinner</p>
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
          {rows.map((c, i) => {
            const b = bal.get(c.id!) ?? 0;
            return (
              <tr key={c.id} className="break-inside-avoid">
                <td className="border border-ink-200 px-1.5 py-1 align-top">{i + 1}</td>
                <td className="border border-ink-200 px-1.5 py-1 align-top">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-ink-500">{formatPhone(c.phone)} · {[c.landmark, c.area].filter(Boolean).join(', ')}</div>
                </td>
                {days.map((d) => (
                  <td key={d} className="border border-ink-200 px-1 py-1 text-center align-top">
                    <div>{mark(c.id!, d, 'lunch')}</div>
                    <div className="text-ink-500">{mark(c.id!, d, 'dinner')}</div>
                  </td>
                ))}
                <td className={`border border-ink-200 px-1.5 py-1 text-center align-top ${b < 0 ? 'font-semibold text-red-700' : ''}`}>{b < 0 ? `owes ${-b}` : b}</td>
                <td className="w-24 border border-ink-200 px-1.5 py-1" />
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
