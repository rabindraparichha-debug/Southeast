// Refunds a pending refund to the customer's original online payment (Razorpay, reversing the
// Route transfer). Cash/UPI refunds are marked paid directly with the mark_refund_paid RPC.
//
// Wave 3: the refund row is claimed first (claim_refund_for_gateway, as the signed-in owner), so two
// clicks or two tabs at once produce one gateway refund; the second gets refund_in_progress. Our
// refund id is Razorpay's idempotency key. A definite refusal from Razorpay releases the claim
// (refund 'failed', retry or pay in cash); a timeout leaves it claimed until Razorpay's webhook
// settles it or the claim goes stale after 15 minutes.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { createRefund, deliverMockEvent, loadConfig, mockEvent, RazorpayApiError } from '../_shared/razorpay.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const service = (fn: string, args: Record<string, unknown>) =>
  rpc<boolean>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, fn, args);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'not_authenticated' }, 401);

  let cfg;
  try {
    cfg = loadConfig((k) => Deno.env.get(k));
  } catch (e) {
    // payments_not_configured: a hosted project without Razorpay keys (mock runs only locally).
    const code = String((e as Error).message).split(':')[0];
    return json({ error: code }, code === 'payments_not_configured' ? 503 : 500);
  }

  const { refund_id } = await req.json().catch(() => ({}));
  const { data: r, error } = await rpc<{ refund_id: string; amount_paise: number; razorpay_payment_id: string }>(
    SUPABASE_URL, ANON_KEY, auth, 'claim_refund_for_gateway', { p_refund: refund_id });
  if (error || !r) {
    const code = error?.message ?? 'failed';
    return json({ error: code }, code === 'refund_in_progress' ? 409 : 400);
  }

  let refund: { id: string };
  try {
    refund = await createRefund(cfg, r.razorpay_payment_id, r.amount_paise, r.refund_id);
  } catch (e) {
    console.error('refund failed', e);
    await reportError(monitor, e, { fn: 'razorpay-refund' });
    if (e instanceof RazorpayApiError && e.definite) {
      await service('release_refund_claim', { p_refund: r.refund_id, p_error: String(e.message).slice(0, 500) });
      return json({ error: 'gateway_rejected' }, 502);
    }
    return json({ error: 'gateway_error' }, 502);
  }

  const marked = await service('mark_refund_submitted', { p_refund: r.refund_id, p_razorpay_refund_id: refund.id });
  if (marked.error) {
    // Razorpay has the refund (its webhook will still settle the row by our refund id in the notes).
    await reportError(monitor, new Error(marked.error.message), { fn: 'razorpay-refund', tags: { step: 'mark_submitted' } });
  }
  if (cfg.mode === 'mock') {
    // Simulate Razorpay confirming the refund through the real webhook path.
    await deliverMockEvent(`${SUPABASE_URL}/functions/v1/razorpay-webhook`, cfg.webhookSecret,
      mockEvent('refund.processed', { refund: { id: refund.id, amount: r.amount_paise, payment_id: r.razorpay_payment_id, notes: { refund_id: r.refund_id } } }));
  }
  return json({ refund_id: r.refund_id, razorpay_refund_id: refund.id, mode: cfg.mode });
});
