-- Held-back apps track, item 1 (D-126; renumbered on merge): the server's record of rider actions it refused.
-- Riders (and owners who deliver) report; riders read only their own reports; owners read and
-- resolve their kitchen's; admins read and resolve all; staff, another kitchen and anon get nothing.
-- Idempotent per client op; a newer refusal reopens; a later successful sync closes it by itself;
-- photos, delivery codes and phone numbers never reach the table.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen S (owner, staff, two riders), kitchen T (owner), a platform admin.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(), now(), now()
from (values
  ('f5000000-0000-4000-f000-000000000001'::uuid, '919777000001'),
  ('f5000000-0000-4000-f000-000000000002'::uuid, '919777000002'),
  ('f5000000-0000-4000-f000-000000000003'::uuid, '919777000003'),
  ('f5000000-0000-4000-f000-000000000004'::uuid, '919777000004'),
  ('f5000000-0000-4000-f000-000000000005'::uuid, '919777000005'),
  ('f5000000-0000-4000-f000-000000000006'::uuid, '919777000006')
) as u(id, phone);
insert into public.platform_admins (user_id) values ('f5000000-0000-4000-f000-000000000006');
insert into public.kitchens (id, name, slug, owner_id, lat, lng) values
  ('85500000-0000-4000-f000-000000000001', 'Sync Kitchen', 'sync-kitchen', 'f5000000-0000-4000-f000-000000000001', 20.3553, 85.8197),
  ('85500000-0000-4000-f000-000000000002', 'Other Kitchen', 'other-sync-kitchen', 'f5000000-0000-4000-f000-000000000005', 20.3553, 85.8197);
insert into public.kitchen_settings (kitchen_id) values ('85500000-0000-4000-f000-000000000001'), ('85500000-0000-4000-f000-000000000002');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('85500000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000001', 'owner', 'Owner S'),
  ('85500000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000002', 'staff', 'Staff S'),
  ('85500000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000003', 'rider', 'Rider One'),
  ('85500000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000004', 'rider', 'Rider Two'),
  ('85500000-0000-4000-f000-000000000002', 'f5000000-0000-4000-f000-000000000005', 'owner', 'Owner T');

select set_config('app.now', '2026-11-16 12:30:00+05:30', true);
create temp table ids (k text primary key, v uuid);
grant select, insert on ids to authenticated, anon;

do $$
declare
  v_c uuid; v_c2 uuid; v_route uuid; v_run uuid; v_t uuid; v_trun uuid; v_tc uuid; v_s uuid;
