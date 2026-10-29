-- M5 tests: route order for 25 stops within 3 km, drag reorder persisting to the next day,
-- offline delivery synced later with its original timestamp, proof (OTP/photo), failed deliveries
-- (kitchen fault credits), tiffins, live board, rider stats and permissions per role.
-- Calendar: Mon 2 Nov 2026. Tuesday lunch locks Mon 21:00 IST, Wednesday lunch Tue 21:00.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen R in Patia (owner, staff, 2 riders); 25 lunch customers on a 1.5 km circle,
-- created in a shuffled order so the saved order can't come from insertion order.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(), now(), now()
from (values
  ('f1000000-0000-4000-f000-000000000001'::uuid, '919666000001'),
  ('f1000000-0000-4000-f000-000000000002'::uuid, '919666000002'),
  ('f1000000-0000-4000-f000-000000000003'::uuid, '919666000003'),
  ('f1000000-0000-4000-f000-000000000004'::uuid, '919666000004')
) as u(id, phone);
insert into public.kitchens (id, name, slug, owner_id, lat, lng, weekly_off) values
  ('81000000-0000-4000-f000-000000000001', 'Route Kitchen', 'route-kitchen', 'f1000000-0000-4000-f000-000000000001',
   20.3553, 85.8197, '{7}');
insert into public.kitchen_settings (kitchen_id) values ('81000000-0000-4000-f000-000000000001');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('81000000-0000-4000-f000-000000000001', 'f1000000-0000-4000-f000-000000000001', 'owner', 'Owner R'),
  ('81000000-0000-4000-f000-000000000001', 'f1000000-0000-4000-f000-000000000002', 'staff', 'Staff R'),
  ('81000000-0000-4000-f000-000000000001', 'f1000000-0000-4000-f000-000000000003', 'rider', 'Bikash Rider'),
  ('81000000-0000-4000-f000-000000000001', 'f1000000-0000-4000-f000-000000000004', 'rider', 'Second Rider');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('91000000-0000-4000-f000-000000000001', '81000000-0000-4000-f000-000000000001', 'Lunch', '{lunch}', '{1,2,3,4,5,6}', 7000);

select set_config('app.now', '2026-11-02 10:00:00+05:30', true);
create temp table c (n integer primary key, angle integer, cust uuid, sub uuid, addr uuid);
grant select on c to authenticated, anon;
do $$
declare i integer; a integer; v_c uuid; v_s uuid; v_a uuid;
begin
  for i in 1..25 loop
    a := (i * 7) % 25;  -- shuffled position on the circle
    v_c := private.insert_customer('81000000-0000-4000-f000-000000000001', 'Route Customer ' || i, '+91933300' || lpad(i::text, 4, '0'),
      'veg', 'en', null,
      jsonb_build_object('line1', 'Flat ' || i, 'area', 'Patia',
        'lat', 20.3553 + 0.013490 * cos(radians(a * 360.0 / 25)),
        'lng', 85.8197 + 0.014390 * sin(radians(a * 360.0 / 25))), 'vendor', 'vendor');
    select id into v_a from public.addresses where customer_id = v_c and is_default;
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values ('81000000-0000-4000-f000-000000000001', v_c, '91000000-0000-4000-f000-000000000001', v_a, '2026-11-03', 'active')
    returning id into v_s;
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
    values ('81000000-0000-4000-f000-000000000001', v_c, 'adjust', 20, 140000, 'test balance');
    insert into c values (i, a, v_c, v_s, v_a);
  end loop;
end $$;
update public.customers set whatsapp_opt_in = true where id in (select cust from c);

-- ===========================================================================
-- The optimiser on its own
-- ===========================================================================
-- Points on a circle around the start: the best open path walks around the circle.
create temp table t (k text primary key, v integer[]);
insert into t values ('circle', private.tsp_order(
  (select array_agg(20.3553 + 0.013490 * cos(radians(((g * 7) % 25) * 360.0 / 25)) order by g) from generate_series(1, 25) g),
  (select array_agg(85.8197 + 0.014390 * sin(radians(((g * 7) % 25) * 360.0 / 25)) order by g) from generate_series(1, 25) g),
  20.3553, 85.8197));
