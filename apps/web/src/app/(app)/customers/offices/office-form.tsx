'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import type { Office } from '@/lib/p5';
import { LocationPicker, type LatLng } from '@/components/location-picker';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';

export function OfficeForm({ kitchenId, office, billable, center }: {
  kitchenId: string; office: Office | null; billable: { id: string; name: string }[]; center: LatLng | null;
}) {
  const router = useRouter();
  const [f, setF] = useState({
    name: office?.name ?? '', billing: office?.billing_customer_id ?? '', line1: office?.line1 ?? '', area: office?.area ?? '',
    landmark: office?.landmark ?? '', contact_name: office?.contact_name ?? '', contact_phone: office?.contact_phone ?? '',
  });
  const [pin, setPin] = useState<LatLng | null>(office?.lat != null && office?.lng != null ? { lat: office.lat, lng: office.lng } : null);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().rpc('upsert_office', {
      p_kitchen: kitchenId, p_name: f.name.trim(), p_billing_customer: f.billing,
      p_line1: f.line1.trim(), p_area: f.area.trim(), p_landmark: f.landmark.trim(),
      ...(pin ? { p_lat: pin.lat, p_lng: pin.lng } : {}),
      p_contact_name: f.contact_name.trim(), p_contact_phone: f.contact_phone.trim(),
      ...(office ? { p_office: office.id } : {}),
    });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyErrorIn('office', error) });
    setMsg({ tone: 'green', text: office ? 'Office saved.' : 'Office added. Now add members from each customer’s page.' });
    if (office) router.push('/customers/offices');
    else setF({ name: '', billing: '', line1: '', area: '', landmark: '', contact_name: '', contact_phone: '' });
    router.refresh();
  }

  return (
    <Card title={office ? `Edit ${office.name}` : 'Add an office'} actions={office && <Link href="/customers/offices" className="text-sm text-ink-500 hover:underline">Cancel</Link>}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Office name"><Input value={f.name} onChange={set('name')} maxLength={80} required /></Field>
        <Field label="Billing contact (pays for every member)" hint="A customer of your kitchen, e.g. the office manager. Add them as a customer first.">
          <Select value={f.billing} onChange={set('billing')} required>
            <option value="">Choose a customer</option>
            {billable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Building / floor"><Input value={f.line1} onChange={set('line1')} /></Field>
          <Field label="Area"><Input value={f.area} onChange={set('area')} /></Field>
        </div>
        <Field label="Landmark"><Input value={f.landmark} onChange={set('landmark')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reception contact"><Input value={f.contact_name} onChange={set('contact_name')} maxLength={80} /></Field>
          <Field label="Contact phone"><Input value={f.contact_phone} onChange={set('contact_phone')} inputMode="tel" /></Field>
        </div>
        <LocationPicker value={pin} onChange={setPin} center={center} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || !f.name.trim() || !f.billing}>{busy ? 'Saving…' : office ? 'Save office' : 'Add office'}</Button>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        </div>
      </form>
    </Card>
  );
}