begin
  v_c := private.insert_customer('85500000-0000-4000-f000-000000000001', 'Sync Customer', '+919777100001', 'veg', 'en', null,
    jsonb_build_object('line1', 'Flat 1', 'area', 'Patia', 'lat', 20.356, 'lng', 85.82), 'vendor', 'vendor');
  v_c2 := private.insert_customer('85500000-0000-4000-f000-000000000001', 'Second Customer', '+919777100002', 'veg', 'en', null,
    jsonb_build_object('line1', 'Flat 2', 'area', 'Patia', 'lat', 20.357, 'lng', 85.82), 'vendor', 'vendor');
  v_tc := private.insert_customer('85500000-0000-4000-f000-000000000002', 'Other Customer', '+919777100003', 'veg', 'en', null,
    jsonb_build_object('line1', 'Flat 3', 'area', 'Patia', 'lat', 20.358, 'lng', 85.82), 'vendor', 'vendor');
  insert into public.delivery_routes (kitchen_id, slot, name, rider_id)
  values ('85500000-0000-4000-f000-000000000001', 'lunch', 'Patia', 'f5000000-0000-4000-f000-000000000003') returning id into v_route;
  insert into public.delivery_runs (kitchen_id, route_id, service_date, slot, rider_id, status)
  values ('85500000-0000-4000-f000-000000000001', v_route, '2026-11-16', 'lunch', 'f5000000-0000-4000-f000-000000000003', 'out')
  returning id into v_run;
  insert into ids values ('c1', v_c), ('c2', v_c2), ('run', v_run);
  insert into public.delivery_stops (kitchen_id, run_id, customer_id, address_id, seq, meal_count)
  values ('85500000-0000-4000-f000-000000000001', v_run, v_c, (select id from public.addresses where customer_id = v_c), 1, 1)
  returning id into v_s;
  insert into ids values ('s1', v_s);
  insert into public.delivery_stops (kitchen_id, run_id, customer_id, address_id, seq, meal_count)
  values ('85500000-0000-4000-f000-000000000001', v_run, v_c2, (select id from public.addresses where customer_id = v_c2), 2, 1)
  returning id into v_s;
  insert into ids values ('s2', v_s);
  -- Review fixes: a stop the owner moves to Rider Two's run (s3), and one that syncs before its report (s4).
  v_c := private.insert_customer('85500000-0000-4000-f000-000000000001', 'Moved Customer', '+919777100004', 'veg', 'en', null,
    jsonb_build_object('line1', 'Flat 4', 'area', 'Patia', 'lat', 20.359, 'lng', 85.82), 'vendor', 'vendor');
  insert into ids values ('c3', v_c);
  insert into public.delivery_stops (kitchen_id, run_id, customer_id, address_id, seq, meal_count)
  values ('85500000-0000-4000-f000-000000000001', v_run, v_c, (select id from public.addresses where customer_id = v_c), 3, 1)
  returning id into v_s;
  insert into ids values ('s3', v_s);
  v_c := private.insert_customer('85500000-0000-4000-f000-000000000001', 'Fast Customer', '+919777100005', 'veg', 'en', null,
    jsonb_build_object('line1', 'Flat 5', 'area', 'Patia', 'lat', 20.36, 'lng', 85.82), 'vendor', 'vendor');
  insert into public.delivery_stops (kitchen_id, run_id, customer_id, address_id, seq, meal_count)
  values ('85500000-0000-4000-f000-000000000001', v_run, v_c, (select id from public.addresses where customer_id = v_c), 4, 1)
  returning id into v_s;
  insert into ids values ('s4', v_s);
  insert into public.delivery_routes (kitchen_id, slot, name, rider_id)
  values ('85500000-0000-4000-f000-000000000001', 'lunch', 'Saheed Nagar', 'f5000000-0000-4000-f000-000000000004') returning id into v_t;
  insert into public.delivery_runs (kitchen_id, route_id, service_date, slot, rider_id, status)
  values ('85500000-0000-4000-f000-000000000001', v_t, '2026-11-16', 'lunch', 'f5000000-0000-4000-f000-000000000004', 'out')
  returning id into v_trun;
  insert into ids values ('run2', v_trun);
  insert into public.delivery_routes (kitchen_id, slot, name)
  values ('85500000-0000-4000-f000-000000000002', 'lunch', 'Other') returning id into v_t;
  insert into public.delivery_runs (kitchen_id, route_id, service_date, slot, status)
  values ('85500000-0000-4000-f000-000000000002', v_t, '2026-11-16', 'lunch', 'planned') returning id into v_trun;
  insert into ids values ('trun', v_trun);
  insert into public.delivery_stops (kitchen_id, run_id, customer_id, address_id, seq, meal_count)
  values ('85500000-0000-4000-f000-000000000002', v_trun, v_tc, (select id from public.addresses where customer_id = v_tc), 1, 1)
  returning id into v_s;
  insert into ids values ('ts', v_s);
end $$;

-- ===========================================================================
-- Shape: RLS, grants, audit, no direct writes
-- ===========================================================================
select ok((select relrowsecurity from pg_class where oid = 'public.rider_sync_rejects'::regclass), 'rider_sync_rejects has RLS');
select is((select coalesce(array_agg(privilege_type::text order by privilege_type), '{}') from information_schema.role_table_grants
           where grantee = 'authenticated' and table_schema = 'public' and table_name = 'rider_sync_rejects'),
  array['SELECT'], 'signed-in users can only read rider_sync_rejects (writes go through the RPCs)');
