-- Vendor-first wave 3 (ops): engine health (heartbeats, overdue slots, failed cron runs, wave 1's
-- engine_errors if present), Freeze now, the lean audit log (diff-only personal rows, no rider
-- pings, scrub-only guard), real erasure, and retention (purge job, storage retention RPCs).
-- Calendar: 2027-02-01 is a Monday. Default cutoffs: lunch 21:00 the day before, dinner 12:00.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen O (owner, staff, rider), lunch+dinner plan, 3 customers from Tue 2 Feb.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-e300-000000000001', 'authenticated', 'authenticated', '919131400001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-e300-000000000002', 'authenticated', 'authenticated', '919131400002', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-e300-000000000003', 'authenticated', 'authenticated', '919131400003', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, weekly_off, capacity_lunch, capacity_dinner)
values ('31400000-0000-4000-e300-000000000001', 'Ops Test Kitchen', 'ops-test-kitchen', '00000000-0000-4000-e300-000000000001', '{}', 100, 100);
insert into public.kitchen_settings (kitchen_id) values ('31400000-0000-4000-e300-000000000001');
insert into public.members (kitchen_id, user_id, role) values
  ('31400000-0000-4000-e300-000000000001', '00000000-0000-4000-e300-000000000001', 'owner'),
  ('31400000-0000-4000-e300-000000000001', '00000000-0000-4000-e300-000000000002', 'staff'),
  ('31400000-0000-4000-e300-000000000001', '00000000-0000-4000-e300-000000000003', 'rider');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('41400000-0000-4000-e300-000000000001', '31400000-0000-4000-e300-000000000001', 'Both meals', '{lunch,dinner}', '{1,2,3,4,5,6,7}', 6000);

select set_config('app.now', '2027-02-01 10:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
grant select on ids to authenticated;

do $$
declare
  v_cust uuid;
  r record;
begin
  for r in select * from (values (1, 'Erasable Elango', '+919131401001', 'Flat 77 Rosewood Lane'),
                                 (2, 'Retained Ranjan', '+919131401002', 'House 5 Mango Street'),
                                 (3, 'Sibling Sunita', '+919131401003', 'Plot 9 Lake View')) as x(n, name, phone, line1) loop
    v_cust := private.insert_customer('31400000-0000-4000-e300-000000000001', r.name, r.phone, 'veg', 'en', null,
      jsonb_build_object('line1', r.line1, 'area', 'Patia'), 'vendor', 'vendor');
    insert into ids values ('c' || r.n, v_cust);
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
    values ('31400000-0000-4000-e300-000000000001', v_cust, 'adjust', 40, 240000, 'Opening balance (test)');
    if r.n <= 2 then
      insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
      values ('31400000-0000-4000-e300-000000000001', v_cust, '41400000-0000-4000-e300-000000000001',
              (select id from public.addresses where customer_id = v_cust), '2027-02-02', 'active');
    end if;
  end loop;
end $$;

select is((select count(*) from public.meal_orders where kitchen_id = '31400000-0000-4000-e300-000000000001'
           and service_date = '2027-02-02' and slot = 'lunch'), 2::bigint, 'setup: orders exist for Tue lunch');

-- Start from a clean pg_cron log (rolled back with the test).
delete from cron.job_run_details;

-- ===========================================================================
-- Health: heartbeats and jobs
-- ===========================================================================
select is((select count(*) from public.engine_heartbeats where job in (select job from private.engine_jobs())), 5::bigint,
  'every expected job has a heartbeat row');
select is((select count(*) from cron.job where jobname in ('tiffin-lock-due-slots', 'tiffin-nightly', 'tiffin-owner-summary', 'tiffin-purge')
           and command like '%private.run_job(%'), 4::bigint, 'engine jobs run through private.run_job (heartbeat)');
select is((select command from cron.job where jobname = 'tiffin-storage-retention'), 'select private.kick_function(''storage-retention'')',
  'storage retention is started by pg_cron');

select set_config('app.now', '2027-02-02 09:30:00+05:30', true);
select is((select count(*) from public.engine_heartbeats where job = 'tiffin-owner-summary' and last_ok_at = private.now()), 0::bigint,
  'before: the summary job has not run at this time');
select lives_ok($$ select private.run_job('tiffin-owner-summary') $$, 'run_job runs a job');
select is((select last_ok_at from public.engine_heartbeats where job = 'tiffin-owner-summary'), private.now(), 'and stamps its heartbeat');
select throws_ok($$ select private.run_job('tiffin-unknown') $$, '22023', 'unknown_job', 'unknown jobs are refused');

-- A day later nothing else ran: the lock job (real clock) and nightly are stale.
select is((public.ops_health() -> 'checks' ->> 'lock_job')::boolean, false, 'a lock job with no recent heartbeat is unhealthy');
select is((public.ops_health() ->> 'ok')::boolean, false, 'so the platform is unhealthy');

-- ===========================================================================
-- Count not frozen
-- ===========================================================================
select is((select count(*) from private.overdue_slots('31400000-0000-4000-e300-000000000001')), 1::bigint,
  'Tue lunch (cutoff Mon 21:00) has orders but no count: overdue');
select is((select slot::text || ' ' || service_date from private.overdue_slots('31400000-0000-4000-e300-000000000001')), 'lunch 2027-02-02',
  'the overdue slot is Tue lunch (Tue dinner is still open)');
select ok((public.ops_health() -> 'checks' ->> 'overdue_slots')::integer >= 1, 'ops_health counts it');
select ok(exists (select 1 from jsonb_array_elements(private.engine_health() -> 'overdue_slots' -> 'items') x
                  where x ->> 'kitchen' = 'Ops Test Kitchen' and x ->> 'slot' = 'lunch'), 'engine_health names the kitchen and slot');

select set_config('app.now', '2027-02-01 21:03:00+05:30', true);
select is((select count(*) from private.overdue_slots('31400000-0000-4000-e300-000000000001')), 0::bigint,
  'within 5 minutes of the cutoff it is not overdue yet (the minute job has time)');
select set_config('app.now', '2027-02-02 09:30:00+05:30', true);

-- Freeze now: owner only.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-02-02', 'lunch') $$, '42501', 'forbidden', 'staff cannot freeze');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-02-02', 'lunch') $$, '42501', 'forbidden', 'riders cannot freeze');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-02-02', 'lunch') $$, '42501', 'forbidden', 'another kitchen cannot freeze');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$ select public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-02-02', 'lunch') $$, '42501', 'forbidden', 'admins do not freeze kitchens');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-02-02', 'dinner') $$, '22023', 'before_cutoff',
  'a slot cannot be frozen before its cutoff');
