// LOCAL DEVELOPMENT ONLY. A stand-in for Razorpay's hosted payment page when RAZORPAY_MODE=mock:
// GET shows a "Pay (test)" page for one of our payment rows; POST sends a correctly signed
// payment_link.paid event through the real razorpay-webhook function, which credits meals.
// Never deploy it to a hosted project (docs/OPERATIONS.md lists the functions to deploy). If it is
// deployed anyway it answers 404 unless SUPABASE_URL is a local stack and PLATFORM_ENV allows mocks.
import { isLocalSupabaseUrl, mockAllowed } from '../_shared/platform.ts';
import { deliverMockEvent, loadConfig, mockEvent, type RazorpayConfig } from '../_shared/razorpay.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type Payment = { id: string; amount_paise: number; meals: number; description: string | null; status: string; razorpay_payment_link_id: string | null };

async function loadPayment(id: string): Promise<Payment | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${id}&select=id,amount_paise,meals,description,status,razorpay_payment_link_id`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  const rows = (await res.json()) as Payment[];
  return rows[0] ?? null;
}

const page = (title: string, body: string) =>
  new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">${body}</body>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

const env = (k: string) => Deno.env.get(k);
const notFound = () => new Response('not_found', { status: 404 });

Deno.serve(async (req) => {
  if (!isLocalSupabaseUrl(SUPABASE_URL) || !mockAllowed(env)) return notFound();
  let cfg: RazorpayConfig;
  try {
    cfg = loadConfig(env);
  } catch {
    return notFound();
  }
  if (cfg.mode !== 'mock') return notFound();
  const url = new URL(req.url);
  const payment = await loadPayment(url.searchParams.get('payment_id') ?? '');
  if (!payment) return page('Not found', '<h2>Payment not found</h2>');
  const rupees = (payment.amount_paise / 100).toLocaleString('en-IN');

  if (req.method === 'GET') {
    if (payment.status === 'paid') return page('Paid', `<h2>✅ Already paid</h2><p>₹${rupees}</p>`);
    return page('Pay (test)', `<p style="background:#fef3c7;padding:8px;border-radius:8px">TEST MODE: no real money moves.</p>
<h2>₹${rupees}</h2><p>${payment.description ?? ''} (${payment.meals} meals)</p>
<form method="post"><button style="font-size:18px;padding:12px 24px;background:#ea580c;color:#fff;border:0;border-radius:8px">Pay ₹${rupees} (test)</button></form>`);
  }

  const body = mockEvent('payment_link.paid', {
    payment_link: { id: payment.razorpay_payment_link_id, reference_id: payment.id, status: 'paid', amount: payment.amount_paise },
    payment: { id: `pay_mock_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`, amount: payment.amount_paise, currency: 'INR',
               method: 'upi', status: 'captured', notes: { payment_id: payment.id } },
  });
  const res = await deliverMockEvent(`${SUPABASE_URL}/functions/v1/razorpay-webhook`, cfg.webhookSecret, body);
  const out = await res.json().catch(() => ({}));
  return page('Paid', `<h2>${res.ok ? '✅ Payment successful (test)' : '❌ Failed'}</h2><p>₹${rupees} · ${out.result ?? out.error ?? ''}</p>`);
});
