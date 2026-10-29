import { verifySignature } from '../_shared/razorpay.ts';

export type WebhookDeps = {
  /** Error reporting (monitoring); optional. */
  report?: (e: unknown) => void;
  webhookSecret: string;
  /** Stores + applies the event in Postgres (idempotent on event id). Returns the outcome. */
  processEvent: (eventId: string, payload: unknown) => Promise<string>;
};

// Razorpay retries non-2xx responses, so only signature/format problems get 4xx;
// database errors return 500 to trigger a retry (the event id dedupe makes retries safe).
export async function handleRazorpayWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  const body = await req.text();
  if (!(await verifySignature(body, req.headers.get('x-razorpay-signature'), deps.webhookSecret))) {
    return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401 });
  }
  const eventId = req.headers.get('x-razorpay-event-id');
  if (!eventId) return new Response(JSON.stringify({ error: 'missing_event_id' }), { status: 400 });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }
  try {
    const result = await deps.processEvent(eventId, payload);
    return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('razorpay-webhook processing failed', e);
    deps.report?.(e);
    return new Response(JSON.stringify({ error: 'processing_failed' }), { status: 500 });
  }
}
