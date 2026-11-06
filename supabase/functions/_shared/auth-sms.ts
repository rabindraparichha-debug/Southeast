// Login codes for Supabase Auth's Send SMS hook (docs/LOGIN.md, D-126).
// No external imports (WebCrypto + fetch only), so the same file runs in Deno and in the Node tests
// (tests/integration/auth-sms.test.ts).
//
// What Supabase Auth sends (supabase/auth internal/hooks/v0hooks + api/phone.go): a Standard
// Webhooks-signed POST whose JSON body is { user, sms: { otp, phone } }. It does NOT say which
// channel the app asked for (options.channel is only used by the built-in providers), so the order
// of channels is ours: AUTH_SMS_ROUTES (default "whatsapp,sms"). A code asked for again within
// AUTH_SMS_ESCALATE_SECONDS of a previous code that was not used (user.confirmation_sent_at, which
// Auth has not yet updated when it calls the hook, later than user.last_sign_in_at) starts at the
// next route. Because the apps cannot know which route was used, they run channel-neutral in hook
// mode (LOGIN_DELIVERY=hook, packages/core/src/login.ts).
//
// Privacy: never log the code or a full phone number. Use maskPhone() and error codes only.
import { mockAllowed } from './platform.ts';

export type Channel = 'whatsapp' | 'sms';
export type Provider = 'twilio' | 'telnyx';
export type Route = { channel: Channel; provider: Provider };
export type Mode = 'mock' | 'live';

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** MG… Messaging Service: Twilio picks the sender from its pool (SMS and/or WhatsApp senders). */
  messagingServiceSid?: string;
  /** Explicit SMS sender (DLT header / alphanumeric id or number) when no Messaging Service is used. */
  smsFrom?: string;
  /** WhatsApp sender number (+E.164) when it is not in the Messaging Service. */
  whatsappFrom?: string;
  /** HX… Content SID of the Meta-approved WhatsApp authentication template ({{1}} = the code). */
  whatsappContentSid?: string;
  apiBase: string;
};

export type TelnyxConfig = {
  apiKey: string;
  /** Sender: a Telnyx number (+E.164) or an alphanumeric sender id (in India: the DLT header). */
  from?: string;
  /** Needed for alphanumeric senders and number pools. */
  messagingProfileId?: string;
  apiBase: string;
};

export type AuthSmsConfig = {
  mode: Mode;
  routes: Route[];
  /** A code requested again within this many seconds starts at the next route. */
  escalateSeconds: number;
  /** Per provider call. Auth gives the whole hook about 5 s, so two attempts must fit. */
  timeoutMs: number;
  /** Stop trying further routes once this much time has gone. */
  budgetMs: number;
  /** Country calling codes we send to (SMS-pumping guard). Empty = any. */
  allowedCountryCodes: string[];
  /** SMS text; {code} is replaced. In India it must match the DLT content template exactly. */
  smsTemplate: string;
  /** Twilio ValidityPeriod (seconds) for messages sent through a Messaging Service. */
  validitySeconds: number;
  /** Mock only: channels that pretend to fail (to try fallbacks and error screens locally). */
  mockFail: Channel[];
  twilio?: TwilioConfig;
  telnyx?: TelnyxConfig;
};

/** Error codes returned to Auth (and from there to the apps, see apps/web/src/lib/errors.ts). */
export type HookErrorCode = 'sms_send_failed' | 'sms_not_configured' | 'phone_not_allowed' | 'invalid_payload';

