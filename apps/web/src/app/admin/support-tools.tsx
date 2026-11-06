'use client';

// Founder support tools (wave 4). Every action needs a reason and is written to admin_actions.
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatPhone, normalizePhone } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Field, Input, Select } from '@/components/ui';

/** Masked number with a logged Reveal (audit_log + admin_actions). */
export function RevealMemberPhone({ userId, kitchenId, masked }: { userId: string; kitchenId: string; masked: string | null }) {
  const [phone, setPhone] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function reveal() {
    setError('');
    const { data, error } = await supabaseBrowser().rpc('admin_reveal_member_phone', { p_user: userId, p_kitchen: kitchenId });
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
      <span className="font-mono text-ink-700">{masked ?? 'No phone'}</span>
      {masked && <button type="button" onClick={reveal} className="text-xs text-brand-700 hover:underline" title="Logged">Reveal</button>}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}

/** Lost or changed SIM: the admin-change-phone Edge Function changes the login number. */
export function ChangePhoneForm({ userId, name }: { userId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'red' | 'green' | 'amber'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const e164 = normalizePhone(phone);
    if (!e164) return setMsg({ tone: 'red', text: friendlyError({ message: 'invalid_phone' }) });
    if (!reason.trim()) return setMsg({ tone: 'red', text: friendlyError({ message: 'reason_required' }) });
    if (!window.confirm(`Change ${name}'s login number to ${formatPhone(e164)}? They are signed out everywhere and log in with the new number.`)) return;
    setBusy(true);
    const { data, error } = await supabaseBrowser().functions.invoke<{ signed_out?: boolean }>('admin-change-phone', { body: { user_id: userId, new_phone: e164, reason } });
    setBusy(false);
    if (error) {
      const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
      return setMsg({ tone: 'red', text: friendlyError({ message: body?.error ?? error.message }) });
    }
    setMsg(data?.signed_out === false
      ? { tone: 'amber', text: 'Number changed, but signing them out of other devices failed. Use “Sign out everywhere” below.' }
      : { tone: 'green', text: 'Number changed. They were signed out and can log in with the new number.' });
    setPhone('');
    setReason('');
    router.refresh();
  }

  if (!open) return <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setOpen(true)}>Change phone</button>;
  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded-lg bg-ink-50 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="New mobile number"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric" placeholder="98610 00000" required /></Field>
        <Field label="Reason (kept in the admin log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lost SIM, checked on a call" maxLength={500} required /></Field>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? 'Changing…' : 'Change number'}</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** Hand the kitchen to another member; the old owner becomes staff or leaves. */
export function TransferOwnershipForm({ kitchenId, members }: { kitchenId: string; members: { member_id: string; name: string }[] }) {
  const router = useRouter();
  const [member, setMember] = useState(members[0]?.member_id ?? '');
  const [oldOwner, setOldOwner] = useState<'staff' | 'remove'>('staff');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!members.length) return <p className="text-sm text-ink-500">Invite the new owner as staff first; then they can be made owner here.</p>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const who = members.find((m) => m.member_id === member)?.name ?? 'this member';
    if (!window.confirm(`Make ${who} the owner of this kitchen? The current owner ${oldOwner === 'staff' ? 'becomes staff' : 'is removed'}.`)) return;
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('admin_transfer_ownership', { p_kitchen: kitchenId, p_member: member, p_old_owner: oldOwner, p_reason: reason });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: 'Ownership transferred.' });
    setReason('');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="New owner">
          <Select value={member} onChange={(e) => setMember(e.target.value)}>
            {members.map((m) => <option key={m.member_id} value={m.member_id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="The current owner">
          <Select value={oldOwner} onChange={(e) => setOldOwner(e.target.value as 'staff' | 'remove')}>
            <option value="staff">becomes staff</option>
            <option value="remove">leaves the kitchen</option>
          </Select>
        </Field>
      </div>
      <Field label="Reason (kept in the admin log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required /></Field>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>{busy ? 'Transferring…' : 'Transfer ownership'}</Button>
    </form>
  );
}

/** Approve (or withdraw approval for) a vendor application: approved numbers may create a kitchen. */
export function ApproveApplicationButton({ id, approved, rejected }: { id: string; approved: boolean; rejected: boolean }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function set(value: boolean) {
    const reason = window.prompt(value ? 'Approve this number to create a kitchen. Note (optional):' : 'Withdraw the approval? Reason:') ;
    if (reason === null) return;
    setBusy(true);
    setError('');
    const { error } = await supabaseBrowser().rpc('admin_set_vendor_approval', { p_id: id, p_approved: value, p_reason: reason || undefined });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  if (rejected && !approved) return null;
  return (
    <span className="inline-flex items-center gap-2">
      {approved
        ? <button type="button" disabled={busy} className="text-xs text-ink-500 hover:underline" onClick={() => set(false)}>Withdraw approval</button>
        : <Button variant="secondary" className="px-2 py-1 text-xs" disabled={busy} onClick={() => set(true)}>Approve number</Button>}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}

/** Lost or stolen phone: end every session of this person (they log in again with a code). */
export function SignOutEverywhere({ userId, name }: { userId: string; name: string }) {
  const [msg, setMsg] = useState<{ tone: 'red' | 'green' | 'amber'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    const reason = window.prompt(`Sign ${name} out on every device? Reason (kept in the admin log):`)?.trim();
    if (!reason) return;
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabaseBrowser().rpc('admin_sign_out_user', { p_user: userId, p_reason: reason });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    const ok = (data as { signed_out?: boolean } | null)?.signed_out;
    setMsg(ok ? { tone: 'green', text: 'Signed out everywhere.' } : { tone: 'amber', text: 'Signing out failed. Try again in a minute.' });
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className="text-xs text-brand-700 hover:underline" onClick={run} disabled={busy}>{busy ? 'Signing out…' : 'Sign out everywhere'}</button>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </span>
  );
}
