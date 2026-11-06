// Phase 2 hardening over the API (D-126..D-132): what callers really get through PostgREST and the
// lead-intake function. Timing and money rules are in supabase/tests/15_phase2_hardening.test.sql.
import { beforeAll, describe, expect, it } from 'vitest';
import { anonClient, env, loginAs, type Client } from './helpers';

async function intake(query: string, body: unknown, headers: Record<string, string> = {}) {
  const { url, anonKey } = env();
  const res = await fetch(`${url}/functions/v1/lead-intake${query}`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('Phase 2 hardening over the API', () => {
  let owner: { client: Client; accessToken: string };
  const run = Date.now().toString(36);
  let kitchen1: string;
  let customer1: string;
  let otherCode: string;

  beforeAll(async () => {
    owner = await loginAs('+919000000160'); // own spare number: test files run in parallel
    const k1 = await owner.client.rpc('create_kitchen', { p_name: `Phase2 One ${run}`, p_area: 'Patia' });
    const k2 = await owner.client.rpc('create_kitchen', { p_name: `Phase2 Two ${run}`, p_area: 'Patia' });
    expect(k1.error).toBeNull();
    expect(k2.error).toBeNull();
    kitchen1 = (k1.data as { id: string }).id;
    const kitchen2 = (k2.data as { id: string }).id;
    const phone = (n: number) => `97${String(Date.now() + n).slice(-8)}`;
    const c1 = await owner.client.rpc('create_customer', { p_kitchen: kitchen1, p_name: 'Phase Two A', p_phone: phone(1), p_consent: true });
    const c2 = await owner.client.rpc('create_customer', { p_kitchen: kitchen2, p_name: 'Phase Two B', p_phone: phone(2), p_consent: true });
    expect(c1.error).toBeNull();
    expect(c2.error).toBeNull();
    customer1 = c1.data as string;
    const { data } = await owner.client.from('customers').select('referral_code').eq('id', c2.data as string).single();
    otherCode = data!.referral_code!;
  });

  it('a referral code from another kitchen gets its own message', async () => {
    const { error } = await owner.client.rpc('apply_referral_code', { p_customer: customer1, p_code: otherCode });
    expect(error?.message).toBe('referral_other_kitchen');
  });

  it('the public join page is behind the customer_portal flag (off by default)', async () => {
    const { error } = await anonClient().rpc('referral_invite', { p_slug: 'maa-tarini-tiffin', p_code: otherCode });
    expect(error?.message).toBe('feature_disabled');
    const join = await anonClient().rpc('referral_join', {
      p_slug: 'maa-tarini-tiffin', p_code: otherCode, p_name: 'X', p_phone: '9876543210',
      p_plan: '20000000-0000-4000-a000-0000000000a1', p_address: 'House 1', p_consent: true,
    });
    expect(join.error?.message).toBe('feature_disabled');
  });

  it('owners cannot reach the team queue, the AI budget or payment-link cancelling', async () => {
    expect((await owner.client.rpc('admin_escalations', {})).error?.message).toBe('forbidden');
    expect((await owner.client.rpc('admin_requeue_mock_conversions')).error?.message).toBe('forbidden');
    const ai = await owner.client.rpc('wa_ai_take', { p_conversation: customer1, p_conversation_cap: 9, p_day_cap: 9 });
    expect(ai.error).not.toBeNull();
    const cancel = await owner.client.rpc('cancel_payment_link_record', { p_payment: customer1, p_error: 'x' });
    expect(cancel.error).not.toBeNull();
    const usage = await owner.client.from('ai_usage').select('day');
    expect(usage.data ?? []).toHaveLength(0);
    const log = await owner.client.from('complaint_admin_events').select('id');
    expect(log.data ?? []).toHaveLength(0);
    const attempts = await owner.client.from('referral_join_attempts').select('id');
    expect(attempts.data ?? []).toHaveLength(0);
  });

  it('lead intake takes its key from a header, never from the URL', async () => {
    const key = process.env.LEAD_INTAKE_KEY ?? 'local-dev-lead-key';
    const lead = { external_id: `p2-${run}`, name: 'Header Lead', phone: '+919861000160', area: 'Patia' };
    const inUrl = await intake(`?source=sulekha&key=${encodeURIComponent(key)}`, lead);
    expect(inUrl.status).toBe(403);
    expect(inUrl.body.error).toBe('key_in_url');
    const missing = await intake('?source=sulekha', lead);
    expect(missing.status).toBe(401);
    const wrong = await intake('?source=sulekha', lead, { 'X-Lead-Key': 'wrong-key' });
    expect(wrong.status).toBe(403);
    const ok = await intake('?source=sulekha', lead, { 'X-Lead-Key': key });
    expect(ok.status).toBe(200);
    expect(ok.body.duplicate).toBe(false);
  });
});
