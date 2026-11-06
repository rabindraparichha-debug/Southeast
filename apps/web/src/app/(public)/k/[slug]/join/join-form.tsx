'use client';

import { useState, type FormEvent } from 'react';
import { addDays, formatPaise, istDate, normalizePhone } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import type { ReferralInvite } from '@/lib/public';
import { Alert, Button, Field, Input, DIET_LABEL } from '@/components/ui';

const SLOT = { lunch: 'Lunch', dinner: 'Dinner' } as const;

type Props = { slug: string; code: string; kitchenName: string; plans: ReferralInvite['plans'] };

export function JoinForm({ slug, code, kitchenName, plans }: Props) {
  const tomorrow = addDays(istDate(), 1);
  const platform = (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '').replace(/\D/g, '');
  const [f, setF] = useState({
    name: '', phone: '', plan: plans[0]?.id ?? '', address: '', area: '', landmark: '', start: tomorrow,
    consent: false, whatsapp: false, // unticked: opting in must be a choice (D-133)
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ kitchen_name: string; trial_meals: number } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const phone = normalizePhone(f.phone);
    if (!f.name.trim()) return setError('Please enter your name.');
    if (!phone) return setError('Enter a valid 10-digit Indian mobile number.');
    if (f.address.trim().length < 3) return setError('Enter your delivery address (house, street, area).');
    if (!f.consent) return setError('Please tick the box to agree to be contacted.');
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('referral_join', {
      p_slug: slug, p_code: code, p_name: f.name.trim(), p_phone: phone, p_plan: f.plan,
      p_address: f.address.trim(), p_area: f.area.trim() || undefined, p_landmark: f.landmark.trim() || undefined,
      p_start_date: f.start || undefined, p_consent: true, p_whatsapp_opt_in: f.whatsapp,
    });
    setBusy(false);
    if (error) return setError(friendlyErrorIn('public', error));
    setDone(data as unknown as { kitchen_name: string; trial_meals: number });
    window.scrollTo({ top: 0 });
  }

  if (done) {
    return (
      <div className="rounded-2xl bg-white p-5 ring-1 ring-ink-100" data-testid="join-done">
        <h2 className="text-lg font-semibold text-ink-900">Thank you!</h2>
        <p className="mt-1 text-ink-700">
          {done.kitchen_name} will call you to confirm your trial of {done.trial_meals} meals and when to start. You pay the kitchen directly.
        </p>
        {/* This page cannot prove whose phone it is, so WhatsApp updates start only from the phone itself (D-135). */}
        {f.whatsapp && platform && (
          <p className="mt-3 text-sm text-ink-700">
            For updates on WhatsApp, send UPDATES from your phone:{' '}
            <a className="font-medium text-green-700 hover:underline" target="_blank" rel="noreferrer" data-testid="join-whatsapp"
               href={`https://wa.me/${platform}?text=${encodeURIComponent('UPDATES')}`}>open WhatsApp</a>
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-5 ring-1 ring-ink-100">
      <Field label="Your name">
        <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" maxLength={80} required />
      </Field>
      <Field label="Mobile number" hint={`${kitchenName} calls you on this number.`}>
        <div className="flex">
          <span className="inline-flex items-center rounded-l-lg bg-ink-100 px-3 text-sm text-ink-500 ring-1 ring-ink-200">+91</span>
          <Input className="rounded-l-none" inputMode="numeric" autoComplete="tel-national" placeholder="98610 00000"
            value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required />
        </div>
      </Field>
      <fieldset>
        <legend className="text-sm font-medium text-ink-700">Plan</legend>
        <div className="mt-1 space-y-2">
          {plans.map((p) => (
            <label key={p.id} className={`flex cursor-pointer items-start justify-between gap-3 rounded-lg p-3 text-sm ring-1 ${f.plan === p.id ? 'bg-brand-50 ring-brand-300' : 'ring-ink-200'}`}>
              <span className="flex items-start gap-2">
                <input type="radio" name="plan" className="mt-0.5" checked={f.plan === p.id} onChange={() => setF({ ...f, plan: p.id })} />
                <span>
                  <span className="font-medium text-ink-900">{p.name}</span>
                  <span className="block text-ink-500">{DIET_LABEL[p.diet]} · {p.slots.map((s) => SLOT[s]).join(' + ')}</span>
                </span>
              </span>
              <span className="shrink-0 font-semibold">{formatPaise(p.price_per_meal_paise)}<span className="font-normal text-ink-500">/meal</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Delivery address">
        <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={200} placeholder="House / flat, street" required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Area">
          <Input value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} maxLength={80} />
        </Field>
        <Field label="Landmark">
          <Input value={f.landmark} onChange={(e) => setF({ ...f, landmark: e.target.value })} maxLength={120} />
        </Field>
      </div>
      <Field label="Start from">
        <Input type="date" min={tomorrow} max={addDays(istDate(), 30)} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
      </Field>
      <label className="flex items-start gap-2 text-sm text-ink-700">
        <input type="checkbox" className="mt-0.5" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} required />
        <span>I agree that {kitchenName} may contact me about my tiffin</span>
      </label>
      <label className="flex items-start gap-2 text-sm text-ink-700">
        <input type="checkbox" className="mt-0.5" checked={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.checked })} />
        <span>Send me updates on WhatsApp</span>
      </label>
      <Alert>{error}</Alert>
      <Button type="submit" className="w-full py-3 text-base" disabled={busy}>{busy ? 'Sending…' : `Join ${kitchenName}`}</Button>
    </form>
  );
}
