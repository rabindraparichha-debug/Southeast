'use client';

import { useMemo, useState } from 'react';
import type { Database } from '@tiffin/db';
import { formatQty, unitsFor, type StockUnit } from '@/lib/inventory';
import { Chip, FieldInput } from '@/components/field-ui';

/** One row of stock_levels as the phone screens use it (no money: values stay on /inventory for owners). */
export type StockItem = { item_id: string; name: string; unit: StockUnit; stock: number; min_qty: number; low: boolean; active: boolean };

export function toStockItems(rows: Database['public']['Functions']['stock_levels']['Returns'] | null): StockItem[] {
  return (rows ?? [])
    .filter((r) => r.active)
    .map((r) => ({ item_id: r.item_id, name: r.name, unit: r.unit, stock: Number(r.stock), min_qty: Number(r.min_qty), low: r.low, active: r.active }));
}

/** "1.5", "0,5", "500" -> number; null when empty or not a non-negative number with at most 3 decimals. */
export function parseEntryQty(input: string): number | null {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$|^\.\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Search-as-you-type item list. Shows at most `limit` matches. */
export function ItemPicker({ items, onPick, limit = 8 }: { items: StockItem[]; onPick: (item: StockItem) => void; limit?: number }) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => !s || i.name.toLowerCase().includes(s)).slice(0, limit);
  }, [items, q, limit]);
  return (
    <div className="space-y-1.5">
      <FieldInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items" data-testid="item-search" />
      {matches.length === 0 && <p className="p-2 text-sm text-ink-500">No items match.</p>}
      {matches.map((i) => (
        <button key={i.item_id} type="button" onClick={() => onPick(i)} data-testid={`pick-${i.name}`}
          className="flex w-full items-center gap-2 rounded-xl bg-white px-3 py-3 text-left ring-1 ring-ink-200 active:bg-ink-50">
          <span className="min-w-0 flex-1 text-base text-ink-900">{i.name}</span>
          {i.low && <LowBadge />}
          <span className={`shrink-0 text-sm ${i.low ? 'text-red-700' : 'text-ink-500'}`}>{formatQty(i.stock, i.unit)}</span>
        </button>
      ))}
    </div>
  );
}

/** kg/g, l/ml chips (nothing to choose for pieces). */
export function UnitChips({ itemUnit, value, onChange }: { itemUnit: StockUnit; value: StockUnit; onChange: (u: StockUnit) => void }) {
  const units = unitsFor(itemUnit);
  if (units.length < 2) return <span className="shrink-0 px-2 text-base text-ink-600">{itemUnit}</span>;
  return (
    <div className="flex shrink-0 gap-1.5">
      {units.map((u) => <Chip key={u} label={u} selected={value === u} onClick={() => onChange(u)} testId={`unit-${u}`} />)}
    </div>
  );
}

export function LowBadge() {
  return <span className="shrink-0 rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">Low</span>;
}
