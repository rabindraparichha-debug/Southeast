'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { KitchenStatus } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button } from '@/components/ui';

// Listing needs the FSSAI check first (verified ≠ listed, D-186). Suspending stops the kitchen's
// meal generation, count lock and summaries, so it asks first.
export function StatusButtons({ kitchenId, status, hasFssai, verified = false }: {
  kitchenId: string; status: KitchenStatus; hasFssai: boolean; verified?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState('');
  async function set(next: KitchenStatus) {
    if (next === 'suspended' && !window.confirm('Suspend this kitchen? Its meals, count lock and summaries stop until you make it private or list it again.')) return;
    const { error } = await supabaseBrowser().rpc('set_kitchen_status', { p_kitchen: kitchenId, p_status: next });
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  const canList = hasFssai && verified;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {status !== 'active' && (
        <Button variant="secondary" disabled={!canList}
          title={!hasFssai ? 'FSSAI number required' : !verified ? 'Check the FSSAI certificate first (Verify)' : 'Show on the public pages and offer to platform customers'}
          onClick={() => set('active')}>List</Button>
      )}
      {status !== 'draft' && <Button variant="ghost" onClick={() => set('draft')}>Make private</Button>}
      {status !== 'suspended' && <Button variant="danger" onClick={() => set('suspended')}>Suspend</Button>}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