export class AuthSmsConfigError extends Error {
  constructor(public code: 'sms_not_configured', detail: string) {
    super(`${code}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Environment (mock fails closed outside a local stack)
// ---------------------------------------------------------------------------
type Env = (name: string) => string | undefined;

/**
 * The secret published in supabase/functions/.env.example (base64 of "local-dev-send-sms-hook-secret!!").
 * It is refused unless the function runs on a local stack (mockAllowed, _shared/platform.ts).
 */
export const LOCAL_PLACEHOLDER_HOOK_SECRET = 'v1,whsec_bG9jYWwtZGV2LXNlbmQtc21zLWhvb2stc2VjcmV0ISE=';

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new AuthSmsConfigError('sms_not_configured', `${name} must be an integer ${min}-${max}`);
  return n;
}

/** "whatsapp,sms" / "whatsapp:twilio,sms:telnyx" → routes. A bare "sms" uses AUTH_SMS_PROVIDER. */
export function parseRoutes(raw: string | undefined, smsProvider: Provider): Route[] {
  const routes: Route[] = [];
  for (const part of (raw ?? 'whatsapp,sms').split(',')) {
    const item = part.trim().toLowerCase();
    if (!item) continue;
    const [channel, provider] = item.split(':') as [string, string | undefined];
    if (channel !== 'whatsapp' && channel !== 'sms') throw new AuthSmsConfigError('sms_not_configured', `unknown channel "${channel}" in AUTH_SMS_ROUTES`);
    const p = (provider ?? (channel === 'whatsapp' ? 'twilio' : smsProvider)) as Provider;
    if (p !== 'twilio' && p !== 'telnyx') throw new AuthSmsConfigError('sms_not_configured', `unknown provider "${p}" in AUTH_SMS_ROUTES`);
    if (channel === 'whatsapp' && p !== 'twilio') throw new AuthSmsConfigError('sms_not_configured', 'WhatsApp codes are sent through Twilio only');
    if (!routes.some((r) => r.channel === channel && r.provider === p)) routes.push({ channel, provider: p });
  }
  if (routes.length === 0) throw new AuthSmsConfigError('sms_not_configured', 'AUTH_SMS_ROUTES is empty');
  return routes;
}

export function loadAuthSmsConfig(env: Env): AuthSmsConfig {
  const smsProvider = (env('AUTH_SMS_PROVIDER') || 'twilio').trim().toLowerCase() as Provider;
  if (smsProvider !== 'twilio' && smsProvider !== 'telnyx') throw new AuthSmsConfigError('sms_not_configured', `unknown AUTH_SMS_PROVIDER "${smsProvider}"`);
  const routes = parseRoutes(env('AUTH_SMS_ROUTES'), smsProvider);

  const twilio: TwilioConfig | undefined = env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') ? {
    accountSid: env('TWILIO_ACCOUNT_SID')!.trim(),
    authToken: env('TWILIO_AUTH_TOKEN')!.trim(),
    messagingServiceSid: env('TWILIO_MESSAGING_SERVICE_SID')?.trim() || undefined,
    smsFrom: env('TWILIO_SMS_FROM')?.trim() || undefined,
    whatsappFrom: env('TWILIO_WHATSAPP_FROM')?.trim() || undefined,
    whatsappContentSid: env('TWILIO_WHATSAPP_CONTENT_SID')?.trim() || undefined,
    apiBase: (env('TWILIO_API_BASE') || 'https://api.twilio.com').replace(/\/$/, ''),
  } : undefined;
  const telnyx: TelnyxConfig | undefined = env('TELNYX_API_KEY') ? {
    apiKey: env('TELNYX_API_KEY')!.trim(),
    from: env('TELNYX_FROM')?.trim() || undefined,
    messagingProfileId: env('TELNYX_MESSAGING_PROFILE_ID')?.trim() || undefined,
    apiBase: (env('TELNYX_API_BASE') || 'https://api.telnyx.com').replace(/\/$/, ''),
  } : undefined;

  const declared = (env('AUTH_SMS_MODE') || '').trim().toLowerCase();
  const mode = (declared || (twilio || telnyx ? 'live' : 'mock')) as Mode;
  if (mode !== 'mock' && mode !== 'live') throw new AuthSmsConfigError('sms_not_configured', `unknown AUTH_SMS_MODE "${mode}"`);
  if (mode === 'mock' && !mockAllowed(env)) {
    throw new AuthSmsConfigError('sms_not_configured', 'mock login codes run only on a local stack (PLATFORM_ENV=local); set the provider secrets');
  }

  if (mode === 'live') {
    for (const r of routes) {
      if (r.provider === 'twilio') {
        if (!twilio) throw new AuthSmsConfigError('sms_not_configured', 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are needed');
        if (r.channel === 'whatsapp') {
          if (!twilio.whatsappContentSid) throw new AuthSmsConfigError('sms_not_configured', 'TWILIO_WHATSAPP_CONTENT_SID (authentication template) is needed for WhatsApp');
          if (!twilio.whatsappFrom && !twilio.messagingServiceSid) throw new AuthSmsConfigError('sms_not_configured', 'TWILIO_WHATSAPP_FROM or TWILIO_MESSAGING_SERVICE_SID is needed for WhatsApp');
        } else if (!twilio.smsFrom && !twilio.messagingServiceSid) {
          throw new AuthSmsConfigError('sms_not_configured', 'TWILIO_MESSAGING_SERVICE_SID or TWILIO_SMS_FROM is needed for SMS');
        }
      } else {
        if (!telnyx) throw new AuthSmsConfigError('sms_not_configured', 'TELNYX_API_KEY is needed');
        if (!telnyx.from && !telnyx.messagingProfileId) throw new AuthSmsConfigError('sms_not_configured', 'TELNYX_FROM or TELNYX_MESSAGING_PROFILE_ID is needed');
      }
    }
  }

  const smsTemplate = env('AUTH_SMS_TEMPLATE') || '{code} is your Tiffin OS login code. Do not share it with anyone.';
  if (!smsTemplate.includes('{code}')) throw new AuthSmsConfigError('sms_not_configured', 'AUTH_SMS_TEMPLATE must contain {code}');

  return {
    mode,
    routes,
    escalateSeconds: int(env, 'AUTH_SMS_ESCALATE_SECONDS', 600, 0, 86_400),
    timeoutMs: int(env, 'AUTH_SMS_TIMEOUT_MS', 2000, 200, 4500),
    budgetMs: int(env, 'AUTH_SMS_BUDGET_MS', 4300, 500, 4800),
    allowedCountryCodes: (env('AUTH_SMS_ALLOWED_COUNTRY_CODES') ?? '91').split(',').map((s) => s.trim().replace(/^\+/, '')).filter(Boolean),
    smsTemplate,
    validitySeconds: int(env, 'AUTH_SMS_VALIDITY_SECONDS', 600, 1, 36_000),
    mockFail: (env('AUTH_SMS_MOCK_FAIL') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s): s is Channel => s === 'whatsapp' || s === 'sms'),
    twilio,
    telnyx,
  };
}

// ---------------------------------------------------------------------------
// Standard Webhooks signature (https://www.standardwebhooks.com/)
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Supabase shows the hook secret as "v1,whsec_<base64>". Several may be given separated by "|"
 * (the same separator Auth uses), for rotation. Returns the raw keys.
 */
export function parseHookSecrets(raw: string | undefined): Uint8Array[] {
  const keys: Uint8Array[] = [];
  for (const part of (raw ?? '').split('|')) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(?:v1,)?whsec_([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m) throw new AuthSmsConfigError('sms_not_configured', 'SEND_SMS_HOOK_SECRETS must look like v1,whsec_<base64>');
    let key: Uint8Array;
    try {
      key = base64ToBytes(m[1]!);
    } catch {
      throw new AuthSmsConfigError('sms_not_configured', 'SEND_SMS_HOOK_SECRETS is not valid base64');
    }
    if (key.length < 16) throw new AuthSmsConfigError('sms_not_configured', 'SEND_SMS_HOOK_SECRETS is too short');
    keys.push(key);
  }
  if (keys.length === 0) throw new AuthSmsConfigError('sms_not_configured', 'SEND_SMS_HOOK_SECRETS is not set');
  return keys;
}

async function hmacBase64(key: Uint8Array, content: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(content))));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signs like Supabase Auth does: "v1," + base64(HMAC-SHA256(key, "<id>.<timestamp>.<body>")). */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const [key] = parseHookSecrets(secret);
  return `v1,${await hmacBase64(key!, `${id}.${timestamp}.${body}`)}`;
}

export type WebhookHeaders = { id: string | null; timestamp: string | null; signature: string | null };

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'expired' | 'bad_signature' };

/**
 * Checks webhook-id / webhook-timestamp / webhook-signature against any of the keys. The signature
 * header is a space-separated list ("v1,<b64> v1,<b64>"); Auth joins several with ", ".
 */
export async function verifyWebhook(h: WebhookHeaders, body: string, keys: Uint8Array[], nowSeconds: number): Promise<VerifyResult> {
  if (!h.id || !h.timestamp || !h.signature) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(h.timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const ts = Number(h.timestamp);
  if (Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: 'expired' };
  const given = h.signature.split(/\s+/).map((s) => s.replace(/,+$/, '')).filter(Boolean)
    .map((s) => { const i = s.indexOf(','); return i > 0 ? { v: s.slice(0, i), sig: s.slice(i + 1) } : null; })
    .filter((x): x is { v: string; sig: string } => x !== null && x.v === 'v1');
  if (given.length === 0) return { ok: false, reason: 'bad_signature' };
  const content = `${h.id}.${ts}.${body}`;
  for (const key of keys) {
    const expected = await hmacBase64(key, content);
    if (given.some((g) => safeEqual(g.sig, expected))) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}

/**
 * Remembers the webhook-id of every signed request until its signature expires, so a captured
 * delivery cannot be replayed to send the same code again (Standard Webhooks: idempotency on the id).
 * Auth signs each attempt, retries included, with a new id. One guard per isolate (index.ts): it stops
 * replays that reach the same isolate, which is where repeated requests normally land; a replay that
 * reaches a fresh isolate gets at most one more send there.
 */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private readonly max = 5000) {}

  /** True the first time an id is seen while it is still valid; false for a replay. */
  firstSeen(id: string, validUntilMs: number, nowMs: number): boolean {
    for (const [k, until] of this.seen) if (until <= nowMs) this.seen.delete(k);
    if (this.seen.has(id)) return false;
    if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(id, validUntilMs);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Payload, masking, routing
// ---------------------------------------------------------------------------
/** The parts of Auth's SendSMSInput we read (models.User JSON + v0hooks.SMS). */
export type HookPayload = {
  user?: {
    phone?: string;
    /** The number a phone change is going to (models.User PhoneChange is serialised as new_phone). */
    new_phone?: string;
    confirmation_sent_at?: string | null;
    phone_change_sent_at?: string | null;
    last_sign_in_at?: string | null;
  } | null;
  sms?: { otp?: string; phone?: string } | null;
};

/** "+919000000042" → "+91******0042". Never log a full number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return '+***';
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : '';
  const rest = digits.slice(cc.length);
  return `+${cc}${'*'.repeat(Math.max(rest.length - 4, 0))}${rest.slice(-4)}`;
}

export type Parsed = {
  to: string;
  code: string;
  kind: 'login' | 'phone_change';
  /** When the previous code of this kind went out, if it is still unused (null: start at the first route). */
  previousSentAt: string | null;
};

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * Destination (+E.164) and code from the hook body. sms.phone is the number being verified.
 * A login code counts as a resend only while the previous code is unused: Auth never clears
 * confirmation_sent_at when a code is verified, but it moves last_sign_in_at, so a person who logged
 * in on the web at 10:00 and opens the app at 10:04 starts at the first route again. (Reauthentication
 * codes cannot be told apart from login codes here; the apps never ask for one.)
 */
export function parsePayload(p: HookPayload): Parsed | null {
  const digits = String(p.sms?.phone || p.user?.phone || '').replace(/\D/g, '');
  const code = String(p.sms?.otp ?? '');
  if (!/^[1-9]\d{7,14}$/.test(digits) || !/^\d{4,10}$/.test(code)) return null;
  const newPhone = String(p.user?.new_phone ?? '').replace(/\D/g, '');
  if (newPhone && newPhone === digits) {
    return { to: `+${digits}`, code, kind: 'phone_change', previousSentAt: p.user?.phone_change_sent_at ?? null };
  }
  const sentAt = p.user?.confirmation_sent_at ?? null;
  const used = ms(p.user?.last_sign_in_at) >= ms(sentAt);
  return { to: `+${digits}`, code, kind: 'login', previousSentAt: used ? null : sentAt };
}

export function countryAllowed(to: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const digits = to.replace(/\D/g, '');
  return allowed.some((cc) => digits.startsWith(cc) && digits.length > cc.length + 6);
}

/** Routes in the order to try: a recent previous code (a resend) starts at the next route. */
export function orderRoutes(routes: Route[], previousSentAt: string | null, now: Date, escalateSeconds: number): Route[] {
  const prev = previousSentAt ? Date.parse(previousSentAt) : NaN;
  const age = (now.getTime() - prev) / 1000;
  const resend = Number.isFinite(age) && age >= 0 && age < escalateSeconds;
  const start = resend && routes.length > 1 ? 1 : 0;
  return [...routes.slice(start), ...routes.slice(0, start)];
}

export function renderSms(template: string, code: string): string {
  return template.split('{code}').join(code);
}

// ---------------------------------------------------------------------------
// Provider requests (built here, sent by the caller's fetch)
// ---------------------------------------------------------------------------
export type ProviderRequest = { url: string; init: { method: 'POST'; headers: Record<string, string>; body: string } };

export function buildTwilioRequest(cfg: TwilioConfig, channel: Channel, to: string, code: string, smsText: string, validitySeconds: number): ProviderRequest {
  const form = new URLSearchParams();
  if (channel === 'whatsapp') {
    form.set('To', `whatsapp:${to}`);
    if (cfg.whatsappFrom) form.set('From', `whatsapp:${cfg.whatsappFrom.replace(/^whatsapp:/, '')}`);
    else form.set('MessagingServiceSid', cfg.messagingServiceSid!);
    // Authentication templates take exactly one variable, the code (Twilio Content API, whatsapp/authentication).
    form.set('ContentSid', cfg.whatsappContentSid!);
    form.set('ContentVariables', JSON.stringify({ 1: code }));
  } else {
    form.set('To', to);
    if (cfg.smsFrom) form.set('From', cfg.smsFrom);
    else form.set('MessagingServiceSid', cfg.messagingServiceSid!);
    form.set('Body', smsText);
  }
  if (!form.has('From')) form.set('ValidityPeriod', String(validitySeconds));
  return {
    url: `${cfg.apiBase}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${cfg.accountSid}:${cfg.authToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  };
}

export function buildTelnyxRequest(cfg: TelnyxConfig, to: string, smsText: string): ProviderRequest {
  const body: Record<string, string> = { to, text: smsText, type: 'SMS' };
  if (cfg.from) body.from = cfg.from;
  if (cfg.messagingProfileId) body.messaging_profile_id = cfg.messagingProfileId;
  return {
    url: `${cfg.apiBase}/v2/messages`,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

export type ProviderResult = { ok: true; id: string } | { ok: false; error: string };

/** Twilio answers 201 with { sid, status }; errors are { code, message, status }. */
export function interpretTwilio(status: number, body: unknown): ProviderResult {
  const b = (body ?? {}) as { sid?: string; status?: string; code?: number; error_code?: number | string | null };
  if (status >= 200 && status < 300) {
    if (b.status === 'failed' || b.status === 'undelivered') return { ok: false, error: `twilio_${b.status}_${b.error_code ?? ''}` };
    return { ok: true, id: b.sid ?? 'twilio' };
  }
  return { ok: false, error: `twilio_http_${status}${b.code ? `_${b.code}` : ''}` };
}

/** Telnyx answers 200 with { data: { id } }; errors are { errors: [{ code, title }] }. */
export function interpretTelnyx(status: number, body: unknown): ProviderResult {
  const b = (body ?? {}) as { data?: { id?: string }; errors?: { code?: string }[] };
  if (status >= 200 && status < 300 && b.data?.id) return { ok: true, id: b.data.id };
  const code = b.errors?.[0]?.code;
  return { ok: false, error: `telnyx_http_${status}${code ? `_${code}` : ''}` };
}

// ---------------------------------------------------------------------------
// Sending with fallback
// ---------------------------------------------------------------------------
export type Attempt = { channel: Channel; provider: Provider | 'mock'; ok: boolean; error?: string; ms: number };
export type SendOutcome = { ok: true; route: Route; id: string; attempts: Attempt[] } | { ok: false; attempts: Attempt[] };

export type SendDeps = {
  fetch: typeof fetch;
  /** Milliseconds clock (injected for tests). */
  clock?: () => number;
};

async function callProvider(req: ProviderRequest, timeoutMs: number, fetchFn: typeof fetch): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(req.url, { ...req.init, signal: ctl.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Tries each route in order until one provider accepts the message, within the time budget. */
export async function sendCode(cfg: AuthSmsConfig, routes: Route[], to: string, code: string, deps: SendDeps): Promise<SendOutcome> {
  const clock = deps.clock ?? (() => Date.now());
  const started = clock();
  const attempts: Attempt[] = [];
  const smsText = renderSms(cfg.smsTemplate, code);
  for (const route of routes) {
    const elapsed = clock() - started;
    if (attempts.length > 0 && elapsed + Math.min(cfg.timeoutMs, 1000) > cfg.budgetMs) break;
    const t0 = clock();
    if (cfg.mode === 'mock') {
      const fail = cfg.mockFail.includes(route.channel);
      attempts.push({ channel: route.channel, provider: 'mock', ok: !fail, error: fail ? 'mock_failure' : undefined, ms: 0 });
      if (!fail) return { ok: true, route, id: `mock-${route.channel}`, attempts };
      continue;
    }
    const timeout = Math.max(200, Math.min(cfg.timeoutMs, cfg.budgetMs - elapsed));
    let result: ProviderResult;
    try {
      if (route.provider === 'twilio') {
        const req = buildTwilioRequest(cfg.twilio!, route.channel, to, code, smsText, cfg.validitySeconds);
        const r = await callProvider(req, timeout, deps.fetch);
        result = interpretTwilio(r.status, r.body);
      } else {
        const req = buildTelnyxRequest(cfg.telnyx!, to, smsText);
        const r = await callProvider(req, timeout, deps.fetch);
        result = interpretTelnyx(r.status, r.body);
      }
    } catch (e) {
      result = { ok: false, error: (e as Error)?.name === 'AbortError' ? `${route.provider}_timeout` : `${route.provider}_network` };
    }
    attempts.push({ channel: route.channel, provider: route.provider, ok: result.ok, error: result.ok ? undefined : result.error, ms: clock() - t0 });
    if (result.ok) return { ok: true, route, id: result.id, attempts };
  }
  return { ok: false, attempts };
}

// ---------------------------------------------------------------------------
// The hook itself (pure; index.ts wires Deno.serve, env and the monitor)
// ---------------------------------------------------------------------------
export type HookResponse = { status: number; body: Record<string, unknown> };

export type HookDeps = SendDeps & {
  env: Env;
  now: () => Date;
  /** One line per request, already masked. */
  log: (entry: Record<string, unknown>) => void;
  /** Error reporting (codes only). Tags with once: 'true' are sent once per isolate (reportOncePerCode). */
  report: (error: Error, tags: Record<string, string>) => void;
  /** Webhook ids already handled (one per isolate). Without it, replays are not checked. */
  replay?: ReplayGuard;
};

const MAX_BODY = 64 * 1024;

/** Auth turns { error: { http_code, message } } in a 200 answer into that HTTP error for the app. */
function hookError(code: HookErrorCode, httpCode: number): HookResponse {
  return { status: 200, body: { error: { http_code: httpCode, message: code } } };
}

const UNAUTHORIZED: HookResponse = { status: 401, body: { error: 'invalid_signature' } };

/**
 * Wraps a reporter so that reports tagged once: 'true' go out once per code for the life of the
 * isolate. Unsigned requests to a deployed but unconfigured hook then cannot flood Sentry.
 */
export function reportOncePerCode(report: HookDeps['report']): HookDeps['report'] {
  const sent = new Set<string>();
  return (error, tags) => {
    if (tags.once === 'true') {
      const key = tags.code ?? '';
      if (sent.has(key)) return;
      sent.add(key);
    }
    report(error, tags);
  };
}

export async function handleSendSmsHook(
  req: { method: string; headers: (name: string) => string | null; body: string },
  deps: HookDeps,
): Promise<HookResponse> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  if (req.body.length > MAX_BODY) return { status: 413, body: { error: 'payload_too_large' } };

  // Secrets first. Missing or refused secrets answer exactly like a bad signature, so an unsigned
  // request learns nothing about our configuration; the misconfiguration is logged and reported once.
  let keys: Uint8Array[];
  let cfg: AuthSmsConfig;
  try {
    const rawSecrets = deps.env('SEND_SMS_HOOK_SECRETS');
    keys = parseHookSecrets(rawSecrets);
    if (!mockAllowed(deps.env) && (rawSecrets ?? '').split('|').some((s) => s.trim() === LOCAL_PLACEHOLDER_HOOK_SECRET)) {
      throw new AuthSmsConfigError('sms_not_configured', 'the published local hook secret is refused outside a local stack');
    }
  } catch (e) {
    deps.report(e as Error, { code: 'hook_secret', once: 'true' });
    deps.log({ event: 'refused', reason: 'hook_secret_not_configured' });
    return UNAUTHORIZED;
  }

  const now = deps.now();
  const id = req.headers('webhook-id');
  const timestamp = req.headers('webhook-timestamp');
  const verdict = await verifyWebhook({ id, timestamp, signature: req.headers('webhook-signature') },
    req.body, keys, Math.floor(now.getTime() / 1000));
  if (!verdict.ok) {
    deps.log({ event: 'refused', reason: verdict.reason });
    return UNAUTHORIZED;
  }
  // A valid signature stays valid until timestamp + tolerance: remember the id that long.
  if (deps.replay && !deps.replay.firstSeen(id!, (Number(timestamp) + WEBHOOK_TOLERANCE_SECONDS + 1) * 1000, now.getTime())) {
    deps.log({ event: 'refused', reason: 'replayed' });
    return { status: 409, body: { error: 'replayed' } };
  }

  try {
    cfg = loadAuthSmsConfig(deps.env);
  } catch (e) {
    deps.report(e as Error, { code: 'sms_not_configured' });
    deps.log({ event: 'failed', reason: 'sms_not_configured' });
    return hookError('sms_not_configured', 500);
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(req.body) as HookPayload;
  } catch {
    return hookError('invalid_payload', 400);
  }
  const parsed = parsePayload(payload);
  if (!parsed) {
    deps.log({ event: 'failed', reason: 'invalid_payload' });
    return hookError('invalid_payload', 400);
  }
  const masked = maskPhone(parsed.to);
  if (!countryAllowed(parsed.to, cfg.allowedCountryCodes)) {
    deps.log({ event: 'refused', reason: 'phone_not_allowed', to: masked });
    return hookError('phone_not_allowed', 400);
  }

  const routes = orderRoutes(cfg.routes, parsed.previousSentAt, now, cfg.escalateSeconds);
  const outcome = await sendCode(cfg, routes, parsed.to, parsed.code, deps);
  const attempts = outcome.attempts.map((a) => `${a.channel}:${a.provider}:${a.ok ? 'ok' : a.error}`);
  if (outcome.ok) {
    deps.log({ event: 'sent', mode: cfg.mode, kind: parsed.kind, channel: outcome.route.channel, provider: outcome.route.provider, to: masked, resend: routes[0] !== cfg.routes[0], attempts });
    return { status: 200, body: {} };
  }
  deps.log({ event: 'failed', reason: 'sms_send_failed', mode: cfg.mode, to: masked, attempts });
  deps.report(new Error(`sms_send_failed: ${attempts.join(' ')}`), { code: 'sms_send_failed' });
  return hookError('sms_send_failed', 422);
}
