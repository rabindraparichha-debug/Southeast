'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { shortDate } from '@/lib/p5';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@/components/ui';

type Entry = { id: string; kind: string; name: string; starts_on: string; ends_on: string; veg_only: boolean; notes: string | null };
type Form = { id: string | null; kind: 'festival' | 'kartika'; name: string; starts_on: string; ends_on: string; veg_only: boolean; notes: string };
const BLANK: Form = { id: null, kind: 'festival', name: '', starts_on: '', ends_on: '', veg_only: false, notes: '' };

export function CalendarEditor({ entries, showPast }: { entries: Entry[]; showPast: boolean }) {
  const router = useRouter();
  const [f, setF] = useState<Form>(BLANK);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().rpc('admin_upsert_calendar_entry', {
      ...(f.id ? { p_id: f.id } : {}), p_kind: f.kind, p_name: f.name.trim(), p_starts_on: f.starts_on,
      p_ends_on: f.ends_on || f.starts_on, p_veg_only: f.kind === 'kartika' || f.veg_only, p_notes: f.notes.trim(),
    });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: f.id ? 'Entry updated.' : 'Entry added.' });
    setF(BLANK);
    router.refresh();
  }

  async function remove(entry: Entry) {
    if (!window.confirm(`Delete “${entry.name}”?`)) return;
    const { error } = await supabaseBrowser().rpc('admin_delete_calendar_entry', { p_id: entry.id });
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    if (f.id === entry.id) setF(BLANK);
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <Card title={`Entries (${entries.length})`} actions={
        <Link href={showPast ? '/admin/calendar' : '/admin/calendar?past=1'} className="text-sm text-brand-700 hover:underline">{showPast ? 'Hide past' : 'Show past'}</Link>
      }>
        <ul className="divide-y divide-ink-100 text-sm" data-testid="calendar-list">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{e.name}</span>
                  {e.kind === 'kartika' && <Badge tone="blue">Kartika</Badge>}
                  {e.veg_only && <Badge tone="green">Veg</Badge>}
                </div>
                <div className="text-ink-500">{shortDate(e.starts_on)}{e.ends_on !== e.starts_on && ` – ${shortDate(e.ends_on)}`}{e.notes && ` · ${e.notes}`}</div>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" onClick={() => setF({ id: e.id, kind: e.kind === 'kartika' ? 'kartika' : 'festival', name: e.name, starts_on: e.starts_on, ends_on: e.ends_on, veg_only: e.veg_only, notes: e.notes ?? '' })}>Edit</Button>
                <Button variant="ghost" className="text-red-700" onClick={() => remove(e)}>Delete</Button>
              </div>
            </li>
          ))}
          {!entries.length && <li className="py-3 text-ink-500">No entries.</li>}
        </ul>
      </Card>

      <Card title={f.id ? 'Edit entry' : 'Add entry'}>
        <form onSubmit={save} className="space-y-3" data-testid="calendar-form">
          <Field label="Kind">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Form['kind'] })}>
              <option value="festival">Festival</option>
              <option value="kartika">Kartika month</option>
            </Select>
          </Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} required data-testid="cal-name" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From"><Input type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} required data-testid="cal-from" /></Field>
            <Field label="To" hint="Empty = one day"><Input type="date" value={f.ends_on} min={f.starts_on} onChange={(e) => setF({ ...f, ends_on: e.target.value })} /></Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={f.kind === 'kartika' || f.veg_only} disabled={f.kind === 'kartika'} onChange={(e) => setF({ ...f, veg_only: e.target.checked })} />
            <span>Veg-only day (customers who observe veg days get veg)</span>
          </label>
          <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={300} /></Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !f.name.trim() || !f.starts_on}>{busy ? 'Saving…' : f.id ? 'Save' : 'Add'}</Button>
            {f.id && <Button variant="ghost" onClick={() => setF(BLANK)}>Cancel</Button>}
          </div>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        </form>
      </Card>
    </div>
  );
}
