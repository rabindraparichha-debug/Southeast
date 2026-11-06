'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL, addDays, formatServiceDate } from '@tiffin/core';
import type { ClosureResult, MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';

// Kitchen closures (D-125): close a day or one meal of a day (festival, family event). No meals are
// generated, cooked or charged. Always previewed first (set_kitchen_closure with p_dry_run); allowed
// only while the meal is still open (before its cutoff). Customers are not told automatically.

export type Closure = { id: string; closed_on: string; slot: MealSlot | null; reason: string | null };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const what = (date: string, slot: MealSlot | null) => `${formatServiceDate(date)} · ${slot ? SLOT_LABEL[slot] : 'Whole day'}`;

export function ClosureManager({ kitchenId, today, closures, canEdit }: {
  kitchenId: string; today: string; closures: Closure[]; canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(addDays(today, 1));
  const [slot, setSlot] = useState<'' | MealSlot>('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ClosureResult | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  async function close(dryRun: boolean, at = { date, slot }) {
    setBusy(true);
    setError('');
    const { data, error } = await supabaseBrowser().rpc('set_kitchen_closure', {
      p_kitchen: kitchenId,
      p_date: at.date,
      p_slot: at.slot || undefined,
      p_reason: reason.trim() || undefined,
      p_dry_run: dryRun,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    const res = data as unknown as ClosureResult;
    if (dryRun) return setPreview(res);
    setDone(`Closed ${what(res.service_date, res.slot)}. ${plural(res.meals, 'meal')} will not be cooked or charged. Tell your customers.`);
    setOpen(false);
    setPreview(null);
    setReason('');
    router.refresh();
  }

  function start(quick: boolean) {
    const at = { date: addDays(today, 1), slot: '' as const };
    setOpen(true);
    setDone('');
    setError('');
    setPreview(null);
    setDate(at.date);
    setSlot(at.slot);
    if (quick) void close(true, at);
  }

  async function remove(c: Closure) {
    setBusy(true);
    setError('');
    const { data, error } = await supabaseBrowser().rpc('remove_kitchen_closure', {
      p_kitchen: kitchenId, p_date: c.closed_on, p_slot: c.slot ?? undefined,
    });
    setBusy(false);
    setRemoving(null);
    if (error) return setError(friendlyError(error));
    const res = data as unknown as ClosureResult;
    setDone(`Open again: ${what(c.closed_on, c.slot)}. ${plural(res.meals, 'meal')} back (meals past their cutoff stay closed).`);
    router.refresh();
  }

  return (
    <Card
      title="Kitchen closed days"
      actions={canEdit && !open && (
        <div className="flex flex-wrap gap-1.5">
          <Button variant="secondary" className="px-3 py-1" onClick={() => start(true)} data-testid="close-tomorrow">Close tomorrow</Button>
          <Button variant="ghost" className="px-3 py-1" onClick={() => start(false)} data-testid="close-date">Close a date</Button>
        </div>
      )}
    >
      {open && (
        <div className="mb-3 space-y-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200" data-testid="closure-form">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <Input type="date" min={today} max={addDays(today, 366)} value={date} onChange={(e) => { setDate(e.target.value); setPreview(null); }} />
            </Field>
            <Field label="Meal">
              <Select value={slot} onChange={(e) => { setSlot(e.target.value as '' | MealSlot); setPreview(null); }} data-testid="closure-slot">
                <option value="">Whole day</option>
                <option value="lunch">Lunch</option>
                <option value="dinner">Dinner</option>
              </Select>
            </Field>
          </div>
          <Field label="Reason (optional)" hint="Shown on the Today cards, e.g. Diwali.">
            <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {!preview ? (
            <div className="flex gap-2">
              <Button onClick={() => close(true)} disabled={busy || !date}>{busy ? 'Checking…' : 'Check'}</Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
            </div>
          ) : (
            <div className="space-y-2 text-sm" data-testid="closure-preview">
              <p>
                <strong>{what(preview.service_date, preview.slot)}</strong>:{' '}
                {preview.meals > 0
                  ? `${plural(preview.orders, 'order')}, ${plural(preview.meals, 'meal')} will not be cooked, delivered or charged.`
                  : 'no meals are booked yet.'}
              </p>
              <p className="text-xs text-ink-500">Customers are not told automatically: tell them yourself. You can reopen it until the cutoff.</p>
              <div className="flex gap-2">
                <Button onClick={() => close(false)} disabled={busy} data-testid="confirm-closure">{busy ? 'Saving…' : 'Confirm closure'}</Button>
                <Button variant="ghost" onClick={() => setPreview(null)}>Back</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {done && <div className="mb-3"><Alert tone="green">{done}</Alert></div>}
      {closures.length > 0 ? (
        <ul className="divide-y divide-ink-100" data-testid="closures-list">
          {closures.map((c) => (
            <li key={c.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium">{what(c.closed_on, c.slot)}</div>
                  {c.reason && <div className="text-xs text-ink-500">{c.reason}</div>}
                </div>
                {canEdit && removing !== c.id && (
                  <Button variant="ghost" className="px-3 py-1" disabled={busy} onClick={() => setRemoving(c.id)}>Remove</Button>
                )}
              </div>
              {removing === c.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-ink-50 p-2 ring-1 ring-ink-200">
                  <span className="text-xs text-ink-700">Open the kitchen again? Meals come back for meals still before their cutoff.</span>
                  <Button className="px-3 py-1" disabled={busy} onClick={() => remove(c)} data-testid="confirm-remove-closure">Open again</Button>
                  <Button variant="ghost" className="px-3 py-1" onClick={() => setRemoving(null)}>Keep closed</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        !open && <p className="text-sm text-ink-500">No closed days coming up.{canEdit ? ' Closing a day stops its meals and charges.' : ''}</p>
      )}
      <div className="mt-2"><Alert>{error}</Alert></div>
    </Card>
  );
}
