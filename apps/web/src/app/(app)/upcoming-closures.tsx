import { istDate } from '@tiffin/core';
import { createClient } from '@/lib/supabase/server';
import { ClosureManager, type Closure } from './closure-manager';

/** Today page: upcoming kitchen closures (owner and staff read; the owner adds and removes them). */
export async function UpcomingClosures({ kitchenId, canEdit }: { kitchenId: string; canEdit: boolean }) {
  const supabase = await createClient();
  const today = istDate();
  const { data } = await supabase.from('kitchen_closures').select('id, closed_on, slot, reason')
    .eq('kitchen_id', kitchenId).gte('closed_on', today).order('closed_on').order('slot', { nullsFirst: true }).limit(30);
  const closures = (data ?? []) as Closure[];
  if (!canEdit && closures.length === 0) return null;
  return <ClosureManager kitchenId={kitchenId} today={today} closures={closures} canEdit={canEdit} />;
}
