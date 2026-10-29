import { addDays, istDate } from '@tiffin/core';
import type { MealSlot, SlotSummary } from '@tiffin/db';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Card, LinkButton, PageHeader, Stat } from '@/components/ui';
import { SlotCard } from '@/components/slot-card';
import { ChangeFeed } from '@/components/change-feed';

export default async function TodayPage() {
  const { kitchen } = await requireKitchen();
  const supabase = await createClient();

  if (kitchen.role === 'rider') {
    return (
      <>
        <PageHeader title="Today" />
        <Card><p className="text-sm text-ink-600">Your stop list will appear in the rider mode of the mobile app.</p></Card>
      </>
    );
  }

  const today = istDate();
  const slots: [string, MealSlot][] = [[today, 'lunch'], [today, 'dinner'], [addDays(today, 1), 'lunch'], [addDays(today, 1), 'dinner']];
  const [summaries, { data: changes }, { count: customerCount }] = await Promise.all([
    Promise.all(slots.map(([d, s]) => supabase.rpc('slot_summary', { p_kitchen: kitchen.kitchenId, p_date: d, p_slot: s }))),
    supabase.rpc('change_feed', { p_kitchen: kitchen.kitchenId, p_limit: 30 }),
    supabase.from('customers_v').select('id', { count: 'exact', head: true }).eq('kitchen_id', kitchen.kitchenId),
  ]);
  const isOwner = kitchen.role === 'owner';

  let active = 0;
  let paused = 0;
  if (isOwner) {
    const { data: subs } = await supabase.from('subscriptions').select('status').eq('kitchen_id', kitchen.kitchenId);
    active = (subs ?? []).filter((s) => s.status === 'active' || s.status === 'low_balance').length;
    paused = (subs ?? []).filter((s) => s.status === 'paused').length;
  }

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' })}
        actions={<LinkButton href="/menu" variant="secondary">Menu</LinkButton>}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summaries.map((r, i) => r.data && <SlotCard key={i} s={r.data as unknown as SlotSummary} />)}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Changes since last count" className="lg:col-span-2">
          <ChangeFeed changes={changes ?? []} linkCustomers={isOwner || kitchen.role === 'staff'} />
        </Card>
        <div className="space-y-4">
          <Stat label="Customers" value={customerCount ?? 0} />
          {isOwner && <Stat label="Active subscriptions" value={active} hint={paused ? `${paused} paused` : undefined} />}
          {isOwner && (
            <div className="flex flex-wrap gap-2">
              <LinkButton href="/customers/new">Add customer</LinkButton>
              <LinkButton href="/customers/import" variant="secondary">Import</LinkButton>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
