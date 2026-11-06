import { addDays, cutoffInstant, istDate } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { createClient } from '@/lib/supabase/server';
import { ClosureManager, type Closure } from './closure-manager';

/** Today page: upcoming kitchen closures (owner and staff read; the owner adds and removes them). */
export async function UpcomingClosures({ kitchenId, canEdit }: { kitchenId: string; canEdit: boolean }) {
  const supabase = await createClient();
  const today = istDate();
  const [{ data }, { data: k }] = await Promise.all([
    supabase.from('kitchen_closures').select('id, closed_on, slot, reason')
      .eq('kitchen_id', kitchenId).gte('closed_on', today).order('closed_on').order('slot', { nullsFirst: true }).limit(30),
    canEdit
      ? supabase.from('kitchens').select('cutoff_lunch, cutoff_lunch_prev_day, cutoff_dinner, cutoff_dinner_prev_day').eq('id', kitchenId).single()
      : Promise.resolve({ data: null }),
  ]);
  const closures = (data ?? []) as Closure[];
  if (!canEdit && closures.length === 0) return null;
  // "Close tomorrow" picks the meals still open, so it needs tomorrow's cutoffs (IST rules → instants).
  const tomorrow = addDays(today, 1);
  const tomorrowCutoffs: Record<MealSlot, string> | null = k
    ? {
        lunch: cutoffInstant(tomorrow, k.cutoff_lunch, k.cutoff_lunch_prev_day).toISOString(),
        dinner: cutoffInstant(tomorrow, k.cutoff_dinner, k.cutoff_dinner_prev_day).toISOString(),
      }
    : null;
  return <ClosureManager kitchenId={kitchenId} today={today} closures={closures} canEdit={canEdit} tomorrowCutoffs={tomorrowCutoffs} />;
}