select is((select count(distinct x) from t, unnest(v) x where k = 'circle'), 25::bigint, 'tsp_order visits all 25 points once');
select ok((select bool_and(abs(d) = 1) or bool_and(abs(d) = 1 or abs(d) = 24) from (
  select (((v[i + 1] * 7) % 25) - ((v[i] * 7) % 25) + 25) % 25 as d0,
         case when (((v[i + 1] * 7) % 25) - ((v[i] * 7) % 25) + 25) % 25 = 1 then 1
              when (((v[i + 1] * 7) % 25) - ((v[i] * 7) % 25) + 25) % 25 = 24 then -1 else 0 end as d
  from t, generate_series(1, 24) i where k = 'circle') x), 'each next stop is a neighbour on the circle');
select is((select count(distinct d) from (
  select case when (((v[i + 1] * 7) % 25) - ((v[i] * 7) % 25) + 25) % 25 = 1 then 1 else -1 end as d
  from t, generate_series(1, 24) i where k = 'circle') x), 1::bigint, 'the path goes around the circle in one direction');

-- 25 scattered points within 3 km: far shorter than visiting them in the given order.
insert into t values ('rand', private.tsp_order(
  (select array_agg(20.3553 + 0.0269 * (('x' || substr(md5('lat' || g), 1, 6))::bit(24)::int / 16777215.0 - 0.5) * 1.4 order by g) from generate_series(1, 25) g),
  (select array_agg(85.8197 + 0.0288 * (('x' || substr(md5('lng' || g), 1, 6))::bit(24)::int / 16777215.0 - 0.5) * 1.4 order by g) from generate_series(1, 25) g),
  20.3553, 85.8197));
select ok((
  with p as (select g, 20.3553 + 0.0269 * (('x' || substr(md5('lat' || g), 1, 6))::bit(24)::int / 16777215.0 - 0.5) * 1.4 as lat,
                       85.8197 + 0.0288 * (('x' || substr(md5('lng' || g), 1, 6))::bit(24)::int / 16777215.0 - 0.5) * 1.4 as lng
             from generate_series(1, 25) g)
  select private.path_km((select array_agg(p.lat order by o.ord) from t, unnest(t.v) with ordinality o(g, ord) join p on p.g = o.g where t.k = 'rand'),
                         (select array_agg(p.lng order by o.ord) from t, unnest(t.v) with ordinality o(g, ord) join p on p.g = o.g where t.k = 'rand'),
                         20.3553, 85.8197)
       < 0.5 * private.path_km((select array_agg(lat order by g) from p), (select array_agg(lng order by g) from p), 20.3553, 85.8197)
), 'scattered stops: the optimised path is under half the unordered one');

-- ===========================================================================
-- M5 test 1: 25 stops within 3 km produce a sensible order...
-- ===========================================================================
select set_config('app.now', '2026-11-02 21:00:30+05:30', true);
select ok(private.lock_slot('81000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch') is not null, 'Tuesday lunch locks');
create temp table run (k text primary key, id uuid);
grant select, insert on run to authenticated, anon;
insert into run select 'tue', id from public.delivery_runs where kitchen_id = '81000000-0000-4000-f000-000000000001' and service_date = '2026-11-03';
select is((select count(*) from run where k = 'tue'), 1::bigint, 'the lock built one run (the kitchen had no routes: Route 1 was created)');
select is((select rider_id from public.delivery_runs where id = (select id from run where k = 'tue')), null::uuid,
  'two riders and no default: the run waits for a rider');
