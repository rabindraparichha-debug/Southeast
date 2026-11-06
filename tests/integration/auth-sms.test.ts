// Login codes: unit tests for the Send SMS hook logic (no network), plus a check of the deployed
// auth-send-sms function on the local stack (signature accepted / refused, mock send).
// docs/LOGIN.md, D-126.
import { describe, expect, it } from 'vitest';
import {
  AuthSmsConfigError, LOCAL_PLACEHOLDER_HOOK_SECRET, authSmsRunsLocally, buildTelnyxRequest, buildTwilioRequest,
  countryAllowed, handleSendSmsHook, interpretTelnyx, interpretTwilio, loadAuthSmsConfig, maskPhone, orderRoutes,
  parseHookSecrets, parsePayload, parseRoutes, sendCode, signWebhook, verifyWebhook, type AuthSmsConfig, type HookDeps,
} from '../../supabase/functions/_shared/auth-sms.ts';
import { anonClient, env as stackEnv } from './helpers.ts';

const SECRET = LOCAL_PLACEHOLDER_HOOK_SECRET;
const OTHER = `v1,whsec_${Buffer.from('another-secret-for-rotation-0001').toString('base64')}`;
const NOW = new Date('2026-11-06T10:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const LOCAL = { SUPABASE_URL: 'http://kong:8000' };

const envOf = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

function payload(over: { phone?: string; otp?: string; sentAt?: string | null } = {}) {
  return JSON.stringify({
    user: { id: 'u1', phone: (over.phone ?? '+919000000042').replace('+', ''), confirmation_sent_at: over.sentAt ?? null },
    sms: { otp: over.otp ?? '482913' },
  });
}

async function signed(body: string, secret = SECRET, ts = NOW_S, id = 'msg_1') {
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': await signWebhook(secret, id, ts, body) };
}

function deps(vars: Record<string, string | undefined>, fetchFn?: typeof fetch) {
  const logs: Record<string, unknown>[] = [];
  const reports: { error: Error; tags: Record<string, string> }[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const d: HookDeps = {
    env: envOf(vars),
    now: () => NOW,
    fetch: fetchFn ?? (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ sid: 'SM1', status: 'queued' }), { status: 201 });
    }) as typeof fetch,
    log: (e) => logs.push(e),
    report: (error, tags) => reports.push({ error, tags }),
  };
  return { d, logs, reports, calls };
}

const req = (body: string, headers: Record<string, string>) => ({
  method: 'POST', body, headers: (n: string) => headers[n.toLowerCase()] ?? null,
});

const TWILIO_LIVE = {
  ...LOCAL, AUTH_SMS_MODE: 'live', SEND_SMS_HOOK_SECRETS: OTHER,
  TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG123',
  TWILIO_WHATSAPP_CONTENT_SID: 'HX123',
};

