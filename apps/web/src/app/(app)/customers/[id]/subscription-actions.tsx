'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL, addDays, formatServiceDate } from '@tiffin/core';
import type { ChangeResult, ChangeType, MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Field, Input, Select } from '@/components/ui';

type Props = {
  subscriptionId: string;
  slots: MealSlot[];
  addresses: { id: string; label: string }[];
  nextMeal: { service_date: string; slot: MealSlot } | null;
  today: string;
  noticeDays: number;
};

const ACTIONS: { type: ChangeType; label: string }[] = [
  { type: 'skip', label: 'Skip' },
  { type: 'pause', label: 'Pause' },
  { type: 'resume', label: 'Resume' },
  { type: 'address', label: 'Change address' },
  { type: 'cancel', label: 'Cancel' },
];

// Records a customer's request (by phone). Always previews first so the vendor can
// tell the customer which meals are affected and whether any are charged.
export function SubscriptionActions({ subscriptionId, slots, addresses, nextMeal, today, noticeDays }: Props) {
  const router = useRouter();
  const [type, setType] = useState<ChangeType | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [slot, setSlot] = useState<'' | MealSlot>('');
  const [address, setAddress] = useState(addresses[0]?.id ?? '');
  const [waive, setWaive] = useState(false);
  const [preview, setPreview] = useState<ChangeResult | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  function open(t: ChangeType) {
    setType(t);
    setPreview(null);
    setError('');
    setDone('');
    setWaive(false);
    setTo('');
    if (t === 'skip') {
      setFrom(nextMeal?.service_date ?? addDays(today, 1));
      setSlot(slots.length > 1 && nextMeal ? nextMeal.slot : '');
    } else if (t === 'cancel') {
      setFrom(addDays(today, noticeDays));
      setSlot('');
    } else {
      // First meal still open for changes (tomorrow's lunch may already be locked).
      setFrom(nextMeal?.service_date ?? addDays(today, 1));
      setSlot('');
    }
  }

  async function call(dryRun: boolean, waiveLate = waive) {
    if (!type) return;
    setBusy(true);
    setError('');
    const { data, error } = await supabaseBrowser().rpc('request_schedule_change', {
      p_subscription: subscriptionId,
      p_type: type,
      p_from: from || undefined,
      p_to: type === 'skip' ? to || from : to || undefined,
      p_slot: slot || undefined,
      p_address: type === 'address' ? address : undefined,
      p_waive_late: waiveLate,
      p_dry_run: dryRun,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    const res = data as unknown as ChangeResult;
    if (dryRun) return setPreview(res);
    setDone(`${ACTIONS.find((a) => a.type === type)?.label} saved.`);
    setType(null);
    setPreview(null);
    router.refresh();
  }

  const charged = preview?.affected.filter((a) => a.charged) ?? [];
  const late = preview?.affected.filter((a) => a.late) ?? [];

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {ACTIONS.map((a) => (
          <Button key={a.type} variant={type === a.type ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => open(a.type)}>
            {a.label}
          </Button>
        ))}
        {done && <Alert tone="green">{done}</Alert>}
      </div>

      {type && (
        <div className="mt-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label={type === 'cancel' ? 'Last meal is the day before' : type === 'resume' ? 'Resume from' : 'From'}>
              <Input type="date" min={today} value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} />
            </Field>
            {(type === 'skip' || type === 'pause' || type === 'address') && (
              <Field label={type === 'skip' ? 'To (same day if empty)' : 'Until (leave empty if open-ended)'}>
                <Input type="date" min={from || today} value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }} />
              </Field>
            )}
            {slots.length > 1 && type !== 'cancel' && (
              <Field label="Meal">
                <Select value={slot} onChange={(e) => { setSlot(e.target.value as '' | MealSlot); setPreview(null); }}>
                  <option value="">All meals</option>
                  {slots.map((s) => <option key={s} value={s}>{SLOT_LABEL[s]}</option>)}
                </Select>
              </Field>
            )}
            {type === 'address' && (
              <Field label="Deliver to">
                <Select value={address} onChange={(e) => { setAddress(e.target.value); setPreview(null); }}>
                  {addresses.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </Select>
              </Field>
            )}
          </div>

          {!preview ? (
            <div className="mt-3 flex gap-2">
              <Button onClick={() => call(true)} disabled={busy || !from}>{busy ? 'Checking…' : 'Check'}</Button>
              <Button variant="ghost" onClick={() => setType(null)}>Close</Button>
            </div>
          ) : (
            <div className="mt-3 space-y-2 text-sm">
              <p>
                {preview.affected.length === 0
                  ? 'No generated meals are affected yet (meals beyond the next 7 days follow this change automatically).'
                  : `Affects ${preview.affected.length} meal${preview.affected.length > 1 ? 's' : ''}: ${preview.affected
                      .slice(0, 6)
                      .map((a) => `${formatServiceDate(a.date)} ${SLOT_LABEL[a.slot]}`)
                      .join(', ')}${preview.affected.length > 6 ? '…' : ''}`}
              </p>
              {charged.length > 0 && (
                <Alert tone="amber">
                  {charged.length} meal{charged.length > 1 ? 's are' : ' is'} past the cutoff and will still be charged. Tell the customer before confirming.
                </Alert>
              )}
              {late.length > 0 && (type === 'skip' || type === 'pause') && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={waive} onChange={(e) => { setWaive(e.target.checked); void call(true, e.target.checked); }} />
                  Waive the late charge where the kitchen can still change the count
                </label>
              )}
              {type === 'cancel' && <p className="text-ink-600">Refund of unused meals is handled in the money milestone.</p>}
              <div className="flex gap-2">
                <Button onClick={() => call(false)} disabled={busy}>{busy ? 'Saving…' : 'Confirm'}</Button>
                <Button variant="ghost" onClick={() => setPreview(null)}>Back</Button>
              </div>
            </div>
          )}
          <div className="mt-2"><Alert>{error}</Alert></div>
        </div>
      )}
    </div>
  );
}