select throws_ok($$ select public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-01-20', 'lunch') $$, '22023', 'out_of_range',
  'only the last 7 days can be frozen');
select is((public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-02-02', 'lunch') ->> 'already_locked')::boolean, false,
  'the owner freezes Tue lunch');
select is((public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-02-02', 'lunch') ->> 'already_locked')::boolean, true,
  'freezing again changes nothing (idempotent)');
reset role;
set local role anon;
select throws_ok($$ select public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-02-02', 'lunch') $$, '42501', null, 'anon cannot freeze');
reset role;

select is((select count(*) from public.count_snapshots where kitchen_id = '31400000-0000-4000-e300-000000000001'
           and service_date = '2027-02-02' and slot = 'lunch'), 1::bigint, 'one count snapshot');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where b.type = 'meal' and o.kitchen_id = '31400000-0000-4000-e300-000000000001' and o.service_date = '2027-02-02' and o.slot = 'lunch'),
  2::bigint, 'one meal entry per order, through the lock path (no second path)');
select is((select count(*) from private.overdue_slots('31400000-0000-4000-e300-000000000001')), 0::bigint, 'no longer overdue');
select is((select actor_id from public.audit_log where table_name = 'count_snapshots' and kitchen_id = '31400000-0000-4000-e300-000000000001'
           and after ->> 'slot' = 'lunch' and after ->> 'service_date' = '2027-02-02'), '00000000-0000-4000-e300-000000000001'::uuid,
  'the audit log shows who froze it');

update public.kitchens set status = 'suspended' where id = '31400000-0000-4000-e300-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.freeze_slot('31400000-0000-4000-e300-000000000001', '2027-02-02', 'lunch') $$, '42501', 'kitchen_suspended',
  'a suspended kitchen cannot freeze');
reset role;
update public.kitchens set status = 'draft' where id = '31400000-0000-4000-e300-000000000001';

