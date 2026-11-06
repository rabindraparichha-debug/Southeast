'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatPhone } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Field, Select, Textarea } from '@/components/ui';
import type { TeamMember } from '../types';

type Result = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

// Take, hand on, note or resolve an escalated complaint (D-132). Every action is logged.
export function ComplaintActions({ complaintId, resolved, assignedTo, team }: {
  complaintId: string; resolved: boolean; assignedTo: string | null; team: TeamMember[];
}) {
  const router = useRouter();
  const supabase = supabaseBrowser();
  const [to, setTo] = useState(team.find((m) => m.id !== assignedTo)?.id ?? '');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const me = team.find((m) => m.me);

  async function run(fn: () => Result, ok: string, clear = false) {
    setBusy(true);
    setMsg(null);
    const { error } = await fn();
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: ok });
    if (clear) setNote('');
    router.refresh();
  }

  if (resolved) return <p className="text-sm text-ink-500">Resolved. Nothing more to do.</p>;

  return (
    <div className="space-y-4 text-sm">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex flex-wrap items-end gap-2">
        {me && assignedTo !== me.id && (
          <Button variant="secondary" disabled={busy}
            onClick={() => run(() => supabase.rpc('admin_assign_complaint', { p_complaint: complaintId }), 'It is yours now.')}>
            Take it
          </Button>
        )}
        <Field label="Hand to" className="min-w-40 flex-1">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            {team.filter((m) => m.id !== assignedTo).map((m) => <option key={m.id} value={m.id}>{m.name}{m.me ? ' (me)' : ''}</option>)}
          </Select>
        </Field>
        <Button variant="secondary" disabled={busy || !to}
          onClick={() => run(() => supabase.rpc('admin_assign_complaint', { p_complaint: complaintId, p_admin: to, p_note: note.trim() || undefined }),
            'Handed on.', true)}>
          Hand on
        </Button>
      </div>
      <Field label="Note" hint="Saved in the team log. To resolve, the customer also sees it on their page.">
        <Textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy || !note.trim()}
          onClick={() => run(() => supabase.rpc('admin_note_complaint', { p_complaint: complaintId, p_note: note.trim() }), 'Note saved.', true)}>
          Add note
        </Button>
        <Button disabled={busy || !note.trim()}
          onClick={() => {
            if (!window.confirm('Resolve this complaint on the kitchen’s behalf? The customer sees your note on their page.')) return;
            void run(() => supabase.rpc('admin_resolve_complaint', { p_complaint: complaintId, p_note: note.trim() }), 'Resolved.', true);
          }}>
          Resolve with this note
        </Button>
      </div>
      <p className="text-xs text-ink-500">Free meals are the kitchen’s money: ask the owner to credit them from their app if needed.</p>
    </div>
  );
}

// Shows the masked number; revealing calls a logged RPC (audit log + the complaint's team log).
export function RevealComplaintPhone({ complaintId, who, masked }: { complaintId: string; who: 'customer' | 'owner'; masked: string }) {
  const [phone, setPhone] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function reveal() {
    setError('');
    const { data, error } = await supabaseBrowser().rpc('admin_reveal_complaint_phone', { p_complaint: complaintId, p_who: who });
    if (error) return setError(friendlyError(error));
    setPhone(data);
  }
  if (phone) {
    return (
      <span className="inline-flex items-center gap-2">
        <a href={`tel:${phone}`} className="font-medium text-brand-700 hover:underline">{formatPhone(phone)}</a>
        <a href={`https://wa.me/${phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className="text-xs text-ink-500 hover:underline">WhatsApp</a>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-ink-700">{masked}</span>
      <button type="button" onClick={reveal} className="text-xs text-brand-700 hover:underline" title="Logged in the audit log">Reveal</button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