select is((select count(*)::int from information_schema.role_table_grants
           where grantee = 'anon' and table_schema = 'public' and table_name = 'rider_sync_rejects'), 0, 'anon has no access to the table');
select ok(exists (select 1 from pg_trigger t where t.tgrelid = 'public.rider_sync_rejects'::regclass and t.tgfoid = 'private.audit_row'::regproc),
  'rider_sync_rejects is audited');
select ok(not has_function_privilege('anon', 'public.report_sync_reject(uuid, text, text, uuid, uuid, uuid, jsonb, integer, boolean, timestamptz, timestamptz)', 'execute')
          and not has_function_privilege('anon', 'public.sync_rejects(uuid, boolean, integer)', 'execute')
          and not has_function_privilege('anon', 'public.resolve_sync_reject(uuid, text)', 'execute'),
  'anon cannot call the sync-report RPCs');
select ok(has_function_privilege('authenticated', 'public.report_sync_reject(uuid, text, text, uuid, uuid, uuid, jsonb, integer, boolean, timestamptz, timestamptz)', 'execute'),
  'signed-in users can call report_sync_reject (it checks the role)');
select ok(not has_function_privilege('authenticated', 'private.sync_reject_summary(jsonb)', 'execute'), 'helpers stay private');

-- ===========================================================================
-- Anon
-- ===========================================================================
set local role anon;
select throws_ok($$ select public.report_sync_reject(gen_random_uuid(), 'complete', 'not_found') $$, '42501', null,
  'anon cannot report');
reset role;

-- ===========================================================================
-- Rider One reports a refused delivery with cash, a photo and a note holding a phone number
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select lives_ok($$
  insert into ids select 'r1', public.report_sync_reject(
    'a1000000-0000-4000-a000-000000000001', 'complete', 'already_done', null, (select v from ids where k = 'run'),
    (select v from ids where k = 's1'),
    jsonb_build_object('proof', 'photo', 'otp', '1234', 'photo_uri', 'file:///proof.jpg', 'note', 'call 98765 43210 at gate',
                       'tiffins_out', 2, 'tiffins_returned', 1.4, 'gps', true, 'offline', true, 'scanned', 'yes',
                       'stop_label', 'Sync Customer', 'service_date', '2026-11-16', 'slot', 'lunch', 'phone', '+919777100001'),
    25000, true, '2026-11-16 12:10:00+05:30', '2026-11-16 12:20:00+05:30')
$$, 'a rider reports a refused delivery');
reset role;
select is((select kitchen_id from public.rider_sync_rejects where id = (select v from ids where k = 'r1')),
  '85500000-0000-4000-f000-000000000001'::uuid, 'the kitchen comes from the run');
select is((select summary from public.rider_sync_rejects where id = (select v from ids where k = 'r1')),
  '{"gps": true, "slot": "lunch", "note": "call … at gate", "proof": "photo", "offline": true, "stop_label": "Sync Customer",
    "tiffins_out": 2, "service_date": "2026-11-16", "tiffins_returned": 1}'::jsonb,
  'only whitelisted keys are kept: no delivery code, photo, phone or unknown keys; digits removed from the note');
select ok((select cash_paise = 25000 and had_photo and action = 'complete' and error_code = 'already_done' and reports = 1
                  and acted_at = '2026-11-16 12:10:00+05:30' and refused_at = '2026-11-16 12:20:00+05:30'
                  and rider_id = 'f5000000-0000-4000-f000-000000000003' and stop_id = (select v from ids where k = 's1')
           from public.rider_sync_rejects where id = (select v from ids where k = 'r1')), 'cash, photo flag, device times and links are stored');
