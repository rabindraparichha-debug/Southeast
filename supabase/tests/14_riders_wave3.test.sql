-- Vendor-first wave 3, riders track (audit items 25, 26 rest, 29):
-- default rider (owner fallback), unassigned runs, routes by area (180 imported customers into 3
-- routes), the import Route column, kitchen-fault credits waiting for the owner, correcting a stop,
-- cash handover, push devices / push outbox / in-app list, and the minimum app version.
-- Calendar: Mon 9 Nov 2026 setup; Tuesday 10 Nov lunch locks Mon 21:00 IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen S (owner only) and kitchen W (owner, staff, two riders); a user with no kitchen.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(), now(), now()
from (values
  ('f3000000-0000-4000-f000-000000000001'::uuid, '919777000001'),  -- owner S
  ('f3000000-0000-4000-f000-000000000002'::uuid, '919777000002'),  -- owner W
  ('f3000000-0000-4000-f000-000000000003'::uuid, '919777000003'),  -- staff W
  ('f3000000-0000-4000-f000-000000000004'::uuid, '919777000004'),  -- rider W (Bikash)
  ('f3000000-0000-4000-f000-000000000005'::uuid, '919777000005'),  -- rider W (Second)
  ('f3000000-0000-4000-f000-000000000006'::uuid, '919777000006')   -- signed in, no kitchen
) as u(id, phone);
insert into public.kitchens (id, name, slug, owner_id, lat, lng, weekly_off) values
  ('83000000-0000-4000-f000-000000000001', 'Solo Kitchen', 'solo-kitchen-w3', 'f3000000-0000-4000-f000-000000000001', 20.3553, 85.8197, '{}'),
  ('83000000-0000-4000-f000-000000000002', 'Wide Kitchen', 'wide-kitchen-w3', 'f3000000-0000-4000-f000-000000000002', 20.2961, 85.8245, '{}');
insert into public.kitchen_settings (kitchen_id) values
  ('83000000-0000-4000-f000-000000000001'), ('83000000-0000-4000-f000-000000000002');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('83000000-0000-4000-f000-000000000001', 'f3000000-0000-4000-f000-000000000001', 'owner', 'Sujata'),
  ('83000000-0000-4000-f000-000000000002', 'f3000000-0000-4000-f000-000000000002', 'owner', 'Ramesh'),
  ('83000000-0000-4000-f000-000000000002', 'f3000000-0000-4000-f000-000000000003', 'staff', 'Staff W'),
  ('83000000-0000-4000-f000-000000000002', 'f3000000-0000-4000-f000-000000000004', 'rider', 'Bikash'),
  ('83000000-0000-4000-f000-000000000002', 'f3000000-0000-4000-f000-000000000005', 'rider', 'Second');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('93000000-0000-4000-f000-000000000001', '83000000-0000-4000-f000-000000000001', 'Thali', '{lunch}', '{1,2,3,4,5,6,7}', 5000),
  ('93000000-0000-4000-f000-000000000002', '83000000-0000-4000-f000-000000000002', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 6000);

