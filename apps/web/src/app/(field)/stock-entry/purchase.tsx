'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addDays, formatPaise, istDate, rupeesToPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { downscaleJpeg } from '@/lib/image';
import { convertQty, normalizePriceJumps, type PurchaseResult, type StockUnit } from '@/lib/inventory';
import { uuid } from '@/lib/rider-store';
import { BigButton, Chip, ErrorText, FieldInput, Muted, Panel } from '@/components/field-ui';
import { ItemPicker, parseEntryQty, toStockItems, UnitChips, type StockItem } from './stock-ui';

type Supplier = { id: string; name: string };
type Line = { key: string; item: StockItem; qty: string; unit: StockUnit; amount: string };
type Photo = { blob: Blob; url: string; path: string; uploaded: boolean };

/** Price per unit of the item for the hint under a line, or null while the line is incomplete. */
function unitPrice(line: Line): number | null {
  const qty = parseEntryQty(line.qty);
  const paise = rupeesToPaise(line.amount);
  if (!qty || paise == null) return null;
  const inItemUnit = convertQty(qty, line.unit, line.item.unit);
  return inItemUnit > 0 ? Math.round(paise / inItemUnit) : null;
}

// A supplier bill in under a minute: supplier, photo, items with quantity and amount, save.
export function PurchaseView({ kitchenId, isOwner, onDone }: { kitchenId: string; isOwner: boolean; onDone: () => void }) {
  const today = istDate();
  const [items, setItems] = useState<StockItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState<string | null>(null); // null: not adding
  const [billDate, setBillDate] = useState(today);
  const [billNo, setBillNo] = useState('');
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState(true);
  const [paidNow, setPaidNow] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<PurchaseResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadSuppliers = useCallback(async () => {
    const { data } = await supabaseBrowser().from('suppliers').select('id, name').eq('kitchen_id', kitchenId).eq('active', true).order('name');
    setSuppliers(data ?? []);
  }, [kitchenId]);

  const loadItems = useCallback(async () => {
    const { data, error: e } = await supabaseBrowser().rpc('stock_levels', { p_kitchen: kitchenId });
    if (e) setError(friendlyError(e));
    setItems(toStockItems(data).sort((a, b) => a.name.localeCompare(b.name)));
  }, [kitchenId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data from Supabase on open
    void loadSuppliers();
    void loadItems();
  }, [loadSuppliers, loadItems]);

  // Free the preview image when it is replaced or the screen closes.
  const photoUrl = photo?.url;
  useEffect(() => () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
  }, [photoUrl]);

  const available = useMemo(() => items.filter((i) => !lines.some((l) => l.item.item_id === i.item_id)), [items, lines]);
  const totalPaise = lines.reduce((sum, l) => sum + (rupeesToPaise(l.amount) ?? 0), 0);

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const addSupplier = async () => {
    setError('');
    if (!newSupplier?.trim()) return setError(friendlyError({ message: 'name_required' }));
    const { data, error: e } = await supabaseBrowser().rpc('upsert_supplier', { p_kitchen: kitchenId, p_name: newSupplier.trim() });
    if (e || !data) return setError(friendlyErrorIn('supplier', e));
    await loadSuppliers();
    setSupplierId(data);
    setNewSupplier(null);
  };

  const onPhoto = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    setError('');
    try {
      const blob = await downscaleJpeg(file, 1600, 0.75); // bills keep a little more detail
      setPhoto({ blob, url: URL.createObjectURL(blob), path: `${kitchenId}/${billDate}-${uuid()}.jpg`, uploaded: false });
    } catch {
      setError(friendlyError({ message: 'photo_failed' }));
    }
  };

  const save = async () => {
    setError('');
    if (lines.length === 0) return setError(friendlyError({ message: 'no_lines' }));
    const payload: { item_id: string; qty: number; unit: StockUnit; amount_paise: number }[] = [];
    for (const l of lines) {
      const qty = parseEntryQty(l.qty);
      if (!qty) return setError(`${l.item.name}: ${friendlyError({ message: 'invalid_qty' })}`);
      const amount = rupeesToPaise(l.amount);
      if (amount == null) return setError(`${l.item.name}: ${friendlyError({ message: 'invalid_bill_amount' })}`);
      payload.push({ item_id: l.item.item_id, qty, unit: l.unit, amount_paise: amount });
    }
    let paid = 0;
    if (isOwner && supplierId && paidNow.trim()) {
      const p = rupeesToPaise(paidNow);
      if (p == null) return setError(friendlyError({ message: 'invalid_amount' }));
      paid = p;
    }
    setBusy(true);
    const s = supabaseBrowser();
    if (photo && !photo.uploaded) {
      setStatus('Uploading photo…');
      const { error: up } = await s.storage.from('bills').upload(photo.path, photo.blob, { contentType: 'image/jpeg' });
      setStatus('');
      // A retry after a lost response finds the photo already there: that is fine.
      if (up && !/exist|duplicate/i.test(up.message)) {
        setBusy(false);
        return setError(`${friendlyError({ message: 'invalid_photo' })} (${friendlyError(up)})`);
      }
      setPhoto({ ...photo, uploaded: true });
    }
    const { data, error: e } = await s.rpc('record_purchase', {
      p_kitchen: kitchenId,
      p_lines: payload,
      p_supplier: supplierId ?? undefined,
      p_bill_date: billDate,
      p_bill_no: billNo.trim() || undefined,
      p_photo_path: photo?.path,
      p_paid_now_paise: paid,
    });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    const r = data as unknown as PurchaseResult;
    setResult({ ...r, price_jumps: normalizePriceJumps(r.price_jumps) });
  };

  const reset = () => {
    setResult(null);
    setLines([]);
    setPicking(true);
    setPhoto(null);
    setBillNo('');
    setPaidNow('');
    setError('');
  };

  const header = (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onDone} className="rounded-lg px-2 py-2 text-sm font-medium text-brand-700">← Stock</button>
      <h1 className="text-lg font-semibold text-ink-900">Purchase</h1>
    </div>
  );

  if (result) {
    const unitOf = (name: string) => items.find((i) => i.name === name)?.unit ?? '';
    return (
      <div className="space-y-3">
        {header}
        <Panel><p className="text-lg font-semibold text-green-700" data-testid="purchase-saved">✓ Purchase saved: {formatPaise(result.total_paise)}</p></Panel>
        {result.price_jumps.length > 0 && (
          <Panel tone="warn">
            <p className="text-base font-semibold text-ink-900">⚠️ Price went up</p>
            {result.price_jumps.map((j) => (
              <p key={j.item} className="text-sm text-ink-700" data-testid="price-jump">
                {isOwner && j.from_paise != null && j.to_paise != null
                  ? `${j.item}: ${formatPaise(j.from_paise)} → ${formatPaise(j.to_paise)} per ${unitOf(j.item)} (+${Math.round(j.pct)}%)`
                  : `${j.item}: price up ${Math.round(j.pct)}%`}
              </p>
            ))}
          </Panel>
        )}
        <BigButton onClick={onDone}>Done</BigButton>
        <BigButton variant="secondary" onClick={reset}>Add another bill</BigButton>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-8">
      {header}
      <Panel>
        <p className="text-sm font-medium text-ink-700">Supplier</p>
        <div className="flex flex-wrap gap-2">
          <Chip label="No supplier" selected={supplierId === null} onClick={() => setSupplierId(null)} />
          {suppliers.map((s) => <Chip key={s.id} label={s.name} selected={supplierId === s.id} onClick={() => setSupplierId(s.id)} />)}
          {newSupplier === null && <Chip label="+ New" selected={false} onClick={() => setNewSupplier('')} />}
        </div>
        {newSupplier !== null && (
          <div className="flex items-center gap-2">
            <FieldInput value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} placeholder="Supplier name" autoFocus className="flex-1" />
            <button type="button" onClick={addSupplier} className="shrink-0 rounded-xl bg-white px-3 py-3 text-sm font-semibold text-ink-800 ring-1 ring-ink-200">Add</button>
          </div>
        )}
        <p className="text-sm font-medium text-ink-700">Bill date</p>
        <div className="flex flex-wrap gap-2">
          <Chip label="Today" selected={billDate === today} onClick={() => setBillDate(today)} />
          <Chip label="Yesterday" selected={billDate === addDays(today, -1)} onClick={() => setBillDate(addDays(today, -1))} />
        </div>
        <FieldInput value={billNo} onChange={(e) => setBillNo(e.target.value)} placeholder="Bill number (optional)" data-testid="bill-no" />
      </Panel>

      <Panel>
        <p className="text-sm font-medium text-ink-700">Bill photo</p>
        <input ref={fileInput} type="file" accept="image/*" capture="environment" className="hidden" data-testid="bill-photo-input"
          onChange={(e) => void onPhoto(e.target.files?.[0])} />
        {photo ? (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
            <img src={photo.url} alt="Bill" className="h-32 w-24 rounded-xl bg-ink-100 object-cover" />
            <div className="flex-1 space-y-2">
              <BigButton variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy}>Retake</BigButton>
              <BigButton variant="secondary" onClick={() => setPhoto(null)} disabled={busy}>Remove</BigButton>
            </div>
          </div>
        ) : (
          <BigButton variant="secondary" onClick={() => fileInput.current?.click()}>📷 Take bill photo</BigButton>
        )}
      </Panel>

      <Panel>
        <p className="text-sm font-medium text-ink-700">Items</p>
        {lines.map((l) => {
          const price = unitPrice(l);
          return (
            <div key={l.key} className="space-y-2 border-b border-ink-100 pb-3" data-testid={`line-${l.item.name}`}>
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-base font-semibold text-ink-900">{l.item.name}</p>
                <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="text-sm text-red-700">Remove</button>
              </div>
              <div className="flex items-center gap-2">
                <FieldInput value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value })} inputMode="decimal" placeholder="Quantity" className="flex-1" data-testid={`qty-${l.item.name}`} />
                <UnitChips itemUnit={l.item.unit} value={l.unit} onChange={(u) => update(l.key, { unit: u })} />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-4 text-center text-lg font-semibold text-ink-600">₹</span>
                <FieldInput value={l.amount} onChange={(e) => update(l.key, { amount: e.target.value })} inputMode="decimal" placeholder="Amount" className="flex-1" data-testid={`amount-${l.item.name}`} />
              </div>
              {price != null && <Muted>{formatPaise(price)} per {l.item.unit}</Muted>}
            </div>
          );
        })}
        {picking ? (
          <ItemPicker
            items={available}
            limit={6}
            onPick={(item) => {
              setLines((ls) => [...ls, { key: uuid(), item, qty: '', unit: item.unit, amount: '' }]);
              setPicking(false);
            }}
          />
        ) : (
          <BigButton variant="secondary" onClick={() => setPicking(true)}>+ Add item</BigButton>
        )}
      </Panel>

      <Panel>
        <p className="text-lg font-bold text-ink-900" data-testid="purchase-total">Total {formatPaise(totalPaise)}</p>
        {isOwner && supplierId && (
          <label className="block space-y-1">
            <span className="text-sm font-medium text-ink-700">Paid now (₹, optional)</span>
            <FieldInput value={paidNow} onChange={(e) => setPaidNow(e.target.value)} inputMode="decimal" placeholder="0" />
            <span className="block text-xs text-ink-500">Leave empty if the supplier gives credit.</span>
          </label>
        )}
        {status && <Muted>{status}</Muted>}
        <ErrorText>{error}</ErrorText>
        <BigButton onClick={save} disabled={busy || lines.length === 0} data-testid="purchase-save">{busy ? 'Saving…' : 'Save purchase'}</BigButton>
      </Panel>
    </div>
  );
}