select is((select count(*)::int from public.audit_log where table_name = 'rider_sync_rejects' and row_id = (select v from ids where k = 'r1')::text),
  1, 'the report is in the audit log');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.report_sync_reject('a1000000-0000-4000-a000-000000000001', 'complete', 'already_done', null,
            (select v from ids where k = 'run'), (select v from ids where k = 's1'), '{}', 25000, true,
            '2026-11-16 12:10:00+05:30', '2026-11-16 12:20:00+05:30'),
  (select v from ids where k = 'r1'), 'the same report sent again returns the same row');
select is((select reports from public.rider_sync_rejects where client_op = 'a1000000-0000-4000-a000-000000000001'), 1,
  '... and changes nothing');
-- A run that no longer exists, from the phone's cached kitchen: stored without the run.
select lives_ok($$
  insert into ids select 'r2', public.report_sync_reject('a1000000-0000-4000-a000-000000000002', 'fail', 'not_found',
    '85500000-0000-4000-f000-000000000001', gen_random_uuid(), gen_random_uuid(),
    '{"reason": "not_home", "route_label": "Patia", "service_date": "2026-13-45"}', 0, false, null, null)
$$, 'a refused action whose run was rebuilt is still reported (kitchen from the phone)');
select is((select array[run_id::text, stop_id::text, summary::text] from public.rider_sync_rejects where id = (select v from ids where k = 'r2')),
  array[null, null, '{"reason": "not_home", "route_label": "Patia"}'], '... without the missing run and stop (an impossible date is dropped)');
-- No kitchen named at all: the rider's only kitchen.
select lives_ok($$
  insert into ids select 'r3', public.report_sync_reject('a1000000-0000-4000-a000-000000000003', 'finish', 'stops_pending')
$$, 'with no kitchen, run or stop, the rider''s only kitchen is used');
select is((select kitchen_id from public.rider_sync_rejects where id = (select v from ids where k = 'r3')),
  '85500000-0000-4000-f000-000000000001'::uuid, '... kitchen S');
-- Guards
select throws_ok($$ select public.report_sync_reject(gen_random_uuid(), 'complete', 'x', null, (select v from ids where k = 'trun')) $$,
  '42501', 'forbidden', 'a rider cannot report against another kitchen''s run');
select throws_ok($$ select public.report_sync_reject(gen_random_uuid(), 'complete', 'x', '85500000-0000-4000-f000-000000000002') $$,
  '42501', 'forbidden', '... or kitchen');
select throws_ok($$ select public.report_sync_reject(gen_random_uuid(), 'complete', 'x', '85500000-0000-4000-f000-000000000001',
                    null, (select v from ids where k = 'ts')) $$, '42501', 'forbidden', '... or name another kitchen''s stop');
select throws_ok($$ select public.report_sync_reject(gen_random_uuid(), 'complete', 'x', null, (select v from ids where k = 'trun'),
                    (select v from ids where k = 's1')) $$, '42501', 'forbidden', 'naming another kitchen''s run with this kitchen''s stop is refused');
select throws_ok($$ select public.report_sync_reject(gen_random_uuid(), 'teleport', 'x', '85500000-0000-4000-f000-000000000001') $$,
  '22023', 'invalid_kind', 'unknown action kinds are refused');
select throws_ok($$ select public.report_sync_reject(gen_random_uuid(), 'complete', 'x', '85500000-0000-4000-f000-000000000001',
                    null, null, '{}', -5) $$, '22023', 'invalid_amount', 'negative cash is refused');
select throws_ok($$ insert into public.rider_sync_rejects (kitchen_id, client_op, action, error_code, acted_at, refused_at)
                    values ('85500000-0000-4000-f000-000000000001', gen_random_uuid(), 'start', 'x', now(), now()) $$,
  '42501', null, 'no direct inserts');
select throws_ok($$ update public.rider_sync_rejects set resolved_at = now() $$, '42501', null, 'no direct updates');
select throws_ok($$ select * from public.sync_rejects('85500000-0000-4000-f000-000000000001') $$, '42501', 'forbidden',
  'a rider cannot list the kitchen''s reports');
