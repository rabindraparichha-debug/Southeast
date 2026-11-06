// Unit tests for the Edge Functions' shared Razorpay module (no network).
import { describe, expect, it } from 'vitest';
import { isLocalSupabaseUrl, mockAllowed, platformEnv } from '../../supabase/functions/_shared/platform.ts';
import { hmacSha256Hex, loadConfig, verifySignature } from '../../supabase/functions/_shared/razorpay.ts';
import { loadWaConfig } from '../../supabase/functions/_shared/whatsapp.ts';
import { handleRazorpayWebhook } from '../../supabase/functions/razorpay-webhook/handler.ts';

const envOf = (vars: Record<string, string>) => (k: string) => vars[k];
// The Edge runtime of a local stack sees SUPABASE_URL=http://kong:8000.
const LOCAL = { SUPABASE_URL: 'http://kong:8000' };
const HOSTED = { SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co' };

describe('PLATFORM_ENV: mock modes run only locally', () => {
  it('knows a local stack by its URL', () => {
    for (const url of ['http://kong:8000', 'http://127.0.0.1:54321', 'http://localhost:54321', 'http://host.docker.internal:54321', 'http://[::1]:54321']) {
      expect(isLocalSupabaseUrl(url)).toBe(true);
    }
    for (const url of ['https://abcdefghijklmnop.supabase.co', 'https://api.example.in', 'not a url', '', undefined]) {
      expect(isLocalSupabaseUrl(url)).toBe(false);
    }
  });
  it('unset counts as local only on a local stack; a hosted project marked local is not trusted', () => {
    expect(platformEnv(envOf(LOCAL))).toBe('local');
    expect(platformEnv(envOf(HOSTED))).toBe('unknown');
    expect(platformEnv(envOf({}))).toBe('unknown');
    expect(platformEnv(envOf({ ...LOCAL, PLATFORM_ENV: 'Local' }))).toBe('local');
    expect(platformEnv(envOf({ ...HOSTED, PLATFORM_ENV: 'local' }))).toBe('unknown');
    expect(platformEnv(envOf({ ...HOSTED, PLATFORM_ENV: 'production' }))).toBe('production');
    expect(platformEnv(envOf({ ...LOCAL, PLATFORM_ENV: 'staging' }))).toBe('staging');
    expect(mockAllowed(envOf(LOCAL))).toBe(true);
    expect(mockAllowed(envOf({ ...LOCAL, PLATFORM_ENV: 'staging' }))).toBe(false);
    expect(mockAllowed(envOf(HOSTED))).toBe(false);
  });
  it('mock payments are refused outside local (payments_not_configured), test keys still work', () => {
    expect(() => loadConfig(envOf({ ...HOSTED, RAZORPAY_WEBHOOK_SECRET: 's' }))).toThrow(/^payments_not_configured/);
    expect(() => loadConfig(envOf({ ...LOCAL, PLATFORM_ENV: 'staging', RAZORPAY_WEBHOOK_SECRET: 's' }))).toThrow(/^payments_not_configured/);
    expect(() => loadConfig(envOf({ ...HOSTED, RAZORPAY_MODE: 'mock', RAZORPAY_WEBHOOK_SECRET: 's', PLATFORM_ENV: 'production' }))).toThrow(/^payments_not_configured/);
    const test = { RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 'x', RAZORPAY_WEBHOOK_SECRET: 's' };
    expect(loadConfig(envOf({ ...HOSTED, PLATFORM_ENV: 'staging', ...test })).mode).toBe('test');
  });
  it('mock WhatsApp is refused outside local (whatsapp_not_configured), live still works', () => {
    const wa = { WHATSAPP_APP_SECRET: 'a', WHATSAPP_VERIFY_TOKEN: 'v' };
    expect(loadWaConfig(envOf({ ...LOCAL, ...wa })).mode).toBe('mock');
    expect(() => loadWaConfig(envOf({ ...HOSTED, ...wa }))).toThrow(/^whatsapp_not_configured/);
    expect(() => loadWaConfig(envOf({ ...HOSTED, PLATFORM_ENV: 'staging', WHATSAPP_MODE: 'mock', ...wa }))).toThrow(/^whatsapp_not_configured/);
    const live = { ...wa, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' };
    expect(loadWaConfig(envOf({ ...HOSTED, PLATFORM_ENV: 'production', ...live })).mode).toBe('live');
  });
});

describe('loadConfig guardrails', () => {
  it('defaults to mock mode without keys (locally)', () => {
    expect(loadConfig(envOf({ ...LOCAL, RAZORPAY_WEBHOOK_SECRET: 's' })).mode).toBe('mock');
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
