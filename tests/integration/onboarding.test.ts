// Wave 4 over the API: the vendor approval gate, Odia kitchen names, invited staff never offered
// "Set up your kitchen", the admin-change-phone Edge Function, dated plan prices, phoned-in
// complaints, "Export my kitchen" and close requests. Spare numbers +919000000150 … 159 only
// (155–159 are not on the seed's allowed list, so the gate can be seen refusing them), and
// +919000000149 for a phone + password sign-up (never logged in with a code).
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@tiffin/core';
import type { ExportPage, OnboardingStatus, PlanPriceResult } from '@tiffin/db';
import { KITCHEN_A, env, loginAs, type Client } from './helpers';

type Login = { client: Client; accessToken: string; userId: string };

// One OTP login per number for the whole file: GoTrue refuses a second code request for the same
// number within seconds, and other suites log in as the admin at the same time.
const logins = new Map<string, Promise<Login>>();
function login(phone: string): Promise<Login> {
  if (!logins.has(phone)) logins.set(phone, loginAs(phone));
  return logins.get(phone)!;
}

async function callFunction(name: string, accessToken: string, body: unknown) {
  const { url, anonKey } = env();
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('Wave 4: approval gate and onboarding', () => {
  let admin: Login;
  beforeAll(async () => {
    admin = await login('+919000000099');
  });

  it('refuses an unapproved number, and an allowed number may create a kitchen', async () => {
    const vendor = await login('+919000000156');
    const refused = await vendor.client.rpc('create_kitchen', { p_name: 'Gate Test Kitchen' });
    expect(refused.error?.message).toBe('not_approved');
    let status = (await vendor.client.rpc('onboarding_status')).data as unknown as OnboardingStatus;
    expect(status.can_create_kitchen).toBe(false);

    const allowed = await admin.client.rpc('admin_allow_vendor_phone', { p_phone: '+919000000156', p_note: 'Integration test' });
    expect(allowed.error).toBeNull();
    status = (await vendor.client.rpc('onboarding_status')).data as unknown as OnboardingStatus;
    expect(status).toMatchObject({ can_create_kitchen: true, basis: 'allowed' });

    // Removed again (so the next run starts refused); the log keeps both actions.
    const removed = await admin.client.rpc('admin_remove_vendor_phone', { p_id: allowed.data as string, p_reason: 'Test over' });
    expect(removed.error).toBeNull();
    status = (await vendor.client.rpc('onboarding_status')).data as unknown as OnboardingStatus;
    expect(status.can_create_kitchen).toBe(false);
    const { data: log } = await admin.client.from('admin_actions').select('action').eq('target', allowed.data as string);
    expect((log ?? []).map((r) => r.action).sort()).toEqual(['vendor_phone_allowed', 'vendor_phone_removed']);

    // Vendors cannot allow themselves.
    const self = await vendor.client.rpc('admin_allow_vendor_phone', { p_phone: '+919000000156', p_note: 'me' });
    expect(self.error?.message).toBe('forbidden');
  });

  it('a phone + password sign-up never counts as a proven phone (D-134)', async () => {
    // +919000000149 is on the seed's allowed list. With phone confirmations on, a password sign-up
    // gets no session until the number is proven with a code; even if it did, the gate would refuse it.
    const { url, anonKey } = env();
    const headers = { apikey: anonKey, 'Content-Type': 'application/json' };
    const creds = JSON.stringify({ phone: '+919000000149', password: 'hunter2hunter2' });
    const signup = await fetch(`${url}/auth/v1/signup`, { method: 'POST', headers, body: creds });
    const signupBody = (await signup.json().catch(() => ({}))) as { access_token?: string };
    expect(signupBody.access_token).toBeUndefined();
    const token = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers, body: creds });
    const tokenBody = (await token.json().catch(() => ({}))) as { access_token?: string };
    if (tokenBody.access_token) {
      const res = await fetch(`${url}/rest/v1/rpc/create_kitchen`, {
        method: 'POST', headers: { ...headers, Authorization: `Bearer ${tokenBody.access_token}` },
        body: JSON.stringify({ p_name: 'Password Kitchen' }),
      });
      expect(((await res.json()) as { message?: string }).message).toBe('not_approved');
    } else {
      expect(token.ok).toBe(false);
    }
  });

  it('creates a kitchen with an Odia name (no raw database error)', async () => {
    const vendor = await loginAs('+919000000150');
    const { data, error } = await vendor.client.rpc('create_kitchen', { p_name: 'ମା ତାରିଣୀ ଟିଫିନ', p_area: 'Patia' });
    expect(error).toBeNull();
    expect(data!.name).toBe('ମା ତାରିଣୀ ଟିଫିନ');
    expect(data!.slug).toMatch(/^kitchen-[0-9a-f]{6}(-[0-9a-f]{4})?$/);
    const bad = await vendor.client.rpc('create_kitchen', { p_name: 'X' });
    expect(bad.error?.message).toBe('invalid_name');
  });

  it('an invited person sees their kitchen, not "Set up your kitchen"', async () => {
    const owner = await loginAs('+919000000153');
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Invite IT ${Date.now().toString(36)}` });
    expect(error).toBeNull();
    const invite = await owner.client.rpc('invite_member', { p_kitchen: kitchen!.id, p_phone: '9000000157', p_role: 'staff' });
    expect(invite.error).toBeNull();

    const staff = await loginAs('+919000000157');
    if ((invite.data as { status: string }).status === 'invited') {
      const before = (await staff.client.rpc('onboarding_status')).data as unknown as OnboardingStatus;
      expect(before.pending_invites).toBeGreaterThanOrEqual(1);
    }
    await staff.client.rpc('claim_invites');
    const after = (await staff.client.rpc('onboarding_status')).data as unknown as OnboardingStatus;
    expect(after.pending_invites).toBe(0);
    expect(after.memberships).toBeGreaterThanOrEqual(1);
    expect(after.can_create_kitchen).toBe(false);
  });
});

describe('Wave 4: admin-change-phone Edge Function', () => {
  it('changes a login phone (admin only, with a reason) and signs the user out', async () => {
    const admin = await login('+919000000099');
    const member = await loginAs('+919000000151');

    const noReason = await callFunction('admin-change-phone', admin.accessToken, { user_id: member.userId, new_phone: '9000000152' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toBe('reason_required');

    const notAdmin = await callFunction('admin-change-phone', member.accessToken,
      { user_id: member.userId, new_phone: '9000000152', reason: 'Lost SIM' });
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.body.error).toBe('forbidden');

    const taken = await callFunction('admin-change-phone', admin.accessToken,
      { user_id: member.userId, new_phone: '9000000001', reason: 'Lost SIM' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('phone_in_use');

    const changed = await callFunction('admin-change-phone', admin.accessToken,
      { user_id: member.userId, new_phone: '90000 00152', reason: 'Lost SIM (integration test)' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ ok: true, phone_last4: '0152', signed_out: true });

    // The old refresh token no longer works; the new number logs in to the same account.
    const refreshed = await member.client.auth.refreshSession();
    expect(refreshed.error).not.toBeNull();
    const again = await loginAs('+919000000152');
    expect(again.userId).toBe(member.userId);

    // Put it back so the next run starts from the same state.
    const back = await callFunction('admin-change-phone', admin.accessToken,
      { user_id: member.userId, new_phone: '9000000151', reason: 'Restore after integration test' });
    expect(back.status).toBe(200);
    const { data: log } = await admin.client.from('admin_actions').select('action, reason').eq('target', member.userId)
      .order('id', { ascending: false }).limit(2);
    expect(log?.map((r) => r.reason)).toEqual(['Restore after integration test', 'Lost SIM (integration test)']);
  });
});

describe('Wave 4: owner tools', () => {
  let owner: Login;
  let kitchenId: string;
  let planId: string;
  let customerId: string;

  beforeAll(async () => {
    owner = await loginAs('+919000000154');
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Owner Tools IT ${Date.now().toString(36)}` });
    expect(error).toBeNull();
    kitchenId = kitchen!.id;
    const { data: plan } = await owner.client.from('plans')
      .insert({ kitchen_id: kitchenId, name: 'Lunch', slots: ['lunch'], price_per_meal_paise: 7000 }).select('id').single();
    planId = plan!.id;
    const { data: cust, error: cErr } = await owner.client.rpc('create_customer', {
      p_kitchen: kitchenId, p_name: 'Export Customer', p_phone: `97${String(Date.now()).slice(-8)}`, p_consent: true,
      p_address: { line1: 'Flat 9', area: 'Patia' },
    });
    expect(cErr).toBeNull();
    customerId = cust as string;
  });

  it('schedules a plan price from a later date and cancels it', async () => {
    const from = addDays(istDate(), 20);
    const { data, error } = await owner.client.rpc('set_plan_price', { p_plan: planId, p_price_paise: 8000, p_from: from });
    expect(error).toBeNull();
    const res = data as unknown as PlanPriceResult;
    expect(res).toMatchObject({ scheduled: true, effective_from: from, price_per_meal_paise: 8000 });
    const { data: plan } = await owner.client.from('plans').select('price_per_meal_paise').eq('id', planId).single();
    expect(plan!.price_per_meal_paise).toBe(7000);
    const { data: upcoming } = await owner.client.from('plan_prices').select('id, price_per_meal_paise, effective_from')
      .eq('plan_id', planId).is('cancelled_at', null).gt('effective_from', istDate());
    expect(upcoming).toEqual([{ id: res.id, price_per_meal_paise: 8000, effective_from: from }]);
    expect((await owner.client.rpc('cancel_plan_price', { p_id: res.id! })).error).toBeNull();
    const past = await owner.client.rpc('set_plan_price', { p_plan: planId, p_price_paise: 8000, p_from: addDays(istDate(), -1) });
    expect(past.error?.message).toBe('date_in_past');
  });

  it('logs a phoned-in complaint', async () => {
    const { data: id, error } = await owner.client.rpc('log_complaint', { p_customer: customerId, p_category: 'quality', p_note: 'Rice was hard' });
    expect(error).toBeNull();
    const { data: row } = await owner.client.from('complaints').select('channel, status, description').eq('id', id as string).single();
    expect(row).toEqual({ channel: 'vendor', status: 'responded', description: 'Rice was hard' });
  });

  it('exports the kitchen page by page (owner only)', async () => {
    const { data, error } = await owner.client.rpc('export_kitchen', { p_kitchen: kitchenId, p_part: 'customers' });
    expect(error).toBeNull();
    const page = data as unknown as ExportPage;
    expect(page.rows).toHaveLength(1);
    expect(String(page.rows[0]!.phone)).toMatch(/^\+919\d{9}$/);
    expect(page.next_offset).toBeNull();
    const outsider = await login('+919000000156'); // not a member of either kitchen
    const denied = await outsider.client.rpc('export_kitchen', { p_kitchen: KITCHEN_A, p_part: 'customers' });
    expect(denied.error?.message).toBe('forbidden');
    const notMine = await outsider.client.rpc('export_kitchen', { p_kitchen: kitchenId, p_part: 'customers' });
    expect(notMine.error?.message).toBe('forbidden');
  });

  it('files a close request the platform team resolves', async () => {
    const { data: id, error } = await owner.client.rpc('request_kitchen_close', { p_kitchen: kitchenId, p_reason: 'Integration test' });
    expect(error).toBeNull();
    const admin = await login('+919000000099');
    const { data: open } = await admin.client.rpc('admin_close_requests', {});
    expect((open as { id: string }[]).some((r) => r.id === id)).toBe(true);
    const resolved = await admin.client.rpc('admin_resolve_close_request', { p_id: id as string, p_status: 'declined', p_note: 'Test only' });
    expect(resolved.error).toBeNull();
    const { data: mine } = await owner.client.from('kitchen_close_requests').select('status, resolution_note').eq('id', id as string).single();
    expect(mine).toEqual({ status: 'declined', resolution_note: 'Test only' });
  });
});
