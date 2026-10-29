// M3 end-to-end over HTTP: Edge Functions (payment link, webhook, refund, mock page) + RPCs.
// Runs against the local stack in RAZORPAY_MODE=mock (supabase/functions/.env).
import { beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@tiffin/core';
import { hmacSha256Hex, mockEvent } from '../../supabase/functions/_shared/razorpay.ts';
import { env, loginAs, type Client } from './helpers';

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? 'local-dev-webhook-secret';

async function invoke<T>(name: string, token: string, body: unknown): Promise<{ status: number; body: T }> {
  const { url, anonKey } = env();
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function webhook(body: string, eventId: string, signature?: string) {
  const res = await fetch(`${env().url}/functions/v1/razorpay-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature ?? (await hmacSha256Hex(WEBHOOK_SECRET, body)),
      'X-Razorpay-Event-Id': eventId,
    },
    body,
  });
  return { status: res.status, body: (await res.json()) as { result?: string; error?: string } };
}

describe('M3: payments, webhooks and refunds through the Edge Functions', () => {
  let owner: { client: Client; accessToken: string };
  let customerId: string;
  let subscriptionId: string;
  const run = Date.now().toString(36);

  beforeAll(async () => {
    owner = await loginAs('+919000000102'); // own spare number: test files run in parallel
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Money IT ${run}`, p_area: 'Nayapalli' });
    expect(error).toBeNull();
    const kitchenId = (kitchen as { id: string }).id;

    const admin = await loginAs('+919000000099');
    const verified = await admin.client.rpc('set_payout_account', { p_kitchen: kitchenId, p_account_id: 'acc_TestIntegration1', p_kyc_status: 'verified' });
    expect(verified.error).toBeNull();

    const { data: plan } = await owner.client.from('plans')
      .insert({ kitchen_id: kitchenId, name: 'Premium', slots: ['lunch'], price_per_meal_paise: 10000 }).select('id').single();
    const phone = `98${String(Date.now()).slice(-8)}`;
    const { data: cust, error: cErr } = await owner.client.rpc('create_customer', { p_kitchen: kitchenId, p_name: 'Integration Payer', p_phone: phone, p_consent: true });
    expect(cErr).toBeNull();
    customerId = cust as string;
    const { data: sub, error: sErr } = await owner.client.from('subscriptions')
      .insert({ kitchen_id: kitchenId, customer_id: customerId, plan_id: plan!.id, start_date: istDate(), status: 'active' }).select('id').single();
    expect(sErr).toBeNull();
    subscriptionId = sub!.id;
  });

  it('M3 test 1: a ₹2,000 payment creates exactly one recharge even if the webhook fires twice', async () => {
    const link = await invoke<{ payment_id: string; amount_paise: number; short_url: string; mode: string }>(
      'razorpay-payment-link', owner.accessToken, { customer_id: customerId, meals: 20 });
    expect(link.status).toBe(200);
    expect(link.body.amount_paise).toBe(200000);
    expect(link.body.mode).toBe('mock');

    const body = mockEvent('payment_link.paid', {
      payment_link: { id: 'plink_it', reference_id: link.body.payment_id },
      payment: { id: `pay_it_${run}`, amount: 200000, currency: 'INR', method: 'upi', notes: { payment_id: link.body.payment_id } },
    });
    expect((await webhook(body, `evt_it_${run}`)).body.result).toBe('paid');
    expect((await webhook(body, `evt_it_${run}`)).body.result).toBe('duplicate');
    const captured = mockEvent('payment.captured', {
      payment: { id: `pay_it_${run}`, amount: 200000, currency: 'INR', notes: { payment_id: link.body.payment_id } },
    });
    expect((await webhook(captured, `evt_it2_${run}`)).body.result).toBe('already_paid');

    const { data: recharges } = await owner.client.from('balance_entries').select('meals, amount_paise')
      .eq('customer_id', customerId).eq('type', 'recharge');
    expect(recharges).toEqual([{ meals: 20, amount_paise: 200000 }]);
    const { data: payment } = await owner.client.from('payments').select('status, settled_to_account').eq('id', link.body.payment_id).single();
    expect(payment).toEqual({ status: 'paid', settled_to_account: 'acc_TestIntegration1' });
  });

  it('rejects a webhook with a bad signature', async () => {
    const body = mockEvent('payment.captured', { payment: { id: 'pay_forged', amount: 1, currency: 'INR' } });
    const res = await webhook(body, `evt_forged_${run}`, 'deadbeef');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
  });

  it('mock payment page pays a link through the real webhook path', async () => {
    const link = await invoke<{ payment_id: string; short_url: string }>('razorpay-payment-link', owner.accessToken, { customer_id: customerId, meals: 5 });
    const pageHtml = await (await fetch(link.body.short_url)).text();
    expect(pageHtml).toContain('Pay ₹500');
    const paid = await (await fetch(link.body.short_url, { method: 'POST' })).text();
    expect(paid).toContain('Payment successful');
    const { data } = await owner.client.from('customer_balances').select('meals').eq('customer_id', customerId).single();
    expect(data?.meals).toBe(25);
  });

  it('M3 test 2: cancelling with 9 meals left refunds them, visible to vendor and customer', async () => {
    // 16 of the 25 prepaid meals were eaten (recorded as an adjustment for this API test;
    // the engine path with real locks is covered in supabase/tests/04_money.test.sql).
    const eaten = await owner.client.rpc('add_balance_entry', { p_customer: customerId, p_type: 'adjust', p_meals: -16, p_reason: 'Meals eaten (test)' });
    expect(eaten.error).toBeNull();

    const cancel = await owner.client.rpc('request_schedule_change', { p_subscription: subscriptionId, p_type: 'cancel', p_from: istDate() });
    expect(cancel.error).toBeNull();

    const { data: refund } = await owner.client.from('refunds').select('id, meals, amount_paise, status').eq('customer_id', customerId).single();
    expect(refund).toMatchObject({ meals: 9, amount_paise: 90000, status: 'pending' });

    // Customer side: the refund notice is queued for them (sent on WhatsApp from M4).
    const { data: notice } = await owner.client.from('notifications_outbox').select('payload')
      .eq('recipient_id', customerId).eq('template', 'refund_notice').single();
    expect(notice?.payload).toMatchObject({ meals: 9, amount_paise: 90000 });

    // Refund to the original online payment (mock Razorpay confirms via the webhook).
    const res = await invoke<{ razorpay_refund_id: string }>('razorpay-refund', owner.accessToken, { refund_id: refund!.id });
    expect(res.status).toBe(200);
    const { data: after } = await owner.client.from('refunds').select('status, method').eq('id', refund!.id).single();
    expect(after).toEqual({ status: 'processed', method: 'razorpay' });
    const { data: bal } = await owner.client.from('customer_balances').select('meals').eq('customer_id', customerId).single();
    expect(bal?.meals).toBe(0);
  });

  it('staff of the kitchen cannot create payment links', async () => {
    const staff = await loginAs('+919000000002'); // kitchen A staff, not a member here
    const res = await invoke<{ error: string }>('razorpay-payment-link', staff.accessToken, { customer_id: customerId, meals: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('forbidden');
  });
});
