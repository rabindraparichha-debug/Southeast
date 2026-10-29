'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import type { VendorAppStatus } from '@/lib/public';
import { Button, Textarea } from '@/components/ui';

export function ApplicationActions({ id, status, notes }: { id: string; status: VendorAppStatus; notes: string | null }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function update(p: { p_status?: VendorAppStatus; p_notes?: string }, ok: string) {
    setBusy(true);
    setMsg('');
    const { error } = await supabaseBrowser().rpc('admin_update_vendor_application', { p_id: id, ...p });
    setBusy(false);
    if (error) return setMsg(friendlyErrorIn('admin', error));
    setMsg(ok);
    if (p.p_notes) setText('');
    router.refresh();
  }

  const stamp = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  return (
    <div className="space-y-2 text-sm">
      {notes && <p className="whitespace-pre-line rounded-lg bg-ink-50 p-2 text-xs text-ink-700">{notes}</p>}
      <div className="flex gap-2">
        <Textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note" aria-label="Note" />
        <Button variant="secondary" disabled={busy || !text.trim()}
          onClick={() => update({ p_notes: `${notes ? `${notes}\n` : ''}${stamp}: ${text.trim()}` }, 'Note saved.')}>Save</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {(status === 'new' || status === 'rejected') && (
          <Button variant="secondary" disabled={busy} onClick={() => update({ p_status: 'contacted' }, 'Marked contacted.')}>Mark contacted</Button>
        )}
        {status !== 'rejected' && status !== 'live' && (
          <Button variant="danger" disabled={busy} onClick={() => update({ p_status: 'rejected' }, 'Rejected.')}>Reject</Button>
        )}
      </div>
      {msg && <p className="text-xs text-ink-500">{msg}</p>}
    </div>
  );
}
