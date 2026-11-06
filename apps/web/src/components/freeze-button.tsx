'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button } from './ui';

/** "Freeze now": locks a slot whose cutoff passed without a lock (freeze_slot, idempotent). Owner only. */
export function FreezeButton({ kitchenId, date, slot }: { kitchenId: string; date: string; slot: MealSlot }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function freeze() {
    if (!window.confirm('Freeze this count now? Meals are counted and charged as they stood at the cutoff, as the automatic lock would have done.')) return;
    setBusy(true);
    setError('');
    const { error } = await supabaseBrowser().rpc('freeze_slot', { p_kitchen: kitchenId, p_date: date, p_slot: slot });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.refresh();
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button variant="danger" onClick={freeze} disabled={busy}>{busy ? 'Freezing…' : 'Freeze now'}</Button>
      {error && <span className="text-xs text-red-800">{error}</span>}
    </div>
  );
}
