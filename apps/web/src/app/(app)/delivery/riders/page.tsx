import Link from 'next/link';
import { formatPaise, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { formatKm } from '@/lib/delivery';
import { Alert, Card, PageHeader } from '@/components/ui';
import { DeliveryTabs } from '../tabs';

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// Monthly numbers per rider, to pay riders: shifts, stops, proof rate, km, cash. Owner only.
export default async function RidersPage({ searchParams }: PageProps<'/delivery/riders'>) {
  const { kitchen } = await requireKitchen(['owner']);
  const sp = await searchParams;
  const thisMonth = istDate().slice(0, 7);
  const month = typeof sp.month === 'string' && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : thisMonth;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('rider_stats', { p_kitchen: kitchen.kitchenId, p_month: `${month}-01` });
  const rows = data ?? [];
  const sum = (k: 'shifts' | 'stops_delivered' | 'stops_failed' | 'cash_collected_paise') => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
  const km = rows.reduce((t, r) => t + Number(r.km ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Riders"
        subtitle={`${monthLabel(month)} · finished runs only`}
        actions={
          <form className="flex flex-wrap items-center gap-2">
            <Link href={`/delivery/riders?month=${shiftMonth(month, -1)}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50">←</Link>
            <input type="month" name="month" defaultValue={month} aria-label="Month" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <button className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-ink-200 hover:bg-ink-50">Show</button>
            {month < thisMonth && (
              <Link href={`/delivery/riders?month=${shiftMonth(month, 1)}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50">→</Link>
            )}
          </form>
        }
      />
      <DeliveryTabs isOwner />
      {error ? (
        <Alert>{friendlyError(error)}</Alert>
      ) : (
        <Card className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
              <tr>
                <th className="py-2 pr-3">Rider</th>
                <th className="py-2 pr-3 text-right">Shifts</th>
                <th className="py-2 pr-3 text-right">Days</th>
                <th className="py-2 pr-3 text-right">Delivered</th>
                <th className="py-2 pr-3 text-right">Failed</th>
                <th className="py-2 pr-3 text-right">Proof rate</th>
                <th className="py-2 pr-3 text-right">Planned km</th>
                <th className="py-2 text-right">Cash collected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((r) => (
                <tr key={r.rider_id} data-testid="rider-row">
                  <td className="py-2 pr-3 font-medium">{r.rider_name || 'Former member'}</td>
                  <td className="py-2 pr-3 text-right">{r.shifts}</td>
                  <td className="py-2 pr-3 text-right">{r.days}</td>
                  <td className="py-2 pr-3 text-right">{r.stops_delivered}</td>
                  <td className={`py-2 pr-3 text-right ${r.stops_failed ? 'text-red-700' : ''}`}>{r.stops_failed}</td>
                  <td className={`py-2 pr-3 text-right ${r.proof_rate != null && r.proof_rate < 90 ? 'text-amber-700' : ''}`}>
                    {r.proof_rate == null ? '—' : `${Number(r.proof_rate).toFixed(1)}%`}
                  </td>
                  <td className="py-2 pr-3 text-right">{formatKm(r.km)}</td>
                  <td className="py-2 text-right">{formatPaise(r.cash_collected_paise ?? 0)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={8} className="py-6 text-center text-ink-500">No finished runs this month.</td></tr>
              )}
            </tbody>
            {rows.length > 1 && (
              <tfoot className="border-t border-ink-200 font-semibold">
                <tr>
                  <td className="py-2 pr-3">Total</td>
                  <td className="py-2 pr-3 text-right">{sum('shifts')}</td>
                  <td className="py-2 pr-3 text-right" />
                  <td className="py-2 pr-3 text-right">{sum('stops_delivered')}</td>
                  <td className="py-2 pr-3 text-right">{sum('stops_failed')}</td>
                  <td className="py-2 pr-3 text-right" />
                  <td className="py-2 pr-3 text-right">{formatKm(km)}</td>
                  <td className="py-2 text-right">{formatPaise(sum('cash_collected_paise'))}</td>
                </tr>
              </tfoot>
            )}
          </table>
          <p className="mt-3 text-xs text-ink-500">
            Proof rate: deliveries with a correct delivery code or a photo. Km is the planned route distance (straight line × 1.3), not GPS.
            Cash counts what riders collected at the door, confirmed or not.
          </p>
        </Card>
      )}
    </>
  );
}
