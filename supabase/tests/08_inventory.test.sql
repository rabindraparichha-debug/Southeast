-- M6 tests: toor dal at 30 g per portion with a count of 100 deducts 3 kg at the lock (once);
-- a stock-take 1 kg short shows as variance with a reason prompt; purchases (price jump, supplier
-- dues), wastage, alerts, cost per meal, the 10 pm summary, permissions.
-- Calendar: Mon 2 Nov 2026; Tuesday lunch locks Mon 21:00 IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select set_config('app.now', '2026-11-01 10:00:00+05:30', true);
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'f3000000-0000-4000-f000-000000000001', 'authenticated', 'authenticated', '919888000001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f3000000-0000-4000-f000-000000000002', 'authenticated', 'authenticated', '919888000002', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f3000000-0000-4000-f000-000000000003', 'authenticated', 'authenticated', '919888000003', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('84000000-0000-4000-f000-000000000001', 'Stock Kitchen', 'stock-kitchen', 'f3000000-0000-4000-f000-000000000001', '{7}');
insert into public.kitchen_settings (kitchen_id, gas_paise_per_meal, packaging_paise_per_meal)
values ('84000000-0000-4000-f000-000000000001', 300, 500);
insert into public.members (kitchen_id, user_id, role) values
  ('84000000-0000-4000-f000-000000000001', 'f3000000-0000-4000-f000-000000000001', 'owner'),
  ('84000000-0000-4000-f000-000000000001', 'f3000000-0000-4000-f000-000000000002', 'staff'),
  ('84000000-0000-4000-f000-000000000001', 'f3000000-0000-4000-f000-000000000003', 'rider');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('94000000-0000-4000-f000-000000000001', '84000000-0000-4000-f000-000000000001', 'Lunch', '{lunch}', '{1,2,3,4,5,6}', 7000);
-- 10 subscriptions × 10 tiffins = 100 meals on Tuesday.
do $$
declare i integer; v_c uuid;
begin
  for i in 1..10 loop
    v_c := private.insert_customer('84000000-0000-4000-f000-000000000001', 'Office ' || i, '+91955500' || lpad(i::text, 4, '0'),
      'veg', 'en', null, null, 'vendor', 'vendor');
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, start_date, status, qty)
    values ('84000000-0000-4000-f000-000000000001', v_c, '94000000-0000-4000-f000-000000000001', '2026-11-03', 'active', 10);
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
    values ('84000000-0000-4000-f000-000000000001', v_c, 'adjust', 200, 1400000, 'test balance');
  end loop;
end $$;
insert into public.menus (kitchen_id, service_date, slot, dishes, published)
values ('84000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch', '{Rice,Dal,Aloo bhaja}', true);

create temp table ids (k text primary key, id uuid);
grant select, insert on ids to authenticated;

-- ===========================================================================
-- Items, recipes, purchases (as staff and owner)
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
insert into ids values ('dal', public.create_item('84000000-0000-4000-f000-000000000001', 'Toor dal', 'kg', 'pulse', 5, 20, 12000));
insert into ids values ('rice', public.create_item('84000000-0000-4000-f000-000000000001', 'Rice', 'kg', 'grain', 10, 50, 5000));
insert into ids values ('oil', public.create_item('84000000-0000-4000-f000-000000000001', 'Mustard oil', 'l', 'oil', 1, 5, 18000));
select throws_ok($$ select public.create_item('84000000-0000-4000-f000-000000000001', 'toor DAL', 'kg') $$, '23505', 'already_exists',
  'item names are unique per kitchen (any case)');
insert into ids values ('d_dal', public.upsert_dish('84000000-0000-4000-f000-000000000001', 'Dal'));
insert into ids values ('d_rice', public.upsert_dish('84000000-0000-4000-f000-000000000001', 'Rice'));
select is(public.set_recipe_line((select id from ids where k = 'd_dal'), (select id from ids where k = 'dal'), 30, 'g'), 0.0300,
  '30 g of dal per portion is stored as 0.03 kg (the item''s unit)');
