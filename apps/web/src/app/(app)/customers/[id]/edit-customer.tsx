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
  const set = (k: keyof Customer) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const patch: Record<string, string> = {};
    (['name', 'diet', 'preferred_language', 'notes'] as const).forEach((k) => {
      if (f[k] !== customer[k]) patch[k] = f[k];
    });
    if (f.phone !== customer.phone) patch.phone = f.phone;
    const { error } = await supabaseBrowser().rpc('update_customer', { p_customer: customer.id, p_patch: patch });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
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
          <Input value={f.phone} onChange={set('phone')} inputMode="tel" required />
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
