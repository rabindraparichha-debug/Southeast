import { requireKitchen } from '@/lib/session';
import { LEAD_ROLES } from '@/lib/roles';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { CustomerForm } from '../customer-form';

export default async function NewCustomerPage() {
  const { kitchen } = await requireKitchen(LEAD_ROLES);
  const supabase = await createClient();
  const [{ data: k }, { data: s }] = await Promise.all([
    supabase.from('kitchens').select('lat, lng').eq('id', kitchen.kitchenId).single(),
    supabase.from('kitchen_settings').select('default_billing_mode').eq('kitchen_id', kitchen.kitchenId).single(),
  ]);
  return (
    <>
      <PageHeader title="Add customer" subtitle="For customers who call or visit. They don’t need an app." />
      <CustomerForm kitchenId={kitchen.kitchenId} kitchenCenter={k?.lat && k?.lng ? { lat: k.lat, lng: k.lng } : null}
        defaultBilling={s?.default_billing_mode ?? 'monthly'} />
    </>
  );
}
