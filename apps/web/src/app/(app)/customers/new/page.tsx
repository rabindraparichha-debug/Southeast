import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { CustomerForm } from '../customer-form';

export default async function NewCustomerPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const { data: k } = await supabase.from('kitchens').select('lat, lng').eq('id', kitchen.kitchenId).single();
  return (
    <>
      <PageHeader title="Add customer" subtitle="For customers who call or visit. They don’t need an app." />
      <CustomerForm kitchenId={kitchen.kitchenId} kitchenCenter={k?.lat && k?.lng ? { lat: k.lat, lng: k.lng } : null} />
    </>
  );
}
