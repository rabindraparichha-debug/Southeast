import Link from 'next/link';
import { SLOT_LABEL } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import type { RoutePoints } from '@/lib/delivery';
import { Alert, PageHeader } from '@/components/ui';
import { DeliveryTabs } from '../tabs';
import { RoutesManager, type RouteRow, type RiderOption } from './routes-manager';
import { RouteEditor } from './route-editor';

// Saved routes per meal: default rider, active flag, and the stop order the daily runs follow.
export default async function RoutesPage({ searchParams }: PageProps<'/delivery/routes'>) {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: routes }, { data: stops }, { data: members }] = await Promise.all([
    supabase.from('delivery_routes').select('id, name, slot, rider_id, active, created_at')
      .eq('kitchen_id', kitchen.kitchenId).order('name'),
    supabase.from('route_stops').select('route_id').eq('kitchen_id', kitchen.kitchenId),
    supabase.from('members').select('user_id, display_name, role').eq('kitchen_id', kitchen.kitchenId).in('role', ['owner', 'rider']),
  ]);

  const counts = new Map<string, number>();
  for (const s of stops ?? []) counts.set(s.route_id, (counts.get(s.route_id) ?? 0) + 1);
  const rows: RouteRow[] = (routes ?? []).map((r) => ({ ...r, stops: counts.get(r.id) ?? 0 }));
  const riders: RiderOption[] = (members ?? [])
    .map((m) => ({ id: m.user_id, name: `${m.display_name || 'Unnamed'}${m.role === 'owner' ? ' (owner)' : ''}` }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const selectedId = typeof sp.route === 'string' ? sp.route : null;
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  let points: RoutePoints | null = null;
  let pointsError = '';
  if (selected) {
    const { data, error } = await supabase.rpc('route_points', { p_route: selected.id });
    if (error) pointsError = friendlyError(error);
    else points = data as unknown as RoutePoints;
  }

  return (
    <>
      <PageHeader
        title="Delivery routes"
        subtitle="Each meal has one or more routes. New customers join the nearest route automatically; the order you save here is what riders follow every day."
      />
      <DeliveryTabs isOwner={kitchen.role === 'owner'} />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <RoutesManager kitchenId={kitchen.kitchenId} routes={rows} riders={riders} selectedId={selected?.id ?? null} />
        </div>
        <div className="lg:col-span-3">
          {selected ? (
            pointsError ? <Alert>{pointsError}</Alert> : points && (
              <RouteEditor key={selected.id} initial={points} slotLabel={SLOT_LABEL[selected.slot as MealSlot]} />
            )
          ) : (
            <div className="rounded-xl border border-dashed border-ink-200 p-8 text-center text-sm text-ink-500">
              Open a route to see and change its stop order.
              {selectedId && <p className="mt-2"><Link href="/delivery/routes" className="text-brand-700 hover:underline">That route was not found.</Link></p>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