select throws_ok($$ select public.resolve_sync_reject((select v from ids where k = 'r1')) $$, '42501', 'forbidden',
  'a rider cannot resolve');
select is((select count(*)::int from public.rider_sync_rejects), 3, 'Rider One reads their own three reports');

-- Rider Two reads none of Rider One's, and reports their own.
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select is((select count(*)::int from public.rider_sync_rejects), 0, 'another rider of the kitchen reads none of them');
select lives_ok($$ insert into ids select 'r4', public.report_sync_reject('a1000000-0000-4000-a000-000000000004', 'start', 'forbidden',
                   null, (select v from ids where k = 'run')) $$, 'a rider whose run was reassigned can still report');
-- The same client op from another rider is a separate report (keys are per rider).
select lives_ok($$ insert into ids select 'r5', public.report_sync_reject('a1000000-0000-4000-a000-000000000001', 'complete', 'not_found',
                   '85500000-0000-4000-f000-000000000001') $$, 'client ops are scoped to the rider');
select is((select count(*)::int from public.rider_sync_rejects), 2, 'Rider Two reads their own two');

-- Staff: nothing.
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from public.rider_sync_rejects), 0, 'staff read no reports (cash is money)');
select throws_ok($$ select * from public.sync_rejects('85500000-0000-4000-f000-000000000001') $$, '42501', 'forbidden', 'staff cannot list');
select throws_ok($$ select public.report_sync_reject(gen_random_uuid(), 'complete', 'x', '85500000-0000-4000-f000-000000000001') $$,
  '42501', 'forbidden', 'staff cannot report');
select throws_ok($$ select public.resolve_sync_reject((select v from ids where k = 'r1')) $$, '42501', 'forbidden', 'staff cannot resolve');

-- Other kitchen's owner: nothing.
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000005","role":"authenticated"}', true);
select is((select count(*)::int from public.rider_sync_rejects), 0, 'another kitchen''s owner reads none');
select throws_ok($$ select * from public.sync_rejects('85500000-0000-4000-f000-000000000001') $$, '42501', 'forbidden',
  'another kitchen''s owner cannot list');
select throws_ok($$ select public.resolve_sync_reject((select v from ids where k = 'r1')) $$, '42501', 'forbidden',
  'another kitchen''s owner cannot resolve');
select throws_ok($$ select * from public.sync_rejects(null) $$, '42501', 'forbidden', 'only admins list every kitchen');

-- ===========================================================================
-- Owner: list, names, resolve
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((select count(*)::int from public.rider_sync_rejects), 5, 'the owner reads every report of the kitchen');
select is((select count(*)::int from public.sync_rejects('85500000-0000-4000-f000-000000000001')), 5, 'sync_rejects lists the 5 open ones');
select is((select array[rider_name, customer_name, route_name, service_date::text, slot::text]
           from public.sync_rejects('85500000-0000-4000-f000-000000000001') where id = (select v from ids where k = 'r1')),
  array['Rider One', 'Sync Customer', 'Patia', '2026-11-16', 'lunch'], 'names come from the live rows');
select is((select array[customer_name, route_name] from public.sync_rejects('85500000-0000-4000-f000-000000000001')
           where id = (select v from ids where k = 'r2')),
  array[null, 'Patia'], '... or from the phone''s labels when the run is gone');
select lives_ok($$ select public.resolve_sync_reject((select v from ids where k = 'r4'), 'Talked to the rider') $$, 'the owner resolves one');
select ok((select resolved_at = '2026-11-16 12:30:00+05:30' and resolved_by = 'f5000000-0000-4000-f000-000000000001'
                  and resolution_note = 'Talked to the rider'
           from public.rider_sync_rejects where id = (select v from ids where k = 'r4')), '... with the time, who and the note');