select is((select count(*) from public.delivery_stops where run_id = (select id from run where k = 'tue')), 25::bigint, '25 stops');
select is((select count(*) from public.meal_orders where service_date = '2026-11-03' and stop_id is not null
           and kitchen_id = '81000000-0000-4000-f000-000000000001'), 25::bigint, 'every order points at its stop');
select ok((select bool_and(private.km_between(20.3553, 85.8197, a.lat, a.lng) < 3)
           from public.delivery_stops s join public.addresses a on a.id = s.address_id where s.run_id = (select id from run where k = 'tue')),
  'all stops are within 3 km');
select is((select count(*) from (
  select (lead(c.angle) over (order by s.seq) - c.angle + 25) % 25 as d
  from public.delivery_stops s join c on c.cust = s.customer_id where s.run_id = (select id from run where k = 'tue')) x
  where d is not null and d not in (1, 24)), 0::bigint, 'sensible order: each stop is the next house around the circle');
select ok((select planned_km between 12 and 15 from public.delivery_runs where id = (select id from run where k = 'tue')),
  'planned km is about 1.5 km out + the circle, with the road factor');

-- Permissions on route editing.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.reorder_run((select id from run where k = 'tue'), '{}') $$, '42501', 'forbidden',
  'a rider cannot reorder runs');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.live_board('81000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch') $$, '42501', 'forbidden',
  'another kitchen''s owner cannot see the board');
select is((select count(*) from public.delivery_stops where kitchen_id = '81000000-0000-4000-f000-000000000001'), 0::bigint,
  'another kitchen''s owner sees no stops through the API');

-- ...and a drag reorder persists to the next day. Staff move the last stop to the front.
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.reorder_run((select id from run where k = 'tue'),
  (select array_agg(id order by seq) from public.delivery_stops where run_id = (select id from run where k = 'tue') and seq > 1)) $$,
  '22023', 'invalid_order', 'a reorder must list every stop exactly once');
select lives_ok($$ select public.reorder_run((select id from run where k = 'tue'),
  (select array_agg(id order by case when seq = 25 then 0 else seq end) from public.delivery_stops where run_id = (select id from run where k = 'tue'))) $$,
  'staff drag the last stop to the front');
reset role;
create temp table tue_order as
  select s.customer_id, s.seq from public.delivery_stops s where s.run_id = (select id from run where k = 'tue');
select is((select n from c where cust = (select customer_id from tue_order where seq = 1)),
          (select n from c join public.route_stops rs on rs.address_id = c.addr where rs.seq = 1 and rs.kitchen_id = '81000000-0000-4000-f000-000000000001'),
  'the saved route now starts with the dragged stop');
select is((select count(*) from public.meal_orders o join public.delivery_stops s on s.id = o.stop_id where o.stop_seq <> s.seq), 0::bigint,
  'meal_orders.stop_seq follows the new order');

-- A 26th customer joins Wednesday: inserted at the cheapest place, everyone else keeps their order.
do $$
declare v_c uuid; v_a uuid;
begin
  v_c := private.insert_customer('81000000-0000-4000-f000-000000000001', 'Route Customer 26', '+919333000026', 'veg', 'en', null,
    jsonb_build_object('line1', 'Flat 26', 'area', 'Patia', 'lat', 20.3553 + 0.0135, 'lng', 85.8197 + 0.0004), 'vendor', 'vendor');
  select id into v_a from public.addresses where customer_id = v_c and is_default;
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
  values ('81000000-0000-4000-f000-000000000001', v_c, '91000000-0000-4000-f000-000000000001', v_a, '2026-11-04', 'active');
  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
  values ('81000000-0000-4000-f000-000000000001', v_c, 'adjust', 20, 140000, 'test balance');
