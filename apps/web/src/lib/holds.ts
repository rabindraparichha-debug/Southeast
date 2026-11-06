import 'server-only';
import { istDate } from '@tiffin/core';
import type { Hold } from '@/components/holds-list';
import type { createClient } from './supabase/server';

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * A customer's upcoming skips and pauses (subscription_holds; owner + staff), across their live
 * subscriptions, oldest first. Owners read subscriptions; staff learn the subscription ids from
 * the customer's meals (subscriptions are owner-only under RLS).
 */
export async function loadHolds(supabase: Client, customerId: string, isOwner: boolean): Promise<Hold[]> {
  let subs: { id: string; plan: string | null }[] = [];
  if (isOwner) {
    const { data } = await supabase.from('subscriptions').select('id, plan:plans(name)').eq('customer_id', customerId)
      .neq('status', 'cancelled').order('created_at');
    subs = (data ?? []).map((s) => ({ id: s.id, plan: s.plan?.name ?? null }));
  } else {
    const { data } = await supabase.from('meal_orders').select('subscription_id').eq('customer_id', customerId)
      .gte('service_date', istDate());
    subs = [...new Set((data ?? []).map((m) => m.subscription_id))].map((id) => ({ id, plan: null }));
  }
  const results = await Promise.all(subs.map((s) => supabase.rpc('subscription_holds', { p_subscription: s.id })));
  const many = subs.length > 1;
  return results
    .flatMap((r, i) => ((r.data ?? []) as unknown as Hold[]).map((h) => ({
      ...h, subscription_id: subs[i]!.id, plan_name: many ? subs[i]!.plan : null,
    })))
    .sort((a, b) => a.from_date.localeCompare(b.from_date) || a.requested_at.localeCompare(b.requested_at));
}
