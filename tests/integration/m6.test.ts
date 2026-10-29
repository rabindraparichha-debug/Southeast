// M6 end-to-end over HTTP: items, recipes in grams, the production plan, a supplier bill with a
// photo in Storage, wastage, a stock-take with a variance reason, and money parts kept from staff.
// Uses its own kitchen (spare number 90000 00104).
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, istDate } from '@tiffin/core';
import { loginAs, rest, type Client } from './helpers';

const run = Date.now().toString(36);

describe('M6: inventory over the API', () => {
  let owner: { client: Client; accessToken: string };
  let kitchenId: string;
  let dalId: string;
  const tomorrow = addDays(istDate(), 1);

  beforeAll(async () => {
    owner = await loginAs('+919000000104');
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Stock IT ${run}`, p_area: 'Patia' });
    expect(error).toBeNull();
    kitchenId = (kitchen as { id: string }).id;
    // Every day so "tomorrow" always has meals.
    const { data: plan } = await owner.client.from('plans')
      .insert({ kitchen_id: kitchenId, name: 'Lunch', slots: ['lunch'], days_of_week: [1, 2, 3, 4, 5, 6, 7], price_per_meal_paise: 7000 })
      .select('id').single();
    for (const i of [1, 2]) {
      const { data: cust, error: cErr } = await owner.client.rpc('create_customer', {
        p_kitchen: kitchenId, p_name: `Stock Customer ${i}`, p_phone: `97${String(Date.now()).slice(-7)}${i}`, p_consent: true,
      });
      expect(cErr).toBeNull();
      await owner.client.from('subscriptions').insert({ kitchen_id: kitchenId, customer_id: cust as string, plan_id: plan!.id,
        start_date: istDate(), status: 'active', qty: 5 });
    }
    await owner.client.from('menus').insert({ kitchen_id: kitchenId, service_date: tomorrow, slot: 'lunch', dishes: ['Dal', 'Rice'], published: true });
  });

  it('recipes in grams drive the production plan', async () => {
    const { data: item, error } = await owner.client.rpc('create_item', {
      p_kitchen: kitchenId, p_name: 'Toor dal', p_unit: 'kg', p_category: 'pulse', p_min_qty: 2, p_opening_qty: 10, p_opening_price_paise: 12000,
    });
    expect(error).toBeNull();
    dalId = item as string;
    const { data: dish } = await owner.client.rpc('upsert_dish', { p_kitchen: kitchenId, p_name: 'Dal' });
    const line = await owner.client.rpc('set_recipe_line', { p_dish: dish as string, p_item: dalId, p_qty: 30, p_unit: 'g' });
    expect(Number(line.data)).toBe(0.03);
    const { data: plan } = await owner.client.rpc('production_plan', { p_kitchen: kitchenId, p_date: tomorrow, p_slot: 'lunch' });
    const p = plan as { dishes: { name: string; portions: number }[]; ingredients: { item: string; qty: number }[]; no_recipe: string[] };
    expect(p.dishes).toEqual([{ dish_id: dish, name: 'Dal', portions: 10 }]);
    expect(p.ingredients[0]).toMatchObject({ item: 'Toor dal', qty: 0.3 }); // 30 g × 10 portions
    expect(p.no_recipe).toEqual(['Rice']);
  });

  it('records a supplier bill with its photo, flags a price jump, and tracks dues', async () => {
    const path = `${kitchenId}/${run}-bill.jpg`;
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
    expect((await owner.client.storage.from('bills').upload(path, jpeg, { contentType: 'image/jpeg' })).error).toBeNull();
    const { data: sup } = await owner.client.rpc('upsert_supplier', { p_kitchen: kitchenId, p_name: 'IT Kirana' });
    const { data, error } = await owner.client.rpc('record_purchase', {
      p_kitchen: kitchenId, p_supplier: sup as string, p_photo_path: path, p_bill_no: 'IT-1', p_paid_now_paise: 50000,
      p_lines: [{ item_id: dalId, qty: 5000, unit: 'g', amount_paise: 75000 }],
    });
    expect(error).toBeNull();
    expect((data as { price_jumps: { pct: number }[] }).price_jumps[0]!.pct).toBe(25); // ₹150/kg after ₹120
    const dues = await owner.client.rpc('supplier_dues', { p_kitchen: kitchenId });
    expect((dues.data as { due_paise: number }[])[0]!.due_paise).toBe(25000);
    const levels = await owner.client.rpc('stock_levels', { p_kitchen: kitchenId });
    expect(Number((levels.data as { stock: number }[])[0]!.stock)).toBe(15);
  });

  it('a stock-take 1 kg short needs a reason before it closes', async () => {
    const { data: take } = await owner.client.rpc('start_stock_take', { p_kitchen: kitchenId });
    const c = await owner.client.rpc('set_stock_count', { p_stock_take: take as string, p_item: dalId, p_counted: 14 });
    expect(c.data).toMatchObject({ variance: -1, needs_reason: true });
    const refused = await owner.client.rpc('close_stock_take', { p_stock_take: take as string });
    expect(refused.error?.message).toBe('reason_required');
    await owner.client.rpc('set_stock_count', { p_stock_take: take as string, p_item: dalId, p_counted: 14, p_reason: 'Rats' });
    const closed = await owner.client.rpc('close_stock_take', { p_stock_take: take as string });
    expect(closed.error).toBeNull();
    const moves = await rest(`stock_moves?select=type,qty,reason&item_id=eq.${dalId}&type=eq.count`, owner.accessToken);
    expect(moves.body).toEqual([{ type: 'count', qty: -1, reason: 'Rats' }]);
    // The ledger can't be edited through the API.
    const edit = await rest(`stock_moves?item_id=eq.${dalId}`, owner.accessToken, { method: 'PATCH', body: JSON.stringify({ qty: 99 }) });
    expect([401, 403]).toContain(edit.status);
  });
});
