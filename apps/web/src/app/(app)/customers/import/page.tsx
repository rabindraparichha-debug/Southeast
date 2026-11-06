import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { ImportArea } from './import-area';

export default async function ImportPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const [{ data: plans }, { data: settings }] = await Promise.all([
    supabase.from('plans').select('name, diet').eq('kitchen_id', kitchen.kitchenId).eq('active', true),
    supabase.from('kitchen_settings').select('default_billing_mode').eq('kitchen_id', kitchen.kitchenId).maybeSingle(),
  ]);
  return (
    <>
      <PageHeader title="Import customers" subtitle="Upload your register as Excel (.xlsx) or CSV, or take a photo of your notebook. Bad rows are listed; good rows are saved." />
      <ImportArea kitchenId={kitchen.kitchenId} plans={plans ?? []} defaultBilling={settings?.default_billing_mode ?? 'monthly'} />
    </>
  );
}