select throws_ok($$ select public.resolve_sync_reject((select v from ids where k = 'r4')) $$, '22023', 'not_pending', 'only once');
select throws_ok($$ select public.resolve_sync_reject(gen_random_uuid()) $$, 'P0002', 'not_found', 'unknown ids are not found');
select is((select count(*)::int from public.sync_rejects('85500000-0000-4000-f000-000000000001')), 4, 'the open list drops it');
select is((select count(*)::int from public.sync_rejects('85500000-0000-4000-f000-000000000001', true)), 5, '... resolved ones on request');
-- An owner who delivers reports too.
select lives_ok($$ insert into ids select 'r6', public.report_sync_reject('a1000000-0000-4000-a000-000000000006', 'complete', 'otp_wrong',
                   null, (select v from ids where k = 'run'), (select v from ids where k = 's2'), '{}', 0, false) $$,
  'an owner delivering can report');
reset role;

-- ===========================================================================
-- A newer refusal of the same action reopens; a later successful sync closes it by itself
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000004","role":"authenticated"}', true);
select is(public.report_sync_reject('a1000000-0000-4000-a000-000000000004', 'start', 'forbidden', null, (select v from ids where k = 'run'),
            null, '{}', 0, false, null, '2026-11-16 12:40:00+05:30'),
  (select v from ids where k = 'r4'), 'refused again after the rider tried again: same row');
reset role;
select ok((select resolved_at is null and resolved_by is null and resolution_note is null and reports = 2
           from public.rider_sync_rejects where id = (select v from ids where k = 'r4')), '... reopened and counted');

-- Rider One taps "Try again" on the refused delivery of stop 2 (op ...0007) and it now goes through.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select lives_ok($$ insert into ids select 'r7', public.report_sync_reject('a1000000-0000-4000-a000-000000000007', 'complete', 'http_503',
                   null, (select v from ids where k = 'run'), (select v from ids where k = 's2')) $$, 'a report for stop 2');
select lives_ok($$ select public.complete_stop((select v from ids where k = 's2'), 'none', p_client_op => 'a1000000-0000-4000-a000-000000000007',
                   p_at => '2026-11-16 12:28:00+05:30') $$, 'the same action syncs later');
reset role;
select ok((select resolved_at is not null and resolved_by is null and resolution_note = 'Synced later from the phone'
           from public.rider_sync_rejects where id = (select v from ids where k = 'r7')), 'the report closes by itself');
select ok((select resolved_at is null from public.rider_sync_rejects where id = (select v from ids where k = 'r6')),
  'other reports for the same stop stay open');

-- A report that arrives after the same action synced is overtaken: it never reopens (review fix).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.report_sync_reject('a1000000-0000-4000-a000-000000000007', 'complete', 'http_503', null,
            (select v from ids where k = 'run'), (select v from ids where k = 's2'), '{}', 5000, false, null,
            '2026-11-16 12:45:00+05:30'),
  (select v from ids where k = 'r7'), 'a delayed newer refusal of an action that already synced: same row');
reset role;
select ok((select resolved_at is not null and reports = 1 and cash_paise = 0
           from public.rider_sync_rejects where id = (select v from ids where k = 'r7')), '... stays closed and unchanged');
-- The rider tried again and it synced before the first report got through: stored already closed.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select lives_ok($$ select public.complete_stop((select v from ids where k = 's4'), 'none', p_client_op => 'a1000000-0000-4000-a000-000000000010',
                   p_at => '2026-11-16 12:29:00+05:30') $$, 'an action syncs first');
select lives_ok($$ insert into ids select 'r10', public.report_sync_reject('a1000000-0000-4000-a000-000000000010', 'complete', 'http_503',
                   null, (select v from ids where k = 'run'), (select v from ids where k = 's4'), '{}', 12000, false) $$,
  '... and its report arrives afterwards');
