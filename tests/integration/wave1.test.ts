// Vendor-first wave 1 over the API, as the owner apps would call it: closures, undo of a skip,
// reactivation, holds, engine errors (owner reads, cannot write). Timing rules (cutoffs, lock,
// runs, catch-up) are covered in supabase/tests/14_vendor_first.test.sql with a simulated clock.
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@tiffin/core';
import type { ChangeResult, ClosureResult, ReactivateResult } from '@tiffin/db';
import { loginAs, type Client } from './helpers';

describe('Vendor-first wave 1: owner RPCs', () => {
  let owner: { client: Client; accessToken: string };
  let kitchenId: string;
  let subscriptionId: string;
  const run = Date.now().toString(36);
  // Far enough ahead that every cutoff is still open whatever the time of day.
  const day = addDays(istDate(), 3);

  beforeAll(async () => {
    owner = await loginAs('+919000000106'); // own spare number: test files run in parallel
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Wave IT ${run}`, p_area: 'Patia' });
    expect(error).toBeNull();
    kitchenId = (kitchen as { id: string }).id;
    const { data: plan } = await owner.client.from('plans')
      .insert({ kitchen_id: kitchenId, name: 'Daily', slots: ['lunch', 'dinner'], days_of_week: [1, 2, 3, 4, 5, 6, 7], price_per_meal_paise: 6000 })
      .select('id').single();
    const { data: cust, error: cErr } = await owner.client.rpc('create_customer', {
      p_kitchen: kitchenId, p_name: 'Wave Customer', p_phone: `97${String(Date.now()).slice(-8)}`, p_consent: true,
      p_address: { line1: 'Flat 1', area: 'Patia' },
    });
    expect(cErr).toBeNull();
    const { data: sub, error: sErr } = await owner.client.from('subscriptions')
      .insert({ kitchen_id: kitchenId, customer_id: cust as string, plan_id: plan!.id, start_date: istDate(), status: 'active' })
      .select('id, address_id').single();
    expect(sErr).toBeNull();
    expect(sub!.address_id).not.toBeNull(); // takes the customer's address by itself
    subscriptionId = sub!.id;
  });

  const ordersOn = async (date: string) =>
    (await owner.client.from('meal_orders').select('slot, status').eq('subscription_id', subscriptionId).eq('service_date', date)).data ?? [];

  it('closes a day (preview first), then reopens it', async () => {
    const preview = await owner.client.rpc('set_kitchen_closure', { p_kitchen: kitchenId, p_date: day, p_dry_run: true });
    expect(preview.error).toBeNull();
    expect((preview.data as unknown as ClosureResult).meals).toBe(2);
    expect(await ordersOn(day)).toHaveLength(2);

    const closed = await owner.client.rpc('set_kitchen_closure', { p_kitchen: kitchenId, p_date: day, p_reason: 'Festival' });
    expect(closed.error).toBeNull();
    expect(await ordersOn(day)).toHaveLength(0);
    const { data: list } = await owner.client.from('kitchen_closures').select('closed_on, slot, reason').eq('kitchen_id', kitchenId);
    expect(list).toEqual([{ closed_on: day, slot: null, reason: 'Festival' }]);

    const reopened = await owner.client.rpc('remove_kitchen_closure', { p_kitchen: kitchenId, p_date: day });
    expect(reopened.error).toBeNull();
    expect(await ordersOn(day)).toHaveLength(2);
  });

  it('undoes one specific skip, listed in the upcoming holds', async () => {
    const skip = await owner.client.rpc('request_schedule_change', { p_subscription: subscriptionId, p_type: 'skip', p_from: day, p_slot: 'dinner' });
    expect(skip.error).toBeNull();
    const changeId = (skip.data as unknown as ChangeResult).change_id!;
    const holds = await owner.client.rpc('subscription_holds', { p_subscription: subscriptionId });
    expect((holds.data ?? []).map((h) => h.change_id)).toContain(changeId);

    const undo = await owner.client.rpc('revoke_schedule_change', { p_change: changeId });
    expect(undo.error).toBeNull();
    expect((await ordersOn(day)).every((o) => o.status === 'scheduled')).toBe(true);
    const again = await owner.client.rpc('revoke_schedule_change', { p_change: changeId });
    expect(again.error?.message).toBe('already_revoked');
  });

  it('reactivates a cancelled subscription', async () => {
    const cancel = await owner.client.rpc('request_schedule_change', { p_subscription: subscriptionId, p_type: 'cancel', p_from: istDate() });
    expect(cancel.error).toBeNull();
    expect(await ordersOn(day)).toHaveLength(0);
    const back = await owner.client.rpc('reactivate_subscription', { p_subscription: subscriptionId });
    expect(back.error).toBeNull();
    // No payment was recorded: a prepaid balance of 0 comes back suspended (credit limit 0) until one is.
    expect(['active', 'low_balance', 'suspended']).toContain((back.data as unknown as ReactivateResult).status);
    const { data: events } = await owner.client.from('subscription_events').select('reason').eq('subscription_id', subscriptionId);
    expect((events ?? []).map((e) => e.reason)).toContain('reactivated');
  });

  it('engine errors are readable by the owner but never writable', async () => {
    const read = await owner.client.from('engine_errors').select('id').eq('kitchen_id', kitchenId);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);
    const write = await owner.client.from('engine_errors').insert({ kitchen_id: kitchenId, job: 'lock', message: 'x' });
    expect(write.error?.code).toBe('42501');
  });
});
