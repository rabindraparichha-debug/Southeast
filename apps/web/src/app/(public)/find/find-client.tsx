'use client';

import { useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import Link from 'next/link';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { addDays, formatPaise, istDate, normalizePhone } from '@tiffin/core';
import type { DietType, MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import { track } from '@/lib/analytics';
import { BUDGETS, ratingLabel, type LeadChoice, type LeadSource, type ShortlistKitchen, type SubmitLeadResult } from '@/lib/public';
import { Alert, Button, Field, Input, Select } from '@/components/ui';

// The browser keeps the lead token (and the pick) for this tab, so a refresh keeps the shortlist.
const KEY = 'tiffin.find.v1';
type Saved = {
  token: string;
  result: SubmitLeadResult;
  choice?: LeadChoice & { kitchen_id: string };
  payment?: 'cash' | 'error';
};
const listeners = new Set<() => void>();
let memoryRaw: string | null = null; // fallback when sessionStorage is blocked
const store = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get(): string | null {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return memoryRaw;
    }
  },
  set(v: Saved | null) {
    memoryRaw = v ? JSON.stringify(v) : null;
    try {
      if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
      else sessionStorage.removeItem(KEY);
    } catch {
      // Private mode without storage: the flow still works until a refresh.
    }
    listeners.forEach((fn) => fn());
  },
};

const TERMS = 'Unused meals are refunded pro-rata. Cancel any time with the kitchen’s notice period. No hidden charges.';
const MEALS: { value: string; label: string; slots: MealSlot[] }[] = [
  { value: 'lunch', label: 'Lunch', slots: ['lunch'] },
  { value: 'dinner', label: 'Dinner', slots: ['dinner'] },
  { value: 'both', label: 'Both', slots: ['lunch', 'dinner'] },
];
const DIETS: { value: DietType; label: string }[] = [
  { value: 'veg', label: 'Veg' },
  { value: 'nonveg', label: 'Non-veg' },
  { value: 'jain', label: 'Jain' },
];

type Props = { areas: string[]; source: LeadSource; campaign: string | null; initialArea: string; kitchenSlug: string | null };

export function FindClient({ areas, source, campaign, initialArea, kitchenSlug }: Props) {
  const raw = useSyncExternalStore(store.subscribe, store.get, () => null);
  const saved = useMemo<Saved | null>(() => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Saved;
    } catch {
      return null;
    }
  }, [raw]);

  if (saved?.choice) return <Chosen saved={saved} />;
  if (saved) return <Shortlist saved={saved} kitchenSlug={kitchenSlug} />;
  return <LeadForm areas={areas} source={source} campaign={campaign} initialArea={initialArea} kitchenSlug={kitchenSlug} />;
}

function LeadForm({ areas, source, campaign, initialArea, kitchenSlug }: Props) {
  const tomorrow = addDays(istDate(), 1);
  const knownArea = areas.find((a) => a.toLowerCase() === initialArea.toLowerCase()) ?? '';
  const [f, setF] = useState({
    name: '', phone: '', area: knownArea, meals: 'lunch', diet: 'veg' as DietType, budget: '', start: tomorrow,
    consent: false, whatsapp: true,
  });
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function locate() {
    setError('');
    if (!('geolocation' in navigator)) return setError('Your browser cannot share your location. Choose your area instead.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) });
      },
      () => {
        setLocating(false);
        setError('Could not get your location. Choose your area instead.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const phone = normalizePhone(f.phone);
    if (!f.name.trim()) return setError('Please enter your name.');
    if (!phone) return setError('Enter a valid 10-digit Indian mobile number.');
    if (!f.area && !coords) return setError('Choose your area or share your location.');
    if (!f.consent) return setError('Please tick the box to agree to be contacted.');
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('submit_lead', {
      p_name: f.name.trim(),
      p_phone: phone,
      p_area: f.area || undefined,
      p_lat: coords?.lat,
      p_lng: coords?.lng,
      p_slots: MEALS.find((m) => m.value === f.meals)!.slots,
      p_diet: f.diet,
      p_budget_paise: BUDGETS.find((b) => b.value === f.budget)?.paise ?? undefined,
      p_start: f.start || undefined,
      p_source: source,
      p_campaign: campaign ?? undefined,
      p_consent: true,
      p_whatsapp_opt_in: f.whatsapp,
      p_language: 'en',
    });
    setBusy(false);
    if (error) return setError(friendlyErrorIn('public', error));
    const result = data as unknown as SubmitLeadResult;
    track('lead_submitted', { source, campaign, area: f.area || (coords ? 'shared_location' : null) });
    store.set({ token: result.token, result });
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold text-ink-900">Find a home-style tiffin near you</h1>
      <p className="mt-1 text-sm text-ink-500">
        Tell us where and when. We show you 2–3 FSSAI-registered kitchens nearby that have space. Start with a small paid trial.
      </p>
      {kitchenSlug && <p className="mt-2 text-sm text-brand-700">We’ll check whether this kitchen delivers to you, and show you others nearby too.</p>}
      <form onSubmit={submit} className="mt-5 space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-ink-100">
        <Field label="Your name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" maxLength={80} required />
        </Field>
        <Field label="Mobile number" hint="We’ll send your kitchen options and updates here.">
          <div className="flex">
            <span className="inline-flex items-center rounded-l-lg bg-ink-100 px-3 text-sm text-ink-500 ring-1 ring-ink-200">+91</span>
            <Input className="rounded-l-none" inputMode="numeric" autoComplete="tel-national" placeholder="98610 00000"
              value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required />
          </div>
        </Field>
        <Field label="Area">
          <Select value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>
            <option value="">{coords ? 'Using my location' : 'Choose your area'}</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
        </Field>
        <div className="-mt-2 flex flex-wrap items-center gap-2 text-sm">
          {coords ? (
            <>
              <span className="text-green-800">📍 Location added (±{coords.accuracy} m)</span>
              <button type="button" className="text-ink-500 underline" onClick={() => setCoords(null)}>Remove</button>
            </>
          ) : (
            <button type="button" onClick={locate} disabled={locating} className="text-brand-700 underline disabled:opacity-50">
              {locating ? 'Finding you…' : '📍 Use my location (more accurate)'}
            </button>
          )}
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-ink-700">Meal times</legend>
          <Segmented name="meals" value={f.meals} options={MEALS} onChange={(v) => setF({ ...f, meals: v })} />
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium text-ink-700">Food</legend>
          <Segmented name="diet" value={f.diet} options={DIETS} onChange={(v) => setF({ ...f, diet: v as DietType })} />
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Budget per meal">
            <Select value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })}>
              {BUDGETS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </Select>
          </Field>
          <Field label="Start from">
            <Input type="date" min={tomorrow} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" className="mt-0.5" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} required />
          <span>I agree to be contacted about my tiffin enquiry</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" className="mt-0.5" checked={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.checked })} />
          <span>Send me updates on WhatsApp</span>
        </label>
        <Alert>{error}</Alert>
        <Button type="submit" className="w-full py-3 text-base" disabled={busy}>{busy ? 'Finding kitchens…' : 'Show kitchens near me'}</Button>
        <p className="text-center text-xs text-ink-500">Free to use. We never hold your money: you pay the kitchen directly.</p>
      </form>
    </div>
  );
}

