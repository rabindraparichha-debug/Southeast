import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { Alert, PageHeader } from '@/components/ui';
import { DeliveryTabs } from '../tabs';
import { TiffinBoard } from './tiffin-board';

// Steel tiffin boxes with customers (from the riders' counts) and returns at the kitchen.
export default async function TiffinsPage() {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const supabase = await createClient();
  const [{ data: balances, error }, { data: customers }] = await Promise.all([
    supabase.rpc('tiffin_balances', { p_kitchen: kitchen.kitchenId }),
    supabase.from('customers_v').select('id, name, area').eq('kitchen_id', kitchen.kitchenId).order('name'),
  ]);

  return (
    <>
      <PageHeader title="Tiffins" subtitle="Boxes with customers, from what riders record at each stop. Customers holding 2 or more with nothing returned for 2 days are flagged." />
      <DeliveryTabs isOwner={kitchen.role === 'owner'} />
      {error ? <Alert>{friendlyError(error)}</Alert> : <TiffinBoard balances={balances ?? []} customers={customers ?? []} />}
    </>
  );
}