select set_config('app.now', '2026-11-09 10:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated, anon, service_role;

-- Kitchen S: two customers, no rider.
do $$
declare v_c uuid; v_a uuid; i integer;
begin
  for i in 1..2 loop
    v_c := private.insert_customer('83000000-0000-4000-f000-000000000001', 'Solo Customer ' || i, '+91944400000' || i, 'veg', 'en', null,
      jsonb_build_object('line1', 'House ' || i, 'area', 'Patia'), 'vendor', 'vendor');
    select id into v_a from public.addresses where customer_id = v_c and is_default;
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values ('83000000-0000-4000-f000-000000000001', v_c, '93000000-0000-4000-f000-000000000001', v_a, '2026-11-10', 'active');
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
    values ('83000000-0000-4000-f000-000000000001', v_c, 'adjust', 20, 100000, 'test balance');
  end loop;
end $$;

-- ===========================================================================
-- 1. Default rider: a kitchen with no rider gives its runs to the owner
-- ===========================================================================
select is(private.default_rider('83000000-0000-4000-f000-000000000001'), 'f3000000-0000-4000-f000-000000000001'::uuid,
  'no rider: the default rider is the owner');
select is(private.default_rider('83000000-0000-4000-f000-000000000002'), null::uuid, 'two riders: no default rider');

select set_config('app.now', '2026-11-09 21:00:30+05:30', true);
select ok(private.lock_slot('83000000-0000-4000-f000-000000000001', '2026-11-10', 'lunch') is not null, 'kitchen S locks Tuesday lunch');
select is((select rider_id from public.delivery_runs where kitchen_id = '83000000-0000-4000-f000-000000000001' and service_date = '2026-11-10'),
  'f3000000-0000-4000-f000-000000000001'::uuid, 'the run built at lock is the owner''s');
select is((select rider_id from public.delivery_routes where kitchen_id = '83000000-0000-4000-f000-000000000001'),
  'f3000000-0000-4000-f000-000000000001'::uuid, 'and so is the new route');

select set_config('app.now', '2026-11-10 11:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is(jsonb_array_length(public.rider_today()), 1, 'the owner who delivers sees the run in rider mode');
select is(jsonb_array_length(public.rider_today() -> 0 -> 'stops'), 2, 'with both stops');
select is(public.unassigned_runs(), '[]'::jsonb, 'nothing is left unassigned');
reset role;

-- ===========================================================================
-- 2. Import with a Route column; 180 customers split by area into 3 routes
-- ===========================================================================
select set_config('app.now', '2026-11-09 10:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
create temp table imp (r jsonb);
grant all on imp to authenticated;
insert into imp select public.import_customers('83000000-0000-4000-f000-000000000002',
  (select jsonb_agg(jsonb_build_object(
     'name', 'Wide Customer ' || i, 'phone', '97000' || lpad(i::text, 5, '0'),
     'area', (array['Patia', 'Saheed Nagar', 'Jaydev Vihar'])[1 + (i % 3)],
     'line1', 'Flat ' || i, 'plan', 'Lunch', 'start_date', '2026-11-10', 'balance', '20',
     'route', case when i <= 3 then 'Express' end) order by i)
   from generate_series(1, 180) i),
  true, 'wide.xlsx');
reset role;
select is((select (r ->> 'imported')::int from imp), 180, '180 customers imported');
select is((select count(*) from public.route_stops rs join public.delivery_routes r on r.id = rs.route_id
           where r.kitchen_id = '83000000-0000-4000-f000-000000000002' and r.name = 'Express' and r.slot = 'lunch'), 3::bigint,
  'the Route column placed 3 customers on route "Express" (created by the import)');
select is((select count(*) from public.delivery_routes where kitchen_id = '83000000-0000-4000-f000-000000000002' and name = 'Express'),
  1::bigint, 'only for the plan''s slot (lunch)');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is((select jsonb_agg(jsonb_build_object(a ->> 'area', (a ->> 'addresses')::int) order by a ->> 'area')
           from jsonb_array_elements(public.area_routes('83000000-0000-4000-f000-000000000002', 'lunch') -> 'areas') a),
  '[{"Jaydev Vihar": 60}, {"Patia": 60}, {"Saheed Nagar": 60}]'::jsonb, 'staff see three areas of 60 addresses each');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select throws_ok($$ select public.area_routes('83000000-0000-4000-f000-000000000002', 'lunch') $$, '42501', 'forbidden',
  'a rider cannot see the area overview');
select throws_ok($$ select public.assign_routes_by_area('83000000-0000-4000-f000-000000000002', 'lunch', '[{"area":"Patia","route":"X"}]') $$,
  '42501', 'forbidden', 'a rider cannot assign routes');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.assign_routes_by_area('83000000-0000-4000-f000-000000000002', 'lunch', '[{"area":"Patia","route":"X"}]') $$,
  '42501', 'forbidden', 'another kitchen''s owner cannot assign routes');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.assign_routes_by_area('83000000-0000-4000-f000-000000000002', 'lunch', '[{"route":"X"}]') $$,
  '22023', 'invalid_rules', 'a rule needs an area');
select throws_ok($$ select public.assign_routes_by_area('83000000-0000-4000-f000-000000000002', 'lunch',
  '[{"area":"Patia","route":"X","rider_id":"00000000-0000-4000-a000-000000000013"}]') $$,
  '22023', 'invalid_rider', 'only this kitchen''s riders');

create temp table plan (k text primary key, r jsonb);
grant all on plan to authenticated;
insert into plan select 'dry', public.assign_routes_by_area('83000000-0000-4000-f000-000000000002', 'lunch',
  '[{"area":"patia ","route":"North","rider_id":"f3000000-0000-4000-f000-000000000004"},
    {"area":"Saheed  Nagar","route":"South"},{"area":"Jaydev Vihar","route":"East"}]', true);
select is((select jsonb_agg((x ->> 'addresses')::int order by x ->> 'route') from jsonb_array_elements((select r from plan where k = 'dry') -> 'rules') x),
  '[60, 60, 60]'::jsonb, 'dry run: 60 addresses per rule (area matched ignoring case and spaces)');
select is((select count(*) from public.delivery_routes where kitchen_id = '83000000-0000-4000-f000-000000000002' and name in ('North', 'South', 'East')),
  0::bigint, 'dry run writes nothing');

insert into plan select 'real', public.assign_routes_by_area('83000000-0000-4000-f000-000000000002', 'lunch',
  '[{"area":"patia ","route":"North","rider_id":"f3000000-0000-4000-f000-000000000004"},
    {"area":"Saheed  Nagar","route":"South"},{"area":"Jaydev Vihar","route":"East"}]');
reset role;
select is((select jsonb_object_agg(r.name, (select count(*) from public.route_stops rs where rs.route_id = r.id))
           from public.delivery_routes r where r.kitchen_id = '83000000-0000-4000-f000-000000000002' and r.slot = 'lunch'),
  '{"East": 60, "North": 60, "South": 60, "Express": 0}'::jsonb, 'three routes of 60 addresses; Express is emptied');
select is((select rider_id from public.delivery_routes where kitchen_id = '83000000-0000-4000-f000-000000000002' and name = 'North'),
  'f3000000-0000-4000-f000-000000000004'::uuid, 'North gets Bikash as its rider');
select is((select count(*) from public.delivery_routes where kitchen_id = '83000000-0000-4000-f000-000000000002' and name in ('South', 'East')
           and rider_id is null), 2::bigint, 'two riders: the other new routes wait for a rider');
select is((select count(distinct (rs.seq)) from public.route_stops rs join public.delivery_routes r on r.id = rs.route_id
           where r.kitchen_id = '83000000-0000-4000-f000-000000000002' and r.name = 'North'), 60::bigint, 'the route order is renumbered');

select set_config('app.now', '2026-11-09 21:00:30+05:30', true);
select ok(private.lock_slot('83000000-0000-4000-f000-000000000002', '2026-11-10', 'lunch') is not null, 'kitchen W locks Tuesday lunch');
select is((select jsonb_object_agg(rt.name, (select count(*) from public.delivery_stops s where s.run_id = dr.id))
           from public.delivery_runs dr join public.delivery_routes rt on rt.id = dr.route_id
           where dr.kitchen_id = '83000000-0000-4000-f000-000000000002' and dr.service_date = '2026-11-10'),
  '{"East": 60, "North": 60, "South": 60}'::jsonb, '180 imported customers are split by area into 3 runs');
insert into ids select 'north', dr.id from public.delivery_runs dr join public.delivery_routes rt on rt.id = dr.route_id
  where dr.kitchen_id = '83000000-0000-4000-f000-000000000002' and rt.name = 'North';
insert into ids select 'south', dr.id from public.delivery_runs dr join public.delivery_routes rt on rt.id = dr.route_id
  where dr.kitchen_id = '83000000-0000-4000-f000-000000000002' and rt.name = 'South';
insert into ids select 's' || s.seq, s.id from public.delivery_stops s where s.run_id = (select v from ids where k = 'north') and s.seq <= 9;

-- Moving an area after the lock resyncs planned runs right away.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((public.assign_routes_by_area('83000000-0000-4000-f000-000000000002', 'lunch', '[{"area":"Jaydev Vihar","route":"South"}]')
           ->> 'rebuilt_slots')::int, 1, 'after the lock, the locked slot is rebuilt');
reset role;
select is((select count(*) from public.delivery_stops where run_id = (select v from ids where k = 'south')), 120::bigint,
  'South now carries Jaydev Vihar too');
select is((select count(*) from public.delivery_runs dr join public.delivery_routes rt on rt.id = dr.route_id
           where dr.kitchen_id = '83000000-0000-4000-f000-000000000002' and rt.name = 'East'), 0::bigint, 'the empty East run is removed');

-- ===========================================================================
-- 3. Unassigned runs: owners only
-- ===========================================================================
select set_config('app.now', '2026-11-10 11:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((select jsonb_agg(x ->> 'route_name') from jsonb_array_elements(public.unassigned_runs()) x
           where x ->> 'kitchen_id' = '83000000-0000-4000-f000-000000000002'), '["South"]'::jsonb,
  'the owner sees today''s run that has no rider');
