// Photo retention and erasure clean-up (vendor-first wave 3; docs/OPERATIONS.md). Started daily at 03:15 IST by
// pg_cron (tiffin-storage-retention → private.kick_function) with the service role key. SQL cannot
// delete storage objects (storage.protect_delete), so this asks ops_expired_objects() what to delete
// (photos queued by customer erasure, then proof, dispatch and notebook-import photos past the days in
// platform_settings 'retention'), removes them with the Storage API, clears the erasure queue
// (ops_mark_purged) and reports its run (ops_heartbeat). Receipts and purchase bills are never touched.
// Optional JSON body for ops re-runs and tests: { "now": ISO time, "prefix": "path/" }.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { removalBatches, retentionOptions, type ExpiredObject } from '../_shared/ops.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));

const call = async <T>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await rpc<T>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, fn, args);
  if (error) throw new Error(`${fn}: ${error.code ?? error.message}`);
  return data as T;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.headers.get('Authorization') !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ error: 'forbidden' }, 403);
  const opts = retentionOptions(await req.json().catch(() => ({})));
  if ('error' in opts) return json({ error: opts.error }, 400);

  const counts = { deleted: 0, failed: 0, requests: 0 };
  const seen = new Set<string>();
  try {
    for (let round = 0; round < 20; round++) {
      const rows = await call<ExpiredObject[]>('ops_expired_objects', { p_limit: 500, p_now: opts.now, p_prefix: opts.prefix });
      // Never retry the same object in one run (a remove that "succeeds" without deleting would loop).
      const fresh = rows.filter((r) => !seen.has(`${r.bucket}/${r.name}`));
      if (!fresh.length) break;
      for (const b of removalBatches(fresh, 100)) {
        b.names.forEach((n) => seen.add(`${b.bucket}/${n}`));
        counts.requests++;
        const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(b.bucket)}`, {
          method: 'DELETE',
          headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: b.names }),
        });
        await res.text();
        if (!res.ok) {
          counts.failed += b.names.length;
          await reportError(monitor, new Error(`storage remove ${res.status}`), { fn: 'storage-retention', tags: { bucket: b.bucket } });
          continue;
        }
        counts.deleted += b.names.length;
        await call<number>('ops_mark_purged', { p_bucket: b.bucket, p_names: b.names });
      }
    }
    // Only a normal daily run counts as the job's heartbeat (not a test or a shifted clock).
    if (!opts.now && !opts.prefix) await call('ops_heartbeat', { p_job: 'tiffin-storage-retention', p_result: counts });
  } catch (e) {
    await reportError(monitor, e, { fn: 'storage-retention' });
    return json({ ...counts, error: 'retention_failed' }, 500);
  }
  return json(counts);
});
