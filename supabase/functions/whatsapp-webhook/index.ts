// WhatsApp Cloud API webhook (verify_jwt = false: Meta authenticates with X-Hub-Signature-256).
import { handleWhatsAppWebhook } from './handler.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { loadWaConfig, sendWhatsApp, type WaConfig } from '../_shared/whatsapp.ts';
import { createPaymentLink, linkInputFromRecord, loadConfig as loadRazorpay, type LinkRecord } from '../_shared/razorpay.ts';
import { AI_OUTPUT_SCHEMA, type AiResult, type Complete } from '../_shared/ai.ts';
import { rpc as callRpc } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const env = (k: string) => Deno.env.get(k);

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await callRpc<T>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

// Claude fallback (only when ANTHROPIC_API_KEY is set; otherwise the rule-based fallback is used).
// Loaded lazily so the webhook never depends on fetching the SDK when AI is off.
let complete: Complete | undefined;
if (env('ANTHROPIC_API_KEY')) {
  complete = async (system, user) => {
    const { default: Anthropic } = await import('npm:@anthropic-ai/sdk@0.137.0');
    const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
    const res = await client.beta.messages.create({
      model: env('ANTHROPIC_MODEL') ?? 'claude-opus-5-5',
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_OUTPUT_SCHEMA } },
      system,
      messages: [{ role: 'user', content: user }],
    } as never) as { stop_reason: string; content: { type: string; text?: string }[] };
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    try {
      return JSON.parse(text) as AiResult;
    } catch {
      return null;
    }
  };
}

const monitor = loadMonitorConfig((k) => Deno.env.get(k));

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
    createLink: async (record) => {
      // Same input as every other payment-link path: the Route transfer is the kitchen's share
      // (amount minus any platform commission), not the whole amount (wave 3, audit item 40).
      const link = await createPaymentLink(loadRazorpay(env), linkInputFromRecord(record as unknown as LinkRecord));
      await rpc('attach_payment_link', { p_payment: record.payment_id, p_link_id: link.id, p_short_url: link.shortUrl, p_expires_at: link.expiresAt });
      return link.shortUrl;
    },
    complete,
  });
});
