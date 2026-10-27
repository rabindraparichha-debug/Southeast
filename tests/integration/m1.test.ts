// M1 acceptance tests against the running local API (`pnpm db:start && pnpm db:reset` first).
import { beforeAll, describe, expect, it } from 'vitest';
import type { ImportResult } from '@tiffin/db';
import { KITCHEN_A, KITCHEN_B, anonClient, loginAs, rest, type Client } from './helpers';

describe('M1 test 1: kitchen A staff cannot see kitchen B, including via the API directly', () => {
  let staffA: { client: Client; accessToken: string };
  let bCustomerId: string;

  beforeAll(async () => {
    staffA = await loginAs('+919000000002');
    const ownerB = await loginAs('+919000000011');
    const { data } = await ownerB.client.from('customers_v').select('id').limit(1).single();
    bCustomerId = data!.id!;
  });

  it('supabase-js: staff A sees only kitchen A customers', async () => {
    const { data, error } = await staffA.client.from('customers_v').select('id, kitchen_id, name, phone');
    expect(error).toBeNull();
    expect(data).toHaveLength(20);
    expect(new Set(data!.map((c) => c.kitchen_id))).toEqual(new Set([KITCHEN_A]));
    expect(data!.every((c) => c.phone?.startsWith('+91 ••••••'))).toBe(true);
  });

  it('REST: filtering for kitchen B returns nothing', async () => {
    const view = await rest(`customers_v?kitchen_id=eq.${KITCHEN_B}&select=id,name`, staffA.accessToken);
    expect(view.status).toBe(200);
    expect(view.body).toEqual([]);

    const table = await rest(`customers?kitchen_id=eq.${KITCHEN_B}&select=id,name`, staffA.accessToken);
    expect(table.status).toBe(200);
    expect(table.body).toEqual([]);

    const byId = await rest(`customers?id=eq.${bCustomerId}&select=id,name`, staffA.accessToken);
    expect(byId.body).toEqual([]);

    const addresses = await rest(`addresses?kitchen_id=eq.${KITCHEN_B}&select=id`, staffA.accessToken);
    expect(addresses.body).toEqual([]);

    const kitchens = await rest('kitchens?select=id', staffA.accessToken);
    expect(kitchens.body).toEqual([{ id: KITCHEN_A }]);
  });

  it('REST: the encrypted phone column cannot be selected', async () => {
    const res = await rest('customers?select=id,phone_enc&limit=1', staffA.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('42501');
  });

  it('REST: writes to kitchen B are refused', async () => {
    const patch = await rest(`customers?id=eq.${bCustomerId}`, staffA.accessToken, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(patch.body.code).toBe('42501');

    const kitchenPatch = await rest(`kitchens?id=eq.${KITCHEN_B}`, staffA.accessToken, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(kitchenPatch.status).toBe(200);
    expect(kitchenPatch.body).toEqual([]); // RLS: zero rows matched

    const rpc = await rest('rpc/search_customers', staffA.accessToken, {
      method: 'POST',
      body: JSON.stringify({ p_kitchen: KITCHEN_B, p_q: '' }),
    });
    expect(rpc.body.message).toBe('forbidden');
  });

  it('anonymous requests see nothing', async () => {
    const { error } = await anonClient().from('customers_v').select('id');
    expect(error?.code).toBe('42501');
  });
});

describe('M1 test 2: importing 50 customers with 3 bad rows', () => {
  it('saves 47, reports the 3 bad rows with reasons', async () => {
    // A fresh vendor signs up and creates their own kitchen.
    const vendor = await loginAs('+919000000101');
    const { data: kitchen, error: kErr } = await vendor.client.rpc('create_kitchen', {
      p_name: `Import Test Kitchen ${Date.now()}`,
      p_area: 'Nayapalli',
    });
    expect(kErr).toBeNull();
    const kitchenId = (kitchen as { id: string }).id;

    const { error: planErr } = await vendor.client.from('plans').insert({
      kitchen_id: kitchenId,
      name: 'Veg Lunch',
      slots: ['lunch'],
      price_per_meal_paise: 7000,
    });
    expect(planErr).toBeNull();

    const suffix = String(Date.now()).slice(-3);
    const rows = Array.from({ length: 50 }, (_, k) => {
      const i = k + 1;
      const phone = `97${suffix}${String(i).padStart(5, '0')}`;
      if (i === 7) return { name: 'Bad Phone', phone: '98765' };
      if (i === 21) return { name: '', phone: `96${suffix}${String(i).padStart(5, '0')}` };
      if (i === 33) return { name: 'Duplicate', phone: `97${suffix}00001` };
      return { name: `Customer ${i}`, phone, area: 'Nayapalli', plan: i % 2 ? 'Veg Lunch' : '', start_date: i % 2 ? '2026-11-02' : '' };
    });

    const { data, error } = await vendor.client.rpc('import_customers', {
      p_kitchen: kitchenId,
      p_rows: rows,
      p_consent: true,
      p_file_name: 'integration.csv',
    });
    expect(error).toBeNull();
    const result = data as unknown as ImportResult;
    expect(result.imported).toBe(47);
    expect(result.failed).toBe(3);
    expect(result.errors).toEqual([
      { row: 7, errors: ['invalid_phone'] },
      { row: 21, errors: ['name_required'] },
      { row: 33, errors: ['duplicate_in_file'] },
    ]);

    const { count } = await vendor.client
      .from('customers_v')
      .select('id', { count: 'exact', head: true })
      .eq('kitchen_id', kitchenId);
    expect(count).toBe(47);
  });
});