select is((select (x ->> 'stops')::int from jsonb_array_elements(public.unassigned_runs()) x
           where x ->> 'kitchen_id' = '83000000-0000-4000-f000-000000000002'), 120, 'with its stop count');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.unassigned_runs(), '[]'::jsonb, 'staff do not');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000005","role":"authenticated"}', true);
select is(public.unassigned_runs(), '[]'::jsonb, 'riders do not');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select is((select count(*) from jsonb_array_elements(public.unassigned_runs()) x
           where x ->> 'kitchen_id' = '83000000-0000-4000-f000-000000000002'), 0::bigint, 'another kitchen''s owner does not');
-- "Take this run": the owner assigns it to themselves with the existing assign_run.
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select lives_ok($$ select public.assign_run((select v from ids where k = 'south'), 'f3000000-0000-4000-f000-000000000002') $$,
  'the owner takes the run');
select is((select count(*) from jsonb_array_elements(public.rider_today()) x where x ->> 'route_name' = 'South'), 1::bigint,
  'and finds it in rider mode');
reset role;
set local role anon;
select throws_ok($$ select public.unassigned_runs() $$, '42501', null, 'anon cannot call unassigned_runs');
reset role;

-- ===========================================================================
-- 4. Push devices (registered before the alerts below)
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select ok(public.register_device('ExponentPushToken[owner-w-device-1]', 'android', '1.0.0', 'Pixel') is not null, 'the owner registers a phone');
select ok(public.register_device('ExponentPushToken[owner-w-device-1]', 'android', '1.0.1', 'Pixel') is not null,
  'registering again only refreshes it');
