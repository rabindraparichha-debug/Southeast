// Helpers for the ops-health and storage-retention Edge Functions (vendor-first wave 3). No external
// imports: runs in Deno and in the Node test suite (tests/integration/ops.test.ts).

export type OpsHealthChecks = {
  lock_job: boolean;
  nightly_job: boolean;
  summary_job: boolean;
  overdue_slots: number;
  failing_jobs: number;
  engine_errors: number | null;
};

export type OpsHealthBody =
  | { ok: boolean; checked_at: string | null; checks: OpsHealthChecks }
  | { ok: false; error: 'health_unavailable' };

const bool = (v: unknown): boolean => v === true;
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * Turns public.ops_health() into the HTTP answer for an uptime pinger: 200 only when every check
 * passed, 503 otherwise. Only the known fields are copied, so nothing else (database error text,
 * keys, names) can reach the public response.
 */
export function healthResponse(raw: unknown): { status: number; body: OpsHealthBody } {
  if (!raw || typeof raw !== 'object' || typeof (raw as { checks?: unknown }).checks !== 'object' || !(raw as { checks?: unknown }).checks) {
    return { status: 503, body: { ok: false, error: 'health_unavailable' } };
  }
  const r = raw as { ok?: unknown; checked_at?: unknown; checks: Record<string, unknown> };
  const errors = r.checks.engine_errors;
  const checks: OpsHealthChecks = {
    lock_job: bool(r.checks.lock_job),
    nightly_job: bool(r.checks.nightly_job),
    summary_job: bool(r.checks.summary_job),
    overdue_slots: count(r.checks.overdue_slots),
    failing_jobs: count(r.checks.failing_jobs),
    engine_errors: errors === null || errors === undefined ? null : count(errors),
  };
  // Recomputed here as well: a response says "ok" only if the checks it shows agree.
  const ok = bool(r.ok) && checks.lock_job && checks.nightly_job && checks.summary_job
    && checks.overdue_slots === 0 && checks.failing_jobs === 0 && (checks.engine_errors ?? 0) === 0;
  const checkedAt = typeof r.checked_at === 'string' && !Number.isNaN(Date.parse(r.checked_at)) ? r.checked_at : null;
  return { status: ok ? 200 : 503, body: { ok, checked_at: checkedAt, checks } };
}

/** Optional OPS_HEALTH_KEY: unset means open; set means `?key=` must match (constant-time compare). */
export function keyMatches(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected) return true;
  const a = given ?? '';
  let diff = a.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (a.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  return diff === 0;
}

export type ExpiredObject = { bucket: string; name: string; reason?: string };

/** Groups objects by bucket into Storage API remove calls of at most `size` names each. */
export function removalBatches(rows: ExpiredObject[], size = 100): { bucket: string; names: string[] }[] {
  const byBucket = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.bucket || !r.name) continue;
    const list = byBucket.get(r.bucket) ?? [];
    if (!list.includes(r.name)) list.push(r.name);
    byBucket.set(r.bucket, list);
  }
  const out: { bucket: string; names: string[] }[] = [];
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += size) out.push({ bucket, names: names.slice(i, i + size) });
  }
  return out;
}

/** Validates the optional ops/test body of storage-retention: { now?: ISO time, prefix?: path prefix }. */
export function retentionOptions(body: unknown): { now: string | null; prefix: string | null } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as { now?: unknown; prefix?: unknown };
  let now: string | null = null;
  if (b.now !== undefined && b.now !== null) {
    if (typeof b.now !== 'string' || Number.isNaN(Date.parse(b.now))) return { error: 'invalid_now' };
    now = new Date(b.now).toISOString();
  }
  let prefix: string | null = null;
  if (b.prefix !== undefined && b.prefix !== null) {
    if (typeof b.prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,199}$/.test(b.prefix) || b.prefix.includes('..')) {
      return { error: 'invalid_prefix' };
    }
    prefix = b.prefix;
  }
  return { now, prefix };
}
