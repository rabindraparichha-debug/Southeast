import { addDays, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { LinkButton, PageHeader } from '@/components/ui';
import { MenuEditor } from './menu-editor';

export default async function MenuPage() {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const supabase = await createClient();
  const today = istDate();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const [{ data: menus }, { data: k }] = await Promise.all([
    supabase.from('menus').select('id, service_date, slot, dishes, notes').eq('kitchen_id', kitchen.kitchenId)
      .gte('service_date', days[0]!).lte('service_date', days[6]!),
    supabase.from('kitchens').select('weekly_off').eq('id', kitchen.kitchenId).single(),
  ]);
  return (
    <>
      <PageHeader title="Menu" subtitle="Next 7 days. Shown on the kitchen sheet, and to customers on WhatsApp later."
        actions={<LinkButton href="/menu/specials" variant="secondary">Festival specials</LinkButton>} />
      <MenuEditor kitchenId={kitchen.kitchenId} days={days} weeklyOff={k?.weekly_off ?? []} menus={menus ?? []} />
    </>
  );
}