select is((select count(*) from public.member_devices), 1::bigint, 'one device row, visible to its owner');
select throws_ok($$ select public.register_device('not-a-token', 'android') $$, '22023', 'invalid_token', 'tokens are checked');
select throws_ok($$ select public.register_device('ExponentPushToken[owner-w-device-2]', 'symbian') $$, '22023', 'invalid_platform',
  'platforms are checked');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select is((select count(*) from public.member_devices), 0::bigint, 'another person sees no device rows');
select lives_ok($$ select public.register_device('ExpoPushToken[rider-w-device-1]', 'android') $$, 'a rider can register too');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000006","role":"authenticated"}', true);
select throws_ok($$ select public.register_device('ExponentPushToken[nobody-device-1]', 'ios') $$, '42501', 'forbidden',
  'someone with no kitchen cannot register');
reset role;
set local role anon;
select throws_ok($$ select public.register_device('ExponentPushToken[anon-device-1]', 'ios') $$, '42501', null, 'anon cannot register');
reset role;

-- ===========================================================================
-- 5. Kitchen-fault credits recorded by a rider wait for the owner
-- ===========================================================================
select set_config('app.now', '2026-11-10 12:30:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select is(public.fail_stop((select v from ids where k = 's1'), 'kitchen_late') ->> 'credit_entry_id', null,
  'a rider''s kitchen-fault failure posts no credit by itself');
select is(public.fail_stop((select v from ids where k = 's2'), 'not_home') ->> 'status', 'failed', 'a customer-side failure');
select is(public.fail_stop((select v from ids where k = 's3'), 'food_issue', 'Dal spilled') ->> 'status', 'failed', 'another kitchen fault');
select is((select credit_status from public.delivery_stops where id = (select v from ids where k = 's1')), 'pending',
  'the rider sees the credit is waiting for the owner');
select throws_ok($$ select public.decide_stop_credit((select v from ids where k = 's1'), true) $$, '42501', 'forbidden',
  'a rider cannot approve credits');
select throws_ok($$ select public.stop_credit_requests('83000000-0000-4000-f000-000000000002') $$, '42501', 'forbidden',
  'a rider cannot list credit requests');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.decide_stop_credit((select v from ids where k = 's1'), true) $$, '42501', 'forbidden',
  'staff cannot approve credits');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.decide_stop_credit((select v from ids where k = 's1'), true) $$, '42501', 'forbidden',
  'another kitchen''s owner cannot approve credits');
reset role;
select is((select credit_status from public.delivery_stops where id = (select v from ids where k = 's2')), null,
  'not home: nothing to approve');
select is((select count(*) from public.balance_entries where type = 'credit' and ref_id in
           ((select v from ids where k = 's1'), (select v from ids where k = 's3'))), 0::bigint, 'no credit yet');
select is((select count(*) from public.notifications_outbox where template = 'stop_credit_request' and channel = 'push'
           and recipient_id = 'f3000000-0000-4000-f000-000000000002'), 2::bigint, 'the owner gets an app alert for each request');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((select jsonb_agg(x ->> 'reason' order by x ->> 'reason') from jsonb_array_elements(
             public.stop_credit_requests('83000000-0000-4000-f000-000000000002')) x), '["food_issue", "kitchen_late"]'::jsonb,
  'the owner lists both requests');
