'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button } from '@/components/ui';

export function MoneyActions({ kind, id, online = false }: { kind: 'pending' | 'refund'; id: string; online?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(true);
    setError('');
    const { error } = await fn();
    setBusy(false);
    if (error) {
      const ctx = (error as { context?: Response }).context;
      const body = ctx ? await ctx.json().catch(() => null) : null;
      return setError(friendlyError({ message: body?.error ?? (error as { message?: string }).message }));
    }
    router.refresh();
  }

  const s = supabaseBrowser();
  return (
    <span className="flex flex-wrap items-center gap-1">
      {kind === 'pending' ? (
        <>
          <Button variant="secondary" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => run(() => s.rpc('confirm_payment', { p_payment: id }))}>Confirm</Button>
          <Button variant="ghost" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => run(() => s.rpc('reject_payment', { p_payment: id, p_reason: 'Not received' }))}>Not received</Button>
        </>
      ) : (
        <>
          <Button variant="secondary" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => run(() => s.rpc('mark_refund_paid', { p_refund: id, p_method: 'cash' }))}>Paid cash</Button>
          <Button variant="secondary" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => run(() => s.rpc('mark_refund_paid', { p_refund: id, p_method: 'upi_manual' }))}>Paid UPI</Button>
          {online && <Button variant="secondary" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => run(() => s.functions.invoke('razorpay-refund', { body: { refund_id: id } }))}>Refund online</Button>}
        </>
      )}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
