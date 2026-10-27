'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { LocationPicker, type LatLng } from '@/components/location-picker';
import { Alert, Badge, Button, Card, Field, Input } from '@/components/ui';

export type Address = {
  id: string; label: string | null; line1: string | null; area: string | null; landmark: string | null;
  delivery_notes: string | null; lat: number | null; lng: number | null; is_default: boolean;
};

const blank = { label: '', line1: '', area: '', landmark: '', delivery_notes: '' };

export function AddressManager({ kitchenId, customerId, addresses, editable, center }: {
  kitchenId: string; customerId: string; addresses: Address[]; editable: boolean; center: LatLng | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Address | 'new' | null>(null);
  const [f, setF] = useState(blank);
  const [pin, setPin] = useState<LatLng | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  function open(a: Address | 'new') {
    setEditing(a);
    setError('');
    if (a === 'new') {
      setF(blank);
      setPin(null);
    } else {
      setF({ label: a.label ?? '', line1: a.line1 ?? '', area: a.area ?? '', landmark: a.landmark ?? '', delivery_notes: a.delivery_notes ?? '' });
      setPin(a.lat && a.lng ? { lat: a.lat, lng: a.lng } : null);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const supabase = supabaseBrowser();
    const values = { ...f, lat: pin?.lat ?? null, lng: pin?.lng ?? null };
    const { error } =
      editing === 'new'
        ? await supabase.from('addresses').insert({ ...values, kitchen_id: kitchenId, customer_id: customerId, is_default: addresses.length === 0 })
        : await supabase.from('addresses').update(values).eq('id', (editing as Address).id);
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setEditing(null);
    router.refresh();
  }

  async function makeDefault(id: string) {
    const { error } = await supabaseBrowser().from('addresses').update({ is_default: true }).eq('id', id);
    if (error) return setError(friendlyError(error));
    router.refresh();
  }

  return (
    <Card title="Addresses" actions={editable && !editing && <Button variant="secondary" onClick={() => open('new')}>Add address</Button>}>
      {!editing && (
        <ul className="divide-y divide-ink-100">
          {addresses.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 py-3 text-sm">
              <div>
                <div className="font-medium">
                  {a.label || [a.line1, a.area].filter(Boolean).join(', ') || 'Address'} {a.is_default && <Badge tone="green">Default</Badge>}
                </div>
                <div className="text-ink-500">{[a.line1, a.landmark, a.area].filter(Boolean).join(', ')}</div>
                {a.delivery_notes && <div className="text-ink-500">Note: {a.delivery_notes}</div>}
                <div className="text-xs text-ink-400">{a.lat && a.lng ? '📍 Pin saved' : 'No map pin yet'}</div>
              </div>
              {editable && (
                <div className="flex shrink-0 gap-1">
                  {!a.is_default && <Button variant="ghost" onClick={() => makeDefault(a.id)}>Make default</Button>}
                  <Button variant="ghost" onClick={() => open(a)}>Edit</Button>
                </div>
              )}
            </li>
          ))}
          {addresses.length === 0 && <li className="py-3 text-sm text-ink-500">No address yet.</li>}
        </ul>
      )}
      {editing && (
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label"><Input value={f.label} onChange={set('label')} placeholder="Home / Office" /></Field>
            <Field label="Flat / house"><Input value={f.line1} onChange={set('line1')} /></Field>
            <Field label="Area"><Input value={f.area} onChange={set('area')} /></Field>
            <Field label="Landmark"><Input value={f.landmark} onChange={set('landmark')} /></Field>
          </div>
          <Field label="Delivery notes"><Input value={f.delivery_notes} onChange={set('delivery_notes')} /></Field>
          <LocationPicker value={pin} onChange={setPin} center={center} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save address'}</Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </form>
      )}
      <div className="mt-2"><Alert>{error}</Alert></div>
    </Card>
  );
}
