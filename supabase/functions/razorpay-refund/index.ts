// Refunds a pending refund to the customer's original online payment (Razorpay, reversing the
// Route transfer). Cash/UPI refunds are marked paid directly with the mark_refund_paid RPC.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { createRefund, deliverMockEvent, loadConfig, mockEvent } from '../_shared/razorpay.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'not_authenticated' }, 401);

  let cfg;
  try {
    cfg = loadConfig((k) => Deno.env.get(k));
  } catch (e) {
    return json({ error: String((e as Error).message).split(':')[0] }, 500);
  }

  const { refund_id } = await req.json().catch(() => ({}));
  const { data: r, error } = await rpc<{ refund_id: string; amount_paise: number; razorpay_payment_id: string }>(
    SUPABASE_URL, ANON_KEY, auth, 'refund_for_gateway', { p_refund: refund_id });
  if (error || !r) return json({ error: error?.message ?? 'failed' }, 400);

  try {
    const refund = await createRefund(cfg, r.razorpay_payment_id, r.amount_paise, r.refund_id);
    const marked = await rpc(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, 'mark_refund_submitted',
      { p_refund: r.refund_id, p_razorpay_refund_id: refund.id });
    if (marked.error) throw new Error(marked.error.message);
    if (cfg.mode === 'mock') {
      // Simulate Razorpay confirming the refund through the real webhook path.
      await deliverMockEvent(`${SUPABASE_URL}/functions/v1/razorpay-webhook`, cfg.webhookSecret,
        mockEvent('refund.processed', { refund: { id: refund.id, amount: r.amount_paise, payment_id: r.razorpay_payment_id, notes: { refund_id: r.refund_id } } }));
    }
    return json({ refund_id: r.refund_id, razorpay_refund_id: refund.id, mode: cfg.mode });
  } catch (e) {
    console.error('refund failed', e);
    return json({ error: 'gateway_error' }, 502);
  }
});
