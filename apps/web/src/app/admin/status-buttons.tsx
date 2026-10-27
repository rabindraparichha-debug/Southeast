'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { KitchenStatus } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button } from '@/components/ui';

export function StatusButtons({ kitchenId, status, hasFssai }: { kitchenId: string; status: KitchenStatus; hasFssai: boolean }) {
  const router = useRouter();
  const [error, setError] = useState('');
  async function set(next: KitchenStatus) {
    const { error } = await supabaseBrowser().rpc('set_kitchen_status', { p_kitchen: kitchenId, p_status: next });
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {status !== 'active' && (
        <Button variant="secondary" disabled={!hasFssai} title={hasFssai ? '' : 'FSSAI number required'} onClick={() => set('active')}>List</Button>
      )}
      {status !== 'draft' && <Button variant="ghost" onClick={() => set('draft')}>Make private</Button>}
      {status !== 'suspended' && <Button variant="danger" onClick={() => set('suspended')}>Suspend</Button>}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