end $$;
select set_config('app.now', '2026-11-03 21:00:30+05:30', true);
select ok(private.lock_slot('81000000-0000-4000-f000-000000000001', '2026-11-04', 'lunch') is not null, 'Wednesday lunch locks');
insert into run select 'wed', id from public.delivery_runs where kitchen_id = '81000000-0000-4000-f000-000000000001' and service_date = '2026-11-04';
select is((select count(*) from public.delivery_stops where run_id = (select id from run where k = 'wed')), 26::bigint, 'Wednesday has 26 stops');
select is(
  (select array_agg(s.customer_id order by s.seq) from public.delivery_stops s
   where s.run_id = (select id from run where k = 'wed') and s.customer_id in (select customer_id from tue_order)),
  (select array_agg(customer_id order by seq) from tue_order),
  'drag reorder persisted: Wednesday keeps Tuesday''s hand-made order');
select is((select seq from public.delivery_stops s join public.customers cu on cu.id = s.customer_id
           where s.run_id = (select id from run where k = 'wed') and cu.name = 'Route Customer 26') between 2 and 26, true,
  'the new customer is placed among the stops, not forced to the front');

-- Saved route editor and the built-in optimiser.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is(jsonb_array_length(public.route_points((select route_id from public.delivery_runs where id = (select id from run where k = 'wed'))) -> 'stops'), 26,
  'route_points lists the saved order');
select ok((public.optimize_route((select route_id from public.delivery_runs where id = (select id from run where k = 'wed'))) ->> 'km_after')::numeric
          <= (select planned_km from public.delivery_runs where id = (select id from run where k = 'wed')) + 0.01,
  'optimize_route never makes the saved route longer than the hand-made one... ');
reset role;
select is((select count(*) from public.route_stops where pinned and kitchen_id = '81000000-0000-4000-f000-000000000001'), 0::bigint,
  '...and clears the hand-placed flags');

-- ===========================================================================
-- Dispatch: assign a rider, start the run, "on the way" messages
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.assign_run((select id from run where k = 'tue'), '00000000-0000-4000-a000-000000000013') $$,
  '22023', 'invalid_rider', 'only this kitchen''s riders can be assigned');
select lives_ok($$ select public.assign_run((select id from run where k = 'tue'), 'f1000000-0000-4000-f000-000000000003') $$,
  'owner assigns Bikash to Tuesday''s run');

select set_config('app.now', '2026-11-03 12:15:00+05:30', true);
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select throws_ok($$ select public.start_run((select id from run where k = 'tue')) $$, '42501', 'forbidden',
  'another rider of the same kitchen cannot start someone else''s run');
select is(public.rider_today(), '[]'::jsonb, 'the second rider has no runs today');
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
create temp table today (v jsonb);
grant all on today to authenticated;
insert into today select public.rider_today();
select is((select jsonb_array_length(v) from today), 1, 'the rider''s day has one run');
select is((select jsonb_array_length(v -> 0 -> 'stops') from today), 25, 'with 25 stops');
select ok((select bool_and(s ->> 'phone_masked' ~ '^XXXXXX[0-9]{4}$') from today, jsonb_array_elements(v -> 0 -> 'stops') s),
  'phones are masked for the rider');
select ok((select not (v::text ~ '\+91933300') from today), 'no full phone number in the rider payload');
select ok((select not (v::text ~ '"otp"') from today), 'no delivery codes in the rider payload');
select throws_ok($$ select otp from public.delivery_stops limit 1 $$, '42501', null, 'the OTP column is not readable');
select is((select count(*) from public.delivery_runs), 1::bigint, 'the rider sees only their own run through the API');
select is((select count(*) from public.delivery_stops), 25::bigint, 'and only its stops');
select lives_ok($$ select public.start_run((select id from run where k = 'tue')) $$, 'the rider starts the run');
reset role;
select is((select status::text from public.delivery_runs where id = (select id from run where k = 'tue')), 'out', 'run is out');
select is((select count(*) from public.notifications_outbox where template = 'on_the_way'
           and dedupe_key like 'on_the_way:%' and kitchen_id = '81000000-0000-4000-f000-000000000001'), 25::bigint,
  '25 "on the way" messages queued');
