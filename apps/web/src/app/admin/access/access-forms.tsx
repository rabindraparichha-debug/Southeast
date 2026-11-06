'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { normalizePhone } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Field, Input, Select } from '@/components/ui';

type Result = { error: { message?: string; code?: string } | null };

function useAction() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => PromiseLike<Result>, ok: string) {
    setBusy(true);
    setMsg(null);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      setMsg({ tone: 'red', text: friendlyError(error) });
      return false;
    }
    setMsg({ tone: 'green', text: ok });
    router.refresh();
    return true;
  }
  return { msg, busy, run };
}

/** platform_settings.open_vendor_signup: anyone who logs in may create a kitchen (default off). */
export function OpenSignupToggle({ enabled }: { enabled: boolean }) {
  const { msg, busy, run } = useAction();
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} disabled={busy}
          onChange={(e) => {
            const on = e.target.checked;
            if (on && !window.confirm('Let anyone who logs in create a kitchen without approval?')) return;
            void run(() => supabaseBrowser().rpc('admin_set_platform_flag', { p_key: 'open_vendor_signup', p_enabled: on }), on ? 'Signup is open.' : 'Signup needs approval again.');
          }} />
        Anyone who logs in may create a kitchen (no approval)
      </label>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </div>
  );
}

export function AllowPhoneForm() {
  const { msg, busy, run } = useAction();
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const e164 = normalizePhone(phone);
    if (!e164) return;
    if (await run(() => supabaseBrowser().rpc('admin_allow_vendor_phone', { p_phone: e164, p_note: note }), 'Number allowed.')) {
      setPhone('');
      setNote('');
    }
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Mobile number"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric" placeholder="98610 00000" required /></Field>
        <Field label="Who is it (kept in the admin log)"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Sujata, home cook in Patia" required /></Field>
      </div>
      {phone && !normalizePhone(phone) && <p className="text-xs text-red-700">{friendlyError({ message: 'invalid_phone' })}</p>}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Button type="submit" disabled={busy || !normalizePhone(phone) || !note.trim()}>Allow number</Button>
    </form>
  );
}

export function RemoveAllowedPhone({ id }: { id: string }) {
  const { msg, busy, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={busy} className="text-xs text-red-700 hover:underline"
        onClick={() => {
          const reason = window.prompt('Remove this number? Reason (optional):');
          if (reason === null) return;
          void run(() => supabaseBrowser().rpc('admin_remove_vendor_phone', { p_id: id, p_reason: reason || undefined }), 'Removed.');
        }}>Remove</button>
      {msg?.tone === 'red' && <span className="text-xs text-red-700">{msg.text}</span>}
    </span>
  );
}

export function AddAdminForm() {
  const { msg, busy, run } = useAction();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const e164 = normalizePhone(phone);
    if (!e164) return;
    if (await run(() => supabaseBrowser().rpc('admin_add_platform_admin', { p_phone: e164, p_reason: reason }), 'Admin added.')) {
      setPhone('');
      setReason('');
    }
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Their mobile number (they must have logged in once)"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric" required /></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required /></Field>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Button type="submit" disabled={busy || !normalizePhone(phone) || !reason.trim()}>Add admin</Button>
    </form>
  );
}

export function RemoveAdmin({ userId, isMe }: { userId: string; isMe: boolean }) {
  const { msg, busy, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={busy} className="text-xs text-red-700 hover:underline"
        onClick={() => {
          const reason = window.prompt(isMe ? 'Remove YOURSELF as admin? Reason:' : 'Remove this admin? Reason:');
          if (!reason?.trim()) return;
          void run(() => supabaseBrowser().rpc('admin_remove_platform_admin', { p_user: userId, p_reason: reason }), 'Removed.');
        }}>Remove</button>
      {msg?.tone === 'red' && <span className="text-xs text-red-700">{msg.text}</span>}
    </span>
  );
}

export function ResolveCloseRequest({ id }: { id: string }) {
  const { msg, busy, run } = useAction();
  const [status, setStatus] = useState<'closed' | 'declined'>('closed');
  const [note, setNote] = useState('');
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => supabaseBrowser().rpc('admin_resolve_close_request', { p_id: id, p_status: status, p_note: note }), 'Recorded.');
      }}>
      <Field label="Outcome">
        <Select value={status} onChange={(e) => setStatus(e.target.value as 'closed' | 'declined')}>
          <option value="closed">Done (export sent, kitchen closed)</option>
          <option value="declined">Declined / owner changed their mind</option>
        </Select>
      </Field>
      <Field label="Note" className="min-w-60 flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} required /></Field>
      <Button type="submit" variant="secondary" disabled={busy || !note.trim()}>Record</Button>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </form>
  );
}
