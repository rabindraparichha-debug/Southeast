'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { WEEKDAYS, formatPaise, rupeesToPaise } from '@tiffin/core';
import type { DietType, MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Badge, Button, Card, DIET_LABEL, DIET_TONE, Field, Input, Select } from '@/components/ui';

type Plan = {
  id: string; name: string; slots: MealSlot[]; diet: DietType; days_of_week: number[];
  price_per_meal_paise: number; description: string | null; active: boolean;
};

const empty = { name: '', slots: ['lunch'] as MealSlot[], diet: 'veg' as DietType, days_of_week: [1, 2, 3, 4, 5, 6], price: '', description: '', active: true };

export function PlansEditor({ kitchenId, plans }: { kitchenId: string; plans: Plan[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | 'new' | null>(plans.length === 0 ? 'new' : null);
  const [f, setF] = useState(empty);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function open(p: Plan | 'new') {
    setError('');
    if (p === 'new') {
      setF(empty);
      setEditing('new');
    } else {
      setF({ name: p.name, slots: p.slots, diet: p.diet, days_of_week: p.days_of_week, price: String(p.price_per_meal_paise / 100), description: p.description ?? '', active: p.active });
      setEditing(p.id);
    }
  }

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const paise = rupeesToPaise(f.price);
    if (!paise) return setError('Enter the price per meal in rupees, e.g. 70.');
    if (f.slots.length === 0) return setError('Choose lunch, dinner or both.');
    if (f.days_of_week.length === 0) return setError('Choose at least one day.');
    setBusy(true);
    const values = {
      name: f.name.trim(), slots: f.slots, diet: f.diet, days_of_week: [...f.days_of_week].sort(),
      price_per_meal_paise: paise, description: f.description || null, active: f.active,
    };
    const supabase = supabaseBrowser();
    const { error } = editing === 'new'
      ? await supabase.from('plans').insert({ ...values, kitchen_id: kitchenId })
      : await supabase.from('plans').update(values).eq('id', editing!);
    setBusy(false);
    if (error) return setError(error.code === '23505' ? 'A plan with this name already exists.' : friendlyError(error));
    setEditing(null);
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Your plans" actions={<Button variant="secondary" onClick={() => open('new')}>New plan</Button>}>
        <ul className="divide-y divide-ink-100">
          {plans.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-3 text-sm">
              <div>
                <div className="flex items-center gap-2 font-medium">
                  {p.name} <Badge tone={DIET_TONE[p.diet]}>{DIET_LABEL[p.diet]}</Badge> {!p.active && <Badge>Inactive</Badge>}
                </div>
                <div className="text-ink-500">
                  {formatPaise(p.price_per_meal_paise)} per meal · {p.slots.join(' + ')} · {p.days_of_week.map((d) => WEEKDAYS[d - 1]?.short).join(' ')}
                </div>
              </div>
              <Button variant="ghost" onClick={() => open(p)}>Edit</Button>
            </li>
          ))}
          {plans.length === 0 && <li className="py-3 text-sm text-ink-500">No plans yet. Create your first plan.</li>}
        </ul>
      </Card>

      {editing && (
        <Card title={editing === 'new' ? 'New plan' : 'Edit plan'}>
          <form onSubmit={save} className="space-y-4">
            <Field label="Plan name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Veg Lunch" required /></Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Price per meal (₹)"><Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" placeholder="70" required /></Field>
              <Field label="Diet">
                <Select value={f.diet} onChange={(e) => setF({ ...f, diet: e.target.value as DietType })}>
                  <option value="veg">Veg</option><option value="nonveg">Non-veg</option><option value="jain">Jain</option>
                </Select>
              </Field>
            </div>
            <fieldset>
              <legend className="text-sm font-medium text-ink-700">Meals</legend>
              <div className="mt-1 flex gap-4 text-sm">
                {(['lunch', 'dinner'] as MealSlot[]).map((s) => (
                  <label key={s} className="flex items-center gap-2 capitalize">
                    <input type="checkbox" checked={f.slots.includes(s)} onChange={() => setF({ ...f, slots: toggle(f.slots, s) })} /> {s}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium text-ink-700">Days</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {WEEKDAYS.map((d) => (
                  <button
                    type="button"
                    key={d.iso}
                    onClick={() => setF({ ...f, days_of_week: toggle(f.days_of_week, d.iso) })}
                    className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${f.days_of_week.includes(d.iso) ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-ink-700 ring-ink-200'}`}
                  >
                    {d.short}
                  </button>
                ))}
              </div>
            </fieldset>
            <Field label="What’s included (shown to customers later)"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Rice, dal, 2 sabzi, roti" /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (available for new subscriptions)</label>
            <Alert>{error}</Alert>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save plan'}</Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
