import { requireKitchen } from '@/lib/session';
import { LEAD_ROLES } from '@/lib/roles';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { PlansEditor } from './plans-editor';

export default async function PlansPage() {
  const { kitchen } = await requireKitchen(LEAD_ROLES);
  const supabase = await createClient();
  const { data: plans } = await supabase
    .from('plans')
    .select('id, name, slots, diet, days_of_week, price_per_meal_paise, description, active')
    .eq('kitchen_id', kitchen.kitchenId)
    .order('active', { ascending: false })
    .order('name');
  return (
    <>
      <PageHeader title="Plans" subtitle="Price per meal. Each meal is taken from the customer’s balance when the count locks." />
      <PlansEditor kitchenId={kitchen.kitchenId} plans={plans ?? []} />
    </>
  );
}