select ok((select bool_and(payload ->> 'otp' ~ '^[0-9]{4}$' and payload ->> 'rider_name' = 'Bikash')
           from public.notifications_outbox where template = 'on_the_way' and kitchen_id = '81000000-0000-4000-f000-000000000001'),
  'each carries the delivery code and the rider''s first name');
select is((select count(*) from public.meal_orders where run_id = (select id from run where k = 'tue') and status = 'out'), 25::bigint,
  'orders are out for delivery');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select lives_ok($$ select public.start_run((select id from run where k = 'tue')) $$, 'starting again is harmless (offline retry)');
reset role;
select is((select count(*) from public.notifications_outbox where template = 'on_the_way' and kitchen_id = '81000000-0000-4000-f000-000000000001'),
  25::bigint, 'no duplicate messages');

-- ===========================================================================
-- Proof of delivery (online)
-- ===========================================================================
create temp table st (seq integer primary key, id uuid, otp text, cust uuid);
grant select on st to authenticated;
insert into st select seq, id, otp, customer_id from public.delivery_stops where run_id = (select id from run where k = 'tue');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.complete_stop((select id from st where seq = 1), 'otp', p_otp => '99999') ->> 'otp_ok', 'false',
  'a wrong code online is rejected...');
select is((select status::text from public.delivery_stops where id = (select id from st where seq = 1)), 'pending', '...and the stop stays pending');
select is(public.complete_stop((select id from st where seq = 1), 'otp', p_otp => (select otp from st where seq = 1),
  p_lat => 20.3553, p_lng => 85.8197, p_tiffins_out => 1) ->> 'status', 'delivered', 'the right code delivers the stop');
select is((select otp_ok from public.delivery_stops where id = (select id from st where seq = 1)), true, 'OTP proof recorded');
select is((select done_at from public.delivery_stops where id = (select id from st where seq = 1)), '2026-11-03 12:15:00+05:30'::timestamptz,
  'done at the server time when online');
select throws_ok($$ select public.complete_stop((select id from st where seq = 2), 'photo') $$, '22023', 'photo_required',
  'photo proof needs a photo');
select throws_ok($$ select public.complete_stop((select id from st where seq = 2), 'photo',
  p_photo_path => '10000000-0000-4000-a000-00000000000b/x.jpg') $$, '22023', 'invalid_photo',
  'the photo must be in this kitchen''s folder');
reset role;
select is((select count(*) from public.meal_orders where stop_id = (select id from st where seq = 1) and status = 'delivered'), 1::bigint,
  'the meal order is delivered');

-- ===========================================================================
-- M5 test 2: a delivery marked offline syncs later with its original timestamp
-- ===========================================================================
select set_config('app.now', '2026-11-03 14:30:00+05:30', true);  -- back in network at 14:30
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.complete_stop((select id from st where seq = 2), 'photo',
  p_photo_path => '81000000-0000-4000-f000-000000000001/2026-11-03/stop2.jpg', p_lat => 20.36, p_lng => 85.82, p_accuracy => 12,
  p_at => '2026-11-03 12:41:00+05:30', p_tiffins_out => 1, p_tiffins_returned => 1, p_cash_paise => 70000,
  p_client_op => 'c0000000-0000-4000-f000-000000000002', p_offline => true) ->> 'status', 'delivered', 'the queued delivery syncs');
reset role;
select is((select done_at from public.delivery_stops where id = (select id from st where seq = 2)), '2026-11-03 12:41:00+05:30'::timestamptz,
  'it keeps the original 12:41 timestamp');
select is((select synced_at from public.delivery_stops where id = (select id from st where seq = 2)), '2026-11-03 14:30:00+05:30'::timestamptz,
  'and records when it reached the server');
select is((select offline from public.delivery_stops where id = (select id from st where seq = 2)), true, 'marked as an offline delivery');
select is((select created_at from public.tiffin_ledger where stop_id = (select id from st where seq = 2)), '2026-11-03 12:41:00+05:30'::timestamptz,
  'tiffin counts carry the original time');
