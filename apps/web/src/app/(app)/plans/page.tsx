import { istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { PlansEditor } from './plans-editor';

export default async function PlansPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const [{ data: plans }, { data: scheduled }] = await Promise.all([
    supabase
      .from('plans')
      .select('id, name, slots, diet, days_of_week, price_per_meal_paise, description, active')
      .eq('kitchen_id', kitchen.kitchenId)
      .order('active', { ascending: false })
      .order('name'),
    // Price changes that start later ("₹80 from 1 Dec"), wave 4.
    supabase.from('plan_prices').select('id, plan_id, price_per_meal_paise, effective_from')
      .eq('kitchen_id', kitchen.kitchenId).is('cancelled_at', null).gt('effective_from', istDate()).order('effective_from'),
  ]);
  return (
    <>
      <PageHeader title="Plans" subtitle="Price per meal. Each meal is taken from the customer’s balance when the count locks." />
      <PlansEditor kitchenId={kitchen.kitchenId} plans={plans ?? []} scheduled={scheduled ?? []} />
    </>
  );
}