select is((select (x ->> 'meals')::int || '/' || (x ->> 'amount_paise') || '/' || (x ->> 'rider_name') from jsonb_array_elements(
             public.stop_credit_requests('83000000-0000-4000-f000-000000000002')) x where x ->> 'reason' = 'kitchen_late'),
  '1/6000/Bikash', 'with the meals, their value and who asked');
select is(public.decide_stop_credit((select v from ids where k = 's1'), true, 'kitchen was late') ->> 'credit_status', 'approved',
  'the owner approves');
select throws_ok($$ select public.decide_stop_credit((select v from ids where k = 's1'), true) $$, '22023', 'not_pending',
  'a decided request cannot be decided again');
select is(public.decide_stop_credit((select v from ids where k = 's3'), false, 'spill was the customer''s') ->> 'credit_status', 'rejected',
  'the owner rejects the other');
-- The owner's own kitchen-fault failure credits at once.
select is((public.fail_stop((select v from ids where k = 's4'), 'missing_meal') ->> 'credit_entry_id') is not null, true,
  'an owner''s own kitchen-fault failure credits at once');
reset role;
select is((select meals || '/' || amount_paise || '/' || ref_type from public.balance_entries
           where id = (select credit_entry_id from public.delivery_stops where id = (select v from ids where k = 's1'))),
  '1/6000/delivery_stop', 'the approved credit gives one meal back at the charged price');
select is((select count(*) from public.balance_entries where type = 'credit' and ref_id = (select v from ids where k = 's3')),
  0::bigint, 'the rejected one posts nothing');
select is((select credit_status from public.delivery_stops where id = (select v from ids where k = 's4')), 'approved',
  'an owner failure is approved by definition');
select is((select count(*) from public.notifications_outbox where template = 'delivery_credit'
           and dedupe_key = 'delivery_credit:' || (select v from ids where k = 's1')), 1::bigint, 'the customer is told once');

-- ===========================================================================
-- 6. Owner corrects a recorded outcome
-- ===========================================================================
create temp table bal (k text primary key, v integer);
grant all on bal to authenticated;
insert into bal select 's1', sum(meals) from public.balance_entries
  where customer_id = (select customer_id from public.delivery_stops where id = (select v from ids where k = 's1'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select throws_ok($$ select public.correct_stop((select v from ids where k = 's1'), 'delivered', null, 'it arrived') $$, '42501', 'forbidden',
  'a rider cannot correct outcomes');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.correct_stop((select v from ids where k = 's1'), 'delivered', null, 'it arrived') $$, '42501', 'forbidden',
  'staff cannot correct outcomes');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.correct_stop((select v from ids where k = 's1'), 'delivered') $$, '22023', 'note_required',
  'a correction needs a note');
select throws_ok($$ select public.correct_stop((select v from ids where k = 's9'), 'delivered', null, 'x') $$, '22023', 'not_recorded',
  'a pending stop is not corrected (use the rider actions)');
select throws_ok($$ select public.correct_stop((select v from ids where k = 's2'), 'failed', null, 'x') $$, '22023', 'reason_required',
  'failed needs a reason');
-- Mis-tap: it was delivered after all. The credit is taken back.
select is(public.correct_stop((select v from ids where k = 's1'), 'delivered', null, 'customer called: tiffin arrived') ->> 'status',
  'delivered', 'failed → delivered');
reset role;
select is((select sum(meals)::int from public.balance_entries
           where customer_id = (select customer_id from public.delivery_stops where id = (select v from ids where k = 's1'))),
  (select v - 1 from bal where k = 's1'), 'the credit is reversed with an adjust row');
select is((select count(*) from public.balance_entries where type = 'adjust' and ref_type = 'stop_credit_reversal'), 1::bigint,
  'one reversal row (the ledger is never edited)');
select is((select status::text || '/' || proof_type::text || '/' || coalesce(credit_status, '-') || '/' || correction_note
           from public.delivery_stops where id = (select v from ids where k = 's1')),
  'delivered/none/-/customer called: tiffin arrived', 'the stop shows the correction');
select is((select string_agg(distinct status::text, ',') from public.meal_orders where stop_id = (select v from ids where k = 's1')),
  'delivered', 'the order follows');
-- ...and back to a kitchen fault: credited again (a fresh reference after the reversal).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is(public.correct_stop((select v from ids where k = 's1'), 'failed', 'kitchen_late', 'no, it really was late') ->> 'credit_status',
  'approved', 'delivered → failed (kitchen fault) credits again');