select is((select created_at from public.payments where id = (select cash_payment_id from public.delivery_stops where id = (select id from st where seq = 2))),
  '2026-11-03 12:41:00+05:30'::timestamptz, 'cash at the door carries the original time');
select is((select status::text || '/' || method::text from public.payments where id = (select cash_payment_id from public.delivery_stops where id = (select id from st where seq = 2))),
  'pending/cash', 'rider cash waits for the owner to confirm');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.complete_stop((select id from st where seq = 2), 'photo',
  p_photo_path => '81000000-0000-4000-f000-000000000001/2026-11-03/stop2.jpg', p_at => '2026-11-03 12:41:00+05:30',
  p_tiffins_out => 1, p_tiffins_returned => 1, p_cash_paise => 70000,
  p_client_op => 'c0000000-0000-4000-f000-000000000002', p_offline => true) ->> 'conflict', 'false',
  'the same queued action sent twice is accepted once...');
select is(public.complete_stop((select id from st where seq = 2), 'none', p_client_op => 'c0000000-0000-4000-f000-000000000099') ->> 'conflict',
  'true', '...a different action on a finished stop is reported as a conflict');
-- An offline OTP can't be checked on the phone: recorded, flagged for review.
select is(public.complete_stop((select id from st where seq = 3), 'otp', p_otp => '0000x', p_at => '2026-11-03 12:50:00+05:30',
  p_client_op => 'c0000000-0000-4000-f000-000000000003', p_offline => true) ->> 'otp_ok', 'false', 'a wrong offline code is kept, flagged');
-- A phone with a clock in the future: clamped to the sync time, the raw value kept.
select is(public.complete_stop((select id from st where seq = 4), 'none', p_at => '2026-11-03 18:00:00+05:30',
  p_client_op => 'c0000000-0000-4000-f000-000000000004', p_offline => true) ->> 'status', 'delivered', 'future device time accepted');
reset role;
select is((select count(*) from public.payments where kitchen_id = '81000000-0000-4000-f000-000000000001' and method = 'cash'), 1::bigint,
  'no duplicate cash entry');
select is((select count(*) from public.tiffin_ledger where stop_id = (select id from st where seq = 2)), 1::bigint, 'no duplicate tiffin entry');
select is((select status::text from public.delivery_stops where id = (select id from st where seq = 3)), 'delivered', 'stop 3 delivered');
select is((select done_at::text || '|' || device_at::text from public.delivery_stops where id = (select id from st where seq = 4)),
  '2026-11-03 09:00:00+00|2026-11-03 12:30:00+00', 'clamped to the server time, device time kept');

-- ===========================================================================
-- Failed deliveries
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.fail_stop((select id from st where seq = 5), 'other') $$, '22023', 'note_required',
  '"other" needs a note');
select is(public.fail_stop((select id from st where seq = 5), 'not_home') ->> 'credit_entry_id', null, 'customer not home: no credit');
select ok((public.fail_stop((select id from st where seq = 6), 'food_issue', 'Dal spilled') ->> 'credit_entry_id') is not null,
  'kitchen fault: a credit entry is posted');
reset role;
select is((select meals || '/' || amount_paise from public.balance_entries
           where id = (select credit_entry_id from public.delivery_stops where id = (select id from st where seq = 6))),
  '1/7000', 'one meal back at the price it was charged');
select is((select sum(meals)::int from public.balance_entries where customer_id = (select cust from st where seq = 6)), 19,
  'the failed meal is given back (20 - 2 locked lunches + 1 credit)');
select is((select sum(meals)::int from public.balance_entries where customer_id = (select cust from st where seq = 5)), 18,
  'not-home: the meal stays charged');
