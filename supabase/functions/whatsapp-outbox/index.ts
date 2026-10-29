// Drains notifications_outbox (WhatsApp). Triggered every minute by pg_cron (private.kick_outbox)
// and after vendor actions. Free-form inside the 24h window; approved templates outside it, and
// only to customers who opted in.
import { corsHeaders, json, rpc as callRpc } from '../_shared/http.ts';
import { loadWaConfig, previewOf, sendWhatsApp } from '../_shared/whatsapp.ts';
import { renderOutbox } from '../_shared/templates.ts';
import type { Lang } from '../_shared/bot-i18n.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type Row = {
  id: string; template: string; payload: Record<string, unknown>; recipient_type: string; phone_e164: string | null;
  language: Lang; kitchen_name: string | null; in_window: boolean; opted_in: boolean;
};

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await callRpc<T>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const cfg = loadWaConfig((k) => Deno.env.get(k));
  const counts = { sent: 0, skipped: 0, failed: 0 };
  for (let batch = 0; batch < 5; batch++) {
    const rows = await rpc<Row[]>('wa_claim_outbox', { p_limit: 25 });
    if (!rows.length) break;
    for (const r of rows) {
      const complete = (ok: boolean, waId: string | null, error: string | null, rendered: string | null, skip = false) =>
        rpc('wa_complete_outbox', { p_id: r.id, p_ok: ok, p_wa_message_id: waId, p_error: error, p_rendered: rendered, p_skip: skip });
      if (!r.phone_e164) {
        await complete(false, null, 'no_phone', null, true);
        counts.skipped++;
        continue;
      }
      if (r.recipient_type === 'customer' && !r.in_window && !r.opted_in) {
        await complete(false, null, 'not_opted_in', null, true);
        counts.skipped++;
        continue;
      }
      const out = renderOutbox(r.template, r.payload, r.language, r.kitchen_name ?? '', r.in_window);
      if (!out) {
        await complete(false, null, 'unknown_template', null, true);
        counts.skipped++;
        continue;
      }
      try {
        const sent = await sendWhatsApp(cfg, r.phone_e164, out);
        await complete(true, sent.id, null, previewOf(out));
        counts.sent++;
      } catch (e) {
        await complete(false, null, String((e as Error).message).slice(0, 500), null);
        counts.failed++;
      }
    }
  }
  return json(counts);
});
