// P5/P6 end-to-end over HTTP: parent pays (payer page + payment link through the Edge Function),
// notebook-photo import (mock AI, preview only, then the existing import RPC), weather alerts
// (service role, mock forecast), dispatch photo in its private bucket, and the kitchen-switching
// flag staying off. Uses its own kitchen (spare number 90000 00105).
import { execSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { env, anonClient, loginAs, type Client } from './helpers';

const run = Date.now().toString(36);
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

function serviceRoleKey(): string {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const out = execSync('npx supabase status -o json', { cwd: new URL('../..', import.meta.url).pathname }).toString();
  return JSON.parse(out.slice(out.indexOf('{'))).SERVICE_ROLE_KEY as string;
}

async function invoke<T>(name: string, bearer: string, body: unknown): Promise<{ status: number; body: T }> {
  const { url, anonKey } = env();
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const phone = (i: number) => `96${String(Date.now()).slice(-7)}${i}`;

describe('P5/P6 over the API', () => {
  let owner: { client: Client; accessToken: string };
  let kitchenId: string;
  let parentId: string;
  let studentId: string;
  let parentToken: string;

  beforeAll(async () => {
    owner = await loginAs('+919000000105');
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', {
      p_name: `P5 IT ${run}`, p_area: 'Patia', p_lat: 20.3553, p_lng: 85.8197,
    });
    expect(error).toBeNull();
    kitchenId = (kitchen as { id: string }).id;
    const { data: plan } = await owner.client.from('plans')
      .insert({ kitchen_id: kitchenId, name: 'Veg Lunch', slots: ['lunch'], days_of_week: [1, 2, 3, 4, 5, 6, 7], price_per_meal_paise: 7000 })
      .select('id').single();
    const ids: string[] = [];
    for (const [i, name] of ['Parent Payer', 'Student Eater'].entries()) {
      const { data: cust, error: cErr } = await owner.client.rpc('create_customer', {
        p_kitchen: kitchenId, p_name: name, p_phone: phone(i), p_consent: true,
        p_address: { line1: `Flat ${i}`, area: 'Patia', lat: 20.3553 + i / 1000, lng: 85.8197 },
      });
      expect(cErr).toBeNull();
      ids.push(cust as string);
      await owner.client.from('subscriptions').insert({ kitchen_id: kitchenId, customer_id: cust as string, plan_id: plan!.id,
        start_date: new Date().toISOString().slice(0, 10), status: 'active' });
    }
    [parentId, studentId] = ids as [string, string];
  });

  it('parent pays for the student from their own page', async () => {
    expect((await owner.client.rpc('set_payer', { p_customer: studentId, p_payer: parentId })).error).toBeNull();
    const chain = await owner.client.rpc('set_payer', { p_customer: parentId, p_payer: studentId });
    expect(chain.error?.message).toBe('payer_chain');

    const { data: token } = await owner.client.rpc('customer_page_link', { p_customer: parentId });
    parentToken = token as string;
    const anon = anonClient();
    const { data: page, error } = await anon.rpc('portal_get', { p_token: parentToken });
    expect(error).toBeNull();
    const p = page as { dependents: { customer_id: string; name: string }[]; referral: { code: string } };
    expect(p.dependents).toEqual([expect.objectContaining({ customer_id: studentId, name: 'Student Eater' })]);
    expect(p.referral.code).toMatch(/^[A-Z2-9]{8}$/);

    // New kitchens have no verified payout account: the Edge Function reports it.
    const blocked = await invoke<{ error: string }>('razorpay-payment-link', env().anonKey,
      { token: parentToken, dependent_id: studentId, meals: 5 });
    expect(blocked).toMatchObject({ status: 400, body: { error: 'payout_account_not_verified' } });
    const admin = await loginAs('+919000000099');
    expect((await admin.client.rpc('set_payout_account', { p_kitchen: kitchenId, p_account_id: `acc_P5IT${run}`, p_kyc_status: 'verified' })).error)
      .toBeNull();
    const link = await invoke<{ short_url: string; amount_paise: number; commission_paise: number; mode: string }>('razorpay-payment-link',
      env().anonKey, { token: parentToken, dependent_id: studentId, meals: 5 });
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ amount_paise: 35000, commission_paise: 0, mode: 'mock' });
    const { data: pay } = await owner.client.from('payments').select('customer_id, description').eq('kitchen_id', kitchenId)
      .order('created_at', { ascending: false }).limit(1).single();
    expect(pay).toMatchObject({ customer_id: studentId, description: '5 meals for Student Eater' });

    const stranger = await invoke<{ error: string }>('razorpay-payment-link', env().anonKey, { token: parentToken, dependent_id: parentId, meals: 5 });
    expect(stranger).toMatchObject({ status: 400, body: { error: 'forbidden' } });
  });

  it('reads a notebook photo into a preview and imports through the existing RPC', async () => {
    const path = `${kitchenId}/${run}-register.jpg`;
    expect((await owner.client.storage.from('imports').upload(path, JPEG, { contentType: 'image/jpeg' })).error).toBeNull();
    const denied = await invoke<{ error: string }>('notebook-import', owner.accessToken, { kitchen_id: kitchenId, path: `other/${run}.jpg` });
    expect(denied).toMatchObject({ status: 400, body: { error: 'invalid_photo' } });

    const res = await invoke<{ mode: string; rows: { flags: string[] }[]; import_rows: Record<string, string>[]; summary: Record<string, number> }>(
      'notebook-import', owner.accessToken, { kitchen_id: kitchenId, path });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('mock');
    expect(res.body.summary).toMatchObject({ total: 4, importable: 2 });
    // Preview only: nothing was written.
    const before = await owner.client.from('customers').select('id', { count: 'exact', head: true }).eq('kitchen_id', kitchenId);
    expect(before.count).toBe(2);
    const imported = await owner.client.rpc('import_customers', {
      p_kitchen: kitchenId, p_rows: res.body.import_rows, p_consent: true, p_file_name: 'notebook.jpg',
    });
    expect(imported.error).toBeNull();
    expect(imported.data).toMatchObject({ imported: 2, failed: 0 });
  });

  it('records the dispatch photo in a private bucket', async () => {
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const path = `${kitchenId}/${run}-dispatch.jpg`;
    expect((await owner.client.storage.from('dispatch').upload(path, JPEG, { contentType: 'image/jpeg' })).error).toBeNull();
    const { error } = await owner.client.rpc('record_dispatch_photo', { p_kitchen: kitchenId, p_date: today, p_slot: 'lunch', p_photo_path: path });
    expect(error).toBeNull();
    const publicUrl = owner.client.storage.from('dispatch').getPublicUrl(path).data.publicUrl;
    expect((await fetch(publicUrl)).status).toBeGreaterThanOrEqual(400);
  });

  it('weather alerts run with the service role only, at most once per slot', async () => {
    const denied = await invoke<{ error: string }>('weather-alerts', owner.accessToken, {});
    expect(denied.status).toBe(403);
    const key = serviceRoleKey();
    const body = { now: '2027-06-01T01:00:00Z', kitchen_id: kitchenId, scenario: 'rain' };
    const first = await invoke<{ alerts: number; duplicates: number; mode: string }>('weather-alerts', key, body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ mode: 'mock', alerts: 3, duplicates: 0 });
    const again = await invoke<{ alerts: number; duplicates: number }>('weather-alerts', key, body);
    expect(again.body).toMatchObject({ alerts: 0, duplicates: 3 });
    const { data: list } = await owner.client.rpc('weather_alerts_list', { p_kitchen: kitchenId, p_days: 90 });
    expect(list as unknown[]).toHaveLength(3); // recent and upcoming alerts
    const { data: rows } = await owner.client.from('weather_alerts').select('service_date, slot, kind').eq('kitchen_id', kitchenId);
    expect(rows!.map((r) => `${r.service_date}:${r.slot}:${r.kind}`).sort())
      .toEqual(['2027-06-01:dinner:rain', '2027-06-01:lunch:rain', '2027-06-02:lunch:rain']);
  });

  it('kitchen switching stays off until the platform turns it on', async () => {
    const res = await anonClient().rpc('portal_switch_options', { p_token: parentToken });
    expect(res.error?.message).toBe('feature_disabled');
    const { data: flags } = await owner.client.from('platform_settings').select('key, enabled');
    expect(flags).toEqual(expect.arrayContaining([{ key: 'kitchen_switching', enabled: false }]));
  });
});