-- ===========================================================================
-- Health: cron failures, engine_errors (wave 1, optional), unscheduled jobs, healthy state
-- ===========================================================================
insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
values ((select jobid from cron.job where jobname = 'tiffin-nightly'), (select coalesce(max(runid), 0) + 1000000 from cron.job_run_details),
        1, 'postgres', 'postgres', 'select 1', 'failed', 'ERROR: simulated failure', private.now() - interval '1 hour', private.now() - interval '1 hour');
select is((select x ->> 'job' from jsonb_array_elements(private.engine_health() -> 'cron' -> 'failing') x), 'tiffin-nightly',
  'a job whose latest run failed is reported');
select is((public.ops_health() -> 'checks' ->> 'failing_jobs')::integer, 1, 'ops_health counts failing jobs');
select is((private.engine_health() -> 'cron' ->> 'failures_24h')::integer, 1, 'and the failures of the last 24 hours');
insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
values ((select jobid from cron.job where jobname = 'tiffin-nightly'), (select coalesce(max(runid), 0) + 1 from cron.job_run_details),
        1, 'postgres', 'postgres', 'select 1', 'succeeded', '1 row', private.now(), private.now());
select is((public.ops_health() -> 'checks' ->> 'failing_jobs')::integer, 0, 'a later success clears it');

-- Every critical heartbeat fresh, no overdue slot, no failing job: healthy.
update public.engine_heartbeats set last_ok_at = private.now()
where job in ('tiffin-lock-due-slots', 'tiffin-nightly', 'tiffin-owner-summary');
select is(public.ops_health() -> 'checks', '{"lock_job": true, "nightly_job": true, "summary_job": true, "overdue_slots": 0, "failing_jobs": 0, "engine_errors": null}'::jsonb
            || case when to_regclass('public.engine_errors') is not null then '{"engine_errors": 0}'::jsonb else '{}'::jsonb end,
  'all checks pass');
select is((public.ops_health() ->> 'ok')::boolean, true, 'healthy');
select ok(public.ops_health()::text !~ '(kitchen|Ops Test|[0-9a-f]{8}-[0-9a-f]{4})', 'ops_health carries no kitchen names or ids');

-- Wave 1's engine_errors table, when it exists, makes recent errors unhealthy. Simulated if absent.
select is((private.engine_health() -> 'engine_errors' ->> 'tracked')::boolean, to_regclass('public.engine_errors') is not null,
  'engine_errors is tracked exactly when the table exists');
do $$
begin
  if to_regclass('public.engine_errors') is null then
    create table public.engine_errors (id bigint generated always as identity, created_at timestamptz not null default now());
    insert into public.engine_errors (created_at) values (private.now() - interval '1 minute');
  else
    execute 'insert into public.engine_errors default values';
  end if;
exception when others then
  raise warning 'could not simulate an engine error: %', sqlerrm;
end $$;
select is((public.ops_health() ->> 'ok')::boolean, false, 'a recent engine error makes it unhealthy');
select ok((private.engine_health() -> 'engine_errors' ->> 'last_24h')::integer >= 1, 'and is counted for the admin tile');

-- Unscheduling the lock job is caught at once (the "unschedule the lock cron" test of the audit).
select cron.unschedule('tiffin-lock-due-slots');
select is((select x ->> 'scheduled' from jsonb_array_elements(private.engine_health() -> 'jobs') x where x ->> 'job' = 'tiffin-lock-due-slots'),
  'false', 'an unscheduled lock job is reported');
select is((public.ops_health() -> 'checks' ->> 'lock_job')::boolean, false, 'and makes ops_health fail');

-- Who can read health.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select ok(public.engine_health() ? 'jobs', 'admins read engine health');
select throws_ok($$ select public.ops_health() $$, '42501', null, 'signed-in users cannot call ops_health (service role only)');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.engine_health() $$, '42501', 'forbidden', 'owners cannot read platform health');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.engine_health() $$, '42501', 'forbidden', 'staff cannot read platform health');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.engine_health() $$, '42501', 'forbidden', 'riders cannot read platform health');
select throws_ok($$ select * from public.engine_heartbeats $$, '42501', null, 'heartbeats are not readable directly');
reset role;
set local role anon;
select throws_ok($$ select public.engine_health() $$, '42501', null, 'anon cannot read engine health');
select throws_ok($$ select public.ops_health() $$, '42501', null, 'anon cannot call ops_health');
reset role;
set local role service_role;
select ok(public.ops_health() ? 'checks', 'the service role (ops-health function) can');
reset role;

