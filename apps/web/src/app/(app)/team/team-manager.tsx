'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatPhone } from '@tiffin/core';
import type { MemberRole } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Badge, Button, Card, Field, Input, ROLE_LABEL, Select } from '@/components/ui';

type Member = { id: string; user_id: string; role: MemberRole; display_name: string | null };
type Invite = { id: string; phone_e164: string; role: MemberRole; display_name: string | null };

export function TeamManager({ kitchenId, members, invites, currentUserId }: { kitchenId: string; members: Member[]; invites: Invite[]; currentUserId: string }) {
  const router = useRouter();
  const [f, setF] = useState({ phone: '', role: 'staff' as MemberRole, name: '' });
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  async function run(p: PromiseLike<{ error: { message?: string; code?: string } | null }>, ok?: string) {
    const { error } = await p;
    setMsg(error ? { tone: 'red', text: friendlyError(error) } : ok ? { tone: 'green', text: ok } : null);
    if (!error) router.refresh();
    return !error;
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    const supabase = supabaseBrowser();
    const { data, error } = await supabase.rpc('invite_member', { p_kitchen: kitchenId, p_phone: f.phone, p_role: f.role, p_display_name: f.name || undefined });
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    const status = (data as { status: string }).status;
    setMsg({ tone: 'green', text: status === 'added' ? 'Added. They can log in now.' : 'Invited. They join automatically when they first log in with this number.' });
    setF({ phone: '', role: 'staff', name: '' });
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Members">
        <ul className="divide-y divide-ink-100">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-3 text-sm">
              <div className="font-medium">
                {m.display_name || 'Unnamed'} {m.user_id === currentUserId && <span className="text-ink-500">(you)</span>}
              </div>
              {m.role === 'owner' ? (
                <Badge tone="blue">Owner</Badge>
              ) : (
                <div className="flex items-center gap-2">
                  <Select className="w-28" value={m.role} onChange={(e) => run(supabaseBrowser().rpc('set_member_role', { p_member: m.id, p_role: e.target.value as MemberRole }), 'Role updated.')}>
                    <option value="staff">Staff</option>
                    <option value="rider">Rider</option>
                  </Select>
                  <Button variant="ghost" onClick={() => confirm(`Remove ${m.display_name || 'this member'}?`) && run(supabaseBrowser().rpc('remove_member', { p_member: m.id }), 'Removed.')}>Remove</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {invites.length > 0 && (
          <>
            <h3 className="mt-6 text-sm font-semibold text-ink-700">Waiting for first login</h3>
            <ul className="divide-y divide-ink-100">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <div className="font-medium">{i.display_name || formatPhone(i.phone_e164)}</div>
                    <div className="text-ink-500">{formatPhone(i.phone_e164)} · {ROLE_LABEL[i.role]}</div>
                  </div>
                  <Button variant="ghost" onClick={() => run(supabaseBrowser().rpc('revoke_invite', { p_invite: i.id }), 'Invite cancelled.')}>Cancel</Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card title="Add staff or rider">
        <form onSubmit={invite} className="space-y-4">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Rina" /></Field>
          <Field label="Mobile number" hint="They log in with this number using an OTP. No password."><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" required /></Field>
          <Field label="Role">
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as MemberRole })}>
              <option value="staff">Staff (kitchen work)</option>
              <option value="rider">Rider (deliveries)</option>
            </Select>
          </Field>
          <Button type="submit">Add</Button>
        </form>
        <div className="mt-3">{msg && <Alert tone={msg.tone}>{msg.text}</Alert>}</div>
      </Card>
    </div>
  );
}
