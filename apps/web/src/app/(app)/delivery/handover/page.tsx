import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { Alert, PageHeader } from '@/components/ui';
import { DeliveryTabs } from '../tabs';
import { HandoverView, type Collector, type CreditRequest } from './handover-view';

// Cash riders hand over and meal credits riders asked for (audit item 25). Owner only: staff see no
// money, and credits are the kitchen's money.
export default async function HandoverPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const [cash, credits] = await Promise.all([
    supabase.rpc('cash_handover', { p_kitchen: kitchen.kitchenId, p_days: 7 }),
    supabase.rpc('stop_credit_requests', { p_kitchen: kitchen.kitchenId, p_status: null as unknown as string, p_days: 14 }),
  ]);
  const error = cash.error ?? credits.error;
  return (
    <>
      <PageHeader
        title="Cash and credits"
        subtitle="Confirm the cash each rider hands over, and decide the meal credits riders asked for when a delivery failed because of the kitchen."
      />
      <DeliveryTabs isOwner />
      {error ? (
        <Alert>{friendlyError(error)}</Alert>
      ) : (
        <HandoverView
          kitchenId={kitchen.kitchenId}
          collectors={((cash.data ?? {}) as unknown as { collectors?: Collector[] }).collectors ?? []}
          credits={(credits.data ?? []) as unknown as CreditRequest[]}
        />
      )}
    </>
  );
}
