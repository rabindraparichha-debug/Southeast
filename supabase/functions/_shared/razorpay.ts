// Razorpay helpers shared by the Edge Functions. No external imports (WebCrypto + fetch only),
// so the same file runs in Deno and in the Node test suite.
//
// Modes (RAZORPAY_MODE): mock (local, no network), test (rzp_test_ keys), live (refused unless
// RAZORPAY_ALLOW_LIVE=true, which only the product owner may approve).

export type RazorpayMode = 'mock' | 'test' | 'live';

export type RazorpayConfig = {
  mode: RazorpayMode;
  keyId?: string;
  keySecret?: string;
  webhookSecret: string;
  /** Browser-reachable base URL of the functions, for mock payment pages. */
  publicFunctionsUrl: string;
};

export function loadConfig(env: (name: string) => string | undefined): RazorpayConfig {
  const keyId = env('RAZORPAY_KEY_ID') || undefined;
  const mode = (env('RAZORPAY_MODE') || (keyId ? 'test' : 'mock')) as RazorpayMode;
  if (!['mock', 'test', 'live'].includes(mode)) throw new Error(`Unknown RAZORPAY_MODE "${mode}"`);
  const webhookSecret = env('RAZORPAY_WEBHOOK_SECRET');
  if (!webhookSecret) throw new Error('RAZORPAY_WEBHOOK_SECRET is not set');

  const isLiveKey = keyId?.startsWith('rzp_live_') ?? false;
  if ((mode === 'live' || isLiveKey) && env('RAZORPAY_ALLOW_LIVE') !== 'true') {
    throw new Error('live_keys_not_approved: Razorpay live mode needs explicit approval (RAZORPAY_ALLOW_LIVE=true)');
  }
  if (mode === 'test' && !keyId?.startsWith('rzp_test_')) throw new Error('Test mode needs an rzp_test_ key id');
  if (mode !== 'mock' && !env('RAZORPAY_KEY_SECRET')) throw new Error('RAZORPAY_KEY_SECRET is not set');

  return {
    mode,
    keyId,
    keySecret: env('RAZORPAY_KEY_SECRET') || undefined,
    webhookSecret,
    publicFunctionsUrl: (env('PUBLIC_FUNCTIONS_URL') || 'http://127.0.0.1:54321/functions/v1').replace(/\/$/, ''),
  };
}

const enc = new TextEncoder();

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Razorpay signs the raw request body with the webhook secret (HMAC-SHA256, hex). */
export async function verifySignature(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature) return false;
  const expected = await hmacSha256Hex(secret, body);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

function randomId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

async function api<T>(cfg: RazorpayConfig, path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${cfg.keyId}:${cfg.keySecret}`)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Razorpay ${path} failed: ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

export type LinkInput = {
  paymentId: string;
  amountPaise: number;
  description: string;
  customerName: string;
  customerPhone?: string | null;
  linkedAccountId: string;
  kitchenName: string;
};

export type CreatedLink = { id: string; shortUrl: string; expiresAt: string };

/** Creates a Payment Link whose full amount is routed to the kitchen's linked account. */
export async function createPaymentLink(cfg: RazorpayConfig, input: LinkInput): Promise<CreatedLink> {
  const expireBy = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  if (cfg.mode === 'mock') {
    return {
      id: randomId('plink_mock_'),
      shortUrl: `${cfg.publicFunctionsUrl}/razorpay-mock?payment_id=${input.paymentId}`,
      expiresAt: new Date(expireBy * 1000).toISOString(),
    };
  }
  const link = await api<{ id: string; short_url: string; expire_by: number }>(cfg, '/payment_links', {
    amount: input.amountPaise,
    currency: 'INR',
    description: `${input.kitchenName}: ${input.description}`,
    reference_id: input.paymentId,
    customer: { name: input.customerName, contact: input.customerPhone ?? undefined },
    notify: { sms: false, email: false },
    reminder_enable: false,
    expire_by: expireBy,
    notes: { payment_id: input.paymentId },
    // Route: the whole amount goes to the kitchen; the platform holds nothing.
    options: { order: { transfers: [{ account: input.linkedAccountId, amount: input.amountPaise, currency: 'INR', on_hold: 0 }] } },
  });
  return { id: link.id, shortUrl: link.short_url, expiresAt: new Date(link.expire_by * 1000).toISOString() };
}

/** Refunds an online payment (reversing the Route transfer). */
export async function createRefund(cfg: RazorpayConfig, razorpayPaymentId: string, amountPaise: number, refundId: string): Promise<{ id: string }> {
  if (cfg.mode === 'mock') return { id: randomId('rfnd_mock_') };
  return api<{ id: string }>(cfg, `/payments/${razorpayPaymentId}/refund`, {
    amount: amountPaise,
    speed: 'normal',
    reverse_all: 1,
    notes: { refund_id: refundId },
  });
}

/** Builds a webhook body shaped like Razorpay's, for mock mode and tests. */
export function mockEvent(event: string, entities: Record<string, Record<string, unknown>>): string {
  const payload: Record<string, { entity: Record<string, unknown> }> = {};
  for (const [k, v] of Object.entries(entities)) payload[k] = { entity: v };
  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_mock_platform',
    event,
    contains: Object.keys(entities),
    payload,
    created_at: Math.floor(Date.now() / 1000),
  });
}

/** Signs and delivers a mock event to the webhook function. */
export async function deliverMockEvent(webhookUrl: string, secret: string, body: string): Promise<Response> {
  return fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': await hmacSha256Hex(secret, body),
      'X-Razorpay-Event-Id': randomId('evt_mock_'),
    },
    body,
  });
}
