'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { WEEKDAYS } from '@tiffin/core';
import type { Tables } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { LocationPicker, type LatLng } from '@/components/location-picker';
import { Alert, Button, Card, Field, Input } from '@/components/ui';

const hhmm = (t: string) => t.slice(0, 5);

export function SettingsForm({ kitchen, settings }: { kitchen: Tables<'kitchens'>; settings: Tables<'kitchen_settings'> }) {
  const router = useRouter();
  const [k, setK] = useState({
    name: kitchen.name, address: kitchen.address ?? '', area: kitchen.area ?? '', fssai_no: kitchen.fssai_no ?? '',
    service_radius_km: String(kitchen.service_radius_km),
    cutoff_lunch: hhmm(kitchen.cutoff_lunch), cutoff_lunch_prev_day: kitchen.cutoff_lunch_prev_day,
    cutoff_dinner: hhmm(kitchen.cutoff_dinner), cutoff_dinner_prev_day: kitchen.cutoff_dinner_prev_day,
    capacity_lunch: String(kitchen.capacity_lunch), capacity_dinner: String(kitchen.capacity_dinner),
    weekly_off: kitchen.weekly_off,
  });
  const [pin, setPin] = useState<LatLng | null>(kitchen.lat && kitchen.lng ? { lat: kitchen.lat, lng: kitchen.lng } : null);
  const [s, setS] = useState({
    low_balance_meals: String(settings.low_balance_meals), credit_limit_meals: String(settings.credit_limit_meals),
    grace_days: String(settings.grace_days), notice_days: String(settings.notice_days),
    phone_pause_close_time: hhmm(settings.phone_pause_close_time),
  });
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (k.fssai_no && !/^\d{14}$/.test(k.fssai_no.trim())) return setMsg({ tone: 'red', text: 'FSSAI number must be 14 digits.' });
    setBusy(true);
    const supabase = supabaseBrowser();
    const [r1, r2] = await Promise.all([
      supabase.from('kitchens').update({
        name: k.name.trim(), address: k.address || null, area: k.area || null, fssai_no: k.fssai_no.trim() || null,
        service_radius_km: Number(k.service_radius_km), lat: pin?.lat ?? null, lng: pin?.lng ?? null,
        cutoff_lunch: k.cutoff_lunch, cutoff_lunch_prev_day: k.cutoff_lunch_prev_day,
        cutoff_dinner: k.cutoff_dinner, cutoff_dinner_prev_day: k.cutoff_dinner_prev_day,
        capacity_lunch: Number(k.capacity_lunch), capacity_dinner: Number(k.capacity_dinner),
        weekly_off: [...k.weekly_off].sort(),
      }).eq('id', kitchen.id),
      supabase.from('kitchen_settings').update({
        low_balance_meals: Number(s.low_balance_meals), credit_limit_meals: Number(s.credit_limit_meals),
        grace_days: Number(s.grace_days), notice_days: Number(s.notice_days), phone_pause_close_time: s.phone_pause_close_time,
      }).eq('kitchen_id', kitchen.id),
    ]);
    setBusy(false);
    const error = r1.error ?? r2.error;
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: 'Settings saved.' });
    router.refresh();
  }

  const num = (obj: 'k' | 's', key: string) => ({
    type: 'number', min: 0, inputMode: 'numeric' as const,
    value: obj === 'k' ? (k as Record<string, unknown>)[key] as string : (s as Record<string, string>)[key],
    onChange: (e: { target: { value: string } }) => (obj === 'k' ? setK({ ...k, [key]: e.target.value }) : setS({ ...s, [key]: e.target.value })),
  });

  return (
    <form onSubmit={save} className="grid gap-6 lg:grid-cols-2">
      <Card title="Profile">
        <div className="space-y-4">
          <Field label="Kitchen name"><Input value={k.name} onChange={(e) => setK({ ...k, name: e.target.value })} required /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Area"><Input value={k.area} onChange={(e) => setK({ ...k, area: e.target.value })} /></Field>
            <Field label="FSSAI number" hint="14 digits. Required before your kitchen can be listed.">
              <Input value={k.fssai_no} onChange={(e) => setK({ ...k, fssai_no: e.target.value })} inputMode="numeric" maxLength={14} />
            </Field>
          </div>
          <Field label="Address"><Input value={k.address} onChange={(e) => setK({ ...k, address: e.target.value })} /></Field>
          <Field label="Delivery radius (km)"><Input {...num('k', 'service_radius_km')} step="0.5" max={25} /></Field>
          <LocationPicker value={pin} onChange={setPin} />
        </div>
      </Card>

      <div className="space-y-6">
        <Card title="Cutoffs (IST)">
          <p className="mb-4 text-sm text-ink-500">After the cutoff, changes are still accepted but the meal is charged. Customers are told before they confirm.</p>
          <div className="space-y-4">
            {(['lunch', 'dinner'] as const).map((slot) => (
              <div key={slot} className="grid grid-cols-2 items-end gap-4">
                <Field label={`${slot === 'lunch' ? 'Lunch' : 'Dinner'} cutoff`}>
                  <Input type="time" value={k[`cutoff_${slot}`]} onChange={(e) => setK({ ...k, [`cutoff_${slot}`]: e.target.value })} required />
                </Field>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input type="checkbox" checked={k[`cutoff_${slot}_prev_day`]} onChange={(e) => setK({ ...k, [`cutoff_${slot}_prev_day`]: e.target.checked })} />
                  on the day before
                </label>
              </div>
            ))}
            <Field label="Phone requests close at" hint="Pauses/skips the customer asks for by phone (entered by you) close at this time; WhatsApp stays open until the cutoff.">
              <Input type="time" value={s.phone_pause_close_time} onChange={(e) => setS({ ...s, phone_pause_close_time: e.target.value })} required />
            </Field>
          </div>
        </Card>

        <Card title="Capacity and days">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Lunch tiffins per day"><Input {...num('k', 'capacity_lunch')} /></Field>
            <Field label="Dinner tiffins per day"><Input {...num('k', 'capacity_dinner')} /></Field>
          </div>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-ink-700">Weekly off</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {WEEKDAYS.map((d) => {
                const on = k.weekly_off.includes(d.iso);
                return (
                  <button type="button" key={d.iso} onClick={() => setK({ ...k, weekly_off: on ? k.weekly_off.filter((x) => x !== d.iso) : [...k.weekly_off, d.iso] })}
                    className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${on ? 'bg-ink-800 text-white ring-ink-800' : 'bg-white text-ink-700 ring-ink-200'}`}>
                    {d.short}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </Card>

        <Card title="Balance and cancellation rules">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Low balance alert at (meals)"><Input {...num('s', 'low_balance_meals')} /></Field>
            <Field label="Allow credit up to (meals)" hint="0 = stop meals at zero balance."><Input {...num('s', 'credit_limit_meals')} /></Field>
            <Field label="Grace days before cancelling" hint="After the balance runs out."><Input {...num('s', 'grace_days')} /></Field>
            <Field label="Cancellation notice (days)"><Input {...num('s', 'notice_days')} /></Field>
          </div>
        </Card>
      </div>

      <div className="flex items-center gap-3 lg:col-span-2">
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    </form>
  );
}
