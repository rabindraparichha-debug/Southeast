'use client';

import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { FAIL_REASON_LABEL, type BoardStop } from '@/lib/delivery';
import { Button, Input, Select } from '@/components/ui';

const REASONS = ['not_home', 'wrong_address', 'refused', 'unreachable', 'kitchen_late', 'food_issue', 'missing_meal', 'rider_issue', 'other'] as const;

/**
 * Owner fixes a recorded outcome (audit item 25): a mis-tap, a second attempt after "not home", or
 * the wrong reason. Credits follow on the server (a kitchen-fault failure is credited; leaving one
 * reverses its credit with an adjust row). A note is required and kept on the stop. "Try again" is
 * offered on today's board only: riders see only today's runs, so a past stop could not be finished.
 */
export function CorrectStop({ stop, retryAllowed, onDone }: {
  stop: BoardStop;
  retryAllowed: boolean;
  onDone: (message: string, ok: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'delivered' | 'failed' | 'pending'>(stop.status === 'delivered' ? 'failed' : 'delivered');
  const [reason, setReason] = useState<string>(stop.failed_reason ?? 'not_home');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-brand-700 hover:underline">
        Correct
      </button>
    );
  }

  async function save() {
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('correct_stop', {
      p_stop: stop.id,
      p_status: status,
      p_reason: status === 'failed' ? (reason as (typeof REASONS)[number]) : undefined,
      p_note: note,
    });
    setBusy(false);
    if (error) {
      onDone(friendlyError(error), false);
      return;
    }
    setOpen(false);
    setNote('');
    onDone(status === 'pending' ? 'Stop is back on the run for another try.' : 'Stop corrected. Credits were updated.', true);
  }

  return (
    <div className="mt-2 ml-7 flex w-full flex-wrap items-center gap-2 rounded-lg bg-ink-50 p-2 text-xs" data-testid="correct-stop">
      <Select aria-label="Correct to" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="max-w-44">
        <option value="delivered">Delivered</option>
        <option value="failed">Not delivered</option>
        {retryAllowed && <option value="pending">Try again</option>}
      </Select>
      {status === 'failed' && (
        <Select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} className="max-w-48">
          {REASONS.map((r) => <option key={r} value={r}>{FAIL_REASON_LABEL[r] ?? r}</option>)}
        </Select>
      )}
      <Input aria-label="Why (required)" placeholder="Why? (required)" value={note} onChange={(e) => setNote(e.target.value)} className="min-w-40 flex-1" />
      <Button onClick={save} disabled={busy || !note.trim()}>Save</Button>
      <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
    </div>
  );
}
