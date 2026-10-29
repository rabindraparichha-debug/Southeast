'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatIstShort } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Badge, Button, Card, Input, Textarea } from '@/components/ui';

type Msg = { id: string; direction: string; body: string | null; handled_by: string; status: string; created_at: string };
type Complaint = { id: string; category: string; description: string | null; status: string; created_at: string; photo_url: string | null };

const WHO: Record<string, string> = { customer: '', bot: 'Bot', ai: 'AI', vendor: 'You', system: 'Auto' };

export function Thread({ conversationId, customerId, title, handoffOpen, unread, messages, complaints }: {
  conversationId: string; customerId: string | null; title: string; handoffOpen: boolean; unread: number; messages: Msg[]; complaints: Complaint[];
}) {
  const router = useRouter();
  const supabase = supabaseBrowser();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState<Record<string, { text: string; credit: string }>>({});

  useEffect(() => {
    if (unread > 0) void supabase.rpc('mark_conversation_read', { p_conversation: conversationId }).then(() => router.refresh());
  }, [conversationId, unread, supabase, router]);

  async function flush() {
    // Deliver right away instead of waiting for the once-a-minute worker.
    await supabase.functions.invoke('whatsapp-outbox', { body: {} }).catch(() => undefined);
  }

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    const { error } = await supabase.rpc('send_vendor_message', { p_conversation: conversationId, p_body: text });
    if (error) {
      setBusy(false);
      return setError(friendlyError(error));
    }
    await flush();
    setBusy(false);
    setText('');
    router.refresh();
  }

  async function closeHandoff() {
    const { error } = await supabase.rpc('close_conversation', { p_conversation: conversationId });
    if (error) return setError(friendlyError(error));
    router.refresh();
  }

  async function resolve(c: Complaint) {
    const n = note[c.id] ?? { text: '', credit: '0' };
    const { error } = await supabase.rpc('resolve_complaint', { p_complaint: c.id, p_note: n.text, p_credit_meals: Number(n.credit) || 0 });
    if (error) return setError(friendlyError(error));
    await flush();
    router.refresh();
  }

  return (
    <Card
      title={<span>{title} {handoffOpen && <Badge tone="amber">Bot paused · needs your reply</Badge>}</span>}
      actions={
        <div className="flex gap-2">
          {customerId && <a href={`/customers/${customerId}`} className="text-sm text-brand-700 hover:underline">Customer</a>}
          {handoffOpen && <Button variant="secondary" className="px-3 py-1" onClick={closeHandoff}>Done, hand back to bot</Button>}
        </div>
      }
    >
      {complaints.map((c) => (
        <div key={c.id} className="mb-3 rounded-lg bg-red-50 p-3 text-sm ring-1 ring-red-200">
          <div className="flex items-center justify-between">
            <strong>Complaint: {c.category}</strong>
            <Badge tone={c.status === 'escalated' ? 'red' : c.status === 'responded' ? 'blue' : 'amber'}>{c.status}</Badge>
          </div>
          {c.description && <p className="mt-1">{c.description}</p>}
          <p className="mt-1 text-xs text-ink-500">{formatIstShort(c.created_at)} · reply within 2 hours, or it goes to the platform team</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_7rem_auto]">
            <Input placeholder="Reply / resolution note" value={note[c.id]?.text ?? ''} onChange={(e) => setNote({ ...note, [c.id]: { text: e.target.value, credit: note[c.id]?.credit ?? '0' } })} />
            <Input inputMode="numeric" placeholder="Free meals" value={note[c.id]?.credit ?? ''} onChange={(e) => setNote({ ...note, [c.id]: { text: note[c.id]?.text ?? '', credit: e.target.value } })} />
            <Button variant="secondary" onClick={() => resolve(c)}>Resolve</Button>
          </div>
        </div>
      ))}

      <div className="max-h-[50vh] space-y-2 overflow-y-auto rounded-lg bg-ink-50 p-3">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.direction === 'out' ? (m.handled_by === 'vendor' ? 'bg-brand-600 text-white' : 'bg-white ring-1 ring-ink-200') : 'bg-green-100'}`}>
              {m.body}
              <div className={`mt-1 text-[10px] ${m.direction === 'out' && m.handled_by === 'vendor' ? 'text-brand-100' : 'text-ink-500'}`}>
                {WHO[m.handled_by]} {formatIstShort(m.created_at)}{m.direction === 'out' ? ` · ${m.status}` : ''}
              </div>
            </div>
          </div>
        ))}
        {messages.length === 0 && <p className="text-center text-sm text-ink-500">No messages.</p>}
      </div>

      <div className="mt-3 space-y-2">
        <Textarea rows={2} placeholder="Write a reply (sent from the platform WhatsApp number with your kitchen name)" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex items-center gap-2">
          <Button onClick={send} disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</Button>
          <Alert>{error}</Alert>
        </div>
      </div>
    </Card>
  );
}