-- ===========================================================================
-- Lean audit log
-- ===========================================================================
insert into public.delivery_routes (id, kitchen_id, slot, name, rider_id)
values ('51400000-0000-4000-e300-000000000001', '31400000-0000-4000-e300-000000000001', 'lunch', 'Ops route', '00000000-0000-4000-e300-000000000003');
insert into public.delivery_runs (id, kitchen_id, route_id, service_date, slot, rider_id, status)
values ('61400000-0000-4000-e300-000000000001', '31400000-0000-4000-e300-000000000001', '51400000-0000-4000-e300-000000000001',
        '2027-02-02', 'lunch', '00000000-0000-4000-e300-000000000003', 'out');

create temp table vol (k text primary key, rows_before bigint, full_bytes bigint, run_bytes bigint);
insert into vol select 'ping', (select count(*) from public.audit_log where table_name = 'delivery_runs' and row_id = '61400000-0000-4000-e300-000000000001'),
  0, (select pg_column_size(to_jsonb(r)) from public.delivery_runs r where id = '61400000-0000-4000-e300-000000000001');
do $$
begin
  for i in 1..30 loop
    update public.delivery_runs set last_lat = 20.30 + i * 0.001, last_lng = 85.80 + i * 0.001, last_seen_at = private.now() + make_interval(mins => i)
    where id = '61400000-0000-4000-e300-000000000001';
  end loop;
end $$;
select is((select count(*) from public.audit_log where table_name = 'delivery_runs' and row_id = '61400000-0000-4000-e300-000000000001'),
  (select rows_before from vol where k = 'ping'), '30 rider location pings write no audit rows');
update public.delivery_runs set status = 'done', finished_at = private.now() where id = '61400000-0000-4000-e300-000000000001';
select is((select array_agg(k order by k) from public.audit_log a, jsonb_object_keys(a.after) k
           where a.table_name = 'delivery_runs' and a.row_id = '61400000-0000-4000-e300-000000000001' and a.action = 'UPDATE'
             and k <> 'updated_at'),
  array['finished_at', 'id', 'kitchen_id', 'route_id', 'status'], 'a real run change is audited, with only what changed');

-- Personal tables: only changed keys (plus identity); other tables: full rows.
insert into vol select 'cust', (select count(*) from public.audit_log where table_name = 'customers'),
  (select pg_column_size(to_jsonb(c) - private.audit_redacted_columns()) from public.customers c where id = (select v from ids where k = 'c2')), 0;
do $$
begin
  for i in 1..10 loop
    update public.customers set notes = 'Ring twice, visit ' || i where id = (select v from ids where k = 'c2');
  end loop;
end $$;
select ok((select bool_and(after ? 'notes' and after ? 'id' and after ? 'kitchen_id' and not after ? 'name' and not after ? 'diet')
           from public.audit_log where table_name = 'customers' and row_id = (select v from ids where k = 'c2')::text and action = 'UPDATE'),
  'customer updates store only the changed keys (and the row''s identity)');
update public.subscriptions set status = 'paused' where customer_id = (select v from ids where k = 'c2');
select ok((select after ? 'plan_id' and after ? 'start_date' from public.audit_log where table_name = 'subscriptions'
           and after ->> 'customer_id' = (select v from ids where k = 'c2')::text and action = 'UPDATE' order by id desc limit 1),
  'non-personal tables still keep full rows');
update public.subscriptions set status = 'active' where customer_id = (select v from ids where k = 'c2');
update public.customers set notes = notes where id = (select v from ids where k = 'c2');
select is((select count(*) from public.audit_log where table_name = 'customers' and row_id = (select v from ids where k = 'c2')::text
           and action = 'UPDATE' and after - array['updated_at', 'id', 'kitchen_id'] = '{}'::jsonb), 0::bigint,
  'no audit row for an update that changed nothing');

-- Growth simulation (one rider shift + routine edits): stored vs what full copies would have taken.
create temp table vol_out as
select (select sum(pg_column_size(before) + pg_column_size(after)) from public.audit_log
        where table_name = 'customers' and row_id = (select v from ids where k = 'c2')::text and action = 'UPDATE') as stored,
       (select 30 * 2 * run_bytes from vol where k = 'ping') as ping_full,
       (select 10 * 2 * full_bytes from vol where k = 'cust') as edit_full;
