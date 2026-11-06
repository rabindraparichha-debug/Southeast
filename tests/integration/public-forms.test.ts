// Unit tests (no network) for wave 3 safety: the public-forms handler and Turnstile helper, the shared
// Razorpay link input (commission on every path, the WhatsApp bot included), transfer notes and the
// refund idempotency key, and the outbox opt-in exception for the lead confirmation.
import { describe, expect, it } from 'vitest';
import { ACTIONS, handlePublicForm, statusFor, type PublicFormDeps } from '../../supabase/functions/public-forms/handler.ts';
import { clientIp, loadCaptchaConfig, verifyCaptcha } from '../../supabase/functions/_shared/turnstile.ts';
import { linkInputFromRecord, paymentLinkBody, RazorpayApiError, refundBody, routeTransfer } from '../../supabase/functions/_shared/razorpay.ts';
import { CUSTOMER_TEMPLATES_WITHOUT_OPT_IN, renderOutbox } from '../../supabase/functions/_shared/templates.ts';

const envOf = (vars: Record<string, string>) => (k: string) => vars[k];
const LOCAL = { SUPABASE_URL: 'http://kong:8000' };
const HOSTED = { SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', PLATFORM_ENV: 'production' };

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://x/public-forms', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function deps(over: Partial<PublicFormDeps> = {}) {
  const calls: { fn: string; args: Record<string, unknown>; ip: string | null }[] = [];
  const d: PublicFormDeps = {
    verifyCaptcha: async (token) => token === 'good',
    rpc: async (fn, args, ip) => {
      calls.push({ fn, args, ip });
      return { data: { ok: fn }, error: null };
    },
    ...over,
  };
  return { d, calls };
}

