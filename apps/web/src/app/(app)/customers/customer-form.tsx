'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { normalizePhone } from '@tiffin/core';
import type { BillingMode, DietType, LanguageCode } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { LocationPicker, type LatLng } from '@/components/location-picker';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';

export function CustomerForm({ kitchenId, kitchenCenter, defaultBilling }: { kitchenId: string; kitchenCenter: LatLng | null; defaultBilling: BillingMode }) {
  const router = useRouter();
  const [f, setF] = useState({
    name: '', phone: '', diet: 'veg' as DietType, language: 'or' as LanguageCode, notes: '',
    line1: '', area: '', landmark: '', delivery_notes: '', consent: false, billing: defaultBilling,
  });
  // D-118: a phone already used by another customer (a sibling, a family phone) needs a yes from the vendor.
  const [sharedAsked, setSharedAsked] = useState(false);
  const [shared, setShared] = useState(false);
  const [pin, setPin] = useState<LatLng | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!normalizePhone(f.phone)) return setError('Enter a valid 10-digit Indian mobile number.');
    if (!f.consent) return setError('Please confirm the customer agreed to be contacted.');
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('create_customer', {
      p_kitchen: kitchenId,
      p_name: f.name,
      p_phone: f.phone,
      p_consent: f.consent,
      p_diet: f.diet,
      p_language: f.language,
      p_notes: f.notes || undefined,
      p_address: { line1: f.line1, area: f.area, landmark: f.landmark, delivery_notes: f.delivery_notes, lat: pin?.lat, lng: pin?.lng },
      p_billing_mode: f.billing,
      p_allow_shared_phone: shared,
    });
    if (error || !data) {
      setBusy(false);
      if (error?.message === 'phone_in_use') setSharedAsked(true);
      return setError(friendlyError(error));
    }
    router.push(`/customers/${data}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-2">
      <Card title="Customer">
        <div className="space-y-4">
          <Field label="Name">
            <Input value={f.name} onChange={set('name')} required maxLength={100} autoFocus />
          </Field>
          <Field label="Mobile number" hint="Saved encrypted. Staff and riders only ever see the last 4 digits.">
            <Input value={f.phone} onChange={(e) => { setF({ ...f, phone: e.target.value }); setSharedAsked(false); setShared(false); }} inputMode="tel" placeholder="98610 00001" required />
          </Field>
          {sharedAsked && (
            <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-amber-200">
              <input type="checkbox" className="mt-1" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              <span>Yes, {f.name.trim() || 'this customer'} is a different person who shares this number (for example a brother or sister).</span>
            </label>
          )}
          <Field label="Billing" hint={f.billing === 'monthly'
            ? 'Meals go on the khata; you collect at month end. Nothing stops automatically. Add opening dues from the customer’s Money card.'
            : 'The customer pays in advance for meals. Low balance alerts, and meals stop at your credit limit.'}>
            <Select value={f.billing} onChange={(e) => setF({ ...f, billing: e.target.value as BillingMode })}>
              <option value="monthly">Monthly (pay later)</option>
              <option value="prepaid">Prepaid (pay in advance)</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Diet">
              <Select value={f.diet} onChange={set('diet')}>
                <option value="veg">Veg</option>
                <option value="nonveg">Non-veg</option>
                <option value="jain">Jain</option>
              </Select>
            </Field>
            <Field label="WhatsApp language">
              <Select value={f.language} onChange={set('language')}>
                <option value="or">Odia</option>
                <option value="en">English</option>
                <option value="hi">Hindi</option>
              </Select>
            </Field>
          </div>
          <Field label="Notes (allergies, preferences)">
            <Textarea rows={2} value={f.notes} onChange={set('notes')} />
          </Field>
          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input type="checkbox" className="mt-1" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />
            <span>The customer agreed to be contacted by my kitchen about their tiffin (calls, SMS, WhatsApp).</span>
          </label>
        </div>
      </Card>
      <Card title="Delivery address">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Flat / house">
              <Input value={f.line1} onChange={set('line1')} placeholder="Flat 3B, Sai Residency" />
            </Field>
            <Field label="Area">
              <Input value={f.area} onChange={set('area')} placeholder="Patia" />
            </Field>
          </div>
          <Field label="Landmark">
            <Input value={f.landmark} onChange={set('landmark')} placeholder="Near water tank" />
          </Field>
          <Field label="Delivery notes">
            <Input value={f.delivery_notes} onChange={set('delivery_notes')} placeholder="Leave with security" />
          </Field>
          <LocationPicker value={pin} onChange={setPin} center={kitchenCenter} />
        </div>
      </Card>
      <div className="flex items-center gap-3 lg:col-span-2">
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save customer'}</Button>
        <Alert>{error}</Alert>
      </div>
    </form>
  );
}
