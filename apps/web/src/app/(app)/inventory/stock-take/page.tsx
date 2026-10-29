import Link from 'next/link';
import { formatPaise } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { formatIstDateTime, formatQty, formatSignedQty, type StockTakeReview } from '@/lib/inventory';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { InventoryTabs } from '../tabs';
import { CountSheet, StartStockTake } from './count-sheet';

// Physical count: start (or continue) one open count per kitchen, enter what is on the shelf,
// give a reason for big differences, close to make book stock = counted stock.
export default async function StockTakePage({ searchParams }: PageProps<'/inventory/stock-take'>) {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const isOwner = kitchen.role === 'owner';
  const sp = await searchParams;
  const viewId = typeof sp.view === 'string' && /^[0-9a-f-]{36}$/.test(sp.view) ? sp.view : null;
  const supabase = await createClient();

  const [{ data: open }, { data: history }, { data: settings }] = await Promise.all([
    supabase.from('stock_takes').select('id').eq('kitchen_id', kitchen.kitchenId).eq('status', 'open').maybeSingle(),
    supabase.from('stock_takes').select('id, started_at, closed_at').eq('kitchen_id', kitchen.kitchenId).eq('status', 'closed')
      .order('closed_at', { ascending: false }).limit(12),
    supabase.from('kitchen_settings').select('variance_reason_pct').eq('kitchen_id', kitchen.kitchenId).maybeSingle(),
  ]);
  const strip = (r: StockTakeReview): StockTakeReview =>
    isOwner ? r : { ...r, lines: r.lines.map((l) => ({ ...l, variance_value_paise: null })) };

  const [openRes, viewRes] = await Promise.all([
    open ? supabase.rpc('stock_take_review', { p_stock_take: open.id }) : Promise.resolve({ data: null, error: null }),
    viewId ? supabase.rpc('stock_take_review', { p_stock_take: viewId }) : Promise.resolve({ data: null, error: null }),
  ]);
  const review = openRes.data ? strip(openRes.data as unknown as StockTakeReview) : null;
  const viewed = viewRes.data ? strip(viewRes.data as unknown as StockTakeReview) : null;
  const pct = settings?.variance_reason_pct != null ? Number(settings.variance_reason_pct) : null;

  return (
    <>
      <PageHeader
        title="Stock-take"
        subtitle={pct != null ? `Count what is on the shelf. Differences above ${pct}% need a reason.` : 'Count what is on the shelf.'}
        actions={<PrintButton label="Print count sheet" />}
      />
      <InventoryTabs />
      {(openRes.error || viewRes.error) && <Alert>{friendlyError(openRes.error ?? viewRes.error)}</Alert>}

      {review ? (
        <CountSheet review={review} isOwner={isOwner} />
      ) : (
        <Card className="mb-6 print:hidden">
          <p className="mb-3 text-sm text-ink-600">No count in progress. Starting one takes a snapshot of book stock for every active item; you can finish it later.</p>
          <StartStockTake kitchenId={kitchen.kitchenId} />
        </Card>
      )}

      {viewed && (
        <Card title={`Count closed ${viewed.closed_at ? formatIstDateTime(viewed.closed_at) : ''}`} className="mt-6 overflow-x-auto"
          actions={<Link href="/inventory/stock-take" className="text-sm text-brand-700 hover:underline print:hidden">Close</Link>}>
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
              <tr>
                <th className="py-2 pr-3">Item</th><th className="py-2 pr-3 text-right">Expected</th><th className="py-2 pr-3 text-right">Counted</th>
                <th className="py-2 pr-3 text-right">Difference</th>{isOwner && <th className="py-2 pr-3 text-right">Value</th>}<th className="py-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {viewed.lines.map((l) => (
                <tr key={l.item_id}>
                  <td className="py-2 pr-3 font-medium">{l.item}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatQty(l.expected, l.unit)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{l.counted == null ? <span className="text-ink-400">not counted</span> : formatQty(l.counted, l.unit)}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${Number(l.variance) < 0 ? 'text-red-700' : ''}`}>{l.variance ? formatSignedQty(l.variance, l.unit) : '—'}</td>
                  {isOwner && <td className="py-2 pr-3 text-right tabular-nums">{l.variance_value_paise ? formatPaise(Number(l.variance_value_paise)) : '—'}</td>}
                  <td className="py-2 text-ink-600">{l.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Past counts" className="mt-6 print:hidden">
        <ul className="divide-y divide-ink-100 text-sm">
          {(history ?? []).map((h) => (
            <li key={h.id} className="flex items-center justify-between py-2">
              <span>Closed {h.closed_at ? formatIstDateTime(h.closed_at) : ''} <span className="text-ink-500">(started {formatIstDateTime(h.started_at)})</span></span>
              {viewId === h.id ? <Badge tone="blue">Showing</Badge> : <Link href={`/inventory/stock-take?view=${h.id}`} className="text-brand-700 hover:underline">View</Link>}
            </li>
          ))}
          {!history?.length && <li className="py-2 text-ink-500">No closed counts yet.</li>}
        </ul>
      </Card>
    </>
  );
}
