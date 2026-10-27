import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { SettingsForm } from './settings-form';

export default async function SettingsPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const [{ data: k }, { data: s }] = await Promise.all([
    supabase.from('kitchens').select('*').eq('id', kitchen.kitchenId).single(),
    supabase.from('kitchen_settings').select('*').eq('kitchen_id', kitchen.kitchenId).single(),
  ]);
  if (!k || !s) return null;
  return (
    <>
      <PageHeader title="Kitchen settings" subtitle={`Status: ${k.status === 'active' ? 'Listed publicly' : k.status === 'suspended' ? 'Suspended' : 'Private (not listed)'}`} />
      <SettingsForm kitchen={k} settings={s} />
    </>
  );
}
