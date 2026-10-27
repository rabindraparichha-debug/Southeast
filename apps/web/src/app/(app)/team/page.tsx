import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { TeamManager } from './team-manager';

export default async function TeamPage() {
  const { kitchen, userId } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const [{ data: members }, { data: invites }] = await Promise.all([
    supabase.from('members').select('id, user_id, role, display_name, created_at').eq('kitchen_id', kitchen.kitchenId).order('role'),
    supabase.from('member_invites').select('id, phone_e164, role, display_name, created_at')
      .eq('kitchen_id', kitchen.kitchenId).is('accepted_at', null).is('revoked_at', null).order('created_at'),
  ]);
  return (
    <>
      <PageHeader title="Team" subtitle="Staff see counts, production and inventory only — no money and no customer phone numbers. Riders see only their stops." />
      <TeamManager kitchenId={kitchen.kitchenId} members={members ?? []} invites={invites ?? []} currentUserId={userId} />
    </>
  );
}
