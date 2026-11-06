// Uploads queued offline conversions (paid trial, plan, renewal of Google Ads leads) to Google
// Ads. Started every 15 minutes by pg_cron (private.kick_ad_conversions) with the service role.
// GOOGLE_ADS_MODE=mock (default) calls nothing and marks them 'mock' (not sent); the first live run
// also uploads every 'mock' row (D-131).
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadAdsConfig, uploadConversions, type PendingConversion, type UploadResult } from '../_shared/google-ads.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';

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
  const cfg = loadAdsConfig((k) => Deno.env.get(k));
  const rows = await call<PendingConversion[]>('ads_claim_conversions', { p_limit: 500, p_include_mock: cfg.mode === 'live' });
  if (!rows.length) return json({ sent: 0, mode: cfg.mode });
  let results: UploadResult[];
  try {
    results = await uploadConversions(cfg, rows);
  } catch (e) {
    await reportError(monitor, e, { fn: 'ads-conversions' });
    results = rows.map((r) => ({ id: r.id, ok: false, error: String((e as Error).message) }));
  }
  for (const r of results) {
    await call('ads_complete_conversion', { p_id: r.id, p_ok: r.ok, p_error: r.error ?? null, p_skip: Boolean(r.skip), p_mock: Boolean(r.mock) });
  }
  return json({ mode: cfg.mode, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok && !r.skip && !r.mock).length,
    skipped: results.filter((r) => r.skip).length, mock: results.filter((r) => r.mock).length });
});
