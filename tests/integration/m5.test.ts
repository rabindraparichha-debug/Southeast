// M5 end-to-end over HTTP: the rider app's calls (today's stops, photo upload, offline sync with the
// original timestamp, failed delivery with credit), the owner's live board and the route-optimize
// Edge Function. Uses kitchen B (delivers 7 days a week). Needs a fresh `pnpm db:reset`.
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { env, KITCHEN_B, anonClient, loginAs, rest, type Client } from './helpers';

type Stop = { id: string; seq: number; status: string; phone_masked: string; customer_id: string; meal_count: number };
type Run = { id: string; kitchen_id: string; service_date: string; slot: string; status: string; stops: Stop[] };

describe('M5: rider mode over the API', () => {
  let rider: { client: Client; accessToken: string };
  let owner: { client: Client; accessToken: string };
  let staff: { client: Client; accessToken: string };
  let run: Run;

  beforeAll(async () => {
    [rider, owner, staff] = await Promise.all([
      loginAs('+919000000013'), loginAs('+919000000011'), loginAs('+919000000012'),
    ]);
    const { data, error } = await rider.client.rpc('rider_today');
    expect(error).toBeNull();
    const runs = (data as Run[]).filter((r) => r.kitchen_id === KITCHEN_B && r.stops.some((s) => s.status === 'pending'));
    expect(runs.length, 'kitchen B needs a run with pending stops today: run `pnpm db:reset`').toBeGreaterThan(0);
    run = runs[0]!;
  });

  it("gives the rider today's stops with masked phones only", async () => {
    expect(run.stops.length).toBeGreaterThan(2);
    for (const s of run.stops) expect(s.phone_masked).toMatch(/^XXXXXX\d{4}$/);
    expect(JSON.stringify(run)).not.toMatch(/\+91\d{10}/);
    expect(JSON.stringify(run)).not.toMatch(/"otp"/);
    // Raw REST: the rider sees only their own runs, and never the OTP column.
    const runs = await rest('delivery_runs?select=id,rider_id', rider.accessToken);
    expect(runs.status).toBe(200);
    expect(new Set(runs.body.map((r: { id: string }) => r.id)).has(run.id)).toBe(true);
    const otp = await rest('delivery_stops?select=otp&limit=1', rider.accessToken);
    expect([401, 403]).toContain(otp.status);
  });

  it('syncs a delivery made offline later, with its original timestamp and a proof photo', async () => {
    const stop = run.stops.find((s) => s.status === 'pending')!;
    const tappedAt = new Date(Date.now() - 25 * 60 * 1000); // marked 25 minutes ago, no network then
    const path = `${KITCHEN_B}/${run.service_date}/${stop.id}.jpg`;
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
    const up = await rider.client.storage.from('proofs').upload(path, jpeg, { contentType: 'image/jpeg' });
    expect(up.error).toBeNull();

    const op = randomUUID();
    const args = {
      p_stop: stop.id, p_proof: 'photo' as const, p_photo_path: path, p_lat: 20.29, p_lng: 85.845, p_accuracy: 20,
      p_at: tappedAt.toISOString(), p_tiffins_out: 1, p_tiffins_returned: 1, p_client_op: op, p_offline: true,
    };
    const first = await rider.client.rpc('complete_stop', args);
    expect(first.error).toBeNull();
    expect((first.data as { status: string }).status).toBe('delivered');
    // The phone retries the same queued action (lost response): accepted once.
    const again = await rider.client.rpc('complete_stop', args);
    expect((again.data as { conflict: boolean }).conflict).toBe(false);

    const board = await owner.client.rpc('live_board', { p_kitchen: KITCHEN_B, p_date: run.service_date, p_slot: run.slot as 'lunch' });
    expect(board.error).toBeNull();
    const s = (board.data as { runs: { id: string; stops: { id: string; done_at: string; synced_at: string; offline: boolean; photo_path: string }[] }[] })
      .runs.find((r) => r.id === run.id)!.stops.find((x) => x.id === stop.id)!;
    expect(new Date(s.done_at).getTime()).toBe(tappedAt.getTime());
    expect(new Date(s.synced_at).getTime()).toBeGreaterThan(tappedAt.getTime());
    expect(s.offline).toBe(true);
    // The owner can open the proof photo; the rider cannot read photos back.
    const signed = await owner.client.storage.from('proofs').createSignedUrl(s.photo_path, 60);
    expect(signed.error).toBeNull();
    const riderRead = await rider.client.storage.from('proofs').createSignedUrl(path, 60);
    expect(riderRead.error).not.toBeNull();
  });

  it('a kitchen-fault failure credits the meal back; a customer-side one does not', async () => {
    const pending = run.stops.filter((s) => s.status === 'pending').slice(1, 3);
    const late = await rider.client.rpc('fail_stop', { p_stop: pending[0]!.id, p_reason: 'kitchen_late', p_note: 'test' });
    expect(late.error).toBeNull();
    const creditId = (late.data as { credit_entry_id: string | null }).credit_entry_id;
    expect(creditId).toBeTruthy();
    const entry = await rest(`balance_entries?select=type,meals&id=eq.${creditId}`, owner.accessToken);
    expect(entry.body[0]).toEqual({ type: 'credit', meals: pending[0]!.meal_count });
    const notHome = await rider.client.rpc('fail_stop', { p_stop: pending[1]!.id, p_reason: 'not_home' });
    expect((notHome.data as { credit_entry_id: string | null }).credit_entry_id).toBeNull();
  });

  it('keeps cash and pay stats from staff, and everything from anon', async () => {
    const board = await staff.client.rpc('live_board', { p_kitchen: KITCHEN_B, p_date: run.service_date, p_slot: run.slot as 'lunch' });
    expect(board.error).toBeNull();
    const stops = (board.data as { runs: { stops: { cash_paise: number | null }[] }[] }).runs.flatMap((r) => r.stops);
    expect(stops.every((s) => s.cash_paise === null)).toBe(true);
    const stats = await staff.client.rpc('rider_stats', { p_kitchen: KITCHEN_B, p_month: run.service_date });
    expect(stats.error?.message).toBe('forbidden');
    const anon = await anonClient().rpc('rider_today');
    expect(anon.error).not.toBeNull();
  });

  it('re-optimises a saved route through the Edge Function (built-in optimiser without VROOM_URL)', async () => {
    const routes = await rest(`delivery_routes?select=id&kitchen_id=eq.${KITCHEN_B}&slot=eq.${run.slot}`, owner.accessToken);
    const { url, anonKey } = env();
    const res = await fetch(`${url}/functions/v1/route-optimize`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_id: routes.body[0]!.id }),
    });
    const body = (await res.json()) as { engine: string; km_before: number; km_after: number };
    expect(res.status).toBe(200);
    expect(body.engine).toBe('local');
    expect(Number(body.km_after)).toBeLessThanOrEqual(Number(body.km_before) + 0.01);
    // A rider may not.
    const denied = await fetch(`${url}/functions/v1/route-optimize`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${rider.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_id: routes.body[0]!.id }),
    });
    expect(denied.status).toBe(400);
  });
});
