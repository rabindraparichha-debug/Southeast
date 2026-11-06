// WhatsApp Cloud API webhook (verify_jwt = false: Meta authenticates with X-Hub-Signature-256).
import { handleWhatsAppWebhook } from './handler.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { loadWaConfig, sendWhatsApp, type WaConfig } from '../_shared/whatsapp.ts';
import { createPaymentLink, loadConfig as loadRazorpay } from '../_shared/razorpay.ts';
import { loadAiConfig, makeClaudeComplete, type SdkModule } from '../_shared/ai-claude.ts';
import { createLinkOrCancel } from '../_shared/payment-link.ts';
import { rpc as callRpc } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const env = (k: string) => Deno.env.get(k);

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await callRpc<T>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

const monitor = loadMonitorConfig((k) => Deno.env.get(k));

// Claude fallback (only when ANTHROPIC_API_KEY is set; otherwise the rule-based fallback is used).
// The SDK is loaded lazily, so the webhook never depends on fetching it when AI is off; if it cannot
// be loaded the chat is handed to the kitchen (D-128). Caps: AI_CONVERSATION_DAILY_CAP, AI_DAILY_CAP.
const ai = loadAiConfig(env);
const complete = ai.apiKey
  ? makeClaudeComplete({
      apiKey: ai.apiKey, model: ai.model, timeoutMs: ai.timeoutMs,
      importSdk: async () => (await import('npm:@anthropic-ai/sdk@0.137.0')) as unknown as SdkModule,
      report: (e, code) => void reportError(monitor, e, { fn: 'whatsapp-webhook', tags: { code } }),
    })
  : undefined;

Deno.serve(async (req) => {
  let cfg: WaConfig;
  try {
    cfg = loadWaConfig(env);
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message).split(':')[0] }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
  return handleWhatsAppWebhook(req, {
    cfg,
    rpc,
    report: (e, code) => void reportError(monitor, e, { fn: 'whatsapp-webhook', tags: { code } }),
    send: (to, out) => sendWhatsApp(cfg, to, out),
    // A failed Razorpay call (or attach) cancels the 'created' row (D-129).
    createLink: (record) => createLinkOrCancel(record.payment_id, async () => {
      const link = await createPaymentLink(loadRazorpay(env), {
        paymentId: record.payment_id, amountPaise: record.amount_paise, description: `${record.meals} meals`,
        customerName: record.customer_name, customerPhone: record.customer_phone, linkedAccountId: record.linked_account_id,
        kitchenName: record.kitchen_name,
      });
      await rpc('attach_payment_link', { p_payment: record.payment_id, p_link_id: link.id, p_short_url: link.shortUrl, p_expires_at: link.expiresAt });
      return link.shortUrl;
    }, (paymentId, reason) => rpc('cancel_payment_link_record', { p_payment: paymentId, p_error: reason }),
    (e) => void reportError(monitor, e, { fn: 'whatsapp-webhook', tags: { code: 'payment_link_cancel' } })),
    complete,
    aiCaps: ai,
  });
});