select diag(format('audit volume for 30 rider pings + 10 customer edits: stored %s bytes; full copies would take %s bytes (%s for pings, %s for edits)',
  stored, ping_full + edit_full, ping_full, edit_full)) from vol_out;
select cmp_ok((select stored::numeric from vol_out), '<', (select 0.25 * (ping_full + edit_full) from vol_out),
  'audit volume is under a quarter of full copies');
select cmp_ok((select stored::numeric from vol_out), '<', (select 0.5 * edit_full from vol_out), 'customer edits alone take under half');

-- Never in the audit log: the delivery OTP.
insert into public.delivery_stops (kitchen_id, run_id, customer_id, seq, meal_count, otp)
values ('31400000-0000-4000-e300-000000000001', '61400000-0000-4000-e300-000000000001', (select v from ids where k = 'c2'), 9, 1, '4321');
select is((select count(*) from public.audit_log where table_name = 'delivery_stops' and after ->> 'run_id' = '61400000-0000-4000-e300-000000000001'
           and after ? 'otp'), 0::bigint, 'the delivery OTP is never copied into the audit log');
select is((select count(*) from public.audit_log where (before ->> 'otp' is not null and before ->> 'otp' <> '[erased]')
           or (after ->> 'otp' is not null and after ->> 'otp' <> '[erased]')), 0::bigint, 'OTPs logged before this change were scrubbed');

-- Append-only, except an erasure scrub that only replaces values with "[erased]".
create temp table probe as
select id from public.audit_log where table_name = 'customers' and row_id = (select v from ids where k = 'c2')::text and action = 'UPDATE'
order by id desc limit 1;
select throws_ok($$ update public.audit_log set action = 'DELETE' where id = (select id from probe) $$, 'P0001', 'audit_log is append-only',
  'audit rows cannot be edited');
select set_config('tiffin.audit_scrub', 'on', true);
select throws_ok($$ update public.audit_log set after = after || '{"notes":"rewritten"}' where id = (select id from probe) $$, 'P0001',
  'audit_log is append-only', 'even with the scrub flag, values cannot be rewritten');
select throws_ok($$ update public.audit_log set table_name = 'plans', after = after || '{"notes":"[erased]"}' where id = (select id from probe) $$,
  'P0001', 'audit_log is append-only', 'or moved to another table');
select throws_ok($$ update public.audit_log set after = after || '{"extra":"[erased]"}' where id = (select id from probe) $$, 'P0001',
  'audit_log is append-only', 'or given new keys');
select throws_ok($$ delete from public.audit_log where id = (select id from probe) $$, 'P0001', 'audit_log is append-only',
  'or deleted');
select lives_ok($$ update public.audit_log set after = after || '{"notes":"[erased]"}' where id = (select id from probe) $$,
  'with the scrub flag a value can only be replaced by "[erased]"');
select set_config('tiffin.audit_scrub', '', true);
select throws_ok($$ update public.audit_log set after = after || '{"notes":"[erased]"}', before = before || '{"notes":"[erased]"}' where id = (select id from probe) $$,
  'P0001', 'audit_log is append-only', 'and without it, not even that');

-- ===========================================================================
-- Real erasure
-- ===========================================================================
update public.addresses set landmark = 'Opposite Banyan Shrine', delivery_notes = 'Gate code 4455'
where customer_id = (select v from ids where k = 'c1');
update public.customers set notes = 'Leaves gate open after nine' where id = (select v from ids where k = 'c1');
insert into public.customer_health (customer_id, kitchen_id, tags, consent_at, consent_basis)
values ((select v from ids where k = 'c1'), '31400000-0000-4000-e300-000000000001', '{diabetic}', private.now(), 'customer');
insert into public.delivery_stops (kitchen_id, run_id, customer_id, seq, meal_count, status, failed_reason, failed_note, gps_lat, gps_lng, photo_path)
values ('31400000-0000-4000-e300-000000000001', '61400000-0000-4000-e300-000000000001', (select v from ids where k = 'c1'), 1, 1, 'failed',
        'not_home', 'Banyan shrine gate was closed', 20.301, 85.801, '31400000-0000-4000-e300-000000000001/proof-elango.jpg');
