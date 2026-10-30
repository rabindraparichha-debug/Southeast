'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { rupeesToPaise } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';

type Festival = { id: string; name: string; starts_on: string; ends_on: string };

export function SpecialForm({ kitchenId, today, festivals }: { kitchenId: string; today: string; festivals: Festival[] }) {
  const router = useRouter();
  const blank = { date: festivals[0]?.starts_on && festivals[0].starts_on >= today ? festivals[0].starts_on : today, slot: 'lunch' as MealSlot, name: '', price: '', description: '', notify: true };
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const price = f.price.trim() ? rupeesToPaise(f.price) : null;
    if (f.price.trim() && price === null) return setMsg({ tone: 'red', text: friendlyError({ message: 'invalid_amount' }) });
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('create_festival_special', {
      p_kitchen: kitchenId, p_date: f.date, p_slot: f.slot, p_name: f.name.trim(),
      ...(price !== null ? { p_addon_price_paise: price } : {}),
      ...(f.description.trim() ? { p_description: f.description.trim() } : {}),
      p_notify: f.notify,
    });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyErrorIn('special', error) });
    const n = (data as { notified?: number } | null)?.notified ?? 0;
    setMsg({ tone: 'green', text: f.notify ? `Saved. ${n} customer${n === 1 ? '' : 's'} will be told on WhatsApp.` : 'Saved.' });
    setF({ ...blank, date: f.date, slot: f.slot });
    router.refresh();
  }

  return (
    <Card title="Add a special">
      <form onSubmit={save} className="space-y-4" data-testid="special-form">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <Input type="date" min={today} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required />
          </Field>
          <Field label="Meal">
            <Select value={f.slot} onChange={(e) => setF({ ...f, slot: e.target.value as MealSlot })}>
              <option value="lunch">Lunch</option>
              <option value="dinner">Dinner</option>
            </Select>
          </Field>
        </div>
        {festivals.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {festivals.filter((x) => x.ends_on >= today).slice(0, 4).map((x) => (
              <button key={x.id} type="button" onClick={() => setF({ ...f, date: x.starts_on < today ? today : x.starts_on, name: f.name || `${x.name} special` })}
                className="rounded-full bg-ink-50 px-2.5 py-1 text-ink-700 ring-1 ring-ink-200 hover:bg-ink-100">{x.name}</button>
            ))}
          </div>
        )}
        <Field label="Dish">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Kakara pitha and kheeri" maxLength={80} required data-testid="special-name" />
        </Field>
        <Field label="Extra price (₹, optional)" hint="Leave empty if it’s part of the normal tiffin.">
          <Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" placeholder="0" data-testid="special-price" />
        </Field>
        <Field label="Description (optional)">
          <Textarea rows={2} maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} />
          <span>Notify customers on WhatsApp (those with this meal in their plan who get WhatsApp updates)</span>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || !f.name.trim()}>{busy ? 'Saving…' : 'Add special'}</Button>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        </div>
      </form>
    </Card>
  );
}

export function DeleteSpecial({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  async function remove() {
    if (!window.confirm('Delete this special? Customers who were already told are not messaged again.')) return;
    const { error } = await supabaseBrowser().rpc('delete_festival_special', { p_special: id });
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  return (
    <div className="text-right">
      <Button variant="ghost" onClick={remove} className="text-red-700">Delete</Button>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
