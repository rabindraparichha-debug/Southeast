// Unit tests for the Edge Functions' shared Razorpay module (no network).
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, loadConfig, verifySignature } from '../../supabase/functions/_shared/razorpay.ts';
import { handleRazorpayWebhook } from '../../supabase/functions/razorpay-webhook/handler.ts';

const envOf = (vars: Record<string, string>) => (k: string) => vars[k];

describe('loadConfig guardrails', () => {
  it('defaults to mock mode without keys', () => {
    expect(loadConfig(envOf({ RAZORPAY_WEBHOOK_SECRET: 's' })).mode).toBe('mock');
  });
  it('refuses live keys unless the owner approved them', () => {
    const live = { RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 'x', RAZORPAY_WEBHOOK_SECRET: 's' };
    expect(() => loadConfig(envOf(live))).toThrow(/live_keys_not_approved/);
    expect(() => loadConfig(envOf({ ...live, RAZORPAY_MODE: 'test' }))).toThrow(/live_keys_not_approved/);
    expect(loadConfig(envOf({ ...live, RAZORPAY_MODE: 'live', RAZORPAY_ALLOW_LIVE: 'true' })).mode).toBe('live');
  });
  it('test mode needs rzp_test_ keys and a secret', () => {
    expect(loadConfig(envOf({ RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 'x', RAZORPAY_WEBHOOK_SECRET: 's' })).mode).toBe('test');
    expect(() => loadConfig(envOf({ RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_WEBHOOK_SECRET: 's' }))).toThrow(/KEY_SECRET/);
    expect(() => loadConfig(envOf({}))).toThrow(/WEBHOOK_SECRET/);
  });
});

describe('webhook signature', () => {
  it('matches Razorpay HMAC-SHA256 hex and rejects tampering', async () => {
    const body = '{"event":"payment.captured"}';
    const sig = await hmacSha256Hex('secret', body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifySignature(body, sig, 'secret')).toBe(true);
    expect(await verifySignature(body + ' ', sig, 'secret')).toBe(false);
    expect(await verifySignature(body, sig, 'other')).toBe(false);
    expect(await verifySignature(body, null, 'secret')).toBe(false);
  });

  it('handler: 401 bad signature, 400 missing event id, 500 on processing error (so Razorpay retries)', async () => {
    const body = '{"event":"payment.captured"}';
    const sig = await hmacSha256Hex('s', body);
    const req = (headers: Record<string, string>) => new Request('http://x', { method: 'POST', body, headers });
    const ok = { webhookSecret: 's', processEvent: async () => 'paid' };
    expect((await handleRazorpayWebhook(req({ 'x-razorpay-signature': 'bad', 'x-razorpay-event-id': 'e' }), ok)).status).toBe(401);
    expect((await handleRazorpayWebhook(req({ 'x-razorpay-signature': sig }), ok)).status).toBe(400);
    expect((await handleRazorpayWebhook(req({ 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'e' }), ok)).status).toBe(200);
    const failing = { webhookSecret: 's', processEvent: async () => { throw new Error('db down'); } };
    expect((await handleRazorpayWebhook(req({ 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'e' }), failing)).status).toBe(500);
  });
});