insert into public.conversations (id, kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4, contact_name)
select '71400000-0000-4000-e300-000000000001', kitchen_id, id, phone_hash, phone_enc, phone_last4, 'Elango WhatsApp'
from public.customers where id = (select v from ids where k = 'c1');
insert into public.messages (conversation_id, kitchen_id, direction, body, handled_by)
values ('71400000-0000-4000-e300-000000000001', '31400000-0000-4000-e300-000000000001', 'in', 'I live at Flat 77 Rosewood Lane', 'customer');
insert into public.complaints (kitchen_id, customer_id, conversation_id, category, description, channel)
values ('31400000-0000-4000-e300-000000000001', (select v from ids where k = 'c1'), '71400000-0000-4000-e300-000000000001', 'other',
        'Rosewood Lane rider was rude', 'whatsapp');
insert into public.import_batches (id, kitchen_id, file_name) values ('81400000-0000-4000-e300-000000000001', '31400000-0000-4000-e300-000000000001', 'register.xlsx');
insert into public.import_rows (batch_id, kitchen_id, row_number, raw, status, customer_id)
values ('81400000-0000-4000-e300-000000000001', '31400000-0000-4000-e300-000000000001', 1,
        '{"name": "Erasable Elango", "line1": "Flat 77 Rosewood Lane", "phone_last4": "1001"}', 'imported', (select v from ids where k = 'c1'));
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, status, dedupe_key)
values ('31400000-0000-4000-e300-000000000001', 'whatsapp', 'customer', (select v from ids where k = 'c1'), 'payment_receipt',
        '{"name": "Erasable Elango"}', 'sent', 'ops-test-receipt-1');
update public.subscriptions set status = 'cancelled', cancelled_at = private.now() where customer_id = (select v from ids where k = 'c1');

create temp table before_erase as
select (select count(*) from public.audit_log where kitchen_id = '31400000-0000-4000-e300-000000000001') as audit_rows,
       (select count(*) from public.balance_entries where customer_id = (select v from ids where k = 'c1')) as entries,
       (select coalesce(sum(meals), 0) from public.balance_entries where customer_id = (select v from ids where k = 'c1')) as meals;
select ok((select count(*) from public.audit_log where kitchen_id = '31400000-0000-4000-e300-000000000001'
           and coalesce(before::text, '') || coalesce(after::text, '') ~* '(Elango|Rosewood|Banyan|gate open|Gate code|diabetic)') > 0,
  'before erasure the audit log holds their name, address, notes and health tags');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.erase_customer((select v from ids where k = 'c1')) $$, 'the owner erases the customer');
reset role;

select is((select count(*) from public.audit_log where kitchen_id = '31400000-0000-4000-e300-000000000001'
           and coalesce(before::text, '') || coalesce(after::text, '') ~* '(Elango|Rosewood|Banyan|gate open|Gate code|diabetic|20\.301|85\.801)'),
  0::bigint, 'after erasure no name, address, note, location or health tag of theirs remains in the audit log');
select ok((select audit_rows from before_erase) <= (select count(*) from public.audit_log where kitchen_id = '31400000-0000-4000-e300-000000000001'),
  'audit rows are scrubbed, never deleted');
select ok(exists (select 1 from public.audit_log where table_name = 'customers' and row_id = (select v from ids where k = 'c1')::text
                  and after ->> 'name' = '[erased]'), 'erased values are marked "[erased]"');
select ok(exists (select 1 from public.audit_log where kitchen_id = '31400000-0000-4000-e300-000000000001' and after::text ~ 'Retained Ranjan'),
  'other customers'' audit rows are untouched');
select is((select count(*) from public.conversations where id = '71400000-0000-4000-e300-000000000001'), 0::bigint,
  'their WhatsApp conversation is forgotten');
select is((select count(*) from public.messages where body ~ 'Rosewood'), 0::bigint, 'with its messages');
select is((select description from public.complaints where customer_id = (select v from ids where k = 'c1')), null, 'complaint text is scrubbed');
select is((select count(*) from public.complaints where customer_id = (select v from ids where k = 'c1')), 1::bigint, 'the complaint itself stays');
select is((select raw from public.import_rows where customer_id = (select v from ids where k = 'c1')), '{"erased": true}'::jsonb,
  'the import row is blanked');
