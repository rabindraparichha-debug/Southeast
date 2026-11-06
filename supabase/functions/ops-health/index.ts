// Engine health for a free uptime pinger (vendor-first wave 3; docs/OPERATIONS.md). GET or HEAD
// https://<project>.functions.supabase.co/ops-health answers 200 {"ok":true,...} when the lock,
// nightly and summary jobs are scheduled and fresh, no slot is past its cutoff without a count, no
// tiffin-* job's latest run failed and (if wave 1's table exists) no engine error in 15 minutes;
// otherwise 503. The body holds booleans and counts only: no names, ids, keys or database errors.
// Deployed with --no-verify-jwt. Optional secret OPS_HEALTH_KEY: when set, ?key=<value> is required.
import { rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { healthResponse, keyMatches } from '../_shared/ops.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPS_HEALTH_KEY = Deno.env.get('OPS_HEALTH_KEY') || null;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));

function respond(req: Request, status: number, body: unknown): Response {
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (!keyMatches(new URL(req.url).searchParams.get('key'), OPS_HEALTH_KEY)) {
    return respond(req, 401, { ok: false, error: 'unauthorized' });
  }
  try {
    const { data, error } = await rpc<unknown>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, 'ops_health', {});
    if (error) {
      await reportError(monitor, new Error(`ops_health failed (${error.code ?? 'no code'})`), { fn: 'ops-health' });
      const out = healthResponse(null);
      return respond(req, out.status, out.body);
    }
    const out = healthResponse(data);
    return respond(req, out.status, out.body);
  } catch (e) {
    await reportError(monitor, e, { fn: 'ops-health' });
    const out = healthResponse(null);
    return respond(req, out.status, out.body);
  }
});
