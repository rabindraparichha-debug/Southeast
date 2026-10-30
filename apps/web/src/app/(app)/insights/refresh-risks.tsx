'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button } from '@/components/ui';

/** Recomputes the at-risk list now instead of waiting for the nightly check. */
export function RefreshRisks({ kitchenId }: { kitchenId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    setBusy(true);
    setError('');
    const { error } = await supabaseBrowser().rpc('at_risk_customers', { p_kitchen: kitchenId, p_refresh: true });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-700">{error}</span>}
      <Button variant="secondary" onClick={refresh} disabled={busy} data-testid="refresh-risks">{busy ? 'Checking…' : '↻ Check now'}</Button>
    </div>
  );
}
