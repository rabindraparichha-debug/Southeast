'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL, addDays } from '@tiffin/core';
import type { ChangeResult, ChangeType, MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { ChangePreview, savedMessage } from '@/components/change-preview';

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
    setDone(savedMessage(ACTIONS.find((a) => a.type === type)?.label ?? 'Change', type, res));
    setType(null);
    setPreview(null);
    router.refresh();
  }

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
              <ChangePreview preview={preview} type={type} waive={waive} disabled={busy}
                onWaive={(w) => { setWaive(w); void call(true, w); }} />
              {type === 'cancel' && <p className="text-ink-600">If this is the customer’s last subscription, their unused meals are added to Refunds waiting on the Money page.</p>}
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
