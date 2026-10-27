import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { PlansEditor } from './plans-editor';

export default async function PlansPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const { data: plans } = await supabase
    .from('plans')
    .select('id, name, slots, diet, days_of_week, price_per_meal_paise, description, active')
    .eq('kitchen_id', kitchen.kitchenId)
    .order('active', { ascending: false })
    .order('name');
  return (
    <>
      <PageHeader title="Plans" subtitle="Price per meal. Customers prepay for meals; balances arrive in the money milestone." />
      <PlansEditor kitchenId={kitchen.kitchenId} plans={plans ?? []} />
    </>
  );
}
