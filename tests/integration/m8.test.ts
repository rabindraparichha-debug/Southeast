// M8 over HTTP: admin console data (platform metrics, kitchen overview, audit log, review
// moderation) is admin-only, and the FSSAI number of a live kitchen is locked for its owner.
import { beforeAll, describe, expect, it } from 'vitest';
import { KITCHEN_A, loginAs, type Client } from './helpers';

describe('M8: admin console and hardening over the API', () => {
  let admin: { client: Client; accessToken: string };
  let owner: { client: Client; accessToken: string };

  beforeAll(async () => {
    [admin, owner] = await Promise.all([loginAs('+919000000099'), loginAs('+919000000001')]);
  });

  it('gives the platform team its metrics and kitchen overview', async () => {
    const { data, error } = await admin.client.rpc('platform_metrics');
    expect(error).toBeNull();
    const m = data as { kitchens: { active: number; goal_live: number }; customers: { total: number; whatsapp_pct: number } };
    expect(m.kitchens.goal_live).toBe(30);
    expect(m.kitchens.active).toBeGreaterThanOrEqual(2);
    expect(m.customers.total).toBeGreaterThan(0);
    const { data: kitchens } = await admin.client.rpc('admin_kitchens');
    const a = (kitchens as { id: string; status: string; checklist_total: number; customers: number }[]).find((k) => k.id === KITCHEN_A)!;
    expect(a).toMatchObject({ status: 'active', checklist_total: 9 });
    expect(a.customers).toBeGreaterThanOrEqual(20);
  });

  it('shows the audit log and reviews to admins only', async () => {
    const { data: log } = await admin.client.rpc('admin_audit_log', { p_table: 'balance_entries', p_limit: 5 });
    expect((log as unknown as { table: string }[]).every((r) => r.table === 'balance_entries')).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(/phone_enc|token_hash/);
    const { data: reviews } = await admin.client.rpc('admin_reviews', { p_kitchen: KITCHEN_A });
    expect((reviews as unknown[]).length).toBeGreaterThan(0);
    for (const fn of ['platform_metrics', 'admin_kitchens', 'admin_reviews'] as const) {
      const r = await owner.client.rpc(fn);
      expect(r.error?.message, fn).toBe('forbidden');
    }
    const r = await owner.client.rpc('admin_audit_log', {});
    expect(r.error?.message).toBe('forbidden');
  });

  it("locks a live kitchen's FSSAI number for its owner", async () => {
    const upd = await owner.client.from('kitchens').update({ fssai_no: '12026001999999' }).eq('id', KITCHEN_A);
    expect(upd.error?.message).toBe('fssai_locked');
    const ok = await owner.client.from('kitchens').update({ description: 'Still editable: home-style Odia meals cooked fresh every morning.' }).eq('id', KITCHEN_A);
    expect(ok.error).toBeNull();
  });
});
