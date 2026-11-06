import { createClient } from '@/lib/supabase/server';
import { loadHolds } from '@/lib/holds';
import { Card } from '@/components/ui';
import { HoldsList } from '@/components/holds-list';

/** "Upcoming skips and pauses" on the customer page, with Undo for the owner (staff read only). */
export async function UpcomingHolds({ customerId, isOwner }: { customerId: string; isOwner: boolean }) {
  const holds = await loadHolds(await createClient(), customerId, isOwner);
  return (
    <Card title="Upcoming skips and pauses">
      <HoldsList holds={holds} canUndo={isOwner} />
    </Card>
  );
}