select is((select row(gps_lat, gps_lng, failed_note, photo_path, status::text)::text from public.delivery_stops
           where customer_id = (select v from ids where k = 'c1') and run_id = '61400000-0000-4000-e300-000000000001'), '(,,,,failed)', 'delivery GPS, note and photo path are removed; the outcome stays');
select is((select reason from public.storage_purge_queue where bucket = 'proofs' and name = '31400000-0000-4000-e300-000000000001/proof-elango.jpg'),
  'erasure', 'their proof photo is queued for deletion through the Storage API');
select is((select count(*) from public.notifications_outbox where recipient_id = (select v from ids where k = 'c1')), 0::bigint,
  'messages to them are deleted');
select is((select count(*) from public.customer_health where customer_id = (select v from ids where k = 'c1')), 0::bigint, 'health tags are deleted');
select is((select row(count(*), coalesce(sum(meals), 0))::text from public.balance_entries where customer_id = (select v from ids where k = 'c1')),
  (select row(entries, meals)::text from before_erase), 'the ledger is unchanged');

-- D-118 (wave 2) lets family members share a phone: then the chat is unlinked, not deleted.
drop index if exists public.customers_kitchen_phone_idx;
insert into ids select 'c4', private.insert_customer('31400000-0000-4000-e300-000000000001', 'Sibling Second', '+919131401003', 'veg', 'en', null,
  '{"line1": "Plot 9 Lake View"}', 'vendor', 'vendor');
insert into public.conversations (id, kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4, contact_name)
select '71400000-0000-4000-e300-000000000002', kitchen_id, id, phone_hash, phone_enc, phone_last4, 'Sunita family phone'
from public.customers where id = (select v from ids where k = 'c3');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.erase_customer((select v from ids where k = 'c3')) $$, 'a customer sharing a phone is erased');
reset role;
select is((select row(customer_id, contact_name)::text from public.conversations where id = '71400000-0000-4000-e300-000000000002'), '(,)',
  'the shared number''s chat stays for the other customer, unlinked from the erased one');

-- ===========================================================================
-- Retention
-- ===========================================================================
select is(array[private.retention_days('proof_photo_days'), private.retention_days('dispatch_photo_days'), private.retention_days('import_photo_days'),
                private.retention_days('outbox_days'), private.retention_days('cron_log_days')], array[90, 30, 7, 90, 14], 'default retention days');
update public.platform_settings set value = value || '{"proof_photo_days": 1, "outbox_days": "soon"}' where key = 'retention';
select is(array[private.retention_days('proof_photo_days'), private.retention_days('outbox_days')], array[7, 90],
  'too-short or invalid values fall back to safe bounds');
update public.platform_settings set value = value || '{"proof_photo_days": 90, "outbox_days": 90}' where key = 'retention';

insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, status, dedupe_key, created_at) values
  ('31400000-0000-4000-e300-000000000001', 'whatsapp', 'member', '00000000-0000-4000-e300-000000000001', 'production_sheet', 'sent', 'ops-purge-old-sent', private.now() - interval '100 days'),
  ('31400000-0000-4000-e300-000000000001', 'whatsapp', 'member', '00000000-0000-4000-e300-000000000001', 'production_sheet', 'failed', 'ops-purge-old-failed', private.now() - interval '100 days'),
  ('31400000-0000-4000-e300-000000000001', 'whatsapp', 'member', '00000000-0000-4000-e300-000000000001', 'production_sheet', 'pending', 'ops-purge-old-pending', private.now() - interval '100 days'),
  ('31400000-0000-4000-e300-000000000001', 'whatsapp', 'member', '00000000-0000-4000-e300-000000000001', 'production_sheet', 'sent', 'ops-purge-recent', private.now() - interval '10 days');
insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time) values
  ((select jobid from cron.job where jobname = 'tiffin-nightly'), (select coalesce(max(runid), 0) + 1 from cron.job_run_details), 1, 'postgres', 'postgres', 'old', 'succeeded', 'old run', private.now() - interval '20 days', private.now() - interval '20 days'),
  ((select jobid from cron.job where jobname = 'tiffin-nightly'), (select coalesce(max(runid), 0) + 2 from cron.job_run_details), 1, 'postgres', 'postgres', 'recent', 'succeeded', 'recent run', private.now() - interval '1 day', private.now() - interval '1 day');

