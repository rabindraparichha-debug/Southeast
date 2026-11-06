// Drains notifications_outbox (WhatsApp). Triggered every minute by pg_cron (private.kick_outbox)
// and after vendor actions. Free-form inside the 24h window; approved templates outside it, and
// only to customers who opted in.
//
// Never twice: each message carries its row id to Meta (biz_opaque_callback_data 'outbox:<id>'), so a
// status webhook proves the send even if recording it here fails. Once the provider has accepted a
// message, this worker only retries recording it; it never reports it as a failed send (that would
// put the row back in the queue). Rows a crashed worker leaves in 'sending' are re-queued by the
// tiffin-outbox-stuck job. In WHATSAPP_MODE=mock nothing is sent and rows are recorded as 'mock'.
import { corsHeaders, json, rpc as callRpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { loadWaConfig, previewOf, sendWhatsApp } from '../_shared/whatsapp.ts';
import { renderOutbox } from '../_shared/templates.ts';
import type { Lang } from '../_shared/bot-i18n.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));

type Row = {
  id: string; template: string; payload: Record<string, unknown>; recipient_type: string; phone_e164: string | null;
  language: Lang; kitchen_name: string | null; in_window: boolean; opted_in: boolean;
};

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await callRpc<T>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/**
 * Pauses between attempts to record a send the provider already accepted: about 30 s in all, so a
 * database blip (restart, deploy, a full pool) does not leave the row for the stuck-row job. Meta's
 * status webhook is the second record (it answers 503 until the database takes it, so Meta retries).
 */
const RECORD_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

async function withRetry(fn: () => Promise<unknown>, delays: number[] = RECORD_RETRY_DELAYS_MS): Promise<unknown> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const cfg = loadWaConfig((k) => Deno.env.get(k));
  const mock = cfg.mode === 'mock';
  const counts = { sent: 0, mock: 0, skipped: 0, failed: 0, unrecorded: 0 };
  for (let batch = 0; batch < 5; batch++) {
    const rows = await rpc<Row[]>('wa_claim_outbox', { p_limit: 25 });
    if (!rows.length) break;
    for (const r of rows) {
      const complete = (ok: boolean, waId: string | null, error: string | null, rendered: string | null, skip = false) =>
        rpc('wa_complete_outbox', {
          p_id: r.id, p_ok: ok, p_wa_message_id: waId, p_error: error, p_rendered: rendered, p_skip: skip, p_mock: ok && mock,
        });
      if (!r.phone_e164) {
        await complete(false, null, 'no_phone', null, true);
        counts.skipped++;
        continue;
      }
      if (r.recipient_type !== 'member' && !r.in_window && !r.opted_in) {
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
      let sent: { id: string; mock: boolean };
      try {
        sent = await sendWhatsApp(cfg, r.phone_e164, out, { callbackData: `outbox:${r.id}` });
      } catch (e) {
        // The provider refused or could not be reached: a real failure, retried with backoff.
        await complete(false, null, String((e as Error).message).slice(0, 500), null)
          .catch((err) => console.error('outbox failure not recorded', r.id, err));
        await reportError(monitor, e, { fn: 'whatsapp-outbox', tags: { template: r.template } });
        counts.failed++;
        continue;
      }
      try {
        await withRetry(() => complete(true, sent.id, null, previewOf(out)));
        counts[sent.mock ? 'mock' : 'sent']++;
      } catch (e) {
        // Sent but not recorded: leave the row as it is. Meta's status webhook (with the row id) marks
        // it sent; it is never reported as a failure, so it is not queued again.
        await reportError(monitor, e, { fn: 'whatsapp-outbox', tags: { template: r.template, stage: 'record' } });
        counts.unrecorded++;
      }
    }
  }
  return json(counts);
});
