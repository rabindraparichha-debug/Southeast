'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button, Input } from '@/components/ui';

// The platform team records that it checked the kitchen's FSSAI certificate (D-186). Verifying does
// not list the kitchen; listing stays a separate step.
export function VerifyForm({ kitchenId, verifiedAt, note, listed, hasFssai }: {
  kitchenId: string; verifiedAt: string | null; note: string | null; listed: boolean; hasFssai: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState(note ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(verified: boolean) {
    setError('');
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('admin_verify_kitchen', { p_kitchen: kitchenId, p_verified: verified, p_note: text.trim() || undefined });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  return (
    <div className="space-y-2">
      <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Note (e.g. certificate seen on video call, valid till Mar 2028)" />
      <div className="flex flex-wrap items-center gap-2">
        {!verifiedAt && <Button variant="secondary" disabled={busy || !hasFssai} title={hasFssai ? '' : 'FSSAI number required'} onClick={() => save(true)}>Verify FSSAI</Button>}
        {verifiedAt && !listed && <Button variant="ghost" disabled={busy} onClick={() => save(false)}>Remove verification</Button>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  );
}
