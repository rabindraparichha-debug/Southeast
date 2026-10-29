'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card, Textarea } from '@/components/ui';

export function BroadcastForm({ kitchenId, cap, used }: { kitchenId: string; cap: number; used: number }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const left = Math.max(0, cap - used);

  async function send() {
    if (!confirm('Send this to every customer who opted in to WhatsApp?')) return;
    const supabase = supabaseBrowser();
    const { data, error } = await supabase.rpc('send_broadcast', { p_kitchen: kitchenId, p_body: text });
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    await supabase.functions.invoke('whatsapp-outbox', { body: {} }).catch(() => undefined);
    setMsg({ tone: 'green', text: `Sent to ${data} customers.` });
    setText('');
    router.refresh();
  }

  return (
    <Card title="Announcement to all customers" actions={<span className="text-xs text-ink-500">{left} of {cap} left this month</span>}>
      <Textarea rows={2} maxLength={700} placeholder="e.g. Closed on Diwali (12 Nov). Special kheer on Friday!" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-2 flex items-center gap-2">
        <Button variant="secondary" onClick={send} disabled={!text.trim() || left === 0}>Send announcement</Button>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
      <p className="mt-2 text-xs text-ink-500">Only customers who agreed to WhatsApp updates receive it. Announcements are limited each month to avoid spam.</p>
    </Card>
  );
}