select is(public.set_recipe_line((select id from ids where k = 'd_dal'), (select id from ids where k = 'oil'), 5, 'ml'), 0.0050,
  '5 ml of oil per portion is stored as 0.005 l');
select is(public.set_recipe_line((select id from ids where k = 'd_rice'), (select id from ids where k = 'rice'), 0.12), 0.1200,
  '0.12 kg of rice per portion');
select throws_ok($$ select public.set_recipe_line((select id from ids where k = 'd_rice'), (select id from ids where k = 'rice'), 2, 'pc') $$,
  '22023', 'unit_mismatch', 'pieces cannot be converted to kg');
select is((public.dish_costs('84000000-0000-4000-f000-000000000001') -> 0 ->> 'cost_per_portion_paise'), null,
  'staff see recipes without costs');
select throws_ok($$ select * from public.supplier_dues('84000000-0000-4000-f000-000000000001') $$, '42501', 'forbidden',
  'staff cannot see supplier dues (money)');
reset role;

-- ===========================================================================
-- M6 test 1: toor dal at 30 g per portion with a count of 100 deducts 3 kg.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((select (x ->> 'qty')::numeric from jsonb_array_elements(public.production_plan('84000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch') -> 'ingredients') x
           where x ->> 'item' = 'Toor dal'), 3.000, 'before the lock, the production plan already says 3 kg of dal');
select is((public.production_plan('84000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch') -> 'no_recipe'), '["Aloo bhaja"]'::jsonb,
  'and lists menu dishes without a recipe');
