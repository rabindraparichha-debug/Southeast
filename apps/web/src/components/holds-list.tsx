'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL, formatServiceDate } from '@tiffin/core';
import type { ChangeResult, MealSlot, SubscriptionHold } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Badge, Button } from './ui';
import { ChangePreview, savedMessage, useScheduleSaved } from './change-preview';

// Upcoming skips and pauses of a customer (subscription_holds) with Undo for the owner
// (revoke_schedule_change: preview first, then confirm). Used on the customer page and the phone desk.

export type Hold = Omit<SubscriptionHold, 'to_date' | 'slot' | 'note' | 'resumed_from'> & {
  to_date: string | null;
  slot: MealSlot | null;
  note: string | null;
  resumed_from: string | null;
  /** Set by loadHolds (src/lib/holds.ts). */
  subscription_id?: string;
  /** Shown when the customer has more than one subscription. */
  plan_name?: string | null;
};

const CHANNEL_LABEL = { whatsapp: 'WhatsApp', web: 'Customer page', vendor: 'By phone', rider: 'Rider' } as const;

export function holdDates(h: Pick<Hold, 'type' | 'from_date' | 'to_date'>): string {
  if (!h.to_date) return `from ${formatServiceDate(h.from_date)} (open-ended)`;
  if (h.to_date === h.from_date) return formatServiceDate(h.from_date);
  return `${formatServiceDate(h.from_date)} – ${formatServiceDate(h.to_date)}`;
}

export function HoldsList({ holds, canUndo, onChanged, compact }: {
  holds: Hold[];
  canUndo: boolean;
  /** Called after an undo is saved (default: refresh the page's server data). */
  onChanged?: (message: string) => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChangeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const announceSaved = useScheduleSaved(setDone);

  async function undo(changeId: string, dryRun: boolean) {
    setBusy(true);
    setError('');
    if (dryRun) setDone('');
    const { data, error } = await supabaseBrowser().rpc('revoke_schedule_change', { p_change: changeId, p_dry_run: dryRun });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    const res = data as unknown as ChangeResult;
    if (dryRun) {
      setOpen(changeId);
      setPreview(res);
      return;
    }
    const msg = savedMessage('Undo', 'revoke', res);
    setOpen(null);
    setPreview(null);
    setDone(msg);
    announceSaved();
    if (onChanged) onChanged(msg);
    else router.refresh();
  }

  if (holds.length === 0) {
    return (
      <div className="space-y-2">
        {done && <Alert tone="green">{done}</Alert>}
        <p className="text-sm text-ink-500">No upcoming skips or pauses.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {done && <Alert tone="green">{done}</Alert>}
      <ul className="divide-y divide-ink-100" data-testid="holds-list">
        {holds.map((h) => (
          <li key={h.change_id} className={compact ? 'py-2 text-sm' : 'py-3 text-sm'}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium">
                  {h.type === 'pause' ? 'Pause' : 'Skip'} {holdDates(h)}
                  {h.slot ? ` · ${SLOT_LABEL[h.slot]} only` : ''}
                  {h.plan_name ? <span className="font-normal text-ink-500"> · {h.plan_name}</span> : null}
                </div>
                <div className="text-xs text-ink-500">
                  {CHANNEL_LABEL[h.channel]} · {new Date(h.requested_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}
                  {h.resumed_from ? ` · ends ${formatServiceDate(h.resumed_from)} (resumed)` : ''}
                  {h.note ? ` · ${h.note}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {h.after_cutoff && <Badge tone="amber">Late</Badge>}
                {canUndo && open !== h.change_id && (
                  <Button variant="secondary" className="px-3 py-1" disabled={busy} onClick={() => undo(h.change_id, true)}
                    data-testid={`undo-${h.change_id}`}>
                    Undo
                  </Button>
                )}
              </div>
            </div>
            {open === h.change_id && preview && (
              <div className="mt-2 space-y-2 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
                <ChangePreview preview={preview} type="revoke" waive={false} />
                <p className="text-xs text-ink-500">Meals already past their cutoff stay as they are (a late skip stays charged).</p>
                <div className="flex gap-2">
                  <Button onClick={() => undo(h.change_id, false)} disabled={busy} data-testid="confirm-undo">{busy ? 'Saving…' : 'Confirm undo'}</Button>
                  <Button variant="ghost" onClick={() => { setOpen(null); setPreview(null); }}>Back</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!canUndo && <p className="text-xs text-ink-500">Only the owner can undo a skip or pause.</p>}
      <Alert>{error}</Alert>
    </div>
  );
}
