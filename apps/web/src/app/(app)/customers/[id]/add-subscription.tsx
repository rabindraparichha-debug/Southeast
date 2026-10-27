'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatPaise, istDate } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import type { DietType } from '@tiffin/db';
import type { Address } from './address-manager';

type Plan = { id: string; name: string; price_per_meal_paise: number; diet: DietType };

export function AddSubscription({ kitchenId, customerId, diet, plans, addresses }: {
  kitchenId: string; customerId: string; diet: DietType; plans: Plan[]; addresses: Address[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    plan_id: (plans.find((p) => p.diet === diet) ?? plans[0])?.id ?? '', start_date: istDate(), qty: '1', status: 'active' as 'active' | 'trial',
    address_id: addresses.find((a) => a.is_default)?.id ?? addresses[0]?.id ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (plans.length === 0) return <p className="text-sm text-ink-500">Create a plan first (Plans page).</p>;
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Add subscription</Button>;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabaseBrowser().from('subscriptions').insert({
      kitchen_id: kitchenId, customer_id: customerId, plan_id: f.plan_id, start_date: f.start_date,
      qty: Number(f.qty), status: f.status, address_id: f.address_id || null,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setOpen(false);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="grid gap-3 sm:grid-cols-5 sm:items-end">
      <Field label="Plan" className="sm:col-span-2">
        <Select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: e.target.value })}>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {formatPaise(p.price_per_meal_paise)}/meal</option>)}
        </Select>
      </Field>
      <Field label="Start date">
        <Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} required />
      </Field>
      <Field label="Tiffins per meal">
        <Input type="number" min={1} max={20} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
      </Field>
      <Field label="Starts as">
        <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'active' | 'trial' })}>
          <option value="active">Active</option>
          <option value="trial">Trial</option>
        </Select>
      </Field>
      {addresses.length > 1 && (
        <Field label="Deliver to" className="sm:col-span-2">
          <Select value={f.address_id} onChange={(e) => setF({ ...f, address_id: e.target.value })}>
            {addresses.map((a) => <option key={a.id} value={a.id}>{a.label || [a.line1, a.area].filter(Boolean).join(', ')}</option>)}
          </Select>
        </Field>
      )}
      <div className="flex gap-2 sm:col-span-5">
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save subscription'}</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Alert>{error}</Alert>
      </div>
    </form>
  );
}
