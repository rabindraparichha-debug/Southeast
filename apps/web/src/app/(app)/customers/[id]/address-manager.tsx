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
  const [defaulting, setDefaulting] = useState<string | null>(null);
  const [done, setDone] = useState('');
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

  // "Make default" alone does not move meals; the owner can apply it to every live subscription
  // from today (a permanent address change, so meals and the rider's runs follow, D-124).
  async function makeDefault(id: string, apply: boolean) {
    setBusy(true);
    setError('');
    const { data, error } = await supabaseBrowser().rpc('set_default_address', { p_address: id, p_apply_to_subscriptions: apply });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    const moved = (data as { subscriptions_moved?: number } | null)?.subscriptions_moved ?? 0;
    setDefaulting(null);
    setDone(apply
      ? moved ? `Default changed. Meals go to this address from today (${moved} subscription${moved > 1 ? 's' : ''} moved).` : 'Default changed. There is no live subscription to move.'
      : 'Default changed. Meals already planned keep their address.');
    router.refresh();
  }

  return (
    <Card title="Addresses" actions={editable && !editing && <Button variant="secondary" onClick={() => open('new')}>Add address</Button>}>
      {!editing && (
        <ul className="divide-y divide-ink-100">
          {addresses.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {a.label || [a.line1, a.area].filter(Boolean).join(', ') || 'Address'} {a.is_default && <Badge tone="green">Default</Badge>}
                </div>
                <div className="text-ink-500">{[a.line1, a.landmark, a.area].filter(Boolean).join(', ')}</div>
                {a.delivery_notes && <div className="text-ink-500">Note: {a.delivery_notes}</div>}
                <div className="text-xs text-ink-400">{a.lat && a.lng ? '📍 Pin saved' : 'No map pin yet'}</div>
                {defaulting === a.id && (
                  <div className="mt-2 space-y-2 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200" data-testid="make-default">
                    <p>Deliver this customer’s meals here from today?</p>
                    <div className="flex flex-wrap gap-2">
                      <Button className="px-3 py-1" disabled={busy} onClick={() => makeDefault(a.id, true)}>Yes, move meals here</Button>
                      <Button variant="secondary" className="px-3 py-1" disabled={busy} onClick={() => makeDefault(a.id, false)}>Only mark as default</Button>
                      <Button variant="ghost" className="px-3 py-1" onClick={() => setDefaulting(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
              {editable && (
                <div className="flex shrink-0 gap-1">
                  {!a.is_default && <Button variant="ghost" onClick={() => { setDefaulting(a.id); setDone(''); setError(''); }}>Make default</Button>}
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
      {done && <div className="mt-2"><Alert tone="green">{done}</Alert></div>}
      <div className="mt-2"><Alert>{error}</Alert></div>
    </Card>
  );
}
