'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatIstShort } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { convertQty, formatQty, formatSignedQty, type StockTakeLine, type StockTakeReview, type StockUnit } from '@/lib/inventory';
import { BigButton, ErrorText, FieldInput, Muted, Panel } from '@/components/field-ui';
import { parseEntryQty, UnitChips } from './stock-ui';

type Entry = { counted: string; unit: StockUnit; reason: string; saving: boolean; error: string };
type CountResult = { item_id: string; expected: number; counted: number | null; variance: number | null; needs_reason: boolean };

/** Typed count converted to the item's unit; undefined when empty, null when not a number. */
function typedQty(e: Entry, line: StockTakeLine): number | null | undefined {
  if (!e.counted.trim()) return undefined;
  const n = parseEntryQty(e.counted);
  return n == null ? null : Math.round(convertQty(n, e.unit, line.unit) * 1000) / 1000;
}

const plainQty = (n: number | null) => (n == null ? '' : String(Math.round(Number(n) * 1000) / 1000));

// Count what is in the kitchen, item by item. Big differences need a reason before closing.
export function CountView({ kitchenId, onDone }: { kitchenId: string; onDone: () => void }) {
  const [loading, setLoading] = useState(true);
  const [take, setTake] = useState<StockTakeReview | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [closedMsg, setClosedMsg] = useState('');

  const review = useCallback(async (id: string) => {
    const { data, error: e } = await supabaseBrowser().rpc('stock_take_review', { p_stock_take: id });
    if (e) return setError(friendlyError(e));
    const r = data as unknown as StockTakeReview;
    r.lines.sort((a, b) => a.item.localeCompare(b.item)); // stable order while counting
    setTake(r);
    setEntries((prev) => {
      const next = { ...prev };
      for (const l of r.lines) {
        next[l.item_id] ??= { counted: plainQty(l.counted), unit: l.unit, reason: l.reason ?? '', saving: false, error: '' };
      }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: e } = await supabaseBrowser()
      .from('stock_takes').select('id').eq('kitchen_id', kitchenId).eq('status', 'open').maybeSingle();
    if (e) setError(friendlyError(e));
    if (data) await review(data.id);
    else setTake(null);
    setLoading(false);
  }, [kitchenId, review]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data from Supabase on open
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (take?.lines ?? []).filter((l) => !s || l.item.toLowerCase().includes(s));
  }, [take, q]);

  const patch = (itemId: string, p: Partial<Entry>) => setEntries((es) => ({ ...es, [itemId]: { ...es[itemId]!, ...p } }));
  const patchLine = (itemId: string, p: Partial<StockTakeLine>) =>
    setTake((tk) => (tk ? { ...tk, lines: tk.lines.map((l) => (l.item_id === itemId ? { ...l, ...p } : l)) } : tk));

  const start = async () => {
    setBusy(true);
    setError('');
    const { data, error: e } = await supabaseBrowser().rpc('start_stock_take', { p_kitchen: kitchenId });
    if (e || !data) {
      setBusy(false);
      return setError(friendlyError(e));
    }
    await review(data);
    setBusy(false);
  };

  /** Saves one row when its count or reason changed. Returns false when the row has a problem. */
  const saveRow = async (line: StockTakeLine, entry: Entry | undefined): Promise<boolean> => {
    if (!take || !entry) return false;
    const qty = typedQty(entry, line);
    if (qty === undefined) return true; // not counted yet
    if (qty === null) {
      patch(line.item_id, { error: friendlyError({ message: 'qty_invalid_count' }) });
      return false;
    }
    const reason = entry.reason.trim();
    if (qty === (line.counted == null ? null : Number(line.counted)) && (!reason || reason === line.reason)) return true; // nothing new
    patch(line.item_id, { saving: true, error: '' });
    const { data, error: e } = await supabaseBrowser().rpc('set_stock_count', {
      p_stock_take: take.id, p_item: line.item_id, p_counted: parseEntryQty(entry.counted)!, p_unit: entry.unit, p_reason: reason || undefined,
    });
    if (e) {
      patch(line.item_id, { saving: false, error: friendlyError(e) });
      return false;
    }
    const r = data as unknown as CountResult;
    patch(line.item_id, { saving: false });
    patchLine(line.item_id, { expected: r.expected, counted: r.counted, variance: r.variance, needs_reason: r.needs_reason, reason: reason || line.reason });
    return true;
  };

  const close = async () => {
    if (!take) return;
    setError('');
    setBusy(true);
    // Save anything still being typed (the last field may not have lost focus yet).
    const results = await Promise.all(take.lines.map((l) => saveRow(l, entries[l.item_id])));
    if (results.some((ok) => !ok)) {
      setBusy(false);
      return setError('Fix the items marked in red first.');
    }
    const { data, error: e } = await supabaseBrowser().rpc('close_stock_take', { p_stock_take: take.id });
    setBusy(false);
    if (e) {
      setError(friendlyErrorIn('stock_take', e));
      if (e.message === 'reason_required' || e.message === 'stock_take_closed') await review(take.id);
      return;
    }
    const n = (data as { adjustments?: number } | null)?.adjustments ?? 0;
    setClosedMsg(`Stock-take closed. ${n} item${n === 1 ? '' : 's'} adjusted.`);
  };

  const cancel = async () => {
    if (!take || !window.confirm('Cancel this stock-take? Nothing counted so far will be saved.')) return;
    setBusy(true);
    const { error: e } = await supabaseBrowser().rpc('cancel_stock_take', { p_stock_take: take.id });
    setBusy(false);
    if (e) return setError(friendlyErrorIn('stock_take', e));
    setTake(null);
    setEntries({});
  };

  const header = (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onDone} className="rounded-lg px-2 py-2 text-sm font-medium text-brand-700">← Stock</button>
      <h1 className="text-lg font-semibold text-ink-900">Stock-take</h1>
    </div>
  );

  if (loading) return <div className="space-y-3">{header}<Muted>Loading…</Muted></div>;

  if (closedMsg) {
    return (
      <div className="space-y-3">
        {header}
        <Panel><p className="text-base font-semibold text-green-700" data-testid="count-closed">✓ {closedMsg}</p></Panel>
        <BigButton onClick={onDone}>Done</BigButton>
      </div>
    );
  }

  if (!take || take.status !== 'open') {
    return (
      <div className="space-y-3">
        {header}
        <Panel>
          <Muted>No stock-take is open. Start one to count what is in the kitchen.</Muted>
          <ErrorText>{error}</ErrorText>
          <BigButton onClick={start} disabled={busy} data-testid="count-start">{busy ? 'Starting…' : 'Start stock-take'}</BigButton>
        </Panel>
      </div>
    );
  }

  const counted = take.lines.filter((l) => l.counted != null).length;
  const missing = take.lines.filter((l) => l.needs_reason).length;

  return (
    <div className="space-y-3 pb-8">
      {header}
      <Panel>
        <p className="text-base font-semibold text-ink-900" data-testid="count-progress">{counted} of {take.lines.length} counted</p>
        <Muted>Started {formatIstShort(take.started_at)}</Muted>
        <Muted>Count each item and type what you have. Leave an item empty if you did not count it.</Muted>
      </Panel>
      <FieldInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items" data-testid="count-search" />

      {shown.map((line) => {
        const e = entries[line.item_id];
        if (!e) return null;
        const showReason = line.needs_reason || Boolean(line.reason);
        return (
          <Panel key={line.item_id} tone={line.needs_reason ? 'danger' : undefined}>
            <div className="flex items-center gap-2" data-testid={`count-row-${line.item}`}>
              <p className="min-w-0 flex-1 text-base font-semibold text-ink-900">{line.item}</p>
              {e.saving && <span className="text-xs text-ink-500">Saving…</span>}
              {line.needs_reason && !e.saving && <span className="text-xs font-bold text-red-700">Reason needed</span>}
            </div>
            <div className="flex items-center gap-2">
              <FieldInput
                value={e.counted}
                onChange={(ev) => patch(line.item_id, { counted: ev.target.value, error: '' })}
                onBlur={() => void saveRow(line, e)}
                onKeyDown={(ev) => { if (ev.key === 'Enter') void saveRow(line, e); }}
                inputMode="decimal"
                placeholder="Quantity"
                className="flex-1"
                data-testid={`count-${line.item}`}
              />
              <UnitChips itemUnit={line.unit} value={e.unit} onChange={(u) => { patch(line.item_id, { unit: u }); void saveRow(line, { ...e, unit: u }); }} />
            </div>
            {line.counted != null && line.variance != null && (
              <p className={`text-sm ${line.needs_reason ? 'text-red-700' : 'text-ink-500'}`} data-testid={`variance-${line.item}`}>
                Book {formatQty(line.expected, line.unit)} · {Math.abs(Number(line.variance)) < 0.0005 ? 'Matches the book' : `Difference ${formatSignedQty(line.variance, line.unit)}`}
              </p>
            )}
            {showReason && (
              <label className="block space-y-1">
                <span className="text-sm font-medium text-red-700">Why is it different? (required)</span>
                <FieldInput
                  value={e.reason}
                  onChange={(ev) => patch(line.item_id, { reason: ev.target.value })}
                  onBlur={() => void saveRow(line, e)}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') void saveRow(line, e); }}
                  placeholder="e.g. used extra for a party order"
                  maxLength={200}
                  data-testid={`reason-${line.item}`}
                />
              </label>
            )}
            <ErrorText>{e.error}</ErrorText>
          </Panel>
        );
      })}

      <Panel>
        <Muted>Closing sets the book stock to what you counted.</Muted>
        {missing > 0 && <p className="text-sm font-semibold text-red-700">Reason needed: {missing}</p>}
        <ErrorText>{error}</ErrorText>
        <BigButton onClick={close} disabled={busy} data-testid="count-close">{busy ? 'Saving…' : 'Close stock-take'}</BigButton>
        <button type="button" onClick={cancel} disabled={busy} className="block w-full py-2 text-center text-sm text-ink-500 underline">Cancel stock-take</button>
      </Panel>
    </div>
  );
}
