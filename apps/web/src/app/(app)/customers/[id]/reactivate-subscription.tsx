'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { addDays, formatServiceDate } from '@tiffin/core';
import type { ReactivateResult } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Field, Input } from '@/components/ui';

// Reactivate a cancelled subscription (reactivate_subscription, D-122): meals come back from today
// or a later date (up to 90 days). The balance rules still apply, so the result may be low balance
// or suspended on an empty prepaid balance; we say so before the page refreshes.
export function ReactivateSubscription({ subscriptionId, today }: { subscriptionId: string; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ tone: 'green' | 'amber'; text: string } | null>(null);

  async function reactivate() {
    setBusy(true);
    setError('');
    const { data, error } = await supabaseBrowser().rpc('reactivate_subscription', {
      p_subscription: subscriptionId,
      p_from: from && from !== today ? from : undefined,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    const res = data as unknown as ReactivateResult;
    const when = formatServiceDate(res.from_date);
    setDone(
      res.status === 'suspended'
        ? { tone: 'amber', text: `Reactivated from ${when}, but the prepaid balance is empty, so it is suspended. Meals restart once a payment is recorded.` }
        : res.status === 'low_balance'
          ? { tone: 'amber', text: `Reactivated from ${when}. The balance is low: remind the customer to pay.` }
          : { tone: 'green', text: `Reactivated. Meals start again from ${when}.` },
    );
    setOpen(false);
  }

  return (
    <div className="mt-2 space-y-2">
      {!open && !done && (
        <Button variant="secondary" className="px-3 py-1" onClick={() => { setOpen(true); setDone(null); setError(''); }} data-testid="reactivate">
          Reactivate
        </Button>
      )}
      {open && (
        <div className="space-y-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
          <Field label="Meals start again from" hint="Today or a later date (up to 90 days). Same plan and number of tiffins.">
            <Input type="date" min={today} max={addDays(today, 90)} value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-48" />
          </Field>
          <div className="flex gap-2">
            <Button onClick={reactivate} disabled={busy || !from} data-testid="confirm-reactivate">{busy ? 'Saving…' : 'Reactivate'}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
          </div>
        </div>
      )}
      {done && (
        <div className="flex flex-wrap items-center gap-2">
          <Alert tone={done.tone}>{done.text}</Alert>
          {/* Refreshing moves the subscription out of the cancelled state (and this box away). */}
          <Button variant="secondary" className="px-3 py-1" onClick={() => router.refresh()} data-testid="reactivate-ok">OK</Button>
        </div>
      )}
      <Alert>{error}</Alert>
    </div>
  );
}
