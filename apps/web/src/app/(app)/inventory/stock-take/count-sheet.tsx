'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import {
  UNIT_LABEL, formatIstDateTime, formatQty, formatSignedQty, parseQty, unitsFor, type StockTakeLine, type StockTakeReview, type StockUnit,
} from '@/lib/inventory';
import { Alert, Badge, Button, Card, Input, Select } from '@/components/ui';

export function StartStockTake({ kitchenId }: { kitchenId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function start() {
    setBusy(true);
    setError('');
    const { error } = await supabaseBrowser().rpc('start_stock_take', { p_kitchen: kitchenId });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  return (
    <div className="space-y-2">
      <Button onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start stock-take'}</Button>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export function CountSheet({ review, isOwner }: { review: StockTakeReview; isOwner: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const counted = review.lines.filter((l) => l.counted != null).length;
  const needReason = review.lines.filter((l) => l.needs_reason).length;
  const lossValue = review.lines.reduce((t, l) => t + Number(l.variance_value_paise ?? 0), 0);

  async function cancel() {
    if (!window.confirm('Throw away this count? Nothing will be changed in stock.')) return;
    setMsg(null);
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('cancel_stock_take', { p_stock_take: review.id });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    router.refresh();
  }

  async function close() {
    setMsg(null);
    if (counted < review.lines.length &&
        !window.confirm(`${review.lines.length - counted} item(s) are not counted. They keep their book stock. Close anyway?`)) return;
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('close_stock_take', { p_stock_take: review.id });
    setBusy(false);
    if (error) {
      const detail = (error as { details?: string }).details;
      return setMsg({ tone: 'red', text: `${friendlyErrorIn('stock_take', error)}${error.message === 'reason_required' && detail ? ` (${detail})` : ''}` });
    }
    const n = (data as { adjustments?: number } | null)?.adjustments ?? 0;
    setMsg({ tone: 'green', text: `Stock-take closed. ${n} item${n === 1 ? '' : 's'} adjusted to the counted stock.` });
    router.refresh();
  }

  return (
    <Card
      title={<span>Count in progress <span className="text-sm font-normal text-ink-500">started {formatIstDateTime(review.started_at)}</span></span>}
      actions={<span className="text-sm text-ink-600 print:hidden">{counted}/{review.lines.length} counted</span>}
      className="overflow-x-auto"
    >
      <table className="min-w-full text-sm" data-testid="count-sheet">
        <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
          <tr>
            <th className="py-2 pr-3">Item</th>
            <th className="py-2 pr-3 text-right">Expected</th>
            <th className="py-2 pr-3">Counted</th>
            <th className="py-2 pr-3 text-right">Difference</th>
            <th className="py-2">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {review.lines.map((l) => <CountRow key={l.item_id} stockTake={review.id} line={l} isOwner={isOwner} />)}
        </tbody>
      </table>
      <div className="mt-4 flex flex-wrap items-center gap-3 print:hidden">
        <Button onClick={close} disabled={busy}>{busy ? 'Saving…' : 'Close stock-take'}</Button>
        <Button variant="ghost" onClick={cancel} disabled={busy}>Cancel count</Button>
        <span className="text-xs text-ink-500">Expected = book stock when the item was counted.</span>
        {needReason > 0 && <span className="text-sm text-amber-800">{needReason === 1 ? '1 item needs a reason' : `${needReason} items need a reason`}</span>}
        {isOwner && lossValue !== 0 && <span className="text-sm text-ink-600">Difference at cost: <strong>{formatPaise(lossValue)}</strong></span>}
      </div>
      {msg && <div className="mt-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
    </Card>
  );
}

function CountRow({ stockTake, line, isOwner }: { stockTake: string; line: StockTakeLine; isOwner: boolean }) {
  const router = useRouter();
  const [qty, setQty] = useState(line.counted != null ? String(Number(line.counted)) : '');
  const [unit, setUnit] = useState<StockUnit>(line.unit);
  const [reason, setReason] = useState(line.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const showReason = line.needs_reason || Boolean(line.reason);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    setError('');
    // An empty box clears an earlier count (p_counted null); an emptied reason clears it (p_reason '').
    const clearing = !qty.trim() && line.counted != null;
    const n = clearing ? null : parseQty(qty, { allowZero: true });
    if (n === null && !clearing) return setError('Enter the counted quantity.');
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('set_stock_count', {
      p_stock_take: stockTake, p_item: line.item_id, p_counted: n ?? undefined, p_unit: unit,
      p_reason: reason.trim() || (line.reason ? '' : undefined),
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    // Store in the item's unit from now on, so the input shows what was saved.
    if (unit !== line.unit) {
      setUnit(line.unit);
      setQty(n == null ? '' : String(Number((data as { counted?: number } | null)?.counted ?? n)));
    }
    router.refresh();
  }

  return (
    <tr className={line.needs_reason ? 'bg-amber-50' : ''} data-item={line.item}>
      <td className="py-2 pr-3 font-medium">{line.item}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatQty(line.expected, line.unit)}</td>
      <td className="py-2 pr-3">
        <form onSubmit={save} className="flex gap-1 print:hidden" aria-label={`Count ${line.item}`}>
          <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className="w-20!" aria-label={`Counted ${line.item}`} />
          <Select value={unit} onChange={(e) => setUnit(e.target.value as StockUnit)} className="w-20!" aria-label={`Unit ${line.item}`}>
            {unitsFor(line.unit).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
          </Select>
          <Button variant="secondary" className="px-2" disabled={busy}>Save</Button>
        </form>
        <span className="hidden print:inline">{line.counted != null ? formatQty(line.counted, line.unit) : '______'}</span>
      </td>
      <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${Number(line.variance) < 0 ? 'text-red-700' : ''}`}>
        {line.variance != null ? (
          <>
            {formatSignedQty(line.variance, line.unit)}
            {line.variance_pct != null && line.variance !== 0 && <span className="ml-1 text-xs text-ink-500">({line.variance_pct}%)</span>}
            {isOwner && line.variance_value_paise ? <div className="text-xs text-ink-500">{formatPaise(Number(line.variance_value_paise))}</div> : null}
          </>
        ) : '—'}
      </td>
      <td className="py-2">
        {showReason ? (
          <form onSubmit={save} className="flex gap-1" aria-label={`Reason ${line.item}`}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is it different?" className="min-w-40"
              aria-label={`Reason for ${line.item}`} required={line.needs_reason} />
            <Button variant="secondary" className="px-2" disabled={busy}>Save</Button>
          </form>
        ) : line.variance === 0 ? <Badge tone="green">OK</Badge> : null}
        {line.needs_reason && <div className="mt-1"><Badge tone="amber">Reason required</Badge></div>}
        {error && <div className="mt-1 text-xs text-red-700">{error}</div>}
      </td>
    </tr>
  );
}
