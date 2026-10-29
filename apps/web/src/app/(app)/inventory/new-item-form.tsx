'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { rupeesToPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import { CATEGORIES, CATEGORY_LABEL, UNITS, UNIT_LABEL, parseQty, type ItemCategory, type StockUnit } from '@/lib/inventory';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';

const empty = { name: '', unit: 'kg' as StockUnit, category: 'other' as ItemCategory, min: '', opening: '', price: '' };

export function NewItemForm({ kitchenId }: { kitchenId: string }) {
  const router = useRouter();
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const min = f.min.trim() ? parseQty(f.min, { allowZero: true }) : 0;
    const opening = f.opening.trim() ? parseQty(f.opening, { allowZero: true }) : 0;
    const price = f.price.trim() ? rupeesToPaise(f.price) : null;
    if (!f.name.trim()) return setMsg({ tone: 'red', text: 'Name is required.' });
    if (min === null || opening === null) return setMsg({ tone: 'red', text: 'Enter valid quantities.' });
    if (f.price.trim() && price === null) return setMsg({ tone: 'red', text: 'Enter the price in rupees, like 42 or 42.50.' });
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('create_item', {
      p_kitchen: kitchenId, p_name: f.name.trim(), p_unit: f.unit, p_category: f.category,
      p_min_qty: min, p_opening_qty: opening, p_opening_price_paise: price ?? undefined,
    });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyErrorIn('item', error) });
    setMsg({ tone: 'green', text: `${f.name.trim()} added.` });
    setF(empty);
    router.refresh();
  }

  return (
    <Card title="New item">
      <form onSubmit={save} className="space-y-3" aria-label="New item">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} placeholder="e.g. Besan" required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit" hint="All stock of this item is kept in this unit.">
            <Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value as StockUnit })} aria-label="Unit">
              {UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
            </Select>
          </Field>
          <Field label="Category">
            <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as ItemCategory })} aria-label="Category">
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </Select>
          </Field>
        </div>
        <Field label={`Minimum stock (${f.unit})`} hint="Below this you get a low-stock alert. Leave empty for none.">
          <Input value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} inputMode="decimal" placeholder="0" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Opening stock (${f.unit})`}><Input value={f.opening} onChange={(e) => setF({ ...f, opening: e.target.value })} inputMode="decimal" placeholder="0" /></Field>
          <Field label={`Price per ${UNIT_LABEL[f.unit]} (₹)`}><Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" placeholder="optional" /></Field>
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Button disabled={busy} className="w-full">{busy ? 'Saving…' : 'Add item'}</Button>
      </form>
    </Card>
  );
}