select is(public.correct_stop((select v from ids where k = 's1'), 'failed', 'food_issue', 'reason fixed') ->> 'changed', 'true',
  'switching between kitchen-fault reasons keeps the one credit');
reset role;
select is((select sum(meals)::int from public.balance_entries
           where customer_id = (select customer_id from public.delivery_stops where id = (select v from ids where k = 's1'))),
  (select v from bal where k = 's1'), 'balance back to one meal credited');
select is((select count(*) from public.balance_entries where type = 'credit' and ref_type = 'delivery_stop_again'), 1::bigint,
  'the second credit uses the reversal as its reference');

-- Second attempt after "not home": back to pending, then delivered by the rider.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is(public.correct_stop((select v from ids where k = 's2'), 'pending', null, 'customer is home now') ->> 'status', 'pending',
  'failed → pending for a second attempt');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select is(public.complete_stop((select v from ids where k = 's2'), 'none') ->> 'status', 'delivered', 'the rider delivers on the second try');
-- Door cash on a stop that turns out failed is rejected; confirmed cash blocks the change.
select is(public.complete_stop((select v from ids where k = 's5'), 'none', p_cash_paise => 6000) ->> 'status', 'delivered',
  'delivered with cash');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is(public.correct_stop((select v from ids where k = 's5'), 'failed', 'not_home', 'wrong house') ->> 'status', 'failed',
  'delivered → failed');
reset role;
select is((select p.status::text from public.payments p where p.customer_id = (select customer_id from public.delivery_stops
           where id = (select v from ids where k = 's5')) and p.method = 'cash'), 'cancelled', 'its pending cash is rejected');

-- ===========================================================================
-- 7. Cash handover
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select is(public.complete_stop((select v from ids where k = 's6'), 'none', p_cash_paise => 12000) ->> 'status', 'delivered', 'cash ₹120');
select is(public.complete_stop((select v from ids where k = 's7'), 'none', p_cash_paise => 6000) ->> 'status', 'delivered', 'cash ₹60');
select is((select (x ->> 'pending_paise')::int || '/' || (x ->> 'pending_count') from jsonb_array_elements(public.my_cash_handover()) x
           where x ->> 'kitchen_id' = '83000000-0000-4000-f000-000000000002'), '18000/2', 'the rider sees ₹180 to hand over');
select throws_ok($$ select public.cash_handover('83000000-0000-4000-f000-000000000002') $$, '42501', 'forbidden',
  'a rider cannot see everyone''s cash');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.cash_handover('83000000-0000-4000-f000-000000000002') $$, '42501', 'forbidden', 'staff see no money');
select is(public.my_cash_handover(), '[]'::jsonb, 'staff collected nothing');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.confirm_rider_cash('83000000-0000-4000-f000-000000000002', 'f3000000-0000-4000-f000-000000000004') $$,
  '42501', 'forbidden', 'another kitchen''s owner cannot confirm');
reset role;
insert into ids select 'pay6', cash_payment_id from public.delivery_stops where id = (select v from ids where k = 's6');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((select (x ->> 'pending_paise')::int || '/' || (x ->> 'rejected_paise') || '/' || (x ->> 'name')
           from jsonb_array_elements(public.cash_handover('83000000-0000-4000-f000-000000000002') -> 'collectors') x),
  '18000/6000/Bikash', 'the owner sees what Bikash holds (and the rejected ₹60)');
select is(public.confirm_rider_cash('83000000-0000-4000-f000-000000000002', 'f3000000-0000-4000-f000-000000000004',
  array[(select v from ids where k = 'pay6')]) ->> 'paise', '12000',
  'confirming one payment');
select is(public.confirm_rider_cash('83000000-0000-4000-f000-000000000002', 'f3000000-0000-4000-f000-000000000004') ->> 'confirmed', '1',
  'then the rest in one step');
select is((select (x ->> 'pending_paise')::int || '/' || (x ->> 'confirmed_paise')
           from jsonb_array_elements(public.cash_handover('83000000-0000-4000-f000-000000000002') -> 'collectors') x),
  '0/18000', 'nothing left to hand over');
select throws_ok($$ select public.correct_stop((select v from ids where k = 's6'), 'pending', null, 'x') $$, '22023', 'cash_confirmed',
  'confirmed cash blocks un-delivering the stop');