reset role;
select ok((select resolved_at is not null and resolved_by is null and resolution_note = 'Synced later from the phone'
           from public.rider_sync_rejects where id = (select v from ids where k = 'r10')), '... stored already closed');

-- The owner moves a pending stop to another rider's run while Rider One's delivery is still offline (review fix).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.move_stop((select v from ids where k = 's3'), (select v from ids where k = 'run2')) $$,
  'the owner moves stop 3 to Rider Two''s run');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.complete_stop((select v from ids where k = 's3'), 'none', p_cash_paise => 25000,
                    p_client_op => 'a1000000-0000-4000-a000-000000000008', p_at => '2026-11-16 12:15:00+05:30') $$,
  '42501', 'forbidden', 'Rider One''s queued delivery is refused (no longer their run)');
select lives_ok($$ insert into ids select 'r8', public.report_sync_reject('a1000000-0000-4000-a000-000000000008', 'complete', 'forbidden',
                   '85500000-0000-4000-f000-000000000001', (select v from ids where k = 'run'), (select v from ids where k = 's3'),
                   '{"proof": "none", "stop_label": "Moved Customer"}', 25000, false, '2026-11-16 12:15:00+05:30', '2026-11-16 12:31:00+05:30') $$,
  '... and its report naming the old run is accepted');
-- The old run was rebuilt away too: still accepted, kitchen from the stop.
select lives_ok($$ insert into ids select 'r9', public.report_sync_reject('a1000000-0000-4000-a000-000000000009', 'fail', 'forbidden',
                   null, gen_random_uuid(), (select v from ids where k = 's3'), '{}', 0, false) $$,
  'a report naming a run that no longer exists, with a live stop, is accepted');
reset role;
select ok((select run_id = (select v from ids where k = 'run') and stop_id = (select v from ids where k = 's3')
                  and customer_id = (select v from ids where k = 'c3') and resolved_at is null
           from public.rider_sync_rejects where id = (select v from ids where k = 'r8')),
  '... stored with the run the rider acted on, the stop and its customer, open');
select ok((select run_id is null and stop_id = (select v from ids where k = 's3') and kitchen_id = '85500000-0000-4000-f000-000000000001'
           from public.rider_sync_rejects where id = (select v from ids where k = 'r9')), '... the missing run is left empty');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((select array[rider_name, customer_name, route_name, cash_paise::text]
           from public.sync_rejects('85500000-0000-4000-f000-000000000001') where id = (select v from ids where k = 'r8')),
  array['Rider One', 'Moved Customer', 'Patia', '25000'], 'the owner sees the refused Rs 250 with the old route and the customer');
reset role;

-- Rebuilding a run never fails because of a report (the link is cleared).
delete from public.delivery_stops where id = (select v from ids where k = 's1');
select is((select stop_id from public.rider_sync_rejects where id = (select v from ids where k = 'r1')), null::uuid,
  'deleting a stop clears the link and keeps the report');
select is((select customer_id from public.rider_sync_rejects where id = (select v from ids where k = 'r1')), (select v from ids where k = 'c1'),
  '... and the customer stays known (for erasure)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((select customer_name from public.sync_rejects('85500000-0000-4000-f000-000000000001', true)
           where id = (select v from ids where k = 'r1')), 'Sync Customer', '... and still named on the owner''s list');
reset role;

-- ===========================================================================
-- Admin: reads and resolves everywhere
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000006","role":"authenticated"}', true);
select is((select count(*)::int from public.rider_sync_rejects), 10, 'the admin reads every report');
select is((select count(*)::int from public.sync_rejects(null, true)), 10, 'the admin lists every kitchen');
select lives_ok($$ select public.resolve_sync_reject((select v from ids where k = 'r1'), 'Cash checked') $$, 'the admin resolves');
select is((select resolved_by from public.rider_sync_rejects where id = (select v from ids where k = 'r1')),
  'f5000000-0000-4000-f000-000000000006'::uuid, '... recorded as the admin');
reset role;

select * from finish();
rollback;
