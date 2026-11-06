'use client';

import { useState, type FormEvent } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { selectKitchen } from '@/app/actions';
import { Alert, Button, Field, Input } from '@/components/ui';
import { acceptVendorTerms, TermsLabel } from '@/components/vendor-terms-accept';

export function OnboardingForm() {
  const [form, setForm] = useState({ name: '', ownerName: '', area: '', address: '', fssai: '' });
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (form.fssai && !/^\d{14}$/.test(form.fssai.trim())) return setError('FSSAI number must be 14 digits.');
    if (!terms) return setError('Please accept the vendor terms and the data processing agreement.');
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('create_kitchen', {
      p_name: form.name,
      p_owner_name: form.ownerName || undefined,
      p_area: form.area || undefined,
      p_address: form.address || undefined,
      p_fssai_no: form.fssai || undefined,
    });
    if (error || !data) {
      setBusy(false);
      return setError(friendlyError(error));
    }
    // Recorded in consents (D-142). If this fails the dashboard asks again before anything else.
    await acceptVendorTerms(data.id);
    await selectKitchen(data.id);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Kitchen name">
        <Input value={form.name} onChange={set('name')} placeholder="Maa Tarini Tiffin" required minLength={2} maxLength={80} />
      </Field>
      <Field label="Your name">
        <Input value={form.ownerName} onChange={set('ownerName')} placeholder="Sunita Mohanty" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Area">
          <Input value={form.area} onChange={set('area')} placeholder="Patia" />
        </Field>
        <Field label="FSSAI number (optional)" hint="14 digits. Our team checks it once; your kitchen stays private.">
          <Input value={form.fssai} onChange={set('fssai')} inputMode="numeric" maxLength={14} />
        </Field>
      </div>
      <Field label="Kitchen address">
        <Input value={form.address} onChange={set('address')} placeholder="Plot 214, Patia Main Road" />
      </Field>
      <label className="flex items-start gap-2 text-sm text-ink-700">
        <input type="checkbox" className="mt-0.5" checked={terms} onChange={(e) => setTerms(e.target.checked)} required data-testid="accept-terms" />
        <TermsLabel />
      </label>
      <Alert>{error}</Alert>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Creating…' : 'Create kitchen'}
      </Button>
    </form>
  );
}