function Segmented<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="mt-1 grid grid-cols-3 gap-2">
      {options.map((o) => (
        <label key={o.value} className={`cursor-pointer rounded-lg px-3 py-2 text-center text-sm font-medium ring-1 ${value === o.value ? 'bg-brand-50 text-brand-700 ring-brand-500' : 'bg-white text-ink-700 ring-ink-200'}`}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function Shortlist({ saved, kitchenSlug }: { saved: Saved; kitchenSlug: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  // A lead that already picked a kitchen gets its stored matches back without kitchen details.
  const valid = saved.result.kitchens.filter((k) => k.name && k.slug && k.trial_meals);
  const kitchens = [...valid].sort((a, b) => Number(b.slug === kitchenSlug) - Number(a.slug === kitchenSlug));
  const askedMissing = kitchenSlug && kitchens.length > 0 && !kitchens.some((k) => k.slug === kitchenSlug);

  async function pick(k: ShortlistKitchen) {
    setError('');
    setBusy(k.kitchen_id);
    const supabase = supabaseBrowser();
    const { data, error } = await supabase.rpc('lead_choose', { p_token: saved.token, p_kitchen: k.kitchen_id });
    if (error) {
      setBusy(null);
      return setError(friendlyErrorIn('public', error));
    }
    const choice = { ...(data as unknown as LeadChoice), kitchen_id: k.kitchen_id };
    const next: Saved = { ...saved, choice };
    track('kitchen_picked', { kitchen: k.slug, area: k.area });
    const pay = await startPayment(choice, k.slug);
    if (pay === 'redirected') {
      store.set(next);
      return;
    }
    setBusy(null);
    store.set({ ...next, payment: pay });
  }

  if (['trial', 'converted', 'renewed'].includes(saved.result.status) || (saved.result.kitchens.length > 0 && valid.length === 0)) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-ink-100">
        <div className="text-4xl" aria-hidden>🍱</div>
        <h1 className="mt-2 text-lg font-semibold">You’ve already picked a kitchen</h1>
        <p className="mt-1 text-sm text-ink-500">Open the customer page link we sent you on WhatsApp to pay, skip or pause. Need help? Message the kitchen.</p>
        <button className="mt-4 text-sm text-ink-500 underline" onClick={() => store.set(null)}>Search again</button>
      </div>
    );
  }

  if (saved.result.kitchens.length === 0) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-ink-100">
        <div className="text-4xl" aria-hidden>🕐</div>
        <h1 className="mt-2 text-lg font-semibold">No kitchen near you has space yet</h1>
        <p className="mt-1 text-sm text-ink-500">We’ll WhatsApp you when one does. You don’t need to do anything else.</p>
        <div className="mt-4 flex justify-center gap-3 text-sm">
          <Link className="text-brand-700 underline" href="/kitchens">See all kitchens</Link>
          <button className="text-ink-500 underline" onClick={() => store.set(null)}>Search again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold text-ink-900">Kitchens near {saved.result.area ?? 'you'} with space</h1>
      <p className="mt-1 text-sm text-ink-500">Pick one to start a short paid trial. You can switch after the trial.</p>
      {askedMissing && <Alert tone="amber">The kitchen you looked at can’t take your order (area, meal times or space). Here are others nearby.</Alert>}
      <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
        <strong>Before you pay:</strong> {TERMS} You pay the kitchen directly; we never hold your money.
      </div>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      <ul className="mt-4 space-y-3">
        {kitchens.map((k) => (
          <li key={k.kitchen_id} className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ${k.slug === kitchenSlug ? 'ring-brand-500' : 'ring-ink-100'}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-ink-900">{k.name}</h2>
                <p className="text-sm text-ink-500">{[k.area, `${Number(k.distance_km).toFixed(1)} km away`].filter(Boolean).join(' · ')}</p>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold">{formatPaise(k.price_per_meal_paise)}<span className="text-sm font-normal text-ink-500">/meal</span></div>
                <div className="text-sm text-ink-700">{ratingLabel(k.rating, k.reviews)}</div>
              </div>
            </div>
            <p className="mt-2 text-sm text-ink-700">{k.plan_name}</p>
            <p className="mt-1 text-xs text-ink-500">{k.fssai_no ? `FSSAI Reg. No. ${k.fssai_no}` : 'FSSAI number pending'}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button onClick={() => pick(k)} disabled={busy !== null} className="py-2.5">
                {busy === k.kitchen_id ? 'Booking…' : `Start trial: ${k.trial_meals} meals for ${formatPaise(k.trial_meals * k.price_per_meal_paise)}`}
              </Button>
              <Link href={`/k/${k.slug}`} className="text-sm text-brand-700 underline">View kitchen</Link>
            </div>
          </li>
        ))}
      </ul>
      <button className="mt-4 text-sm text-ink-500 underline" onClick={() => store.set(null)}>Change my details</button>
    </div>
  );
}

/** Asks the payment-link function for the trial payment page; goes there when it exists. */
async function startPayment(choice: LeadChoice, kitchenSlug: string | null): Promise<'redirected' | 'cash' | 'error'> {
  const { data, error } = await supabaseBrowser().functions.invoke('razorpay-payment-link', {
    body: { token: choice.portal_token, meals: choice.trial_meals },
  });
  const url = (data as { short_url?: string } | null)?.short_url;
  if (!error && url) {
    track('trial_payment_started', { kitchen: kitchenSlug }, { beforeNavigation: true });
    window.location.assign(url);
    return 'redirected';
  }
  if (error instanceof FunctionsHttpError) {
    const body = await (error.context as Response).json().catch(() => null);
    if (body?.error === 'payout_account_not_verified') return 'cash';
  }
  return 'error';
}

function Chosen({ saved }: { saved: Saved }) {
  const c = saved.choice!;
  const [busy, setBusy] = useState(false);
  const [payment, setPayment] = useState(saved.payment);
  const pageUrl = `/c/${c.portal_token}`;

  async function retry() {
    setBusy(true);
    const r = await startPayment(c, saved.result.kitchens.find((k) => k.kitchen_id === c.kitchen_id)?.slug ?? null);
    if (r !== 'redirected') {
      setBusy(false);
      setPayment(r);
      store.set({ ...saved, payment: r });
    }
  }

  return (
    <div className="mx-auto max-w-lg rounded-2xl bg-white p-6 shadow-sm ring-1 ring-ink-100">
      <div className="text-4xl" aria-hidden>🎉</div>
      <h1 className="mt-2 text-xl font-semibold">You’re booked with {c.kitchen_name}</h1>
      <p className="mt-1 text-sm text-ink-700">
        {c.plan_name} · trial of {c.trial_meals} meals for <strong>{formatPaise(c.trial_amount_paise)}</strong> ({formatPaise(c.price_per_meal_paise)}/meal)
      </p>
      {payment === 'cash' ? (
        <div className="mt-4"><Alert tone="amber">The kitchen will collect the trial payment in cash on the first delivery.</Alert></div>
      ) : (
        <div className="mt-4 space-y-2">
          {payment === 'error' && <Alert tone="amber">Online payment didn’t start. Try again, or pay the kitchen in cash on the first delivery.</Alert>}
          <p className="text-xs text-ink-500">{TERMS}</p>
          <Button className="w-full py-3 text-base" onClick={retry} disabled={busy}>{busy ? 'Opening payment…' : `Pay ${formatPaise(c.trial_amount_paise)} now`}</Button>
        </div>
      )}
      <p className="mt-4 text-sm text-ink-700">
        Your meals start once the trial is paid. Skip, pause or report a problem any time on your customer page:
      </p>
      <Link href={pageUrl} className="mt-1 inline-block text-sm font-medium text-brand-700 underline">Open my customer page</Link>
      <p className="mt-4 text-xs text-ink-500">We never hold your money: you pay the kitchen directly.</p>
      <button className="mt-3 text-xs text-ink-500 underline" onClick={() => store.set(null)}>Start a new search</button>
    </div>
  );
}
