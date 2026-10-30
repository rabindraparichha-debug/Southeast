'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Input } from '@/components/ui';

export function FlagToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function toggle() {
    const next = !enabled;
    if (next && !window.confirm('Turn kitchen switching ON for all platform customers? Only do this once legal has cleared it.')) return;
    setBusy(true);
    setError('');
    const { error } = await supabaseBrowser().rpc('admin_set_platform_flag', { p_key: 'kitchen_switching', p_enabled: next });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  return (
    <>
      <Button variant={enabled ? 'secondary' : 'danger'} onClick={toggle} disabled={busy} data-testid="switch-flag">
        {enabled ? 'Turn OFF' : 'Turn ON'}
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </>
  );
}

export function SwitchDecision({ id }: { id: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  async function decide(approve: boolean) {
    if (approve && !window.confirm('Approve? The old subscription ends at the first open date and unused meals are refunded.')) return;
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabaseBrowser().rpc('admin_decide_switch', { p_request: id, p_approve: approve, ...(note.trim() ? { p_note: note.trim() } : {}) });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    const d = data as { status: string; effective_date?: string; trial_amount_paise?: number } | null;
    setMsg({ tone: 'green', text: approve ? `Approved from ${d?.effective_date}. Trial ${d?.trial_amount_paise ? formatPaise(d.trial_amount_paise) : ''}` : 'Rejected.' });
    router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="max-w-xs" maxLength={300} />
      <Button onClick={() => decide(true)} disabled={busy}>Approve</Button>
      <Button variant="danger" onClick={() => decide(false)} disabled={busy}>Reject</Button>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </div>
  );
}