select is((select count(*) from public.notifications_outbox where template = 'delivery_credit'
           and recipient_id = (select cust from st where seq = 6)), 1::bigint, 'the customer is told about the credit');
select is((select status::text from public.meal_orders where stop_id = (select id from st where seq = 6)), 'failed', 'the order is failed');
select ok(exists (select 1 from public.audit_log where table_name = 'delivery_stops' and row_id = (select id from st where seq = 6)::text
                  and action = 'UPDATE'), 'the failure is in the audit log');

-- ===========================================================================
-- Calls, tiffins, finishing, live board, stats
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.rider_call_number((select id from st where seq = 7)), '+919333000' || lpad((select n from c where cust = (select cust from st where seq = 7))::text, 3, '0'),
  'the rider can call a pending stop on a run that is out');
select throws_ok($$ select public.rider_call_number((select id from st where seq = 1)) $$, '42501', 'forbidden',
  'but not a stop already delivered');
select throws_ok($$ select public.finish_run((select id from run where k = 'tue')) $$, '22023', 'stops_pending',
  'a run with pending stops cannot be finished');
reset role;
select ok(exists (select 1 from public.audit_log where action = 'ACCESS' and after ->> 'reason' = 'rider_call'), 'calls are logged');

-- The rest of the stops delivered (seq 7..25) with photos.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is((select count(*) from st, lateral public.complete_stop(st.id, 'photo',
  p_photo_path => '81000000-0000-4000-f000-000000000001/2026-11-03/' || st.seq || '.jpg', p_tiffins_out => 1) r
  where st.seq >= 7 and r ->> 'status' = 'delivered'), 19::bigint, 'the remaining 19 stops are delivered');
select lives_ok($$ select public.finish_run((select id from run where k = 'tue')) $$, 'the run is finished');
select lives_ok($$ select public.rider_ping((select id from run where k = 'tue'), 20.36, 85.82) $$, 'a late ping is ignored');

select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
create temp table board (v jsonb);
grant all on board to authenticated;
insert into board select public.live_board('81000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch');
select is((select v -> 'runs' -> 0 -> 'counts' ->> 'delivered' from board), '23', 'staff live board: 23 delivered');
select is((select v -> 'runs' -> 0 -> 'counts' ->> 'failed' from board), '2', '2 failed');
select is((select v -> 'runs' -> 0 ->> 'status' from board), 'done', 'run done');
select ok((select bool_and(s -> 'cash_paise' = 'null'::jsonb) from board, jsonb_array_elements(v -> 'runs' -> 0 -> 'stops') s),
  'staff see no cash amounts');
select throws_ok($$ select * from public.rider_stats('81000000-0000-4000-f000-000000000001', '2026-11-01') $$, '42501', 'forbidden',
  'staff cannot see rider pay stats');
select is((select count(*) from public.tiffin_balances('81000000-0000-4000-f000-000000000001')), 20::bigint,
  '23 customers hold a tiffin (stop 2 returned one, stops 3-6 took none)');
select lives_ok($$ select public.record_tiffins((select cust from st where seq = 1), 0, 1, 'returned at the kitchen') $$,
  'staff record a tiffin returned at the kitchen');
select is((select count(*) from public.tiffin_balances('81000000-0000-4000-f000-000000000001')), 19::bigint, 'one fewer outstanding');

select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((select v -> 'runs' -> 0 -> 'stops' -> 1 ->> 'cash_paise' from (select public.live_board('81000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch') v) x),
  '70000', 'the owner sees cash collected on the board');
select is((select shifts || '/' || stops_delivered || '/' || stops_failed || '/' || cash_collected_paise
           from public.rider_stats('81000000-0000-4000-f000-000000000001', '2026-11-01')), '1/23/2/70000',
  'rider stats: 1 shift, 23 delivered, 2 failed, ₹700 cash');
select ok((select km > 0 and proof_rate between 90 and 100 from public.rider_stats('81000000-0000-4000-f000-000000000001', '2026-11-01')),
  'km and proof rate (21 of 23 proved: 2 had no proof or a bad code)');