update public.platform_settings set enabled = false where key = 'retention';
select is(private.purge_old_data(), '{"skipped": true}'::jsonb, 'with retention switched off nothing is purged');
update public.platform_settings set enabled = true where key = 'retention';
select lives_ok($$ select private.run_job('tiffin-purge') $$, 'the purge job runs');
select is((select array_agg(dedupe_key order by dedupe_key) from public.notifications_outbox where dedupe_key like 'ops-purge-%'),
  array['ops-purge-old-pending', 'ops-purge-recent'], 'finished outbox rows past 90 days are deleted; pending and recent ones stay');
select is((select array_agg(return_message order by return_message) from cron.job_run_details where command in ('old', 'recent')),
  array['recent run'], 'pg_cron run log rows past 14 days are deleted');
select ok((select last_result ? 'outbox' and last_ok_at = private.now() from public.engine_heartbeats where job = 'tiffin-purge'),
  'the purge job stamps its heartbeat with what it deleted');

-- Storage retention: what the storage-retention function deletes.
insert into storage.objects (bucket_id, name, created_at) values
  ('proofs', 'ops-retention-test/old-proof.jpg', private.now() - interval '100 days'),
  ('proofs', 'ops-retention-test/new-proof.jpg', private.now() - interval '10 days'),
  ('dispatch', 'ops-retention-test/old-dispatch.jpg', private.now() - interval '31 days'),
  ('imports', 'ops-retention-test/old-import.jpg', private.now() - interval '8 days'),
  ('receipts', 'ops-retention-test/old-receipt.jpg', private.now() - interval '400 days'),
  ('bills', 'ops-retention-test/old-bill.jpg', private.now() - interval '400 days');
insert into public.storage_purge_queue (bucket, name, reason) values ('proofs', 'ops-retention-test/erased.jpg', 'erasure');
select is((select array_agg(bucket || ':' || name || ':' || reason) from public.ops_expired_objects(100, null, 'ops-retention-test/')),
  array['proofs:ops-retention-test/erased.jpg:erasure', 'proofs:ops-retention-test/old-proof.jpg:retention',
        'dispatch:ops-retention-test/old-dispatch.jpg:retention', 'imports:ops-retention-test/old-import.jpg:retention'],
  'erasure queue first, then expired proof, dispatch and import photos; receipts and bills are kept');
select is(public.ops_mark_purged('proofs', array['ops-retention-test/erased.jpg']), 1, 'removed objects leave the queue');
update public.platform_settings set enabled = false where key = 'retention';
select is((select count(*) from public.ops_expired_objects(100, null, 'ops-retention-test/')), 0::bigint,
  'with retention off no photo expires');
update public.platform_settings set enabled = true where key = 'retention';
select lives_ok($$ select public.ops_heartbeat('tiffin-storage-retention', '{"deleted": 3}') $$, 'the function reports its run');
select is((select last_result from public.engine_heartbeats where job = 'tiffin-storage-retention'), '{"deleted": 3}'::jsonb, 'heartbeat recorded');
select throws_ok($$ select public.ops_heartbeat('tiffin-nightly') $$, '22023', 'unknown_job', 'only external jobs report through ops_heartbeat');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$ select * from public.ops_expired_objects() $$, '42501', null, 'storage retention RPCs are service-role only');
select throws_ok($$ select public.ops_mark_purged('proofs', '{}') $$, '42501', null, 'ops_mark_purged too');
select throws_ok($$ select * from public.storage_purge_queue $$, '42501', null, 'the purge queue is not readable');
select is((public.admin_set_retention('{"proof_photo_days": 120}') ->> 'proof_photo_days')::integer, 120, 'an admin changes retention days');
select throws_ok($$ select public.admin_set_retention('{"proof_days": 5}') $$, '22023', 'invalid_setting', 'unknown keys are refused');
select throws_ok($$ select public.admin_set_retention('{"outbox_days": 0}') $$, '22023', 'invalid_setting', 'out-of-range values are refused');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-e300-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_set_retention('{"proof_photo_days": 1000}') $$, '42501', 'forbidden', 'owners cannot change retention');
reset role;
set local role anon;
select throws_ok($$ select * from public.ops_expired_objects() $$, '42501', null, 'anon cannot list objects');
select throws_ok($$ select public.admin_set_retention('{}') $$, '42501', null, 'anon cannot change retention');
reset role;

select * from finish();
rollback;
