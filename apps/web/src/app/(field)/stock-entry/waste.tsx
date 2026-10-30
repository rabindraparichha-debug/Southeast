'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { formatQty, type StockUnit } from '@/lib/inventory';
import { BigButton, Chip, ErrorText, FieldInput, Muted, Panel } from '@/components/field-ui';
import { ItemPicker, parseEntryQty, toStockItems, UnitChips, type StockItem } from './stock-ui';

// Stored as plain English words so reports read the same whatever language the app is in (as on mobile).
const REASONS = [
  { key: 'spoiled', value: 'Spoiled' },
  { key: 'burnt', value: 'Burnt' },
  { key: 'spilled', value: 'Spilled' },
  { key: 'leftover', value: 'Leftover' },
  { key: 'other', value: 'Other' },
] as const;
type ReasonKey = (typeof REASONS)[number]['key'];

export function WasteView({ kitchenId, initialItem, onDone }: { kitchenId: string; initialItem?: string; onDone: () => void }) {
  const [items, setItems] = useState<StockItem[]>([]);
  const [item, setItem] = useState<StockItem | null>(null);
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<StockUnit>('kg');
  const [reason, setReason] = useState<ReasonKey | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(async (keep?: string) => {
    const { data, error: e } = await supabaseBrowser().rpc('stock_levels', { p_kitchen: kitchenId });
    if (e) return setError(friendlyError(e));
    const list = toStockItems(data).sort((a, b) => a.name.localeCompare(b.name));
    setItems(list);
    const want = keep ?? initialItem;
    const found = want ? list.find((i) => i.item_id === want) : undefined;
    if (found) {
      setItem(found);
      if (!keep) setUnit(found.unit);
    }
  }, [kitchenId, initialItem]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data from Supabase on open
    void load();
  }, [load]);

  const pick = (i: StockItem) => {
    setItem(i);
    setUnit(i.unit);
    setSaved('');
    setError('');
  };

  const save = async () => {
    setError('');
    setSaved('');
    if (!item) return setError(friendlyError({ message: 'pick_item' }));
    const n = parseEntryQty(qty);
    if (!n) return setError(friendlyError({ message: 'invalid_qty' }));
    if (!reason) return setError(friendlyError({ message: 'reason_required' }));
    if (reason === 'other' && !other.trim()) return setError(friendlyError({ message: 'note_required' }));
    const text = reason === 'other' ? other.trim() : REASONS.find((r) => r.key === reason)!.value;
    setBusy(true);
    const { error: e } = await supabaseBrowser().rpc('record_waste', { p_item: item.item_id, p_qty: n, p_reason: text, p_unit: unit });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    setSaved(`Saved: ${formatQty(n, unit)} ${item.name} (${text})`);
    setQty('');
    setReason(null);
    setOther('');
    void load(item.item_id); // fresh stock figure
  };

  return (
    <div className="space-y-3 pb-8">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onDone} className="rounded-lg px-2 py-2 text-sm font-medium text-brand-700">← Stock</button>
        <h1 className="text-lg font-semibold text-ink-900">Record waste</h1>
      </div>

      {saved && (
        <Panel>
          <p className="text-base font-semibold text-green-700" data-testid="waste-saved">✓ {saved}</p>
          <div className="grid grid-cols-2 gap-2">
            <BigButton onClick={onDone}>Done</BigButton>
            <BigButton variant="secondary" onClick={() => { setSaved(''); setItem(null); }}>Record more</BigButton>
          </div>
        </Panel>
      )}

      <Panel>
        <p className="text-sm font-medium text-ink-700">Choose item</p>
        {item ? (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-lg font-semibold text-ink-900" data-testid="waste-item">{item.name}</p>
              <Muted>In stock: {formatQty(item.stock, item.unit)}</Muted>
            </div>
            <button type="button" onClick={() => setItem(null)} className="px-2 py-2 text-base font-medium text-brand-700">Change</button>
          </div>
        ) : (
          <ItemPicker items={items} onPick={pick} />
        )}
      </Panel>

      {item && (
        <Panel>
          <p className="text-sm font-medium text-ink-700">Quantity</p>
          <div className="flex items-center gap-2">
            <FieldInput value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder="0" className="flex-1" data-testid="waste-qty" />
            <UnitChips itemUnit={item.unit} value={unit} onChange={setUnit} />
          </div>
          <p className="text-sm font-medium text-ink-700">Reason</p>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => <Chip key={r.key} label={r.value} selected={reason === r.key} onClick={() => setReason(r.key)} testId={`waste-reason-${r.key}`} />)}
          </div>
          {reason === 'other' && (
            <FieldInput value={other} onChange={(e) => setOther(e.target.value)} placeholder="What happened?" maxLength={200} data-testid="waste-other" />
          )}
          <ErrorText>{error}</ErrorText>
          <BigButton onClick={save} disabled={busy} data-testid="waste-save">{busy ? 'Saving…' : 'Save waste'}</BigButton>
        </Panel>
      )}
      {!item && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