reset role;
select set_config('app.now', '2026-11-02 21:00:30+05:30', true);
select ok(private.lock_slot('84000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch') is not null, 'Tuesday lunch locks');
select is((select (totals ->> 'total_meals')::int from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000001'), 100,
  'the locked count is 100');
select is((select qty from public.stock_moves where item_id = (select id from ids where k = 'dal') and type = 'consume'), -3.000::numeric(12,3),
  'the lock deducts exactly 3 kg of toor dal');
select is(private.item_stock((select id from ids where k = 'dal')), 17.000::numeric(12,3), 'stock 20 kg → 17 kg');
select is((select qty from public.stock_moves where item_id = (select id from ids where k = 'oil') and type = 'consume'), -0.500::numeric(12,3),
  'and 0.5 l of oil (5 ml × 100)');
select is((select qty from public.stock_moves where item_id = (select id from ids where k = 'rice') and type = 'consume'), -12.000::numeric(12,3),
  'and 12 kg of rice');
select ok(private.lock_slot('84000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch') is not null, 'locking again...');
select is((select count(*) from public.stock_moves where item_id = (select id from ids where k = 'dal') and type = 'consume'), 1::bigint,
  '...deducts nothing twice');
select is((select unit_cost_paise from public.stock_moves where item_id = (select id from ids where k = 'dal') and type = 'consume'), 12000,
  'consumption is valued at the item''s cost (₹120/kg)');

-- Low stock: rice 50 → 38 kg is above the 10 kg minimum; dal at 5 kg minimum is fine too.
select is((select count(*) from public.notifications_outbox where template = 'stock_alert' and kitchen_id = '84000000-0000-4000-f000-000000000001'),
  0::bigint, 'no low-stock alert while above the minimum');

-- ===========================================================================
-- Purchases: price jump, supplier dues; wastage
-- ===========================================================================
select set_config('app.now', '2026-11-03 09:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
insert into ids values ('sup', public.upsert_supplier('84000000-0000-4000-f000-000000000001', 'Patia Kirana', '9437000999'));
insert into ids select 'p1', (public.record_purchase('84000000-0000-4000-f000-000000000001',
  jsonb_build_array(jsonb_build_object('item_id', (select id from ids where k = 'dal'), 'qty', 10, 'amount_paise', 150000),
                    jsonb_build_object('item_id', (select id from ids where k = 'rice'), 'qty', 25000, 'unit', 'g', 'amount_paise', 125000)),
  (select id from ids where k = 'sup'), p_bill_no => 'B-17', p_paid_now_paise => 100000) ->> 'purchase_id')::uuid;
reset role;
select is(private.item_stock((select id from ids where k = 'dal')), 27.000::numeric(12,3), 'buying 10 kg of dal: 17 → 27 kg');
select is(private.item_stock((select id from ids where k = 'rice')), 63.000::numeric(12,3), '25,000 g of rice is 25 kg: 38 → 63 kg');
select is((select price_jump_pct from public.purchase_lines where item_id = (select id from ids where k = 'dal')), 25.00::numeric(7,2),
  'dal at ₹150/kg after ₹120 is a 25% jump (over the 15% threshold)');
select is((select price_jump_pct from public.purchase_lines where item_id = (select id from ids where k = 'rice')), null::numeric,
  'rice at the same price is not flagged');
select is((select count(*) from public.notifications_outbox where template = 'stock_alert' and payload ->> 'kind' = 'price_jump'
           and kitchen_id = '84000000-0000-4000-f000-000000000001'), 1::bigint,
  'the owner is told about the price jump');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((select due_paise from public.supplier_dues('84000000-0000-4000-f000-000000000001')), 175000,
  'supplier dues: ₹2,750 bought − ₹1,000 paid = ₹1,750 on credit');
select lives_ok($$ select public.pay_supplier((select id from ids where k = 'sup'), 75000, 'upi_manual') $$, 'the owner pays ₹750');
select ok((public.dish_costs('84000000-0000-4000-f000-000000000001') -> 0 ->> 'cost_per_portion_paise')::int > 0, 'the owner sees cost per portion');
select is((public.record_purchase('84000000-0000-4000-f000-000000000001',
  jsonb_build_array(jsonb_build_object('item_id', (select id from ids where k = 'oil'), 'qty', 1, 'amount_paise', 30000))) -> 'price_jumps'),
  jsonb_build_array(jsonb_build_object('item', 'Mustard oil', 'pct', 66.67, 'from_paise', 18000, 'to_paise', 30000)),
  'a price jump comes back as one warning with the old and new price (owner)');
select is((select due_paise from public.supplier_dues('84000000-0000-4000-f000-000000000001')), 100000, '₹1,000 still due');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.record_purchase('84000000-0000-4000-f000-000000000001',
  jsonb_build_array(jsonb_build_object('item_id', (select id from ids where k = 'oil'), 'qty', 1, 'amount_paise', 18000)), (select id from ids where k = 'sup'),
  p_paid_now_paise => 18000) $$, '42501', 'forbidden', 'staff can record a bill but not pay the supplier');
select lives_ok($$ select public.record_purchase('84000000-0000-4000-f000-000000000001',
  jsonb_build_array(jsonb_build_object('item_id', (select id from ids where k = 'oil'), 'qty', 1, 'amount_paise', 18000)), (select id from ids where k = 'sup')) $$,
  'staff record a supplier bill');
select throws_ok($$ select public.record_waste((select id from ids where k = 'rice'), 2, '') $$, '22023', 'reason_required', 'wastage needs a reason');
select lives_ok($$ select public.record_waste((select id from ids where k = 'rice'), 2000, 'Rice burnt', 'g') $$, 'staff record 2 kg of burnt rice');
select throws_ok($$ select public.adjust_stock((select id from ids where k = 'rice'), 1, 'found a bag') $$, '42501', 'forbidden',
  'only the owner adjusts stock outside a stock-take');
reset role;
select is(private.item_stock((select id from ids where k = 'rice')), 61.000::numeric(12,3), 'wastage reduces stock: 63 → 61 kg');

-- ===========================================================================
-- M6 test 2: a stock-take 1 kg short shows as variance with a reason prompt.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
insert into ids values ('take', public.start_stock_take('84000000-0000-4000-f000-000000000001'));
select is(public.start_stock_take('84000000-0000-4000-f000-000000000001'), (select id from ids where k = 'take'), 'one open stock-take at a time');
create temp table cnt (v jsonb);
grant all on cnt to authenticated;
insert into cnt select public.set_stock_count((select id from ids where k = 'take'), (select id from ids where k = 'dal'), 26);
select is((select (v ->> 'variance')::numeric from cnt), -1.000, 'dal counted 26 kg against 27 kg expected: variance −1 kg');
select is((select (v ->> 'needs_reason')::boolean from cnt), true, 'the 1 kg shortfall asks for a reason');
select is((select (x ->> 'needs_reason')::boolean from jsonb_array_elements(public.stock_take_review((select id from ids where k = 'take')) -> 'lines') x
           where x ->> 'item' = 'Toor dal'), true, 'the review sheet shows it');
select lives_ok($$ select public.set_stock_count((select id from ids where k = 'take'), (select id from ids where k = 'rice'), 61000, 'g') $$,
  'rice counted exactly (in grams)');
select throws_ok($$ select public.close_stock_take((select id from ids where k = 'take')) $$, '22023', 'reason_required',
  'the count cannot be closed while the variance has no reason');
select lives_ok($$ select public.set_stock_count((select id from ids where k = 'take'), (select id from ids where k = 'dal'), 26, p_reason => 'Spilled while storing') $$,
  'staff give the reason');
select is((public.close_stock_take((select id from ids where k = 'take')) ->> 'adjustments')::int, 1, 'closing posts one adjustment (dal only)');
reset role;
select is(private.item_stock((select id from ids where k = 'dal')), 26.000::numeric(12,3), 'book stock now matches the count: 26 kg');
select is((select reason from public.stock_moves where type = 'count' and item_id = (select id from ids where k = 'dal')), 'Spilled while storing',
  'the variance is recorded with its reason');
select is((select count(*) from public.stock_moves where type = 'count' and item_id = (select id from ids where k = 'oil')), 0::bigint,
  'items not counted are left alone');
-- A small difference (under 2%) needs no reason.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
insert into ids values ('take2', public.start_stock_take('84000000-0000-4000-f000-000000000001'));
select is((public.set_stock_count((select id from ids where k = 'take2'), (select id from ids where k = 'rice'), 60.8) ->> 'needs_reason')::boolean,
  false, 'a 0.2 kg difference on 61 kg (0.3%) needs no reason');
select lives_ok($$ select public.close_stock_take((select id from ids where k = 'take2')) $$, 'and closes straight away');
-- Stock used after the count started (e.g. a slot lock) is not counted twice.
insert into ids values ('take3', public.start_stock_take('84000000-0000-4000-f000-000000000001'));
select lives_ok($$ select public.record_waste((select id from ids where k = 'rice'), 1, 'Spoiled') $$, 'rice is used while the count is open (60.8 → 59.8 kg)');
select is((public.set_stock_count((select id from ids where k = 'take3'), (select id from ids where k = 'rice'), 59.8) ->> 'variance')::numeric, 0.000,
  'counting 59.8 kg shows no variance: the baseline is the book stock when the item is counted');
select is((public.close_stock_take((select id from ids where k = 'take3')) ->> 'adjustments')::int, 0, 'so closing posts nothing');
select is((select stock from public.stock_levels('84000000-0000-4000-f000-000000000001') where name = 'Rice'), 59.800::numeric(12,3),
  'and book stock stays right');
insert into ids values ('take4', public.start_stock_take('84000000-0000-4000-f000-000000000001'));
select lives_ok($$ select public.cancel_stock_take((select id from ids where k = 'take4')) $$, 'an open count can be cancelled');
select ok((select count(*) from public.stock_takes where id = (select id from ids where k = 'take4')) = 0, 'leaving nothing behind');
select ok((select bool_and(unit_cost_paise is null and value_paise is null) from public.stock_levels('84000000-0000-4000-f000-000000000001')),
  'staff see stock levels without costs or values');
select throws_ok($$ select public.record_purchase('84000000-0000-4000-f000-000000000001',
  jsonb_build_array(jsonb_build_object('item_id', (select id from ids where k = 'oil'), 'qty', 'lots', 'amount_paise', 100))) $$,
  '22023', 'invalid_qty', 'a bad quantity gets a short error code');
reset role;

-- ===========================================================================
-- Alerts, costs, 10 pm summary
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.update_item((select id from ids where k = 'oil'), p_min_qty => 7) $$, 'owner raises the oil minimum to 7 l');
select ok(exists (select 1 from jsonb_array_elements(public.inventory_alerts('84000000-0000-4000-f000-000000000001')) x
                  where x ->> 'type' = 'low_stock' and x ->> 'item' = 'Mustard oil'), 'oil (6.5 l) shows as low stock');