reset role;
select is((select count(*) from public.balance_entries b join public.payments p on p.id = b.ref_id
           where b.type = 'recharge' and p.collected_by = 'f3000000-0000-4000-f000-000000000004' and p.status = 'paid'), 2::bigint,
  'confirmed cash is recharged through the normal money path');

-- ===========================================================================
-- 8. Push outbox and the in-app list
-- ===========================================================================
select is((select count(*) from public.notifications_outbox where channel = 'push' and template = 'production_sheet'
           and recipient_id = 'f3000000-0000-4000-f000-000000000002'), 0::bigint,
  'no push twin for the lock before the phone was registered');
select set_config('app.now', '2026-11-10 21:00:30+05:30', true);
select ok(private.lock_slot('83000000-0000-4000-f000-000000000002', '2026-11-11', 'lunch') is not null, 'kitchen W locks Wednesday lunch');
select is((select count(*) from public.notifications_outbox where template = 'production_sheet' and dedupe_key like 'production_sheet:83000000-0000-4000-f000-000000000002:2026-11-11%'),
  1::bigint, 'the WhatsApp production sheet is queued as before');
select is((select count(*) from public.notifications_outbox where channel = 'push' and template = 'production_sheet'
           and dedupe_key like 'push:production_sheet:83000000-0000-4000-f000-000000000002:2026-11-11%'), 1::bigint,
  '...with a push twin for the owner''s phone');
select ok(not exists (select 1 from public.notifications_outbox where channel = 'push' and recipient_id = 'f3000000-0000-4000-f000-000000000001'),
  'kitchen S''s owner has no phone registered: no push rows');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
create temp table notes (v jsonb);
grant all on notes to authenticated;
insert into notes select public.my_notifications();
select is((select count(*) from notes, jsonb_array_elements(v) x where x ->> 'template' = 'production_sheet'), 2::bigint,
  'the in-app list shows each production sheet once (no twins)');
select is((select x ->> 'title' from notes, jsonb_array_elements(v) x where x ->> 'template' = 'production_sheet'
           and x ->> 'title' like '%Wed 11 Nov' limit 1), 'Final count: Lunch Wed 11 Nov', 'with a readable title');
select is((select x ->> 'path' from notes, jsonb_array_elements(v) x where x ->> 'template' = 'stop_credit_request' limit 1), '/handover',
  'credit requests open the handover screen');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.my_notifications(), '[]'::jsonb, 'staff have no alerts of the owner');
select throws_ok($$ select public.push_claim_outbox(10) $$, '42501', null, 'users cannot claim the push outbox');
reset role;

set local role service_role;
create temp table claimed as select * from public.push_claim_outbox(100);
reset role;
select is((select count(*) from claimed where recipient_id = 'f3000000-0000-4000-f000-000000000002'), 3::bigint,
  'the worker claims the owner''s three due push rows');
select is((select tokens from claimed where template = 'production_sheet'), array['ExponentPushToken[owner-w-device-1]'],
  'with the owner''s token');
select is((select title from claimed where template = 'production_sheet'), 'Final count: Lunch Wed 11 Nov', 'and the rendered title');
select is((select data ->> 'path' from claimed where template = 'production_sheet'), '/', 'and where a tap goes (Today)');
set local role service_role;
select public.push_complete_outbox((select id from claimed where template = 'production_sheet'), true);
select public.push_complete_outbox((select id from claimed where template = 'stop_credit_request' limit 1), false, 'DeviceNotRegistered',
  array['ExponentPushToken[owner-w-device-1]']);
select public.push_complete_outbox((select id from claimed where template = 'stop_credit_request' offset 1 limit 1), false, 'no_device',
  null, true);
reset role;
select is((select status from public.notifications_outbox where id = (select id from claimed where template = 'production_sheet')), 'sent',
  'a sent push is marked sent');
select is((select status || '/' || attempts from public.notifications_outbox
           where id = (select id from claimed where template = 'stop_credit_request' limit 1)), 'pending/1', 'a failed push retries later');
select ok((select send_after > private.now() from public.notifications_outbox
           where id = (select id from claimed where template = 'stop_credit_request' limit 1)), 'with backoff');
select is((select active from public.member_devices where token = 'ExponentPushToken[owner-w-device-1]'), false,
  'an unregistered device is switched off');
select is((select status from public.notifications_outbox where id = (select id from claimed where template = 'stop_credit_request' offset 1 limit 1)),
  'cancelled', 'a skipped push is cancelled');
