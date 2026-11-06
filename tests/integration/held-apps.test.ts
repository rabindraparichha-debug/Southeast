// Held-back apps track over the API (D-126): a rider's phone reports an action the server refused,
// the owner lists it with the cash amount and marks it handled; another kitchen sees nothing.
// Role-by-role rules and the automatic close on a later sync are in
// supabase/tests/15_rider_sync_rejects.test.sql.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@tiffin/core';
import { loginAs, rest, type Client } from './helpers';

describe('Refused rider actions reach the owner', () => {
  // Own spare numbers (test files run in parallel): owner, rider, another kitchen's owner.
  let owner: { client: Client; accessToken: string };
  let rider: { client: Client; accessToken: string; userId: string };
  let other: { client: Client; accessToken: string };
  let kitchenId: string;
  const op = randomUUID();
  const run = Date.now().toString(36);

  beforeAll(async () => {
    owner = await loginAs('+919000000180');
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Held IT ${run}`, p_area: 'Patia' });
    expect(error).toBeNull();
    kitchenId = (kitchen as { id: string }).id;
    const invite = await owner.client.rpc('invite_member', { p_kitchen: kitchenId, p_phone: '9000000181', p_role: 'rider', p_display_name: 'Held Rider' });
    expect(invite.error).toBeNull();
    rider = await loginAs('+919000000181');
    await rider.client.rpc('claim_invites');
    other = await loginAs('+919000000182');
    const otherKitchen = await other.client.rpc('create_kitchen', { p_name: `Held Other ${run}`, p_area: 'Patia' });
    expect(otherKitchen.error).toBeNull();
  });

  it('the rider reports a refused delivery once, however often the phone sends it', async () => {
    const args = {
      p_client_op: op, p_kind: 'complete', p_error: 'not_found', p_kitchen: kitchenId, p_run: randomUUID(), p_stop: randomUUID(),
      p_summary: { proof: 'otp', otp: '4321', stop_label: 'Ramesh 9876543210', route_label: 'Patia', service_date: istDate(), slot: 'lunch' },
      p_cash_paise: 15000, p_had_photo: true, p_acted_at: new Date(Date.now() - 600_000).toISOString(), p_refused_at: new Date().toISOString(),
    };
    const first = await rider.client.rpc('report_sync_reject', args);
    expect(first.error).toBeNull();
    const again = await rider.client.rpc('report_sync_reject', args);
    expect(again.data).toBe(first.data);

    // The rider reads their own report directly (RLS), without the delivery code or the phone number.
    const own = await rest(`rider_sync_rejects?select=id,summary,cash_paise,run_id,stop_id&id=eq.${first.data}`, rider.accessToken);
    expect(own.status).toBe(200);
    expect(own.body).toHaveLength(1);
    expect(own.body[0]).toMatchObject({ cash_paise: 15000, run_id: null, stop_id: null });
    expect(JSON.stringify(own.body[0].summary)).not.toMatch(/4321|9876543210/);
    // ... but cannot write or list the kitchen's reports.
    const write = await rest('rider_sync_rejects', rider.accessToken, { method: 'POST', body: JSON.stringify({ kitchen_id: kitchenId }) });
    expect(write.status).toBeGreaterThanOrEqual(400);
    const list = await rider.client.rpc('sync_rejects', { p_kitchen: kitchenId });
    expect(list.error?.message).toBe('forbidden');
  });

  it('the owner sees it with the cash, and marks it handled', async () => {
    const { data, error } = await owner.client.rpc('sync_rejects', { p_kitchen: kitchenId });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ rider_name: 'Held Rider', customer_name: 'Ramesh …', route_name: 'Patia', cash_paise: 15000,
      had_photo: true, error_code: 'not_found', action: 'complete', resolved_at: null });

    // Another kitchen's owner can neither list nor resolve it.
    expect((await other.client.rpc('sync_rejects', { p_kitchen: kitchenId })).error?.message).toBe('forbidden');
    expect((await other.client.rpc('resolve_sync_reject', { p_id: data![0]!.id })).error?.message).toBe('forbidden');
    const peek = await rest(`rider_sync_rejects?select=id&kitchen_id=eq.${kitchenId}`, other.accessToken);
    expect(peek.body).toEqual([]);

    const resolved = await owner.client.rpc('resolve_sync_reject', { p_id: data![0]!.id, p_note: 'Cash received' });
    expect(resolved.error).toBeNull();
    expect((await owner.client.rpc('sync_rejects', { p_kitchen: kitchenId })).data).toHaveLength(0);
    const all = await owner.client.rpc('sync_rejects', { p_kitchen: kitchenId, p_include_resolved: true });
    expect(all.data![0]).toMatchObject({ resolution_note: 'Cash received' });
    expect((await owner.client.rpc('resolve_sync_reject', { p_id: data![0]!.id })).error?.message).toBe('not_pending');
  });
});
