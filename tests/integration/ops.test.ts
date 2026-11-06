// Vendor-first wave 3 (ops): the ops-health uptime endpoint, storage retention through the Storage
// API, "Freeze now" and the admin engine tile, over HTTP against the local stack. The pure helpers of
// supabase/functions/_shared/ops.ts are unit-tested first (no network).
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@tiffin/core';
import { healthCache, healthResponse, keyMatches, removalBatches, retentionOptions } from '../../supabase/functions/_shared/ops.ts';
import { env, loginAs, type Client } from './helpers';

const healthy = {
  ok: true, checked_at: '2026-11-06T10:00:00Z',
  checks: { lock_job: true, nightly_job: true, summary_job: true, overdue_slots: 0, failing_jobs: 0, job_warnings: 0, engine_errors: 0 },
};

describe('ops helpers (no network)', () => {
  it('answers 200 only when every check passed, with known fields only', () => {
    expect(healthResponse(healthy)).toEqual({ status: 200, body: healthy });
    const leaky = { ...healthy, secret: 'eyJhbGciOi...', checks: { ...healthy.checks, kitchen: 'Maa Tarini' } };
    expect(JSON.stringify(healthResponse(leaky).body)).not.toMatch(/eyJ|Maa Tarini|secret|kitchen/);
    expect(healthResponse({ ...healthy, checks: { ...healthy.checks, overdue_slots: 2 } }).status).toBe(503);
    expect(healthResponse({ ...healthy, checks: { ...healthy.checks, engine_errors: 1 } }).status).toBe(503);
    expect(healthResponse({ ...healthy, checks: { ...healthy.checks, lock_job: false } }).status).toBe(503);
    // The database said ok but a check disagrees: still 503.
    expect(healthResponse({ ...healthy, checks: { ...healthy.checks, failing_jobs: 1 } }).body.ok).toBe(false);
    // A failed housekeeping job is a warning: still 200.
    expect(healthResponse({ ...healthy, checks: { ...healthy.checks, job_warnings: 2 } }).status).toBe(200);
    expect(healthResponse(null)).toEqual({ status: 503, body: { ok: false, error: 'health_unavailable' } });
    expect(healthResponse({ message: 'permission denied for function ops_health' })).toEqual({ status: 503, body: { ok: false, error: 'health_unavailable' } });
  });

  it('caches the health answer briefly', () => {
    let t = 1_000;
    const c = healthCache<number>(15_000, () => t);
    expect(c.get()).toBeNull();
    c.set(503);
    t += 14_999;
    expect(c.get()).toBe(503);
    t += 1;
    expect(c.get()).toBeNull();
  });

  it('checks the optional key', () => {
    expect(keyMatches(null, undefined)).toBe(true);
    expect(keyMatches('abc', 'abc')).toBe(true);
    expect(keyMatches('abd', 'abc')).toBe(false);
    expect(keyMatches('abcd', 'abc')).toBe(false);
    expect(keyMatches(null, 'abc')).toBe(false);
  });

  it('batches removals per bucket', () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ bucket: 'proofs', name: `k/${i}.jpg` }))
      .concat([{ bucket: 'imports', name: 'k/a.jpg' }, { bucket: 'imports', name: 'k/a.jpg' }]);
    const b = removalBatches(rows, 100);
    expect(b.map((x) => `${x.bucket}:${x.names.length}`)).toEqual(['proofs:100', 'proofs:100', 'proofs:5', 'imports:1']);
  });

  it('validates the ops body of storage-retention', () => {
    expect(retentionOptions({})).toEqual({ now: null, prefix: null });
    expect(retentionOptions({ now: '2027-01-01T00:00:00Z', prefix: 'abc/def/' })).toEqual({ now: '2027-01-01T00:00:00.000Z', prefix: 'abc/def/' });
    expect(retentionOptions({ now: 'tomorrow' })).toEqual({ error: 'invalid_now' });
    expect(retentionOptions({ prefix: '../etc' })).toEqual({ error: 'invalid_prefix' });
    expect(retentionOptions({ prefix: '%' })).toEqual({ error: 'invalid_prefix' });
  });
});

/** The local stack's service role key (only tests and Edge Functions use it). */
function serviceRoleKey(): string | null {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.SUPABASE_URL) return null;
  const out = execSync('npx supabase status -o json', { cwd: new URL('../..', import.meta.url).pathname }).toString();
  return (JSON.parse(out.slice(out.indexOf('{'))) as { SERVICE_ROLE_KEY?: string }).SERVICE_ROLE_KEY ?? null;
}

