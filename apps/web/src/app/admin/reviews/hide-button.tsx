'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button } from '@/components/ui';

// Hides a review from the kitchen's public page (and its rating), or shows it again. Audited.
export function HideButton({ reviewId, hidden }: { reviewId: string; hidden: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function toggle() {
    setBusy(true);
    setError('');
    const { error } = await supabaseBrowser().rpc('admin_hide_review', { p_review: reviewId, p_hidden: !hidden });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant={hidden ? 'secondary' : 'danger'} className="px-3 py-1 text-xs" disabled={busy} onClick={toggle}>
        {busy ? '…' : hidden ? 'Unhide' : 'Hide'}
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
