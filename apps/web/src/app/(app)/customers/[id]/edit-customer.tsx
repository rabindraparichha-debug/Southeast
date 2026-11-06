'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { DietType, LanguageCode } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';

type Customer = { id: string; name: string; phone: string; diet: DietType; preferred_language: LanguageCode; notes: string };

export function EditCustomer({ customer }: { customer: Customer }) {
  const router = useRouter();
  const [f, setF] = useState(customer);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // D-118: moving to a phone another customer already uses needs the vendor's yes.
  const [sharedAsked, setSharedAsked] = useState(false);
  const [shared, setShared] = useState(false);
  const set = (k: keyof Customer) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const patch: Record<string, string | boolean> = {};
    (['name', 'diet', 'preferred_language', 'notes'] as const).forEach((k) => {
      if (f[k] !== customer[k]) patch[k] = f[k];
    });
    if (f.phone !== customer.phone) {
      patch.phone = f.phone;
      if (shared) patch.allow_shared_phone = true;
    }
    const { error } = await supabaseBrowser().rpc('update_customer', { p_customer: customer.id, p_patch: patch });
    setBusy(false);
    if (error?.message === 'phone_in_use') setSharedAsked(true);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setSharedAsked(false);
    setShared(false);
    setMsg({ tone: 'green', text: 'Saved.' });
    router.refresh();
  }

  return (
    <Card title="Details">
      <form onSubmit={save} className="space-y-4">
        <Field label="Name">
          <Input value={f.name} onChange={set('name')} required />
        </Field>
        <Field label="Mobile number">
          <Input value={f.phone} onChange={(e) => { setF({ ...f, phone: e.target.value }); setSharedAsked(false); setShared(false); }} inputMode="tel" required />
        </Field>
        {sharedAsked && (
          <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-amber-200">
            <input type="checkbox" className="mt-1" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <span>Yes, {f.name.trim() || 'this customer'} shares this number with another customer (for example a brother or sister).</span>
          </label>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Diet">
            <Select value={f.diet} onChange={set('diet')}>
              <option value="veg">Veg</option>
              <option value="nonveg">Non-veg</option>
              <option value="jain">Jain</option>
            </Select>
          </Field>
          <Field label="WhatsApp language">
            <Select value={f.preferred_language} onChange={set('preferred_language')}>
              <option value="or">Odia</option>
              <option value="en">English</option>
              <option value="hi">Hindi</option>
            </Select>
          </Field>
        </div>
        <Field label="Notes">
          <Textarea rows={2} value={f.notes} onChange={set('notes')} />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        </div>
      </form>
    </Card>
  );
}