describe('Turnstile config: on with a key, off only locally', () => {
  it('is off on a local stack without a key', () => {
    expect(loadCaptchaConfig(envOf(LOCAL)).mode).toBe('off');
  });
  it('refuses a hosted project without a key (captcha_not_configured)', () => {
    expect(() => loadCaptchaConfig(envOf(HOSTED))).toThrow(/^captcha_not_configured/);
    expect(() => loadCaptchaConfig(envOf({ ...LOCAL, PLATFORM_ENV: 'staging' }))).toThrow(/^captcha_not_configured/);
  });
  it('uses Cloudflare with a key, anywhere', () => {
    const cfg = loadCaptchaConfig(envOf({ ...HOSTED, TURNSTILE_SECRET_KEY: 'sec' }));
    expect(cfg).toMatchObject({ mode: 'turnstile', secret: 'sec', verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify' });
  });
  it('verifies the token with the secret and the caller IP', async () => {
    let sent: URLSearchParams | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = init.body as URLSearchParams;
      return new Response(JSON.stringify({ success: sent.get('response') === 'tok' }));
    }) as unknown as typeof fetch;
    const cfg = { mode: 'turnstile' as const, secret: 'sec', verifyUrl: 'https://v' };
    expect(await verifyCaptcha(cfg, 'tok', '203.0.113.9', fakeFetch)).toBe(true);
    expect(sent?.get('secret')).toBe('sec');
    expect(sent?.get('remoteip')).toBe('203.0.113.9');
    expect(await verifyCaptcha(cfg, 'bad', null, fakeFetch)).toBe(false);
    expect(await verifyCaptcha(cfg, '', null, fakeFetch)).toBe(false);
    expect(await verifyCaptcha(cfg, 'tok', null, (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toBe(false);
    expect(await verifyCaptcha({ mode: 'off', verifyUrl: '' }, undefined, null)).toBe(true);
  });
  it('reads the caller IP from Cloudflare first, then proxy headers, and ignores junk', () => {
    expect(clientIp(new Headers({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1' }))).toBe('203.0.113.9');
    expect(clientIp(new Headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }))).toBe('198.51.100.7');
    expect(clientIp(new Headers({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIp(new Headers({ 'x-forwarded-for': "'; drop table x" }))).toBeNull();
    expect(clientIp(new Headers())).toBeNull();
  });
});

describe('public-forms handler', () => {
  it('needs a valid CAPTCHA for the lead and vendor forms, not for the pick', async () => {
    const { d, calls } = deps();
    expect((await handlePublicForm(post({ action: 'submit_lead', args: { p_name: 'A' } }), d)).status).toBe(403);
    expect((await handlePublicForm(post({ action: 'submit_vendor_application', args: {}, captcha_token: 'bad' }), d)).status).toBe(403);
    expect(calls).toHaveLength(0);
    const ok = await handlePublicForm(post({ action: 'submit_lead', args: { p_name: 'A' }, captcha_token: 'good' }), d);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { ok: 'submit_lead' } });
    expect((await handlePublicForm(post({ action: 'lead_choose', args: { p_token: 't', p_kitchen: 'k' } }), d)).status).toBe(200);
    expect(ACTIONS.lead_choose.captcha).toBe(false);
  });
  it('passes only the known arguments and the caller IP', async () => {
    const { d, calls } = deps();
    await handlePublicForm(post({ action: 'submit_vendor_application', captcha_token: 'good',
      args: { p_name: 'G', p_phone: '9861000000', p_evil: 'x', p_consent: true } }, { 'cf-connecting-ip': '203.0.113.9' }), d);
    expect(calls[0]).toEqual({ fn: 'submit_vendor_application', args: { p_name: 'G', p_phone: '9861000000', p_consent: true }, ip: '203.0.113.9' });
  });
  it('refuses unknown actions and bad bodies', async () => {
    const { d, calls } = deps();
    for (const body of [{ action: 'admin_leads', args: {} }, { action: 'toString', args: {} }, { action: 'submit_lead', args: [] }, {}]) {
      expect((await handlePublicForm(post(body), d)).status).toBe(400);
    }
    expect((await handlePublicForm(new Request('http://x', { method: 'GET' }), d)).status).toBe(405);
    expect(calls).toHaveLength(0);
  });
  it('maps database codes to HTTP statuses', async () => {
    const { d } = deps({ rpc: async () => ({ data: null, error: { message: 'rate_limited' } }) });
    const res = await handlePublicForm(post({ action: 'lead_choose', args: {} }), d);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(statusFor('too_many_requests')).toBe(429);
    expect(statusFor('feature_disabled')).toBe(404);
    expect(statusFor('invalid_phone')).toBe(400);
  });
});

describe('Razorpay: one link input on every path (commission included), transfer notes, refund idempotency', () => {
  const rec = { payment_id: 'p-1', amount_paise: 70000, meals: 7, linked_account_id: 'acc_X', customer_name: 'Asha',
    customer_phone: '+919861000001', kitchen_name: 'K', transfer_paise: 63000, commission_paise: 7000 };
  it('the WhatsApp bot path now sends the kitchen only its share', () => {
    const input = linkInputFromRecord(rec);
    expect(input).toMatchObject({ paymentId: 'p-1', amountPaise: 70000, transferPaise: 63000, description: '7 meals' });
    expect(paymentLinkBody(input, 1)).toMatchObject({ options: { order: { transfers: [{ account: 'acc_X', amount: 63000, notes: { payment_id: 'p-1' } }] } } });
    expect(linkInputFromRecord({ ...rec, transfer_paise: undefined }).transferPaise).toBeNull();
  });
  it('the transfer carries our payment id so transfer.* webhooks find it', () => {
    expect(routeTransfer(70000, 63000, 'acc_X', 'p-1')).toEqual({ account: 'acc_X', amount: 63000, currency: 'INR', on_hold: 0, notes: { payment_id: 'p-1' } });
  });
  it('refunds send our refund id as receipt (and as the idempotency header)', () => {
    expect(refundBody(5000, 'r-1')).toEqual({ amount: 5000, speed: 'normal', reverse_all: 1, receipt: 'r-1', notes: { refund_id: 'r-1' } });
  });
  it('only a 4xx answer counts as a definite refusal', () => {
    expect(new RazorpayApiError(400, 'x').definite).toBe(true);
    expect(new RazorpayApiError(429, 'x').definite).toBe(false);
    expect(new RazorpayApiError(503, 'x').definite).toBe(false);
  });
});

describe('templates', () => {
  it('lead_confirm goes out without WhatsApp opt-in (the person asked for it), nothing else does', () => {
    expect([...CUSTOMER_TEMPLATES_WITHOUT_OPT_IN]).toEqual(['lead_confirm']);
    expect(renderOutbox('lead_confirm', { name: 'Asha', trial_meals: 2, kitchen_name: 'Maa Tarini', url: 'https://x/find/confirm/t' }, 'en', '', false))
      .toMatchObject({ type: 'template', name: 'lead_confirm_v1', params: ['Asha', '2', 'Maa Tarini', 'https://x/find/confirm/t'] });
  });
  it('transfer_failed tells the owner', () => {
    const out = renderOutbox('transfer_failed', { amount_paise: 16000, paid_at: '2026-11-12T04:30:00Z', error: 'Linked account not activated' }, 'en', 'Puri Rasoi', false);
    expect(out).toMatchObject({ type: 'template', name: 'transfer_failed_v1' });
    expect((out as { preview: string }).preview).toContain('₹160');
  });
});
