import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { SupportLink } from '@/components/support-link';
import { CloseRequest, ExportPanel } from './export-panel';

// Wave 4: "Export my kitchen" and "Request to close my kitchen" (owner only).
export default async function ExportPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const { data: open } = await supabase.from('kitchen_close_requests').select('created_at, reason')
    .eq('kitchen_id', kitchen.kitchenId).eq('status', 'open').maybeSingle();
  return (
    <>
      <PageHeader title="Your data" subtitle="Take a copy of everything, or ask us to close your kitchen." />
      <div className="max-w-3xl space-y-6">
        <ExportPanel kitchenId={kitchen.kitchenId} kitchenSlug={kitchen.slug} />
        <CloseRequest kitchenId={kitchen.kitchenId} open={open ?? null} />
        <SupportLink text={`Hello, this is ${kitchen.kitchenName}.`} />
      </div>
    </>
  );
}
