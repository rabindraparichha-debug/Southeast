// WhatsApp Cloud API webhook (verify_jwt = false: Meta authenticates with X-Hub-Signature-256).
import { handleWhatsAppWebhook } from './handler.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { loadWaConfig, sendWhatsApp, type WaConfig } from '../_shared/whatsapp.ts';
import { cancelPaymentLink, createPaymentLink, linkInputFromRecord, loadConfig as loadRazorpay, type LinkRecord } from '../_shared/razorpay.ts';
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
// be loaded the chat is handed to the kitchen (D-148). Caps: AI_CONVERSATION_DAILY_CAP, AI_DAILY_CAP.
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
    // A failed Razorpay call cancels the 'created' row; a failed attach cancels the link at Razorpay
    // first (D-149, D-155).
    createLink: async (record) => {
      // Loaded inside create(), so a missing key (payments_not_configured) also cancels the row.
      // Same input as every other payment-link path: the Route transfer is the kitchen's share
      // (amount minus any platform commission), not the whole amount (wave 3, audit item 40).
      let rz: ReturnType<typeof loadRazorpay> | undefined;
      const link = await createLinkOrCancel(record.payment_id, {
        create: () => createPaymentLink(rz = loadRazorpay(env), linkInputFromRecord(record as unknown as LinkRecord)),
        attach: async (created) => {
          await rpc('attach_payment_link', { p_payment: record.payment_id, p_link_id: created.id, p_short_url: created.shortUrl,
            p_expires_at: created.expiresAt });
        },
        cancelGateway: (created) => cancelPaymentLink(rz!, created.id),
      }, (paymentId, reason) => rpc('cancel_payment_link_record', { p_payment: paymentId, p_error: reason }),
      (e) => void reportError(monitor, e, { fn: 'whatsapp-webhook', tags: { code: 'payment_link_cancel' } }));
      return link.shortUrl;
    },
    complete,
    aiCaps: ai,
  });
});