select throws_ok($$ select public.record_tiffins((select cust from st where seq = 1), 0, 5) $$, '22023', 'too_many_returned',
  'cannot take back more tiffins than the customer holds');

-- ===========================================================================
-- Second route: moving a stop into a run that is already out; pausing every route
-- ===========================================================================
insert into run select 'wed_b', public.create_route('81000000-0000-4000-f000-000000000001', 'lunch', 'Route B',
  'f1000000-0000-4000-f000-000000000004');
reset role;
insert into public.delivery_runs (id, kitchen_id, route_id, service_date, slot, rider_id, status, started_at)
values ('82000000-0000-4000-f000-000000000001', '81000000-0000-4000-f000-000000000001', (select id from run where k = 'wed_b'),
        '2026-11-04', 'lunch', 'f1000000-0000-4000-f000-000000000004', 'out', now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.move_stop((select id from public.delivery_stops where run_id = (select id from run where k = 'wed') and seq = 1),
  '82000000-0000-4000-f000-000000000001') $$, 'owner moves a stop into a run that is already out');
reset role;
select ok((select otp ~ '^[0-9]{4}$' from public.delivery_stops where run_id = '82000000-0000-4000-f000-000000000001'),
  'the moved stop gets a delivery code');
select is((select count(*) from public.notifications_outbox where template = 'on_the_way'
           and dedupe_key like 'on_the_way:%:82000000-0000-4000-f000-000000000001'), 1::bigint, 'and its "on the way" message');
select is((select r.name from public.route_stops rs join public.delivery_routes r on r.id = rs.route_id
           join public.delivery_stops s on s.address_id = rs.address_id and rs.slot = 'lunch'
           where s.run_id = '82000000-0000-4000-f000-000000000001'), 'Route B', 'the address now belongs to Route B');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.update_route(id, p_active => false) from public.delivery_routes
  where kitchen_id = '81000000-0000-4000-f000-000000000001' and slot = 'lunch' $$, 'both lunch routes paused');
select lives_ok($$ select public.plan_runs('81000000-0000-4000-f000-000000000001', '2026-11-05', 'lunch') $$,
  'planning still works with every route paused...');
select is((select count(*) from public.delivery_routes where kitchen_id = '81000000-0000-4000-f000-000000000001' and name = 'Route 2' and active),
  1::bigint, '...a new "Route 2" is created instead of clashing with the paused "Route 1"');
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.assign_run((select id from run where k = 'wed'), 'f1000000-0000-4000-f000-000000000002') $$,
  '22023', 'invalid_rider', 'staff cannot be assigned as riders');

-- ===========================================================================
-- Other roles
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000013","role":"authenticated"}', true);
select throws_ok($$ select public.complete_stop((select id from st where seq = 1), 'none') $$, '42501', 'forbidden',
  'another kitchen''s rider cannot touch these stops');
select is((select count(*) from public.delivery_runs where kitchen_id = '81000000-0000-4000-f000-000000000001'), 0::bigint,
  'and cannot see these runs');
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ insert into public.tiffin_ledger (kitchen_id, customer_id, tiffins_out) values
  ('81000000-0000-4000-f000-000000000001', (select cust from st where seq = 1), 1) $$, '42501', null, 'no direct writes to the tiffin ledger');
select throws_ok($$ update public.delivery_stops set status = 'delivered' $$, '42501', null, 'no direct writes to stops');
reset role;
select throws_ok($$ update public.tiffin_ledger set tiffins_out = 5 $$, 'P0001', null, 'the tiffin ledger is append-only');

set local role anon;
select throws_ok($$ select public.rider_today() $$, '42501', null, 'anon cannot call rider RPCs');
select throws_ok($$ select count(*) from public.delivery_runs $$, '42501', null, 'anon cannot read runs');
reset role;

select * from finish();
rollback;
