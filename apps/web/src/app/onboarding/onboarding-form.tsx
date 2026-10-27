'use client';

import { useState, type FormEvent } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { selectKitchen } from '@/app/actions';
import { Alert, Button, Field, Input } from '@/components/ui';

export function OnboardingForm() {
  const [form, setForm] = useState({ name: '', ownerName: '', area: '', address: '', fssai: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (form.fssai && !/^\d{14}$/.test(form.fssai.trim())) return setError('FSSAI number must be 14 digits.');
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
        <Field label="FSSAI number (optional)" hint="Needed before your kitchen can be listed for new customers.">
          <Input value={form.fssai} onChange={set('fssai')} inputMode="numeric" maxLength={14} />
        </Field>
      </div>
      <Field label="Kitchen address">
        <Input value={form.address} onChange={set('address')} placeholder="Plot 214, Patia Main Road" />
      </Field>
      <Alert>{error}</Alert>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Creating…' : 'Create kitchen'}
      </Button>
    </form>
  );
}
