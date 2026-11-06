'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Badge, Button, Card, Field, Select, Textarea } from '@/components/ui';

// Wave 4: complaints for this customer, from every channel, and "Log a complaint" for the ones
// that come in by phone (log_complaint, channel 'vendor'). Owner only.
const CATEGORY: Record<string, string> = {
  late: 'Late', quality: 'Food quality', quantity: 'Quantity', missing: 'Missing tiffin', hygiene: 'Hygiene',
  delivery: 'Delivery', billing: 'Billing', privacy: 'Privacy', other: 'Other',
};
const CHANNEL: Record<string, string> = { vendor: 'by phone', whatsapp: 'on WhatsApp', web: 'on the customer page' };
const STATUS_TONE: Record<string, 'gray' | 'green' | 'amber' | 'red'> = { open: 'amber', responded: 'gray', resolved: 'green', escalated: 'red' };

type Complaint = { id: string; category: string; description: string | null; channel: string; status: string; created_at: string; resolution_note: string | null };
type Loaded = { rows: Complaint[]; subs: { id: string; label: string }[] };

async function fetchComplaints(customerId: string): Promise<Loaded> {
  const supabase = supabaseBrowser();
  const [{ data: list }, { data: s }] = await Promise.all([
    supabase.from('complaints').select('id, category, description, channel, status, created_at, resolution_note')
      .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(20),
    supabase.from('subscriptions').select('id, status, plan:plans(name)').eq('customer_id', customerId).neq('status', 'cancelled'),
  ]);
  return {
    rows: (list ?? []) as Complaint[],
    subs: (s ?? []).map((x) => ({ id: x.id, label: x.plan?.name ?? 'Subscription' })),
  };
}

export function ComplaintsCard({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<Complaint[]>([]);
  const [subs, setSubs] = useState<{ id: string; label: string }[]>([]);
  const [category, setCategory] = useState('quality');
  const [note, setNote] = useState('');
  const [sub, setSub] = useState('');
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((d: Loaded) => {
    setRows(d.rows);
    setSubs(d.subs);
  }, []);
  const load = useCallback(async () => apply(await fetchComplaints(customerId)), [apply, customerId]);

  useEffect(() => {
    let alive = true;
    void fetchComplaints(customerId).then((d) => {
      if (alive) apply(d);
    });
    return () => {
      alive = false;
    };
  }, [apply, customerId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().rpc('log_complaint', {
      p_customer: customerId, p_category: category, p_note: note.trim() || undefined, p_subscription: sub || undefined,
    });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setNote('');
    setMsg({ tone: 'green', text: 'Complaint logged.' });
    await load();
  }

  async function resolve(id: string) {
    const text = window.prompt('How was it resolved? (sent to the customer on WhatsApp if they opted in; leave empty to just close it)');
    if (text === null) return;
    const { error } = await supabaseBrowser().rpc('resolve_complaint', { p_complaint: id, p_note: text });
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    await load();
  }

  const day = (at: string) => new Date(at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });

  return (
    <Card title="Complaints">
      <form onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What about">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          {subs.length > 1 && (
            <Field label="Subscription (optional)">
              <Select value={sub} onChange={(e) => setSub(e.target.value)}>
                <option value="">—</option>
                {subs.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            </Field>
          )}
        </div>
        <Field label="What the customer said">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Dal was cold on Tuesday" />
        </Field>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Button type="submit" variant="secondary" disabled={busy}>{busy ? 'Saving…' : 'Log complaint'}</Button>
      </form>
      <ul className="mt-4 divide-y divide-ink-100 text-sm">
        {rows.map((r) => (
          <li key={r.id} className="py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{CATEGORY[r.category] ?? r.category}</span>
              <Badge tone={STATUS_TONE[r.status] ?? 'gray'}>{r.status}</Badge>
              <span className="text-xs text-ink-500">{day(r.created_at)} · {CHANNEL[r.channel] ?? r.channel}</span>
              {r.status !== 'resolved' && <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => void resolve(r.id)}>Resolve</button>}
            </div>
            {r.description && <p className="text-ink-700">{r.description}</p>}
            {r.resolution_note && <p className="text-xs text-ink-500">Resolved: {r.resolution_note}</p>}
          </li>
        ))}
        {!rows.length && <li className="py-2 text-ink-500">No complaints.</li>}
      </ul>
    </Card>
  );
}
