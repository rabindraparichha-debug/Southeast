// M2 API tests: vendor records a skip (preview, then confirm), counts and the change feed
// reflect it, and roles are enforced. Cutoff timing is covered in supabase/tests (simulated clock).
import { beforeAll, describe, expect, it } from 'vitest';
import { istDate, addDays } from '@tiffin/core';
import { KITCHEN_A, loginAs, rest, type Client } from './helpers';

type Summary = { locked: boolean; live: { total_meals: number; skipped: number } };

describe('M2: skip through the API', () => {
  let owner: { client: Client; accessToken: string };
  let staff: { client: Client; accessToken: string };
  let target: { subscription_id: string; service_date: string; slot: 'lunch' | 'dinner' };

  beforeAll(async () => {
    owner = await loginAs('+919000000001');
    staff = await loginAs('+919000000002');
    // A scheduled meal at least 2 days out (well before any cutoff).
    const { data, error } = await owner.client
      .from('meal_orders')
      .select('subscription_id, service_date, slot')
      .eq('kitchen_id', KITCHEN_A)
      .eq('status', 'scheduled')
      .gte('service_date', addDays(istDate(), 2))
      .order('service_date')
      .limit(1)
      .single();
    expect(error).toBeNull();
    target = data as typeof target;
  });

  it('preview shows the meal is not charged, and writes nothing', async () => {
    const { data, error } = await owner.client.rpc('request_schedule_change', {
      p_subscription: target.subscription_id,
      p_type: 'skip',
      p_from: target.service_date,
      p_slot: target.slot,
      p_dry_run: true,
    });
    expect(error).toBeNull();
    const res = data as { dry_run: boolean; after_cutoff: boolean; affected: { charged: boolean }[] };
    expect(res.dry_run).toBe(true);
    expect(res.after_cutoff).toBe(false);
    expect(res.affected).toHaveLength(1);
    expect(res.affected[0]!.charged).toBe(false);
  });

  it('confirmed skip drops the live count by one and appears in the change feed', async () => {
    const before = (await owner.client.rpc('slot_summary', { p_kitchen: KITCHEN_A, p_date: target.service_date, p_slot: target.slot }))
      .data as unknown as Summary;

    const { data, error } = await owner.client.rpc('request_schedule_change', {
      p_subscription: target.subscription_id,
      p_type: 'skip',
      p_from: target.service_date,
      p_slot: target.slot,
    });
    expect(error).toBeNull();
    const changeId = (data as { change_id: string }).change_id;

    const after = (await owner.client.rpc('slot_summary', { p_kitchen: KITCHEN_A, p_date: target.service_date, p_slot: target.slot }))
      .data as unknown as Summary;
    expect(after.live.total_meals).toBe(before.live.total_meals - 1);

    const { data: order } = await owner.client
      .from('meal_orders')
      .select('status, charged')
      .eq('subscription_id', target.subscription_id)
      .eq('service_date', target.service_date)
      .eq('slot', target.slot)
      .single();
    expect(order).toEqual({ status: 'skipped', charged: false });

    const { data: feed } = await staff.client.rpc('change_feed', { p_kitchen: KITCHEN_A, p_since: new Date(Date.now() - 3600_000).toISOString() });
    expect((feed ?? []).some((c) => c.change_id === changeId && c.channel === 'vendor')).toBe(true);
  });

  it('staff can read counts and orders but cannot record changes or see prices', async () => {
    const summary = await staff.client.rpc('slot_summary', { p_kitchen: KITCHEN_A, p_date: target.service_date, p_slot: target.slot });
    expect(summary.error).toBeNull();

    const change = await staff.client.rpc('request_schedule_change', {
      p_subscription: target.subscription_id,
      p_type: 'skip',
      p_from: target.service_date,
    });
    expect(change.error?.message).toBe('forbidden');

    const price = await rest('meal_orders?select=price_per_meal_paise&limit=1', staff.accessToken);
    expect(price.status).toBe(403);

    const balances = await rest('customer_balances?select=meals', staff.accessToken);
    expect(balances.body).toEqual([]);
  });

  it('another kitchen cannot read kitchen A counts or orders', async () => {
    const ownerB = await loginAs('+919000000011');
    const summary = await ownerB.client.rpc('slot_summary', { p_kitchen: KITCHEN_A, p_date: target.service_date, p_slot: target.slot });
    expect(summary.error?.message).toBe('forbidden');
    const orders = await rest(`meal_orders?kitchen_id=eq.${KITCHEN_A}&select=id`, ownerB.accessToken);
    expect(orders.body).toEqual([]);
    const packing = await ownerB.client.rpc('packing_list', { p_kitchen: KITCHEN_A, p_date: target.service_date, p_slot: target.slot });
    expect(packing.error?.message).toBe('forbidden');
  });
});
