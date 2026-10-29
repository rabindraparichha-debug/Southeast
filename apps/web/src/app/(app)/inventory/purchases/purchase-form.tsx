'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatPaise, rupeesToPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { UNIT_LABEL, normalizePriceJumps, parseQty, unitsFor, type PurchaseResult, type StockUnit } from '@/lib/inventory';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';

type Item = { id: string; name: string; unit: StockUnit };
type Supplier = { id: string; name: string };
type Line = { key: number; item_id: string; qty: string; unit: StockUnit | ''; amount: string };

const NEW = '__new';
let nextKey = 1;
const blankLine = (): Line => ({ key: nextKey++, item_id: '', qty: '', unit: '', amount: '' });

export function PurchaseForm({ kitchenId, isOwner, today, items, suppliers }: {
  kitchenId: string; isOwner: boolean; today: string; items: Item[]; suppliers: Supplier[];
}) {
  const router = useRouter();
  const [supplier, setSupplier] = useState('');
  const [newSupplier, setNewSupplier] = useState({ name: '', phone: '' });
  const [date, setDate] = useState(today);
  const [billNo, setBillNo] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoKey, setPhotoKey] = useState(0);
  const [lines, setLines] = useState<Line[]>(() => [blankLine(), blankLine()]);
  const [paidNow, setPaidNow] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PurchaseResult | null>(null);

  const byId = new Map(items.map((i) => [i.id, i]));
  const filled = lines.filter((l) => l.item_id || l.qty || l.amount);
  const total = filled.reduce((t, l) => t + (rupeesToPaise(l.amount) ?? 0), 0);
  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    setResult(null);
    if (filled.length === 0) return setError(friendlyError({ message: 'no_lines' }));
    const payload: { item_id: string; qty: number; unit: StockUnit; amount_paise: number }[] = [];
    for (const [i, l] of filled.entries()) {
      const item = byId.get(l.item_id);
      const qty = parseQty(l.qty);
      const amount = rupeesToPaise(l.amount);
      if (!item) return setError(`Line ${i + 1}: choose an item.`);
      if (qty === null) return setError(`Line ${i + 1}: enter the quantity.`);
      if (amount === null) return setError(`Line ${i + 1}: enter the amount in rupees.`);
      payload.push({ item_id: item.id, qty, unit: (l.unit || item.unit) as StockUnit, amount_paise: amount });
    }
    const paid = isOwner && paidNow.trim() ? rupeesToPaise(paidNow) : 0;
    if (paid === null) return setError('Enter the amount paid in rupees.');
    if (paid > 0 && !supplier) return setError(friendlyError({ message: 'supplier_required' }));
    if (supplier === NEW && !newSupplier.name.trim()) return setError('Enter the new supplier’s name.');

    setBusy(true);
    const s = supabaseBrowser();
    let supplierId = supplier || undefined;
    if (supplier === NEW) {
      const { data, error } = await s.rpc('upsert_supplier', { p_kitchen: kitchenId, p_name: newSupplier.name.trim(), p_phone: newSupplier.phone.trim() || undefined });
      if (error || !data) {
        setBusy(false);
        return setError(friendlyErrorIn('supplier', error));
      }
      supplierId = data;
      setSupplier(data); // a retry must not create the supplier twice
    }
    let path: string | undefined;
    if (photo) {
      const ext = photo.name.split('.').pop()?.toLowerCase() || 'jpg';
      path = `${kitchenId}/${crypto.randomUUID()}.${ext}`;
      const { error } = await s.storage.from('bills').upload(path, photo, { contentType: photo.type });
      if (error) {
        setBusy(false);
        return setError(`Photo upload failed: ${error.message}`);
      }
    }
    const { data, error } = await s.rpc('record_purchase', {
      p_kitchen: kitchenId, p_lines: payload, p_supplier: supplierId, p_bill_date: date, p_bill_no: billNo.trim() || undefined,
      p_photo_path: path, p_paid_now_paise: paid || undefined, p_notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (error) {
      if (path) await s.storage.from('bills').remove([path]);
      return setError(friendlyError(error));
    }
    const r = data as unknown as PurchaseResult;
    setResult({ ...r, price_jumps: normalizePriceJumps(r.price_jumps) });
    setLines([blankLine(), blankLine()]);
    setBillNo('');
    setPaidNow('');
    setNotes('');
    setPhoto(null);
    setPhotoKey((k) => k + 1);
    setNewSupplier({ name: '', phone: '' });
    router.refresh();
  }

  return (
    <Card title="New purchase">
      <form onSubmit={save} className="space-y-4" aria-label="New purchase">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Supplier" className="col-span-2 sm:col-span-1">
            <Select value={supplier} onChange={(e) => setSupplier(e.target.value)} aria-label="Supplier">
              <option value="">No supplier / market</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value={NEW}>+ Add a supplier…</option>
            </Select>
          </Field>
          <Field label="Bill date" className="col-span-2 sm:col-span-1">
            <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        {supplier === NEW && (
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-ink-50 p-3">
            <Field label="Supplier name"><Input value={newSupplier.name} onChange={(e) => setNewSupplier({ ...newSupplier, name: e.target.value })} maxLength={80} /></Field>
            <Field label="Phone (optional)"><Input value={newSupplier.phone} onChange={(e) => setNewSupplier({ ...newSupplier, phone: e.target.value })} inputMode="tel" maxLength={20} /></Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bill no (optional)"><Input value={billNo} onChange={(e) => setBillNo(e.target.value)} maxLength={40} /></Field>
          <Field label="Bill photo (optional)" hint="Photo or PDF, up to 5 MB.">
            <input key={photoKey} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} className="block w-full text-sm" aria-label="Bill photo" />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-700">Items</legend>
          <div className="space-y-2">
            {lines.map((l, i) => {
              const item = byId.get(l.item_id);
              return (
                <div key={l.key} className="grid grid-cols-12 gap-1.5 rounded-lg p-2 ring-1 ring-ink-100" data-testid="purchase-line">
                  <Select value={l.item_id} onChange={(e) => setLine(l.key, { item_id: e.target.value, unit: byId.get(e.target.value)?.unit ?? '' })}
                    className="col-span-12" aria-label={`Item ${i + 1}`}>
                    <option value="">Choose item…</option>
                    {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                  </Select>
                  <Input value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} inputMode="decimal" placeholder="Qty"
                    className="col-span-3" aria-label={`Quantity ${i + 1}`} />
                  <Select value={l.unit || item?.unit || ''} onChange={(e) => setLine(l.key, { unit: e.target.value as StockUnit })}
                    className="col-span-4" aria-label={`Unit ${i + 1}`} disabled={!item}>
                    {item ? unitsFor(item.unit).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>) : <option value="">unit</option>}
                  </Select>
                  <Input value={l.amount} onChange={(e) => setLine(l.key, { amount: e.target.value })} inputMode="decimal" placeholder="₹ amount"
                    className="col-span-4" aria-label={`Amount ${i + 1}`} />
                  <button type="button" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine()]))}
                    className="col-span-1 text-ink-400 hover:text-red-700" aria-label={`Remove line ${i + 1}`}>✕</button>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-between">
            <Button type="button" variant="ghost" onClick={() => setLines((ls) => [...ls, blankLine()])}>+ Add line</Button>
            <span className="text-sm">Total <strong data-testid="running-total">{formatPaise(total)}</strong></span>
          </div>
        </fieldset>

        {isOwner && (
          <Field label="Paid now (₹)" hint={supplier ? 'Leave empty if the bill is on credit; the rest becomes a supplier due.' : 'Choose a supplier to track what you paid and what is due.'}>
            <div className="flex gap-2">
              <Input value={paidNow} onChange={(e) => setPaidNow(e.target.value)} inputMode="decimal" disabled={!supplier} placeholder="0" aria-label="Paid now" />
              <Button type="button" variant="secondary" disabled={!supplier || total === 0} onClick={() => setPaidNow(String(total / 100))}>Full</Button>
            </div>
          </Field>
        )}
        <Field label="Notes (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} /></Field>

        {error && <Alert>{error}</Alert>}
        {result && (
          <div className="space-y-2" data-testid="purchase-result">
            <Alert tone="green">Bill saved: {formatPaise(result.total_paise)}. Stock updated.</Alert>
            {result.price_jumps.length > 0 && (
              <Alert tone="amber">
                <strong>Price jump:</strong>
                <ul className="mt-1 list-inside list-disc">
                  {result.price_jumps.map((j) => (
                    <li key={j.item}>
                      {j.item}: up {Number(j.pct).toFixed(0)}%
                      {j.from_paise != null && j.to_paise != null && ` (${formatPaise(j.from_paise)} → ${formatPaise(j.to_paise)} per unit)`}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
          </div>
        )}
        <Button disabled={busy} className="w-full">{busy ? 'Saving…' : `Save bill${total ? ` · ${formatPaise(total)}` : ''}`}</Button>
      </form>
    </Card>
  );
}