select ok(exists (select 1 from jsonb_array_elements(public.inventory_alerts('84000000-0000-4000-f000-000000000001')) x
                  where x ->> 'type' = 'price_jump' and x ->> 'item' = 'Toor dal'), 'the dal price jump shows');
create temp table cost (v jsonb);
grant all on cost to authenticated;
insert into cost select public.cost_report('84000000-0000-4000-f000-000000000001', '2026-11-03', '2026-11-03');
select is((select (v ->> 'meals')::int from cost), 100, 'cost report: 100 meals');
select is((select (v ->> 'ingredients_paise')::int from cost), 3*12000 + 12*5000 + 9000, 'ingredients: dal ₹360 + rice ₹600 + oil ₹90');
select is((select (v ->> 'cost_per_meal_paise')::int from cost),
  round((3*12000 + 12*5000 + 9000 + 3*5000 + (15000 + 1000) + 100*800)::numeric / 100)::int,
  'cost per meal = (ingredients + 3 kg wasted rice + stock-take losses + gas ₹3 + packaging ₹5 per meal) / meals');
select is((select (v ->> 'stock_loss_paise')::int from cost), 16000, 'stock-take losses: 1 kg dal at ₹150 + 0.2 kg rice at ₹50');
select is((select (v ->> 'revenue_per_meal_paise')::int from cost), 7000, 'revenue per meal ₹70');
select ok((select (v ->> 'margin_pct')::numeric between 0 and 100 from cost), 'margin % is shown');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.cost_report('84000000-0000-4000-f000-000000000001', '2026-11-01', '2026-11-30') $$, '42501', 'forbidden',
  'staff cannot see costs and margins');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select * from public.stock_levels('84000000-0000-4000-f000-000000000001') $$, '42501', 'forbidden', 'riders see no inventory');
