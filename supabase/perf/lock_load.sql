-- M8 load test: the 21:00 lunch lock for 50 kitchens × 100 subscriptions (5,000) must finish in
-- under 60 seconds, including everything the lock now triggers: count snapshot, one meal entry per
-- order, delivery runs (route building) and ingredient consumption from recipes.
-- Runs in one transaction and rolls back. Run with `pnpm db:loadtest`.
\set ON_ERROR_STOP on
\timing off
begin;
set local client_min_messages = warning;

-- Service date: a Tuesday well in the future, so nothing in the seed is touched.
select set_config('app.now', '2027-03-08 18:00:00+05:30', true);

create temp table lt_k (n integer primary key, id uuid, plan uuid, lat double precision, lng double precision);

-- Bulk setup without per-row triggers (5,000 subscription triggers in one transaction exhaust the
-- lock table; real sign-ups are separate transactions). Orders are then generated per kitchen,
-- as the nightly job does. The lock itself runs with every trigger on.
set local session_replication_role = replica;

do $$
declare
  k integer;
  i integer;
  v_k uuid;
  v_owner uuid;
  v_plan uuid;
  v_c uuid;
  v_a uuid;
  v_dal uuid;
  v_rice uuid;
  v_veg uuid;
  v_oil uuid;
  v_atta uuid;
  v_d uuid;
  v_lat double precision;
  v_lng double precision;
  t0 timestamptz := clock_timestamp();
begin
  for k in 1..50 loop
    v_owner := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', v_owner, 'authenticated', 'authenticated', '9170000' || lpad(k::text, 5, '0'), now(), now(), now());
    v_lat := 20.25 + (k % 10) * 0.012;
    v_lng := 85.78 + (k / 10) * 0.015;
    insert into public.kitchens (name, slug, owner_id, lat, lng, capacity_lunch, capacity_dinner, weekly_off)
    values ('Load Kitchen ' || k, 'load-kitchen-' || k, v_owner, v_lat, v_lng, 200, 200, '{}')
    returning id into v_k;
    insert into public.kitchen_settings (kitchen_id) values (v_k);
    insert into public.members (kitchen_id, user_id, role) values (v_k, v_owner, 'owner');
    insert into public.plans (kitchen_id, name, slots, days_of_week, price_per_meal_paise)
    values (v_k, 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 7000) returning id into v_plan;
    insert into lt_k values (k, v_k, v_plan, v_lat, v_lng);

    -- Inventory: 5 items, 3 dishes with recipes, and the menu for the locked day.
    insert into public.items (kitchen_id, name, unit, last_price_paise) values (v_k, 'Toor dal', 'kg', 12000) returning id into v_dal;
    insert into public.items (kitchen_id, name, unit, last_price_paise) values (v_k, 'Rice', 'kg', 5000) returning id into v_rice;
    insert into public.items (kitchen_id, name, unit, last_price_paise) values (v_k, 'Vegetables', 'kg', 4000) returning id into v_veg;
    insert into public.items (kitchen_id, name, unit, last_price_paise) values (v_k, 'Oil', 'l', 17000) returning id into v_oil;
    insert into public.items (kitchen_id, name, unit, last_price_paise) values (v_k, 'Atta', 'kg', 3800) returning id into v_atta;
    insert into public.stock_moves (kitchen_id, item_id, type, qty, reason)
    select v_k, x, 'adjust', 100, 'Opening' from unnest(array[v_dal, v_rice, v_veg, v_oil, v_atta]) x;
    insert into public.dishes (kitchen_id, name) values (v_k, 'Dal') returning id into v_d;
    insert into public.recipe_lines (kitchen_id, dish_id, item_id, qty_per_portion) values (v_k, v_d, v_dal, 0.03), (v_k, v_d, v_oil, 0.004);
    insert into public.dishes (kitchen_id, name) values (v_k, 'Rice') returning id into v_d;
    insert into public.recipe_lines (kitchen_id, dish_id, item_id, qty_per_portion) values (v_k, v_d, v_rice, 0.12);
    insert into public.dishes (kitchen_id, name) values (v_k, 'Sabzi') returning id into v_d;
    insert into public.recipe_lines (kitchen_id, dish_id, item_id, qty_per_portion) values (v_k, v_d, v_veg, 0.1), (v_k, v_d, v_oil, 0.005);
    insert into public.menus (kitchen_id, service_date, slot, dishes, published)
    values (v_k, '2027-03-09', 'lunch', '{Dal,Rice,Sabzi,Roti}', true), (v_k, '2027-03-10', 'lunch', '{Dal,Rice,Sabzi}', true);

    for i in 1..100 loop
      v_c := private.insert_customer(v_k, 'Load ' || k || '-' || i, '+9171' || lpad((k * 1000 + i)::text, 8, '0'), 'veg', 'en', null,
        jsonb_build_object('line1', 'Flat ' || i, 'lat', v_lat + (random() - 0.5) * 0.04, 'lng', v_lng + (random() - 0.5) * 0.04),
        'vendor', 'vendor');
      select id into v_a from public.addresses where customer_id = v_c;
      insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
      values (v_k, v_c, v_plan, v_a, '2027-03-09', 'active');
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
      values (v_k, v_c, 'adjust', 30, 210000, 'load test');
    end loop;
  end loop;
  raise warning 'setup: 50 kitchens, 5,000 subscriptions in % s', round(extract(epoch from clock_timestamp() - t0)::numeric, 1);