describe('Standard Webhooks signature', () => {
  it('accepts a correctly signed request and rejects tampering', async () => {
    const body = payload();
    const keys = parseHookSecrets(SECRET);
    const h = await signed(body);
    const head = { id: h['webhook-id'], timestamp: h['webhook-timestamp'], signature: h['webhook-signature'] };
    expect(await verifyWebhook(head, body, keys, NOW_S)).toEqual({ ok: true });
    expect(await verifyWebhook(head, body.replace('482913', '000000'), keys, NOW_S)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyWebhook({ ...head, id: 'msg_2' }, body, keys, NOW_S)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyWebhook({ ...head, timestamp: String(NOW_S + 1) }, body, keys, NOW_S)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyWebhook(head, body, parseHookSecrets(OTHER), NOW_S)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyWebhook({ ...head, signature: null }, body, keys, NOW_S)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(await verifyWebhook({ ...head, signature: 'v2,abc' }, body, keys, NOW_S)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses old or future timestamps (5 minute tolerance)', async () => {
    const body = payload();
    const keys = parseHookSecrets(SECRET);
    const old = await signed(body, SECRET, NOW_S - 301);
    expect(await verifyWebhook({ id: old['webhook-id'], timestamp: old['webhook-timestamp'], signature: old['webhook-signature'] }, body, keys, NOW_S))
      .toEqual({ ok: false, reason: 'expired' });
    const ok = await signed(body, SECRET, NOW_S - 299);
    expect(await verifyWebhook({ id: ok['webhook-id'], timestamp: ok['webhook-timestamp'], signature: ok['webhook-signature'] }, body, keys, NOW_S))
      .toEqual({ ok: true });
  });

  it('matches the Standard Webhooks reference vector', async () => {
    // https://github.com/standard-webhooks/standard-webhooks (spec example)
    const sig = await signWebhook('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330,
      '{"test": 2432232314}');
    expect(sig).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('accepts any of several signatures and several secrets (rotation)', async () => {
    const body = payload();
    const a = await signWebhook(OTHER, 'm', NOW_S, body);
    const b = await signWebhook(SECRET, 'm', NOW_S, body);
    // Auth joins signatures with ", "; the spec uses spaces.
    for (const header of [`${a}, ${b}`, `${a} ${b}`]) {
      expect(await verifyWebhook({ id: 'm', timestamp: String(NOW_S), signature: header }, body, parseHookSecrets(SECRET), NOW_S)).toEqual({ ok: true });
    }
    expect(await verifyWebhook({ id: 'm', timestamp: String(NOW_S), signature: b }, body, parseHookSecrets(`${OTHER}|${SECRET}`), NOW_S)).toEqual({ ok: true });
  });

  it('rejects malformed secrets', () => {
    expect(() => parseHookSecrets('')).toThrow(AuthSmsConfigError);
    expect(() => parseHookSecrets('plain-secret')).toThrow(/v1,whsec_/);
    expect(() => parseHookSecrets('v1,whsec_c2hvcnQ=')).toThrow(/too short/);
  });
});

describe('payload, masking and routing', () => {
  it('masks phones and never keeps more than the last four digits', () => {
    expect(maskPhone('+919000000042')).toBe('+91******0042');
    expect(maskPhone('919861000002')).toBe('+91******0002');
    expect(maskPhone('123')).toBe('+***');
  });

  it('reads the destination and code (sms.phone wins, e.g. a phone change)', () => {
    expect(parsePayload(JSON.parse(payload()))).toEqual({ to: '+919000000042', code: '482913', previousSentAt: null });
    expect(parsePayload({ user: { phone: '919000000042', phone_change: '919000000043', phone_change_sent_at: '2026-11-06T09:59:00Z' }, sms: { otp: '1234', phone: '919000000043' } }))
      .toEqual({ to: '+919000000043', code: '1234', previousSentAt: '2026-11-06T09:59:00Z' });
    expect(parsePayload({ user: { phone: '' }, sms: { otp: '123456' } })).toBeNull();
    expect(parsePayload({ user: { phone: '919000000042' }, sms: { otp: 'abc' } })).toBeNull();
  });

  it('only sends to allowed country codes', () => {
    expect(countryAllowed('+919000000042', ['91'])).toBe(true);
    expect(countryAllowed('+14155550100', ['91'])).toBe(false);
    expect(countryAllowed('+14155550100', [])).toBe(true);
  });

  it('parses routes and resolves bare sms to AUTH_SMS_PROVIDER', () => {
    expect(parseRoutes(undefined, 'twilio')).toEqual([{ channel: 'whatsapp', provider: 'twilio' }, { channel: 'sms', provider: 'twilio' }]);
    expect(parseRoutes('whatsapp, sms', 'telnyx')).toEqual([{ channel: 'whatsapp', provider: 'twilio' }, { channel: 'sms', provider: 'telnyx' }]);
    expect(parseRoutes('sms:telnyx,sms:twilio', 'twilio')).toEqual([{ channel: 'sms', provider: 'telnyx' }, { channel: 'sms', provider: 'twilio' }]);
    expect(() => parseRoutes('whatsapp:telnyx', 'twilio')).toThrow(/Twilio only/);
    expect(() => parseRoutes('telegram', 'twilio')).toThrow(/unknown channel/);
  });

  it('a code asked for again soon starts at the next route', () => {
    const routes = parseRoutes('whatsapp,sms', 'telnyx');
    expect(orderRoutes(routes, null, NOW, 600)[0]!.channel).toBe('whatsapp');
    expect(orderRoutes(routes, '2026-11-06T09:59:00Z', NOW, 600).map((r) => r.channel)).toEqual(['sms', 'whatsapp']);
    expect(orderRoutes(routes, '2026-11-06T09:40:00Z', NOW, 600)[0]!.channel).toBe('whatsapp');
    expect(orderRoutes(routes.slice(0, 1), '2026-11-06T09:59:00Z', NOW, 600)[0]!.channel).toBe('whatsapp');
  });
});

describe('configuration (fails closed)', () => {
  it('mock mode runs only on a local stack', () => {
    expect(loadAuthSmsConfig(envOf({ ...LOCAL })).mode).toBe('mock');
    expect(() => loadAuthSmsConfig(envOf({ SUPABASE_URL: 'https://abc.supabase.co' }))).toThrow(/sms_not_configured/);
    expect(() => loadAuthSmsConfig(envOf({ SUPABASE_URL: 'https://abc.supabase.co', PLATFORM_ENV: 'local', AUTH_SMS_MODE: 'mock' }))).toThrow(/local stack/);
    expect(() => loadAuthSmsConfig(envOf({ ...LOCAL, PLATFORM_ENV: 'production', AUTH_SMS_MODE: 'mock' }))).toThrow(/local stack/);
    expect(authSmsRunsLocally(envOf({ SUPABASE_URL: 'http://127.0.0.1:54321' }))).toBe(true);
    expect(authSmsRunsLocally(envOf({ SUPABASE_URL: 'https://abc.supabase.co' }))).toBe(false);
  });

  it('live mode needs the secrets of every route', () => {
    expect(loadAuthSmsConfig(envOf(TWILIO_LIVE)).mode).toBe('live');
    expect(() => loadAuthSmsConfig(envOf({ ...TWILIO_LIVE, TWILIO_WHATSAPP_CONTENT_SID: '' }))).toThrow(/CONTENT_SID/);
    expect(() => loadAuthSmsConfig(envOf({ ...TWILIO_LIVE, AUTH_SMS_PROVIDER: 'telnyx' }))).toThrow(/TELNYX_API_KEY/);
    expect(() => loadAuthSmsConfig(envOf({ ...TWILIO_LIVE, AUTH_SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEY' }))).toThrow(/TELNYX_FROM/);
    const cfg = loadAuthSmsConfig(envOf({ ...TWILIO_LIVE, AUTH_SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEY', TELNYX_FROM: 'TIFFIN' }));
    expect(cfg.routes).toEqual([{ channel: 'whatsapp', provider: 'twilio' }, { channel: 'sms', provider: 'telnyx' }]);
    expect(() => loadAuthSmsConfig(envOf({ ...TWILIO_LIVE, AUTH_SMS_TEMPLATE: 'no placeholder' }))).toThrow(/\{code\}/);
    // Keys present means live by default, even without AUTH_SMS_MODE.
    expect(loadAuthSmsConfig(envOf({ ...TWILIO_LIVE, AUTH_SMS_MODE: undefined })).mode).toBe('live');
  });
});

describe('provider requests', () => {
  const twilio = loadAuthSmsConfig(envOf(TWILIO_LIVE)).twilio!;

  it('WhatsApp goes through the authentication template with the code as {{1}}', () => {
    const r = buildTwilioRequest(twilio, 'whatsapp', '+919000000042', '482913', 'ignored', 600);
    expect(r.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(r.init.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
    const form = new URLSearchParams(r.init.body);
    expect(Object.fromEntries(form)).toEqual({
      To: 'whatsapp:+919000000042', MessagingServiceSid: 'MG123', ContentSid: 'HX123',
      ContentVariables: '{"1":"482913"}', ValidityPeriod: '600',
    });
    const direct = buildTwilioRequest({ ...twilio, whatsappFrom: '+919999900000' }, 'whatsapp', '+919000000042', '1', '', 600);
    expect(new URLSearchParams(direct.init.body).get('From')).toBe('whatsapp:+919999900000');
    expect(new URLSearchParams(direct.init.body).has('ValidityPeriod')).toBe(false);
  });

  it('SMS carries the rendered text', () => {
    const form = new URLSearchParams(buildTwilioRequest(twilio, 'sms', '+919000000042', '482913', '482913 is your code', 600).init.body);
    expect(form.get('To')).toBe('+919000000042');
    expect(form.get('Body')).toBe('482913 is your code');
    expect(form.has('ContentSid')).toBe(false);
  });

  it('Telnyx: Bearer key, JSON body, sender and profile', () => {
    const r = buildTelnyxRequest({ apiKey: 'KEY', from: 'TIFFIN', messagingProfileId: 'mp1', apiBase: 'https://api.telnyx.com' }, '+919000000042', 'hi 1');
    expect(r.url).toBe('https://api.telnyx.com/v2/messages');
    expect(r.init.headers.Authorization).toBe('Bearer KEY');
    expect(JSON.parse(r.init.body)).toEqual({ to: '+919000000042', text: 'hi 1', type: 'SMS', from: 'TIFFIN', messaging_profile_id: 'mp1' });
  });

  it('reads provider answers', () => {
    expect(interpretTwilio(201, { sid: 'SM1', status: 'queued' })).toEqual({ ok: true, id: 'SM1' });
    expect(interpretTwilio(201, { sid: 'SM1', status: 'failed', error_code: 30008 })).toEqual({ ok: false, error: 'twilio_failed_30008' });
    expect(interpretTwilio(400, { code: 21211, message: 'Invalid To' })).toEqual({ ok: false, error: 'twilio_http_400_21211' });
    expect(interpretTelnyx(200, { data: { id: 'm1' } })).toEqual({ ok: true, id: 'm1' });
    expect(interpretTelnyx(422, { errors: [{ code: '40300', title: 'Registration required' }] })).toEqual({ ok: false, error: 'telnyx_http_422_40300' });
  });
});

describe('fallback', () => {
  const base = (over: Partial<AuthSmsConfig> = {}): AuthSmsConfig => ({
    ...loadAuthSmsConfig(envOf({ ...TWILIO_LIVE, AUTH_SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEY', TELNYX_FROM: 'TIFFIN' })),
    ...over,
  });

  it('WhatsApp through Twilio fails, SMS through Telnyx goes out', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return url.includes('twilio')
        ? new Response(JSON.stringify({ code: 63016, message: 'x' }), { status: 400 })
        : new Response(JSON.stringify({ data: { id: 'tx1' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = base();
    const out = await sendCode(cfg, cfg.routes, '+919000000042', '482913', { fetch: fetchFn });
    expect(out.ok).toBe(true);
    expect(out.ok && out.route).toEqual({ channel: 'sms', provider: 'telnyx' });
    expect(out.attempts.map((a) => `${a.channel}:${a.ok ? 'ok' : a.error}`)).toEqual(['whatsapp:twilio_http_400_63016', 'sms:ok']);
    expect(urls).toHaveLength(2);
  });

  it('a hanging provider times out and the next one is tried', async () => {
    const fetchFn = ((url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      if (url.includes('telnyx')) return resolve(new Response(JSON.stringify({ data: { id: 'tx1' } }), { status: 200 }));
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    const cfg = base({ timeoutMs: 200 });
    const out = await sendCode(cfg, cfg.routes, '+919000000042', '482913', { fetch: fetchFn });
    expect(out.ok).toBe(true);
    expect(out.attempts[0]).toMatchObject({ channel: 'whatsapp', ok: false, error: 'twilio_timeout' });
  });

  it('stops when the time budget is spent', async () => {
    let t = 0;
    const fetchFn = (async () => { t += 4000; return new Response('{}', { status: 500 }); }) as unknown as typeof fetch;
    const cfg = base({ budgetMs: 4300 });
    const out = await sendCode(cfg, cfg.routes, '+919000000042', '1', { fetch: fetchFn, clock: () => t });
    expect(out.ok).toBe(false);
    expect(out.attempts).toHaveLength(1);
  });

  it('mock sends nothing and can pretend a channel fails', async () => {
    const fetchFn = (async () => { throw new Error('no network in mock'); }) as unknown as typeof fetch;
    const cfg = loadAuthSmsConfig(envOf({ ...LOCAL, AUTH_SMS_MOCK_FAIL: 'whatsapp' }));
    const out = await sendCode(cfg, cfg.routes, '+919000000042', '1', { fetch: fetchFn });
    expect(out.ok && out.route.channel).toBe('sms');
    expect(out.attempts.map((a) => a.provider)).toEqual(['mock', 'mock']);
  });
});

describe('handleSendSmsHook', () => {
  it('mock: a signed request is accepted and logged without the code or the full phone', async () => {
    const body = payload();
    const { d, logs, calls } = deps({ ...LOCAL, SEND_SMS_HOOK_SECRETS: SECRET });
    const res = await handleSendSmsHook(req(body, await signed(body)), d);
    expect(res).toEqual({ status: 200, body: {} });
    expect(calls).toHaveLength(0);
    expect(logs).toEqual([expect.objectContaining({ event: 'sent', mode: 'mock', channel: 'whatsapp', to: '+91******0042' })]);
    expect(JSON.stringify(logs)).not.toMatch(/482913|9000000042/);
  });

  it('refuses a tampered or unsigned request before doing anything', async () => {
    const body = payload();
    const { d, calls } = deps({ ...TWILIO_LIVE });
    const h = await signed(body, OTHER);
    expect((await handleSendSmsHook(req(body.replace('482913', '111111'), h), d)).status).toBe(401);
    expect((await handleSendSmsHook(req(body, {}), d)).status).toBe(401);
    expect((await handleSendSmsHook({ ...req(body, h), method: 'GET' }, d)).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it('live: sends WhatsApp first, and SMS when the code is asked for again', async () => {
    const { d, calls, logs } = deps({ ...TWILIO_LIVE });
    const first = payload();
    expect((await handleSendSmsHook(req(first, await signed(first, OTHER)), d)).status).toBe(200);
    const again = payload({ sentAt: '2026-11-06T09:59:10Z' });
    expect((await handleSendSmsHook(req(again, await signed(again, OTHER)), d)).status).toBe(200);
    expect(calls.map((c) => new URLSearchParams(String(c.init.body)).get('To'))).toEqual(['whatsapp:+919000000042', '+919000000042']);
    expect(logs.map((l) => l.channel)).toEqual(['whatsapp', 'sms']);
  });

  it('answers Auth with an error object when every provider fails', async () => {
    const failing = (async () => new Response(JSON.stringify({ code: 20003 }), { status: 401 })) as unknown as typeof fetch;
    const { d, reports } = deps({ ...TWILIO_LIVE }, failing);
    const body = payload();
    const res = await handleSendSmsHook(req(body, await signed(body, OTHER)), d);
    expect(res).toEqual({ status: 200, body: { error: { http_code: 422, message: 'sms_send_failed' } } });
    expect(reports[0]?.tags.code).toBe('sms_send_failed');
    expect(reports[0]?.error.message).not.toMatch(/482913|9000000042/);
  });

  it('refuses other countries, misconfiguration and the published secret on hosted', async () => {
    const us = payload({ phone: '+14155550100' });
    const a = deps({ ...LOCAL, SEND_SMS_HOOK_SECRETS: SECRET });
    expect((await handleSendSmsHook(req(us, await signed(us)), a.d)).body).toEqual({ error: { http_code: 400, message: 'phone_not_allowed' } });

    const body = payload();
    const hosted = deps({ SUPABASE_URL: 'https://abc.supabase.co', SEND_SMS_HOOK_SECRETS: OTHER });
    expect((await handleSendSmsHook(req(body, await signed(body, OTHER)), hosted.d)).body)
      .toEqual({ error: { http_code: 500, message: 'sms_not_configured' } });

    const published = deps({ SUPABASE_URL: 'https://abc.supabase.co', SEND_SMS_HOOK_SECRETS: SECRET, ...{ AUTH_SMS_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG1', TWILIO_WHATSAPP_CONTENT_SID: 'HX1' } });
    expect((await handleSendSmsHook(req(body, await signed(body)), published.d)).status).toBe(500);
    expect(published.calls).toHaveLength(0);

    const missing = deps({ ...LOCAL });
    expect((await handleSendSmsHook(req(body, await signed(body)), missing.d))).toEqual({ status: 500, body: { error: 'hook_not_configured' } });
  });
});

// The function as deployed on the local stack (supabase/functions/.env from .env.example: mock mode).
describe('auth-send-sms on the local stack', () => {
  const fn = () => `${stackEnv().url}/functions/v1/auth-send-sms`;
  const secret = process.env.SEND_SMS_HOOK_SECRETS ?? SECRET;

  it('accepts a correctly signed request and refuses a tampered one', async () => {
    const body = payload({ phone: '+919000000199' });
    const ts = Math.floor(Date.now() / 1000);
    const headers = { 'Content-Type': 'application/json', 'webhook-id': 'msg_local', 'webhook-timestamp': String(ts), 'webhook-signature': await signWebhook(secret, 'msg_local', ts, body) };
    const ok = await fetch(fn(), { method: 'POST', headers, body });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('application/json');
    expect(await ok.json()).toEqual({});
    const bad = await fetch(fn(), { method: 'POST', headers, body: body.replace('482913', '000000') });
    expect(bad.status).toBe(401);
  });
});

// End to end through Supabase Auth: only when the stack was started with the hook on
// (SUPABASE_AUTH_HOOK_SEND_SMS_ENABLED=true, docs/LOGIN.md "Local check"). A non-test number then reaches
// auth-send-sms (mock), so the code request succeeds instead of failing at the placeholder Twilio provider.
describe.runIf(process.env.AUTH_SEND_SMS_E2E === '1')('Auth -> Send SMS hook (opt-in)', () => {
  it('a non-test number gets a code through the hook', async () => {
    const phone = `+9198765${String(Date.now()).slice(-5)}`;
    const { error } = await anonClient().auth.signInWithOtp({ phone, options: { channel: 'whatsapp' } });
    expect(error).toBeNull();
  });
});
