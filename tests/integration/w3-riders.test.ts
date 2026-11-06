// Vendor-first wave 3, riders track, over the API: a rider's kitchen-fault credit waits for the
// owner, the owner approves and corrects it (credit reversed), the rider's door cash is handed over
// and confirmed in one step, push devices / the in-app alert list / the push-outbox function (mock),
// the owner-only tools on a fresh kitchen, and the public app config.
// Uses kitchen A's run (its rider is used by no other suite); on kitchen A's weekly off (Sunday) it
// falls back to the last pending stops of kitchen B's dinner run (m5 uses the first ones of lunch).
// Needs a fresh `pnpm db:reset`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { anonClient, env, KITCHEN_A, KITCHEN_B, loginAs, rest, type Client } from './helpers';

type Stop = { id: string; status: string; customer_id: string; meal_count: number };
type Run = { id: string; kitchen_id: string; slot: string; status: string; stops: Stop[] };
type User = { client: Client; accessToken: string; userId: string };

const run = Date.now().toString(36);

function serviceRoleKey(): string {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const out = execSync('npx supabase status -o json', { cwd: new URL('../..', import.meta.url).pathname }).toString();
  return JSON.parse(out.slice(out.indexOf('{'))).SERVICE_ROLE_KEY as string;
}

async function pushOutbox(bearer: string) {
  const { url, anonKey } = env();
  const res = await fetch(`${url}/functions/v1/push-outbox`, {
    method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  return { status: res.status, body: (await res.json()) as { mode?: string; sent?: number; error?: string } };
}

describe('Wave 3 riders track over the API', () => {
  let rider: User;
  let owner: User;
  let staff: User;
  let kitchen: string;
  let stops: Stop[];
  let creditId: string;
  const token = `ExponentPushToken[w3-${run}-owner]`;

  beforeAll(async () => {
    const riderA = await loginAs('+919000000003');
    const { data } = await riderA.client.rpc('rider_today');
    const runsA = ((data ?? []) as Run[]).filter((r) => r.kitchen_id === KITCHEN_A && r.stops.filter((s) => s.status === 'pending').length >= 3);
    if (runsA.length) {
      rider = riderA;
      [owner, staff] = await Promise.all([loginAs('+919000000001'), loginAs('+919000000002')]);
      kitchen = KITCHEN_A;
      stops = runsA[0]!.stops.filter((s) => s.status === 'pending').slice(0, 3);
    } else {
      [rider, owner, staff] = await Promise.all([loginAs('+919000000013'), loginAs('+919000000011'), loginAs('+919000000012')]);
      const b = await rider.client.rpc('rider_today');
      const runB = ((b.data ?? []) as Run[]).find((r) => r.kitchen_id === KITCHEN_B && r.slot === 'dinner'
        && r.stops.filter((s) => s.status === 'pending').length >= 3);
      expect(runB, 'needs a run with 3 pending stops today: run `pnpm db:reset`').toBeTruthy();
      kitchen = KITCHEN_B;
      stops = runB!.stops.filter((s) => s.status === 'pending').slice(-3);
    }
    // The owner's phone is registered before any alert, so the alerts below are pushed (mock).
    const reg = await owner.client.rpc('register_device', { p_token: token, p_platform: 'android', p_app_version: '1.0.0' });
    expect(reg.error).toBeNull();
  });

  afterAll(async () => {
    await owner?.client.rpc('unregister_device', { p_token: token });
  });

  it("parks a rider's kitchen-fault credit for the owner", async () => {
    const late = await rider.client.rpc('fail_stop', { p_stop: stops[0]!.id, p_reason: 'food_issue', p_note: `w3 ${run}` });
    expect(late.error).toBeNull();
    expect((late.data as { credit_entry_id: string | null }).credit_entry_id).toBeNull();
    const own = await rest(`delivery_stops?select=credit_status&id=eq.${stops[0]!.id}`, rider.accessToken);
    expect(own.body[0]).toEqual({ credit_status: 'pending' });
    // Staff see no money and decide nothing.
    const list = await staff.client.rpc('stop_credit_requests', { p_kitchen: kitchen });
    expect(list.error?.message).toBe('forbidden');
    const decide = await staff.client.rpc('decide_stop_credit', { p_stop: stops[0]!.id, p_approve: true });
    expect(decide.error?.message).toBe('forbidden');
  });

  it('lets the owner approve it once, then correct the stop (the credit is reversed)', async () => {
    const list = await owner.client.rpc('stop_credit_requests', { p_kitchen: kitchen });
    expect(list.error).toBeNull();
    expect((list.data as { stop_id: string }[]).some((x) => x.stop_id === stops[0]!.id)).toBe(true);
    const ok = await owner.client.rpc('decide_stop_credit', { p_stop: stops[0]!.id, p_approve: true, p_note: 'our fault' });
    expect(ok.error).toBeNull();
    creditId = (ok.data as { credit_entry_id: string }).credit_entry_id;
    const entry = await rest(`balance_entries?select=type,meals&id=eq.${creditId}`, owner.accessToken);
    expect(entry.body[0]).toEqual({ type: 'credit', meals: stops[0]!.meal_count });
    const again = await owner.client.rpc('decide_stop_credit', { p_stop: stops[0]!.id, p_approve: true });
    expect(again.error?.message).toBe('not_pending');

    const noNote = await owner.client.rpc('correct_stop', { p_stop: stops[0]!.id, p_status: 'delivered' });
    expect(noNote.error?.message).toBe('note_required');
    const fixed = await owner.client.rpc('correct_stop', { p_stop: stops[0]!.id, p_status: 'delivered', p_note: 'customer says it came' });
    expect(fixed.error).toBeNull();
    expect((fixed.data as { status: string }).status).toBe('delivered');
    const reversal = await rest(`balance_entries?select=type,meals&ref_type=eq.stop_credit_reversal&ref_id=eq.${creditId}`, owner.accessToken);
    expect(reversal.body).toEqual([{ type: 'adjust', meals: -stops[0]!.meal_count }]);
    const byRider = await rider.client.rpc('correct_stop', { p_stop: stops[0]!.id, p_status: 'pending', p_note: 'x' });
    expect(byRider.error?.message).toBe('forbidden');
  });

  it("hands the rider's door cash over in one step", async () => {
    const done = await rider.client.rpc('complete_stop', { p_stop: stops[1]!.id, p_proof: 'none', p_cash_paise: 5000 });
    expect(done.error).toBeNull();
    const mine = await rider.client.rpc('my_cash_handover');
    expect(mine.error).toBeNull();
    const k = (mine.data as { kitchen_id: string; pending_paise: number; pending: { payment_id: string; amount_paise: number }[] }[])
      .find((m) => m.kitchen_id === kitchen)!;
    expect(k.pending_paise).toBeGreaterThanOrEqual(5000);
    const payment = k.pending.find((p) => p.amount_paise === 5000)!;
    expect((await rider.client.rpc('cash_handover', { p_kitchen: kitchen })).error?.message).toBe('forbidden');
    expect((await staff.client.rpc('cash_handover', { p_kitchen: kitchen })).error?.message).toBe('forbidden');

    const board = await owner.client.rpc('cash_handover', { p_kitchen: kitchen });
    expect(board.error).toBeNull();
    const collector = (board.data as { collectors: { user_id: string; pending_paise: number }[] }).collectors.find((c) => c.user_id === rider.userId)!;
    expect(collector.pending_paise).toBeGreaterThanOrEqual(5000);
    const confirm = await owner.client.rpc('confirm_rider_cash', { p_kitchen: kitchen, p_rider: rider.userId, p_payment_ids: [payment.payment_id] });
    expect(confirm.error).toBeNull();
    expect(confirm.data).toEqual({ confirmed: 1, paise: 5000 });
    const paid = await rest(`payments?select=status&id=eq.${payment.payment_id}`, owner.accessToken);
    expect(paid.body[0]).toEqual({ status: 'paid' });
  });

  it('lists alerts in the app and sends them as push (mock) to a registered phone', async () => {
    const bad = await owner.client.rpc('register_device', { p_token: 'nope', p_platform: 'android' });
    expect(bad.error?.message).toBe('invalid_token');
    // Device rows are private to their owner.
    expect((await rest('member_devices?select=token', owner.accessToken)).body.map((d: { token: string }) => d.token)).toContain(token);
    expect((await rest('member_devices?select=token', staff.accessToken)).body).toEqual([]);

    const list = await owner.client.rpc('my_notifications', { p_limit: 100 });
    expect(list.error).toBeNull();
    const alert = (list.data as { template: string; title: string; path: string; kitchen_id: string }[])
      .find((a) => a.template === 'stop_credit_request' && a.kitchen_id === kitchen);
    expect(alert).toMatchObject({ title: 'Credit to approve', path: '/handover' });

    expect((await pushOutbox(owner.accessToken)).status).toBe(403);
    const sent = await pushOutbox(serviceRoleKey());
    expect(sent.status).toBe(200);
    expect(sent.body.mode).toBe('mock');
    // The every-minute cron may have sent it first; either way it ends up recorded as a mock send.
    // One alert per attempt: the key is stop_credit_request:<stop>:<attempt>:<owner>.
    const dedupe = encodeURIComponent(`stop_credit_request:${stops[0]!.id}:*:${owner.userId}`);
    let row: { status: string; last_error: string | null } | undefined;
    for (let i = 0; i < 10; i++) {
      row = (await rest(`notifications_outbox?select=status,last_error&channel=eq.push&dedupe_key=like.${dedupe}`, owner.accessToken)).body[0];
      if (row && row.status !== 'pending' && row.status !== 'sending') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(row).toEqual({ status: 'mock', last_error: null });
  });

  it("stops the owner's alerts on a shared phone once someone else signs in there", async () => {
    // The owner registers the kitchen phone, then signs out offline (unregister never reaches the
    // server). The rider who signs in next releases the token the app still holds.
    const shared = `ExponentPushToken[w3-${run}-shared]`;
    expect((await owner.client.rpc('register_device', { p_token: shared, p_platform: 'android' })).error).toBeNull();
    expect((await rest('member_devices?select=token', owner.accessToken)).body.map((d: { token: string }) => d.token)).toContain(shared);
    expect((await rider.client.rpc('release_device', { p_token: 'nope' })).error?.message).toBe('invalid_token');
    expect((await rider.client.rpc('release_device', { p_token: shared })).error).toBeNull();
    expect((await rest('member_devices?select=token', owner.accessToken)).body.map((d: { token: string }) => d.token)).not.toContain(shared);
    expect((await anonClient().rpc('release_device', { p_token: shared })).error).not.toBeNull();
  });

  it('keeps the owner tools to owners, on a fresh kitchen without riders', async () => {
    const fresh = await loginAs('+919000000130');
    const { data: existing } = await fresh.client.from('members').select('kitchen_id').eq('user_id', fresh.userId).eq('role', 'owner').limit(1);
    let mine = existing?.[0]?.kitchen_id as string | undefined;
    if (!mine) {
      const created = await fresh.client.rpc('create_kitchen', { p_name: `Riders IT ${run}`, p_area: 'Patia' });
      expect(created.error).toBeNull();
      mine = (created.data as unknown as { id: string }).id;
    }
    expect((await fresh.client.rpc('unassigned_runs')).data).toEqual([]);
    const areas = await fresh.client.rpc('area_routes', { p_kitchen: mine, p_slot: 'lunch' });
    expect(areas.error).toBeNull();
    expect((areas.data as { areas: unknown[] }).areas).toEqual([]);
    const dry = await fresh.client.rpc('assign_routes_by_area', { p_kitchen: mine, p_slot: 'lunch', p_rules: [{ area: 'Patia', route: 'North' }], p_dry_run: true });
    expect(dry.error).toBeNull();
    expect((dry.data as { rules: { addresses: number; created: boolean }[] }).rules[0]).toMatchObject({ addresses: 0, created: true });
    expect((await staff.client.rpc('area_routes', { p_kitchen: mine, p_slot: 'lunch' })).error?.message).toBe('forbidden');
    expect((await fresh.client.rpc('cash_handover', { p_kitchen: kitchen })).error?.message).toBe('forbidden');
  });

  it('serves the minimum app version to everyone, logged in or not', async () => {
    const cfg = await anonClient().rpc('app_config');
    expect(cfg.error).toBeNull();
    expect(cfg.data).toMatchObject({ min_app_version: null });
    const set = await owner.client.rpc('admin_set_min_app_version', { p_version: '9.9.9' });
    expect(set.error?.message).toBe('forbidden');
  });
});