end $$;

set local session_replication_role = origin;
do $$
declare r record; t0 timestamptz := clock_timestamp();
begin
  for r in select id from lt_k order by n loop
    perform private.refresh_orders(r.id, null, 2);
  end loop;
  raise warning 'orders generated in % s', round(extract(epoch from clock_timestamp() - t0)::numeric, 1);
end $$;

-- Orders exist for the locked day.
select count(*) as orders_for_tuesday_lunch from public.meal_orders o join lt_k on lt_k.id = o.kitchen_id
where o.service_date = '2027-03-09' and o.slot = 'lunch';

-- 21:00: lock every kitchen's lunch, as private.run_due_locks() would.
select set_config('app.now', '2027-03-08 21:00:30+05:30', true);
create temp table lt_result (seconds numeric);
do $$
declare
  t0 timestamptz := clock_timestamp();
  r record;
begin
  for r in select id from lt_k order by n loop
    perform private.lock_slot(r.id, '2027-03-09', 'lunch');
  end loop;
  insert into lt_result values (round(extract(epoch from clock_timestamp() - t0)::numeric, 2));
end $$;

select (select seconds from lt_result) as lock_seconds,
       (select count(*) from public.count_snapshots cs join lt_k on lt_k.id = cs.kitchen_id) as snapshots,
       (select count(*) from public.balance_entries b join lt_k on lt_k.id = b.kitchen_id where b.type = 'meal') as meal_entries,
       (select count(*) from public.delivery_stops s join lt_k on lt_k.id = s.kitchen_id) as delivery_stops,
       (select count(*) from public.stock_moves m join lt_k on lt_k.id = m.kitchen_id where m.type = 'consume') as consume_moves;

do $$
begin
  if (select seconds from lt_result) >= 60 then
    raise exception 'LOAD TEST FAILED: lock took % s (limit 60 s)', (select seconds from lt_result);
  end if;
  if (select count(*) from public.balance_entries b join lt_k on lt_k.id = b.kitchen_id where b.type = 'meal') <> 5000 then
    raise exception 'LOAD TEST FAILED: expected 5000 meal entries';
  end if;
  raise warning 'LOAD TEST PASSED: 5,000-subscription lock in % s', (select seconds from lt_result);
end $$;

-- A normal day: routes already exist, so the lock only re-syncs runs. Orders for it come from
-- the 00:30 nightly generation.
select set_config('app.now', '2027-03-09 00:30:00+05:30', true);
do $$
declare r record;
begin
  for r in select id from lt_k order by n loop
    perform private.refresh_orders(r.id, null, 2);
  end loop;
end $$;
select count(*) as orders_for_wednesday_lunch from public.meal_orders o join lt_k on lt_k.id = o.kitchen_id
where o.service_date = '2027-03-10' and o.slot = 'lunch';
select set_config('app.now', '2027-03-09 21:00:30+05:30', true);
create temp table lt_result2 (seconds numeric);
do $$
declare
  t0 timestamptz := clock_timestamp();
  r record;
begin
  for r in select id from lt_k order by n loop
    perform private.lock_slot(r.id, '2027-03-10', 'lunch');
  end loop;
  insert into lt_result2 values (round(extract(epoch from clock_timestamp() - t0)::numeric, 2));
  raise warning 'second day (routes already saved): 5,000-subscription lock in % s, % meal entries', (select seconds from lt_result2),
    (select count(*) from public.balance_entries b join lt_k on lt_k.id = b.kitchen_id where b.type = 'meal');
end $$;

rollback;
