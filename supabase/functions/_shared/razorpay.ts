// Razorpay helpers shared by the Edge Functions. No external imports (WebCrypto + fetch only),
// so the same file runs in Deno and in the Node test suite.
//
// Modes (RAZORPAY_MODE): mock (local only, no network), test (rzp_test_ keys), live (refused unless
// RAZORPAY_ALLOW_LIVE=true, which only the product owner may approve). Mock is refused outside a
// local stack (PLATFORM_ENV, _shared/platform.ts): a hosted project without keys answers
// payments_not_configured instead of handing out mock payment pages.

import { mockAllowed } from './platform.ts';

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
  if (mode === 'mock' && !mockAllowed(env)) {
    throw new Error('payments_not_configured: mock payments run only on a local stack (PLATFORM_ENV=local); set Razorpay test keys');
  }

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

/** Razorpay answered with an error status (as opposed to a timeout or a network error). */
export class RazorpayApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  /** 4xx: Razorpay refused the request for good (retrying the same request will not help). */
  get definite(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 409 && this.status !== 429;
  }
}

async function api<T>(cfg: RazorpayConfig, path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${cfg.keyId}:${cfg.keySecret}`)}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new RazorpayApiError(res.status, `Razorpay ${path} failed: ${res.status} ${JSON.stringify(json)}`);
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
  /** P6 Route split: what goes to the kitchen (amount − platform commission). Defaults to the whole amount. */
  transferPaise?: number | null;
};

export type CreatedLink = { id: string; shortUrl: string; expiresAt: string };

/**
 * The Route transfer for a payment: the kitchen's share goes to its linked account; the platform
 * keeps only the commission (0 unless the platform set a rate for platform-sourced customers).
 */
export function routeTransfer(amountPaise: number, transferPaise: number | null | undefined, linkedAccountId: string, paymentId?: string) {
  const amount = transferPaise ?? amountPaise;
  if (!Number.isInteger(amount) || amount <= 0 || amount > amountPaise) throw new Error('invalid_transfer');
  const transfer = { account: linkedAccountId, amount, currency: 'INR', on_hold: 0 };
  // Our payment id travels with the transfer, so transfer.* webhooks find the payment (wave 3).
  return paymentId ? { ...transfer, notes: { payment_id: paymentId } } : transfer;
}

/** What every payment-link path passes to Razorpay, from the row private.payment_link_record returns. */
export type LinkRecord = {
  payment_id: string; amount_paise: number; meals: number; linked_account_id: string;
  customer_name: string; customer_phone?: string | null; kitchen_name: string;
  transfer_paise?: number | null; commission_paise?: number | null;
};

/** The same link input on every path (owner, customer page, payer, WhatsApp bot), commission included. */
export function linkInputFromRecord(rec: LinkRecord, description?: string | null): LinkInput {
  return {
    paymentId: rec.payment_id, amountPaise: rec.amount_paise, description: description || `${rec.meals} meals`,
    customerName: rec.customer_name, customerPhone: rec.customer_phone ?? null, linkedAccountId: rec.linked_account_id,
    kitchenName: rec.kitchen_name, transferPaise: rec.transfer_paise ?? null,
  };
}

/** Request body for POST /payment_links (also built in mock mode, so tests can check it). */
export function paymentLinkBody(input: LinkInput, expireBy: number): Record<string, unknown> {
  return {
    amount: input.amountPaise,
    currency: 'INR',
    description: `${input.kitchenName}: ${input.description}`,
    reference_id: input.paymentId,
    customer: { name: input.customerName, contact: input.customerPhone ?? undefined },
    notify: { sms: false, email: false },
    reminder_enable: false,
    expire_by: expireBy,
    notes: { payment_id: input.paymentId },
    // Route: the kitchen's share is transferred to its linked account; we hold no customer balance.
    options: { order: { transfers: [routeTransfer(input.amountPaise, input.transferPaise, input.linkedAccountId, input.paymentId)] } },
  };
}

/** Creates a Payment Link whose amount (minus any platform commission) is routed to the kitchen. */
export async function createPaymentLink(cfg: RazorpayConfig, input: LinkInput): Promise<CreatedLink> {
  const expireBy = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const body = paymentLinkBody(input, expireBy); // validates the transfer in every mode
  if (cfg.mode === 'mock') {
    return {
      id: randomId('plink_mock_'),
      shortUrl: `${cfg.publicFunctionsUrl}/razorpay-mock?payment_id=${input.paymentId}`,
      expiresAt: new Date(expireBy * 1000).toISOString(),
    };
  }
  const link = await api<{ id: string; short_url: string; expire_by: number }>(cfg, '/payment_links', body);
  return { id: link.id, shortUrl: link.short_url, expiresAt: new Date(link.expire_by * 1000).toISOString() };
}

/**
 * Cancels a Payment Link at Razorpay (used when the link was created but could not be attached to our
 * payment row, D-155). Mock links need nothing. Razorpay then sends payment_link.cancelled.
 */
export async function cancelPaymentLink(cfg: RazorpayConfig, linkId: string): Promise<void> {
  if (cfg.mode === 'mock' || linkId.startsWith('plink_mock_')) return;
  await api<unknown>(cfg, `/payment_links/${encodeURIComponent(linkId)}/cancel`, {});
}

/**
 * Request body for POST /payments/:id/refund (also built in mock mode, so tests can check it). The
 * attempt number goes in the notes so the webhook can ignore a late refund.failed from an earlier,
 * already failed attempt.
 */
export function refundBody(amountPaise: number, refundId: string, attempt = 1): Record<string, unknown> {
  return { amount: amountPaise, speed: 'normal', reverse_all: 1, receipt: refundId, notes: { refund_id: refundId, attempt: String(attempt) } };
}

/** Razorpay's idempotency key for one attempt of a refund: the same key for a retry after an unclear answer. */
export function refundIdempotencyKey(refundId: string, attempt = 1): string {
  return `${refundId}-${attempt}`;
}

/**
 * Refunds an online payment (reversing the Route transfer). The idempotency key (X-Refund-Idempotency)
 * is our refund id plus the attempt number from claim_refund_for_gateway: a retry after an unclear
 * answer (a timeout, then a stale claim) reuses it and cannot refund twice; a deliberate retry after a
 * definite failure is a new attempt. The caller claims the refund row first.
 */
export async function createRefund(cfg: RazorpayConfig, razorpayPaymentId: string, amountPaise: number, refundId: string, attempt = 1): Promise<{ id: string }> {
  const body = refundBody(amountPaise, refundId, attempt);
  if (cfg.mode === 'mock') return { id: randomId('rfnd_mock_') };
  return api<{ id: string }>(cfg, `/payments/${razorpayPaymentId}/refund`, body, { 'X-Refund-Idempotency': refundIdempotencyKey(refundId, attempt) });
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
