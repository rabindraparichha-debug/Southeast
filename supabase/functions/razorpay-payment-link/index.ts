// Creates a Razorpay Payment Link for N meals, routed to the kitchen's linked account.
// Called by the signed-in owner (web or mobile) via supabase.functions.invoke.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { createPaymentLink, loadConfig } from '../_shared/razorpay.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type Record_ = {
  payment_id: string; amount_paise: number; meals: number; linked_account_id: string;
  customer_name: string; customer_phone: string | null; kitchen_name: string;
};

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

  const { customer_id, meals, description, token } = await req.json().catch(() => ({}));
  // Step 1, as the caller: an owner (role + verified payout account checked), or a customer on
  // their own page (magic-link token checked). Creates our payment row.
  const { data: rec, error } = token
    ? await rpc<Record_>(SUPABASE_URL, ANON_KEY, `Bearer ${ANON_KEY}`, 'portal_payment_link_record', { p_token: token, p_meals: meals })
    : await rpc<Record_>(SUPABASE_URL, ANON_KEY, auth, 'create_payment_link_record',
        { p_customer: customer_id, p_meals: meals, p_description: description ?? null });
  if (error || !rec) return json({ error: error?.message ?? 'failed' }, 400);

  // Step 2: Razorpay (or mock). Step 3, as the service role: attach the link to our row.
  try {
    const link = await createPaymentLink(cfg, {
      paymentId: rec.payment_id, amountPaise: rec.amount_paise, description: description ?? `${rec.meals} meals`,
      customerName: rec.customer_name, customerPhone: rec.customer_phone, linkedAccountId: rec.linked_account_id,
      kitchenName: rec.kitchen_name,
    });
    const attach = await rpc(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, 'attach_payment_link',
      { p_payment: rec.payment_id, p_link_id: link.id, p_short_url: link.shortUrl, p_expires_at: link.expiresAt });
    if (attach.error) throw new Error(attach.error.message);
    return json({ payment_id: rec.payment_id, amount_paise: rec.amount_paise, meals: rec.meals, short_url: link.shortUrl, mode: cfg.mode });
  } catch (e) {
    console.error('payment link failed', e);
    await reportError(monitor, e, { fn: 'razorpay-payment-link' });
    return json({ error: 'gateway_error' }, 502);
  }
});
