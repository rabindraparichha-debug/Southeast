// Creates a Razorpay Payment Link for N meals, routed to the kitchen's linked account.
// Called by the signed-in owner (web or mobile) via supabase.functions.invoke, or from the customer
// page with its token (P5: a payer passes dependent_id to pay for one of their dependents).
// P6: for platform-sourced customers the Route transfer is the amount minus the platform commission.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { cancelPaymentLink, createPaymentLink, linkInputFromRecord, loadConfig, type LinkRecord } from '../_shared/razorpay.ts';
import { createLinkOrCancel } from '../_shared/payment-link.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type Record_ = LinkRecord;

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

  const { customer_id, meals, description, token, dependent_id } = await req.json().catch(() => ({}));
  // Step 1, as the caller: an owner (role + verified payout account checked), or a customer on
  // their own page (magic-link token checked). Creates our payment row.
  const { data: rec, error } = token && dependent_id
    ? await rpc<Record_>(SUPABASE_URL, ANON_KEY, `Bearer ${ANON_KEY}`, 'portal_dependent_payment_link_record',
        { p_token: token, p_dependent: dependent_id, p_meals: meals })
    : token
    ? await rpc<Record_>(SUPABASE_URL, ANON_KEY, `Bearer ${ANON_KEY}`, 'portal_payment_link_record', { p_token: token, p_meals: meals })
    : await rpc<Record_>(SUPABASE_URL, ANON_KEY, auth, 'create_payment_link_record',
        { p_customer: customer_id, p_meals: meals, p_description: description ?? null });
  if (error || !rec) return json({ error: error?.message ?? 'failed' }, 400);

  // Step 2: Razorpay (or mock). Step 3, as the service role: attach the link to our row. If Razorpay
  // fails, the row is cancelled; if only attaching fails, the link is cancelled at Razorpay first (D-149, D-155).
  try {
    const link = await createLinkOrCancel(rec.payment_id, {
      // Every payment-link path builds its input with linkInputFromRecord (commission included, wave 3).
      create: () => createPaymentLink(cfg, linkInputFromRecord(rec, description)),
      attach: async (created) => {
        const attach = await rpc(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, 'attach_payment_link',
          { p_payment: rec.payment_id, p_link_id: created.id, p_short_url: created.shortUrl, p_expires_at: created.expiresAt });
        if (attach.error) throw new Error(attach.error.message);
      },
      cancelGateway: (created) => cancelPaymentLink(cfg, created.id),
    }, async (paymentId, reason) => {
      const res = await rpc(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, 'cancel_payment_link_record',
        { p_payment: paymentId, p_error: reason });
      if (res.error) throw new Error(res.error.message);
    }, (e) => void reportError(monitor, e, { fn: 'razorpay-payment-link', tags: { step: 'cancel' } }));
    return json({ payment_id: rec.payment_id, amount_paise: rec.amount_paise, meals: rec.meals, short_url: link.shortUrl, mode: cfg.mode,
      commission_paise: rec.commission_paise ?? 0 });
  } catch (e) {
    console.error('payment link failed', e);
    await reportError(monitor, e, { fn: 'razorpay-payment-link' });
    return json({ error: 'gateway_error' }, 502);
  }
});