update public.notifications_outbox set attempts = 5, status = 'sending'
where id = (select id from claimed where template = 'stop_credit_request' limit 1);
set local role service_role;
select public.push_complete_outbox((select id from claimed where template = 'stop_credit_request' limit 1), false, 'boom');
reset role;
select is((select status from public.notifications_outbox where id = (select id from claimed where template = 'stop_credit_request' limit 1)),
  'failed', 'after 5 attempts it is marked failed');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select lives_ok($$ select public.unregister_device('ExpoPushToken[rider-w-device-1]') $$, 'sign-out unregisters the phone');
select is((select count(*) from public.member_devices), 0::bigint, 'the device row is gone');
reset role;

-- ===========================================================================
-- 9. A rider who leaves is taken off routes and planned runs
-- ===========================================================================
select set_config('app.now', '2026-11-10 22:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select lives_ok($$ select public.update_route((select id from public.delivery_routes where kitchen_id = '83000000-0000-4000-f000-000000000002'
  and name = 'South'), p_rider => 'f3000000-0000-4000-f000-000000000005') $$, 'South goes to the second rider');
select lives_ok($$ select public.remove_member((select id from public.members where kitchen_id = '83000000-0000-4000-f000-000000000002'
  and user_id = 'f3000000-0000-4000-f000-000000000005')) $$, 'the second rider leaves');
reset role;
select is((select rider_id from public.delivery_routes where kitchen_id = '83000000-0000-4000-f000-000000000002' and name = 'South'),
  'f3000000-0000-4000-f000-000000000004'::uuid, 'the route falls back to the only rider left');
select is((select count(*) from public.delivery_runs where kitchen_id = '83000000-0000-4000-f000-000000000002'
           and rider_id = 'f3000000-0000-4000-f000-000000000005' and status = 'planned'), 0::bigint, 'no planned run keeps the old rider');

-- ===========================================================================
-- 10. Minimum app version
-- ===========================================================================
set local role anon;
select is(public.app_config() ->> 'min_app_version', null, 'no minimum version by default (anon can read the config)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.admin_set_min_app_version('1.2.0') $$, '42501', 'forbidden', 'owners cannot set it');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$ select public.admin_set_min_app_version('1.2.x') $$, '22023', 'invalid_version', 'versions are checked');
select throws_ok($$ select public.admin_set_min_app_version('1.2.0', 'http://example.com/app.apk') $$, '22023', 'invalid_url',
  'download links must be https');
select is(public.admin_set_min_app_version('1.2.0', 'https://example.com/tiffin.apk') ->> 'min_app_version', '1.2.0', 'the admin sets 1.2.0');
reset role;
set local role anon;
select is(public.app_config() ->> 'min_app_version' || ' ' || (public.app_config() ->> 'android_url'), '1.2.0 https://example.com/tiffin.apk',
  'every app sees it, before login too');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select is(public.admin_set_min_app_version(null) ->> 'min_app_version', null, 'an empty version switches the gate off');
-- Platform admins read tables, but kitchen tools stay with the kitchen's owner.
select throws_ok($$ select public.stop_credit_requests('83000000-0000-4000-f000-000000000002') $$, '42501', 'forbidden',
  'an admin cannot decide a kitchen''s credits');
select throws_ok($$ select public.cash_handover('83000000-0000-4000-f000-000000000002') $$, '42501', 'forbidden',
  'nor confirm its cash');
reset role;

-- ===========================================================================
-- 11. Anon reaches none of the new kitchen tools
-- ===========================================================================
set local role anon;
select throws_ok($$ select public.decide_stop_credit('00000000-0000-0000-0000-000000000000', true) $$, '42501', null, 'anon: decide_stop_credit');
select throws_ok($$ select public.correct_stop('00000000-0000-0000-0000-000000000000', 'delivered', null, 'x') $$, '42501', null, 'anon: correct_stop');
select throws_ok($$ select public.cash_handover('83000000-0000-4000-f000-000000000002') $$, '42501', null, 'anon: cash_handover');
select throws_ok($$ select public.my_cash_handover() $$, '42501', null, 'anon: my_cash_handover');
select throws_ok($$ select public.assign_routes_by_area('83000000-0000-4000-f000-000000000002', 'lunch', '[]') $$, '42501', null,
  'anon: assign_routes_by_area');
select throws_ok($$ select public.my_notifications() $$, '42501', null, 'anon: my_notifications');
select throws_ok($$ select public.admin_set_min_app_version('9.9.9') $$, '42501', null, 'anon: admin_set_min_app_version');
select throws_ok($$ select * from public.member_devices $$, '42501', null, 'anon: member_devices');
reset role;

select * from finish();
rollback;
