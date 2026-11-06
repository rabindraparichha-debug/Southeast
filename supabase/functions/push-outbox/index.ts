// Drains notifications_outbox channel 'push' through the Expo Push API (audit item 29). Kicked every
// minute by pg_cron (private.kick_push) with the service role key, checked here. PUSH_MODE=mock
// (local only) sends nothing and records rows as sent with last_error 'mock'; a hosted project with
// PUSH_MODE=mock answers 503 and claims nothing, so no row is marked sent without being sent.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import {
  buildMessages, chunk, interpretTickets, loadPushConfig, sendChunk, type ExpoTicket, type PushConfig, type PushRow,
} from '../_shared/push.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));

const call = async <T>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await rpc<T>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, fn, args);
  if (error) throw new Error(error.message);
  return data as T;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.headers.get('Authorization') !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ error: 'forbidden' }, 403);
  let cfg: PushConfig;
  try {
    cfg = loadPushConfig((k) => Deno.env.get(k));
  } catch (e) {
    return json({ error: String((e as Error).message).split(':')[0] }, 503);
  }
  const counts = { mode: cfg.mode, sent: 0, skipped: 0, failed: 0 };
  for (let batch = 0; batch < 5; batch++) {
    const rows = await call<PushRow[]>('push_claim_outbox', { p_limit: 50 });
    if (!rows.length) break;
    const { messages, owners, noDevice } = buildMessages(rows);
    for (const id of noDevice) {
      await call('push_complete_outbox', { p_id: id, p_ok: false, p_error: 'no_device', p_skip: true });
      counts.skipped++;
    }
    // Tickets for every message, in order; a chunk that fails as a whole (network, Expo down) gets
    // error tickets, so its rows retry with backoff. Outcomes are folded per row over all chunks.
    const tickets: ExpoTicket[] = [];
    for (const msgs of chunk(messages)) {
      try {
        tickets.push(...(await sendChunk(cfg, msgs)));
      } catch (e) {
        await reportError(monitor, e, { fn: 'push-outbox' });
        const message = String((e as Error).message).slice(0, 200);
        tickets.push(...msgs.map((): ExpoTicket => ({ status: 'error', message })));
      }
    }
    for (const o of interpretTickets(messages, owners, tickets)) {
      await call('push_complete_outbox', {
        p_id: o.id, p_ok: o.ok, p_error: o.error, p_dead_tokens: o.deadTokens.length ? o.deadTokens : null,
        p_mock: cfg.mode === 'mock',
      });
      if (o.ok) counts.sent++;
      else counts.failed++;
    }
  }
  return json(counts);
});
