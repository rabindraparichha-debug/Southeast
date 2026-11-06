// Vendor-first wave 2 over the API: monthly (pay-later) billing, manager and accountant roles,
// invites claimed with a real code sign-in, rider change requests approved by a manager, void and
// idempotent payments, statements and CSV exports. Money and roles run in a new kitchen owned by the
// spare login +919000000113 (manager +919000000114, accountant +919000000115), so kitchen A's counts
// stay untouched for the other suites; the rider request uses kitchen A's rider and seeded manager on
// a meal 6 days out (needs a fresh `pnpm db:reset`).
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { istDate } from '@tiffin/core';
import { KITCHEN_A, loginAs, rest, type Client } from './helpers';

const run = String(Date.now()).slice(-6);

type Login = { client: Client; accessToken: string; userId: string };
type Stop = { id: string; status: string; customer_id: string };
type Run = { id: string; kitchen_id: string; stops: Stop[] };

describe('Wave 2: billing mode, manager and accountant, rider requests', () => {
  let owner: Login;
  let manager: Login;
  let accountant: Login;
  let rider: Login;
  let managerA: Login;
  let kitchenId: string;
  let planId: string;
  let customerId: string;
  let subscriptionId: string;

  beforeAll(async () => {
    [owner, rider, managerA] = await Promise.all([loginAs('+919000000113'), loginAs('+919000000003'), loginAs('+919000000110')]);
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Wave Two IT ${run}`, p_area: 'Sundarpada' });
    expect(error).toBeNull();
    kitchenId = (kitchen as { id: string }).id;
    const { data: plan } = await owner.client.from('plans')
      .insert({ kitchen_id: kitchenId, name: 'Thali', slots: ['lunch'], days_of_week: [1, 2, 3, 4, 5, 6, 7], price_per_meal_paise: 6000 })
      .select('id').single();
    planId = plan!.id;
    // Invites for the new roles, claimed at the first login with a code (claim_invites checks the session).
    for (const [phone, role] of [['9000000114', 'manager'], ['9000000115', 'accountant']] as const) {
      const inv = await owner.client.rpc('invite_member', { p_kitchen: kitchenId, p_phone: phone, p_role: role });
      expect(inv.error).toBeNull();
    }
    [manager, accountant] = await Promise.all([loginAs('+919000000114'), loginAs('+919000000115')]);
    expect((await manager.client.rpc('claim_invites')).data).toBe(1);
    expect((await accountant.client.rpc('claim_invites')).data).toBe(1);
    const { data: team } = await owner.client.from('members').select('user_id, role').eq('kitchen_id', kitchenId);
    expect(new Set(team!.map((m) => m.role))).toEqual(new Set(['owner', 'manager', 'accountant']));
  });

  it('a manager adds a monthly customer, records a skip and cash; nothing is suspended', async () => {
    const phone = `93${String(Date.now()).slice(-8)}`;
    const { data: cust, error } = await manager.client.rpc('create_customer', {
      p_kitchen: kitchenId, p_name: 'Wave Two Khata', p_phone: phone, p_consent: true,
    });
    expect(error).toBeNull();
    customerId = cust as string;
    const { data: c } = await manager.client.from('customers_v').select('billing_mode, phone').eq('id', customerId).single();
    expect(c).toMatchObject({ billing_mode: 'monthly', phone: `+91${phone}` }); // kitchen default; managers see full phones

    const { data: sub, error: sErr } = await manager.client.from('subscriptions')
      .insert({ kitchen_id: kitchenId, customer_id: customerId, plan_id: planId, start_date: istDate(), status: 'active' })
      .select('id').single();
    expect(sErr).toBeNull();
    subscriptionId = sub!.id;

    const skipDate = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const skip = await manager.client.rpc('request_schedule_change', {
      p_subscription: subscriptionId, p_type: 'skip', p_from: skipDate, p_dry_run: false,
    });
    expect(skip.error).toBeNull();

    const op = randomUUID();
    const first = await manager.client.rpc('record_payment', { p_customer: customerId, p_amount_paise: 50000, p_method: 'cash', p_client_op: op });
    const again = await manager.client.rpc('record_payment', { p_customer: customerId, p_amount_paise: 50000, p_method: 'cash', p_client_op: op });
    expect(first.error).toBeNull();
    expect(again.data).toBe(first.data); // a double tap records one payment
    const { data: pays } = await owner.client.from('payments').select('id, meals, status').eq('customer_id', customerId);
    expect(pays).toEqual([{ id: first.data, meals: 0, status: 'paid' }]); // monthly: rupees only

    const { data: subRow } = await owner.client.from('subscriptions').select('status').eq('id', subscriptionId).single();
    expect(subRow?.status).toBe('active');
  });

  it('an accountant reads money but cannot write', async () => {
    const dues = await accountant.client.rpc('dues_list', { p_kitchen: kitchenId });
    expect(dues.error).toBeNull();
    const statement = await accountant.client.rpc('customer_statement', { p_customer: customerId, p_month: istDate() });
    expect(statement.error).toBeNull();
    const s = statement.data as { customer: { phone: string }; totals: { paid_paise: number }; closing: { paise: number } };
    expect(s.totals.paid_paise).toBe(50000);
    expect(s.customer.phone).toMatch(/^\+91 •+\d{4}$/); // masked for accountants
    const csv = await accountant.client.rpc('export_payments_csv', { p_kitchen: kitchenId, p_from: istDate(), p_to: istDate() });
    expect(csv.error).toBeNull();
    expect(String(csv.data)).toContain('"Wave Two Khata",monthly,cash,paid,500.00,0');
    const { data: ledger } = await accountant.client.from('balance_entries').select('amount_paise').eq('customer_id', customerId);
    expect(ledger!.length).toBeGreaterThan(0);

    const write = await accountant.client.rpc('record_payment', { p_customer: customerId, p_amount_paise: 100, p_method: 'cash' });
    expect(write.error?.message).toBe('forbidden');
    const credit = await accountant.client.rpc('add_balance_entry', { p_customer: customerId, p_type: 'credit', p_meals: 1, p_reason: 'x' });
    expect(credit.error?.message).toBe('forbidden');
    const change = await accountant.client.rpc('request_schedule_change', { p_subscription: subscriptionId, p_type: 'skip', p_from: istDate() });
    expect(change.error?.message).toBe('forbidden');
    const audit = await rest('audit_log?select=id&limit=1', accountant.accessToken);
    expect(audit.body).toEqual([]); // the audit log is owner-only
  });

  it('a manager voids a payment with a reason; the ledger gets a reversal row', async () => {
    const { data: pay } = await owner.client.from('payments').select('id').eq('customer_id', customerId).single();
    const voided = await manager.client.rpc('void_payment', { p_payment: pay!.id, p_reason: 'Recorded on the wrong customer' });
    expect(voided.error).toBeNull();
    const { data: rows } = await owner.client.from('balance_entries').select('type, ref_type, amount_paise').eq('customer_id', customerId)
      .in('type', ['recharge', 'adjust']).order('created_at');
    expect(rows).toEqual([
      { type: 'recharge', ref_type: 'payment', amount_paise: 50000 },
      { type: 'adjust', ref_type: 'payment_void', amount_paise: -50000 },
    ]);
    const { data: p } = await owner.client.from('payments').select('status, void_reason').eq('id', pay!.id).single();
    expect(p).toEqual({ status: 'voided', void_reason: 'Recorded on the wrong customer' });
  });

  it('owner-only areas stay owner-only for a manager', async () => {
    const invite = await manager.client.rpc('invite_member', { p_kitchen: kitchenId, p_phone: '9000000118', p_role: 'staff' });
    expect(invite.error?.message).toBe('forbidden');
    const settings = await rest(`kitchen_settings?kitchen_id=eq.${kitchenId}`, manager.accessToken, {
      method: 'PATCH', body: JSON.stringify({ grace_days: 1 }),
    });
    expect(settings.body).toEqual([]); // RLS: nothing updated
    const payout = await rest('kitchen_payout_accounts?select=kitchen_id', manager.accessToken);
    expect(payout.body).toEqual([]);
  });

  it('a rider records a request at the door; the manager approves it through the normal change path', async () => {
    const { data, error } = await rider.client.rpc('rider_today');
    expect(error).toBeNull();
    const stop = (data as Run[]).filter((r) => r.kitchen_id === KITCHEN_A).flatMap((r) => r.stops)[0];
    expect(stop, 'kitchen A needs a run today: run `pnpm db:reset`').toBeTruthy();
    // Six days out: never the dates other suites count on kitchen A (2–4 days out).
    const day = new Date(Date.now() + 6 * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const op = randomUUID();
    const req = await rider.client.rpc('rider_request_change', { p_stop: stop!.id, p_type: 'skip', p_from: day, p_client_op: op });
    expect(req.error).toBeNull();
    const retry = await rider.client.rpc('rider_request_change', { p_stop: stop!.id, p_type: 'skip', p_from: day, p_client_op: op });
    expect((retry.data as { request_id: string }).request_id).toBe((req.data as { request_id: string }).request_id);
    const requestId = (req.data as { request_id: string }).request_id;

    const notMine = await rider.client.rpc('approve_change_request', { p_request: requestId });
    expect(notMine.error?.message).toBe('forbidden');
    const list = await managerA.client.rpc('change_requests_list', { p_kitchen: KITCHEN_A });
    expect((list.data as { id: string }[]).some((r) => r.id === requestId)).toBe(true);
    const approved = await managerA.client.rpc('approve_change_request', { p_request: requestId });
    expect(approved.error).toBeNull();
    const { data: row } = await managerA.client.from('change_requests').select('status, change_id').eq('id', requestId).single();
    expect(row?.status).toBe('approved');
    const { data: change } = await managerA.client.from('schedule_changes').select('channel, type, from_date').eq('id', row!.change_id!).single();
    expect(change).toEqual({ channel: 'rider', type: 'skip', from_date: day });
  });
});