describe('ops over HTTP', () => {
  const fn = (name: string) => `${env().url}/functions/v1/${name}`;
  const key = serviceRoleKey();

  it('ops-health answers an uptime pinger with 200/503 and nothing secret', async () => {
    const res = await fetch(fn('ops-health'));
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toMatch(/eyJ|service_role|kitchen|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    const body = JSON.parse(text) as { ok: boolean; checks: Record<string, unknown> };
    expect(body.ok).toBe(res.status === 200);
    expect(Object.keys(body.checks).sort()).toEqual(['engine_errors', 'failing_jobs', 'job_warnings', 'lock_job', 'nightly_job', 'overdue_slots', 'summary_job']);

    const head = await fetch(fn('ops-health'), { method: 'HEAD' });
    expect([200, 503]).toContain(head.status);
    expect(await head.text()).toBe('');
    const post = await fetch(fn('ops-health'), { method: 'POST' });
    expect(post.status).toBe(405);
    await post.text();
  });

  it.skipIf(!key)('ops-health agrees with the database check', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [res, db] = await Promise.all([
        fetch(fn('ops-health')).then(async (r) => ({ status: r.status, body: await r.json() as { ok: boolean } })),
        fetch(`${env().url}/rest/v1/rpc/ops_health`, {
          method: 'POST', headers: { apikey: key!, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}',
        }).then((r) => r.json() as Promise<{ ok: boolean }>),
      ]);
      if (res.body.ok === db.ok) {
        expect(res.status).toBe(db.ok ? 200 : 503);
        return;
      }
      // The function caches its answer for 15 s (healthCache): wait it out and compare again.
      await new Promise((r) => setTimeout(r, 16_000));
    }
    throw new Error('ops-health and ops_health() disagree');
  }, 60_000);

  it('ops_health is not callable with the anon key', async () => {
    const r = await fetch(`${env().url}/rest/v1/rpc/ops_health`, {
      method: 'POST', headers: { apikey: env().anonKey, Authorization: `Bearer ${env().anonKey}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(r.status).toBe(401);
    await r.text();
  });

  it.skipIf(!key)('storage-retention deletes expired photos through the Storage API', async () => {
    const forbidden = await fetch(fn('storage-retention'), { method: 'POST', headers: { Authorization: `Bearer ${env().anonKey}` }, body: '{}' });
    expect(forbidden.status).toBe(403);
    await forbidden.text();

    const prefix = `retention-it-${randomUUID()}/`;
    const headers = { apikey: key!, Authorization: `Bearer ${key}` };
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
    for (const name of ['a.jpg', 'b.jpg']) {
      const up = await fetch(`${env().url}/storage/v1/object/proofs/${prefix}${name}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'image/jpeg' }, body: jpeg,
      });
      expect(up.status, await up.text()).toBe(200);
    }
    const list = async () => {
      const r = await fetch(`${env().url}/storage/v1/object/list/proofs`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: prefix.slice(0, -1), limit: 10 }),
      });
      return (await r.json() as { name: string }[]).map((o) => o.name).sort();
    };
    expect(await list()).toEqual(['a.jpg', 'b.jpg']);

    const run = async (body: Record<string, unknown>) => {
      const r = await fetch(fn('storage-retention'), {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() as { deleted: number; failed: number } };
    };
    const fresh = await run({ prefix });
    expect(fresh).toEqual({ status: 200, body: expect.objectContaining({ deleted: 0, failed: 0 }) });
    expect(await list()).toEqual(['a.jpg', 'b.jpg']);

    const later = await run({ prefix, now: new Date(Date.now() + 100 * 86_400_000).toISOString() });
    expect(later).toEqual({ status: 200, body: expect.objectContaining({ deleted: 2, failed: 0 }) });
    expect(await list()).toEqual([]);
    expect((await run({ prefix: '../x' })).status).toBe(400);
  });
});

describe('Freeze now and the admin engine tile', () => {
  // Own spare numbers: test files run in parallel and the seed logins are shared by many suites.
  let owner: { client: Client };
  let outsider: { client: Client };
  let kitchenId: string;
  const run = Date.now().toString(36);

  beforeAll(async () => {
    [owner, outsider] = await Promise.all([loginAs('+919000000120'), loginAs('+919000000121')]);
    const { data, error } = await owner.client.rpc('create_kitchen', { p_name: `Ops IT ${run}`, p_area: 'Patia' });
    expect(error).toBeNull();
    kitchenId = (data as { id: string }).id;
  });

  it('lets the owner freeze a slot past its cutoff through the idempotent lock', async () => {
    const today = istDate();
    // Today's lunch closed yesterday at 21:00 (default cutoff); the lock job may already have frozen it.
    const first = await owner.client.rpc('freeze_slot', { p_kitchen: kitchenId, p_date: today, p_slot: 'lunch' });
    expect(first.error).toBeNull();
    const again = await owner.client.rpc('freeze_slot', { p_kitchen: kitchenId, p_date: today, p_slot: 'lunch' });
    expect(again.error).toBeNull();
    const a = first.data as { snapshot_id: string }, b = again.data as { snapshot_id: string; already_locked: boolean };
    expect(b).toMatchObject({ snapshot_id: a.snapshot_id, already_locked: true });

    const early = await owner.client.rpc('freeze_slot', { p_kitchen: kitchenId, p_date: addDays(today, 2), p_slot: 'dinner' });
    expect(early.error?.message).toBe('before_cutoff');
    const old = await owner.client.rpc('freeze_slot', { p_kitchen: kitchenId, p_date: addDays(today, -9), p_slot: 'lunch' });
    expect(old.error?.message).toBe('out_of_range');
    const byOutsider = await outsider.client.rpc('freeze_slot', { p_kitchen: kitchenId, p_date: today, p_slot: 'lunch' });
    expect(byOutsider.error?.message).toBe('forbidden');
  });

  it('keeps engine health for the platform team', async () => {
    // The admin view itself is covered by pgTAP 14_ops; over the API a kitchen owner is refused.
    const r = await owner.client.rpc('engine_health');
    expect(r.error?.message).toBe('forbidden');
  });
});