select is((select count(*) from public.items), 0::bigint, 'riders read no items through the API');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select is((select count(*) from public.stock_moves where kitchen_id = '84000000-0000-4000-f000-000000000001'), 0::bigint,
  'another kitchen''s owner sees none of this stock');
select throws_ok($$ select public.record_waste((select id from ids where k = 'rice'), 1, 'x') $$, '42501', 'forbidden',
  'and cannot record waste here');
reset role;
select throws_ok($$ update public.stock_moves set qty = 1 $$, 'P0001', null, 'the stock ledger is append-only');

select set_config('app.now', '2026-11-03 22:00:00+05:30', true);
insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, paid_at, created_at)
select '84000000-0000-4000-f000-000000000001', id, 'cash', 'paid', 70000, 10, private.now(), private.now()
from public.customers where kitchen_id = '84000000-0000-4000-f000-000000000001' limit 1;
select ok(private.queue_owner_summaries() >= 1, 'the 10 pm summary is queued');
select is((select payload -> 'low_stock' from public.notifications_outbox where template = 'owner_daily_summary'
           and kitchen_id = '84000000-0000-4000-f000-000000000001'), '["Mustard oil"]'::jsonb, 'it lists low stock');
select is((select (payload ->> 'collections_paise')::int from public.notifications_outbox where template = 'owner_daily_summary'
           and kitchen_id = '84000000-0000-4000-f000-000000000001'), 70000, 'and today''s collections');

select * from finish();
rollback;
