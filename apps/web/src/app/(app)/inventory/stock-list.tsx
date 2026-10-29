'use client';

import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import {
  CATEGORIES, CATEGORY_LABEL, UNIT_LABEL, formatQty, parseQty, unitsFor, type ItemCategory, type StockUnit,
} from '@/lib/inventory';
import { Alert, Badge, Button, Card, Input, Select } from '@/components/ui';

export type StockRow = {
  item_id: string;
  name: string;
  unit: StockUnit;
  category: ItemCategory;
  stock: number;
  min_qty: number;
  low: boolean;
  active: boolean;
  value_paise: number | null;
  unit_cost_paise: number | null;
};

type Action = { id: string; kind: 'edit' | 'waste' | 'adjust' } | null;

export function StockList({ rows, isOwner }: { rows: StockRow[]; isOwner: boolean }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'' | ItemCategory>('');
  const [showInactive, setShowInactive] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [done, setDone] = useState('');

  // Low stock first (the RPC already sorts active, low, name); search + category filter here.
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => (showInactive || r.active) && (!cat || r.category === cat) && (!needle || r.name.toLowerCase().includes(needle)));
  }, [rows, q, cat, showInactive]);
  const usedCats = CATEGORIES.filter((c) => rows.some((r) => r.category === c));
  const cols = isOwner ? 6 : 5;

  return (
    <Card title="Stock" className="overflow-x-auto">
      <div className="mb-3 flex flex-wrap gap-2 print:hidden">
        <Input type="search" placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs flex-1" aria-label="Search items" />
        <Select value={cat} onChange={(e) => setCat(e.target.value as '' | ItemCategory)} className="w-auto!" aria-label="Category filter">
          <option value="">All categories</option>
          {usedCats.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm text-ink-600">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      {done && <div className="mb-3"><Alert tone="green">{done}</Alert></div>}
      <table className="min-w-full text-sm" data-testid="stock-table">
        <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
          <tr>
            <th className="py-2 pr-3">Item</th>
            <th className="py-2 pr-3">Category</th>
            <th className="py-2 pr-3 text-right">In stock</th>
            <th className="py-2 pr-3 text-right">Minimum</th>
            {isOwner && <th className="py-2 pr-3 text-right">Value</th>}
            <th className="py-2 print:hidden" />
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {shown.map((r) => (
            <Fragment key={r.item_id}>
              <tr className={r.low && r.active ? 'bg-red-50/60' : !r.active ? 'text-ink-400' : ''} data-item={r.name}>
                <td className="py-2 pr-3 font-medium">
                  {r.name} {r.low && r.active && <Badge tone="red">Low</Badge>} {!r.active && <Badge>Inactive</Badge>}
                </td>
                <td className="py-2 pr-3 text-ink-600">{CATEGORY_LABEL[r.category]}</td>
                <td className={`py-2 pr-3 text-right tabular-nums whitespace-nowrap ${r.stock < 0 ? 'text-red-700' : ''}`}>{formatQty(r.stock, r.unit)}</td>
                <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap text-ink-600">{r.min_qty > 0 ? formatQty(r.min_qty, r.unit) : '—'}</td>
                {isOwner && (
                  <td className="py-2 pr-3 text-right tabular-nums" title={r.unit_cost_paise ? `${formatPaise(r.unit_cost_paise)} per ${r.unit}` : undefined}>
                    {formatPaise(r.value_paise ?? 0)}
                  </td>
                )}
                <td className="py-2 text-right whitespace-nowrap print:hidden">
                  <RowButton label="Edit" on={action?.id === r.item_id && action.kind === 'edit'} onClick={() => setAction(toggle(action, r.item_id, 'edit'))} />
                  <RowButton label="Waste" on={action?.id === r.item_id && action.kind === 'waste'} onClick={() => setAction(toggle(action, r.item_id, 'waste'))} />
                  {isOwner && <RowButton label="Adjust" on={action?.id === r.item_id && action.kind === 'adjust'} onClick={() => setAction(toggle(action, r.item_id, 'adjust'))} />}
                </td>
              </tr>
              {action?.id === r.item_id && (
                <tr className="bg-ink-50 print:hidden">
                  <td colSpan={cols} className="p-3">
                    {action.kind === 'edit' && <EditItem row={r} onDone={(m) => { setAction(null); setDone(m); }} />}
                    {action.kind === 'waste' && <StockMoveForm kind="waste" row={r} onDone={(m) => { setAction(null); setDone(m); }} />}
                    {action.kind === 'adjust' && <StockMoveForm kind="adjust" row={r} onDone={(m) => { setAction(null); setDone(m); }} />}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {shown.length === 0 && (
            <tr><td colSpan={cols} className="py-6 text-center text-ink-500">{rows.length ? 'No items match.' : 'No items yet. Add your first item on the right.'}</td></tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

function toggle(current: Action, id: string, kind: 'edit' | 'waste' | 'adjust'): Action {
  return current?.id === id && current.kind === kind ? null : { id, kind };
}

function RowButton({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`ml-1 rounded-md px-2 py-1 text-xs font-medium ring-1 ${on ? 'bg-ink-800 text-white ring-ink-800' : 'bg-white text-ink-700 ring-ink-200 hover:bg-ink-50'}`}>
      {label}
    </button>
  );
}

function EditItem({ row, onDone }: { row: StockRow; onDone: (msg: string) => void }) {
  const router = useRouter();
  const [name, setName] = useState(row.name);
  const [category, setCategory] = useState(row.category);
  const [min, setMin] = useState(String(row.min_qty));
  const [active, setActive] = useState(row.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    const minQty = min.trim() ? parseQty(min, { allowZero: true }) : 0;
    if (minQty === null) return setError('Enter a valid minimum.');
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('update_item', {
      p_item: row.item_id, p_name: name.trim(), p_category: category, p_min_qty: minQty, p_active: active,
    });
    setBusy(false);
    if (error) return setError(friendlyErrorIn('item', error));
    onDone(`${name.trim()} saved.`);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-3" aria-label={`Edit ${row.name}`}>
      <label className="text-xs text-ink-600">Name<Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="mt-1 w-44!" /></label>
      <label className="text-xs text-ink-600">Category
        <Select value={category} onChange={(e) => setCategory(e.target.value as ItemCategory)} className="mt-1 w-36!">
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </Select>
      </label>
      <label className="text-xs text-ink-600">Minimum ({row.unit})<Input value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" className="mt-1 w-24!" /></label>
      <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
      <Button disabled={busy}>Save</Button>
      {error && <span className="w-full text-sm text-red-700">{error}</span>}
    </form>
  );
}

/** Waste (owner + staff, reason required) or an owner adjustment (+/−, reason required). */
function StockMoveForm({ kind, row, onDone }: { kind: 'waste' | 'adjust'; row: StockRow; onDone: (msg: string) => void }) {
  const router = useRouter();
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<StockUnit>(row.unit);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    const n = parseQty(qty, { allowNegative: kind === 'adjust' });
    if (n === null) return setError(kind === 'adjust' ? 'Enter a quantity like 2 or −1.5.' : 'Enter the quantity wasted.');
    if (!reason.trim()) return setError(friendlyError({ message: 'reason_required' }));
    setBusy(true);
    const s = supabaseBrowser();
    const { error } = kind === 'waste'
      ? await s.rpc('record_waste', { p_item: row.item_id, p_qty: n, p_reason: reason.trim(), p_unit: unit })
      : await s.rpc('adjust_stock', { p_item: row.item_id, p_qty: n, p_reason: reason.trim(), p_unit: unit });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onDone(kind === 'waste' ? `Waste of ${qty} ${unit} ${row.name} recorded.` : `${row.name} adjusted by ${qty} ${unit}.`);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-3" aria-label={kind === 'waste' ? `Waste ${row.name}` : `Adjust ${row.name}`}>
      <label className="text-xs text-ink-600">{kind === 'waste' ? 'Quantity wasted' : 'Change (+ add, − remove)'}
        <div className="mt-1 flex gap-1">
          <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className="w-24!" placeholder={kind === 'adjust' ? '-1' : '0.5'} aria-label="Quantity" />
          <Select value={unit} onChange={(e) => setUnit(e.target.value as StockUnit)} className="w-24!" aria-label="Unit">
            {unitsFor(row.unit).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
          </Select>
        </div>
      </label>
      <label className="min-w-48 flex-1 text-xs text-ink-600">Reason (required)
        <Input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1" placeholder={kind === 'waste' ? 'e.g. Spoiled, burnt, spilled' : 'e.g. Found extra bag'} aria-label="Reason" />
      </label>
      <Button disabled={busy} variant={kind === 'waste' ? 'danger' : 'primary'}>{kind === 'waste' ? 'Record waste' : 'Adjust stock'}</Button>
      {error && <span className="w-full text-sm text-red-700">{error}</span>}
    </form>
  );
}
