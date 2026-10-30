import Link from 'next/link';
import { SLOT_LABEL, addDays, formatServiceDate } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { currentDeliverySlot, isDate, type LiveBoard } from '@/lib/delivery';
import { Alert, PageHeader } from '@/components/ui';
import { DeliveryTabs } from './tabs';
import { LiveBoardView } from './live-board';
import { DispatchPhotoCard, type DispatchPhoto } from './dispatch-photo';

function neighbours(date: string, slot: MealSlot) {
  const prev = slot === 'dinner' ? { date, slot: 'lunch' as const } : { date: addDays(date, -1), slot: 'dinner' as const };
  const next = slot === 'lunch' ? { date, slot: 'dinner' as const } : { date: addDays(date, 1), slot: 'lunch' as const };
  return { prev, next };
}

// Live delivery board for one slot: runs, riders, stop progress and proof. Owner + staff.
export default async function DeliveryPage({ searchParams }: PageProps<'/delivery'>) {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const sp = await searchParams;
  const now = currentDeliverySlot();
  const date = isDate(sp.date) ? sp.date : now.date;
  const slot: MealSlot = sp.slot === 'dinner' || sp.slot === 'lunch' ? sp.slot : isDate(sp.date) ? 'lunch' : now.slot;
  const supabase = await createClient();
  const [{ data, error }, { data: photos }] = await Promise.all([
    supabase.rpc('live_board', { p_kitchen: kitchen.kitchenId, p_date: date, p_slot: slot }),
    supabase.from('dispatch_photos').select('id, run_id, photo_path, taken_at').eq('kitchen_id', kitchen.kitchenId)
      .eq('service_date', date).eq('slot', slot).order('taken_at'),
  ]);
  const board = data as unknown as LiveBoard | null;
  const { prev, next } = neighbours(date, slot);
  const isOwner = kitchen.role === 'owner';

  return (
    <>
      <PageHeader
        title="Delivery"
        subtitle={`${formatServiceDate(date)} · ${SLOT_LABEL[slot]}`}
        actions={
          <form className="flex flex-wrap items-center gap-2">
            <Link href={`/delivery?date=${prev.date}&slot=${prev.slot}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50">← {SLOT_LABEL[prev.slot]}</Link>
            <input type="date" name="date" defaultValue={date} aria-label="Date" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <select name="slot" defaultValue={slot} aria-label="Meal" className="rounded-lg py-1.5 pr-8 pl-2 text-sm ring-1 ring-ink-200">
              <option value="lunch">Lunch</option>
              <option value="dinner">Dinner</option>
            </select>
            <button className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-ink-200 hover:bg-ink-50">Show</button>
            <Link href={`/delivery?date=${next.date}&slot=${next.slot}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50">{SLOT_LABEL[next.slot]} →</Link>
            <Link href={`/print/stickers?date=${date}&slot=${slot}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50">🏷️ Stickers</Link>
            {(date !== now.date || slot !== now.slot) && (
              <Link href="/delivery" className="px-2 text-sm font-medium text-brand-700 hover:underline">Now</Link>
            )}
          </form>
        }
      />
      <DeliveryTabs isOwner={isOwner} />
      {error || !data ? (
        <Alert>{friendlyError(error)}</Alert>
      ) : (
        <>
          <DispatchPhotoCard kitchenId={kitchen.kitchenId} date={date} slot={slot}
            runs={(board?.runs ?? []).map((r) => ({ id: r.id, route_name: r.route_name }))} photos={(photos ?? []) as DispatchPhoto[]} />
          <LiveBoardView key={`${date}:${slot}`} kitchenId={kitchen.kitchenId} initial={board!} isOwner={isOwner} />
        </>
      )}
    </>
  );
}
