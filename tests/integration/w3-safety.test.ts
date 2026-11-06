// Vendor-first wave 3 (safety) end-to-end over HTTP: phase flags, revocable customer-page links,
// two refund clicks at once (one gateway refund), public forms behind the Edge Function with rate
// limits, verified vs listed, vendor terms, and Route transfer confirmations through the webhook.
// Mock Razorpay. Spare logins +91 90000 00140-00149 (config.toml).
import { beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@tiffin/core';
import { hmacSha256Hex, mockEvent } from '../../supabase/functions/_shared/razorpay.ts';
import { anonClient, enableFlags, env, loginAs, publicForm, type Client } from './helpers';

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? 'local-dev-webhook-secret';
const run = Date.now().toString(36);

async function invoke<T>(name: string, token: string, body: unknown): Promise<{ status: number; body: T }> {
  const { url, anonKey } = env();
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function webhook(body: string, eventId: string) {
  const res = await fetch(`${env().url}/functions/v1/razorpay-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': await hmacSha256Hex(WEBHOOK_SECRET, body), 'X-Razorpay-Event-Id': eventId },
    body,
  });
  return (await res.json()) as { result?: string; error?: string };
}

describe('Wave 3 safety over the API', () => {
  let admin: { client: Client; accessToken: string };
  let owner: { client: Client; accessToken: string };
  let kitchenId: string;
  let customerId: string;

  beforeAll(async () => {
    [admin, owner] = await Promise.all([loginAs('+919000000099'), loginAs('+919000000140')]);
    await enableFlags(admin.client, ['customer_portal', 'online_payments', 'growth']);
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Safety IT ${run}`, p_area: 'Nayapalli' });
    expect(error).toBeNull();
    kitchenId = (kitchen as { id: string }).id;
    expect((await admin.client.rpc('set_payout_account', { p_kitchen: kitchenId, p_account_id: `acc_W3Safety${run}`, p_kyc_status: 'verified' })).error)
      .toBeNull();
    const { data: plan } = await owner.client.from('plans')
      .insert({ kitchen_id: kitchenId, name: 'Safety Lunch', slots: ['lunch'], price_per_meal_paise: 8000 }).select('id').single();
    const { data: cust, error: cErr } = await owner.client.rpc('create_customer', {
      p_kitchen: kitchenId, p_name: 'Safety Payer', p_phone: `97${String(Date.now()).slice(-8)}`, p_consent: true });
    expect(cErr).toBeNull();
    customerId = cust as string;
    const sub = await owner.client.from('subscriptions')
      .insert({ kitchen_id: kitchenId, customer_id: customerId, plan_id: plan!.id, start_date: istDate(), status: 'active' });
    expect(sub.error).toBeNull();
  });

  it('anyone can read the phase flags; a missing one is off', async () => {
    const { data, error } = await anonClient().rpc('feature_flags');
    expect(error).toBeNull();
    expect(Object.keys(data as object).sort()).toEqual(
      ['customer_portal', 'customer_whatsapp', 'extras', 'growth', 'kitchen_switching', 'marketplace', 'online_payments']);
    expect((data as Record<string, boolean>).customer_portal).toBe(true);
  });

  it('a revoked customer-page link stops working at once; rotate gives one new link', async () => {
    const { data: token, error } = await owner.client.rpc('customer_page_link', { p_customer: customerId });
    expect(error).toBeNull();
    expect((await anonClient().rpc('portal_get', { p_token: token as string })).error).toBeNull();
    const revoked = await owner.client.rpc('revoke_customer_page_links', { p_customer: customerId });
    expect(revoked.data).toBeGreaterThanOrEqual(1);
    expect((await anonClient().rpc('portal_get', { p_token: token as string })).error?.message).toBe('invalid_link');
    const { data: fresh } = await owner.client.rpc('rotate_customer_page_link', { p_customer: customerId });
    expect((await anonClient().rpc('portal_get', { p_token: fresh as string })).error).toBeNull();
    const { data: links } = await owner.client.rpc('customer_page_links', { p_customer: customerId });
    expect(links).toMatchObject({ live: 1 });
  });

  it('an online payment waits for its Route transfer; transfer.* webhooks confirm it', async () => {
    const link = await invoke<{ payment_id: string; amount_paise: number }>('razorpay-payment-link', owner.accessToken, { customer_id: customerId, meals: 10 });
    expect(link.status).toBe(200);
    const paid = mockEvent('payment_link.paid', {
      payment_link: { id: `plink_w3_${run}`, reference_id: link.body.payment_id },
      payment: { id: `pay_w3_${run}`, amount: 80000, currency: 'INR', method: 'upi', notes: { payment_id: link.body.payment_id } },
    });
    expect((await webhook(paid, `evt_w3_paid_${run}`)).result).toBe('paid');
    let { data: p } = await owner.client.from('payments').select('transfer_status').eq('id', link.body.payment_id).single();
    expect(p).toEqual({ transfer_status: 'pending' });
    const transfer = mockEvent('transfer.processed', {
      transfer: { id: `trf_w3_${run}`, source: `pay_w3_${run}`, recipient: `acc_W3Safety${run}`, amount: 80000,
                  notes: { payment_id: link.body.payment_id } },
    });
    expect((await webhook(transfer, `evt_w3_trf_${run}`)).result).toBe('transfer_processed');
    ({ data: p } = await owner.client.from('payments').select('transfer_status').eq('id', link.body.payment_id).single());
    expect(p).toEqual({ transfer_status: 'processed' });
  });

  it('two refund clicks at once produce one gateway refund', async () => {
    const { data: refundId, error } = await owner.client.rpc('refund_unused_meals', { p_customer: customerId, p_meals: 2, p_reason: 'Safety test' });
    expect(error).toBeNull();
    const [a, b] = await Promise.all([
      invoke<{ razorpay_refund_id?: string; error?: string }>('razorpay-refund', owner.accessToken, { refund_id: refundId }),
      invoke<{ razorpay_refund_id?: string; error?: string }>('razorpay-refund', owner.accessToken, { refund_id: refundId }),
    ]);
    // Exactly one call reaches Razorpay. The other is refused at the claim, before the gateway:
    // 'refund_in_progress' while the first is running, or 'not_pending' if it already finished.
    const ok = [a, b].filter((r) => r.status === 200);
    const refused = [a, b].filter((r) => r.status !== 200);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect([[409, 'refund_in_progress'], [400, 'not_pending']]).toContainEqual([refused[0]!.status, refused[0]!.body.error]);
    const { data: r } = await owner.client.from('refunds').select('status, method, razorpay_refund_id').eq('id', refundId as string).single();
    expect(r).toMatchObject({ status: 'processed', method: 'razorpay' });
    expect(r!.razorpay_refund_id).toBe(a.body.razorpay_refund_id ?? b.body.razorpay_refund_id);
    // A processed refund cannot go to the gateway again.
    const again = await invoke<{ error: string }>('razorpay-refund', owner.accessToken, { refund_id: refundId });
    expect(again).toMatchObject({ status: 400, body: { error: 'not_pending' } });
  });

  it('public forms go through the Edge Function, with per-IP limits', async () => {
    const direct = await anonClient().rpc('submit_vendor_application', { p_name: 'X', p_phone: '9861555900', p_consent: true });
    expect(direct.error).not.toBeNull();
    const ip = `203.0.113.${(Date.now() % 250) + 1}`;
    const base = Number(String(Date.now()).slice(-6));
    for (let i = 0; i < 5; i++) {
      const res = await publicForm('submit_vendor_application', { p_name: `Applicant ${i}`, p_phone: `97${String(base + i).padStart(8, '0')}`,
        p_consent: true, p_source: 'website' }, ip);
      expect(res.status, res.error).toBe(200);
    }
    const sixth = await publicForm('submit_vendor_application', { p_name: 'Applicant 6', p_phone: `97${String(base + 6).padStart(8, '0')}`,
      p_consent: true }, ip);
    expect(sixth).toMatchObject({ status: 429, error: 'rate_limited' });
    const bad = await publicForm('admin_leads', {});
    expect(bad).toMatchObject({ status: 400, error: 'invalid_request' });
  });

  it('verification is separate from listing, and the owner sees it', async () => {
    expect((await admin.client.rpc('set_kitchen_status', { p_kitchen: kitchenId, p_status: 'active' })).error?.message).toBe('not_verified');
    const fssai = await owner.client.from('kitchens').update({ fssai_no: `12026002${String(Date.now()).slice(-6)}` }).eq('id', kitchenId);
    expect(fssai.error).toBeNull();
    expect((await admin.client.rpc('admin_verify_kitchen', { p_kitchen: kitchenId, p_verified: true, p_note: 'IT' })).error).toBeNull();
    const { data } = await owner.client.from('kitchens').select('status, verified_at').eq('id', kitchenId).single();
    expect(data!.status).toBe('draft');
    expect(data!.verified_at).not.toBeNull();
    const locked = await owner.client.from('kitchens').update({ fssai_no: '12026002999999' }).eq('id', kitchenId);
    expect(locked.error?.message).toBe('fssai_locked');
  });

  it('the owner accepts the vendor terms and the data processing agreement', async () => {
    const { data: before } = await owner.client.rpc('vendor_terms_status', { p_kitchen: kitchenId });
    const s = before as { accepted: boolean; terms_version: string; dpa_version: string };
    expect(s.accepted).toBe(false);
    const { data: after, error } = await owner.client.rpc('accept_vendor_terms', {
      p_kitchen: kitchenId, p_terms_version: s.terms_version, p_dpa_version: s.dpa_version, p_channel: 'web' });
    expect(error).toBeNull();
    expect(after).toMatchObject({ accepted: true });
    const { data: rows } = await owner.client.from('consents').select('purpose, notice_version').eq('kitchen_id', kitchenId).is('customer_id', null);
    expect(rows!.map((r) => r.purpose).sort()).toEqual(['data_processing', 'vendor_terms']);
  });
});
