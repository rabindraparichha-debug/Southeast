-- Merge of vendor-first wave 3 ops (D-158 – D-166) into m9-p5-p6: 20261130000300_merge_ops.sql and the
-- cross-wave behaviour it must keep.
--   * wave 1 + ops: an open lock error (wave 1's engine_errors: last_seen_at, resolved_at) makes
--     ops_health unhealthy; a manager's Freeze now (wave 2 roles) locks the slot and closes the error;
--   * wave 4 + ops: tiffin-plan-prices runs through private.run_job (heartbeat) and still moves the price;
--   * wave 2 / held-back apps + ops: erasure blanks change request notes and refused-action notes, and
--     their audit rows are diff-only and scrubbed.
-- Calendar: Mon 1 Mar 2027; lunch cutoff 21:00 the day before.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.src(p_schema text, p_name text) returns text language sql as
  $$ select string_agg(p.prosrc, E'\n') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = p_schema and p.proname = p_name $$;

select ok(pg_temp.src('private', 'engine_error_counts') ~ 'last_seen_at' and pg_temp.src('private', 'engine_error_counts') ~ 'resolved_at is null',
  'ops health reads wave 1''s engine_errors columns');
select ok(pg_temp.src('public', 'freeze_slot') ~ 'private.lock_slot' and pg_temp.src('public', 'freeze_slot') ~ 'resolve_engine_errors',
  'Freeze now locks through lock_slot and closes the lock error');

-- ===========================================================================
-- Setup: kitchen F (owner, manager, staff, rider), one customer on a lunch plan from Tue 2 Mar.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(), now(), now()
from (values
  ('e1900000-0000-4000-e000-000000000001'::uuid, '919319000001'),   -- owner
  ('e1900000-0000-4000-e000-000000000002'::uuid, '919319000002'),   -- manager
  ('e1900000-0000-4000-e000-000000000003'::uuid, '919319000003'),   -- staff
  ('e1900000-0000-4000-e000-000000000004'::uuid, '919319000004')    -- rider
) as u(id, phone);
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('e1900000-0000-4000-e000-00000000000a', 'Merge Ops Kitchen', 'merge-ops-kitchen', 'e1900000-0000-4000-e000-000000000001', '{}');
insert into public.kitchen_settings (kitchen_id, default_billing_mode) values ('e1900000-0000-4000-e000-00000000000a', 'prepaid');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('e1900000-0000-4000-e000-00000000000a', 'e1900000-0000-4000-e000-000000000001', 'owner', 'Owner'),
  ('e1900000-0000-4000-e000-00000000000a', 'e1900000-0000-4000-e000-000000000002', 'manager', 'Manager'),
  ('e1900000-0000-4000-e000-00000000000a', 'e1900000-0000-4000-e000-000000000003', 'staff', 'Staff'),
  ('e1900000-0000-4000-e000-00000000000a', 'e1900000-0000-4000-e000-000000000004', 'rider', 'Rider');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise, diet) values
  ('e1900000-0000-4000-e000-0000000000a1', 'e1900000-0000-4000-e000-00000000000a', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 6000, 'veg');

select set_config('app.now', '2027-03-01 10:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
grant select on ids to authenticated;
do $$
declare v_c uuid;
begin
  foreach v_c in array array[
    private.insert_customer('e1900000-0000-4000-e000-00000000000a', 'Erased Esha', '+919319100001', 'veg', 'en', null,
                            '{"line1":"Flat 9","area":"Patia"}', 'vendor', 'vendor'),
    private.insert_customer('e1900000-0000-4000-e000-00000000000a', 'Staying Sam', '+919319100002', 'veg', 'en', null,
                            '{"line1":"Flat 10","area":"Patia"}', 'vendor', 'vendor')] loop
    insert into ids values ('c' || (select count(*) + 1 from ids), v_c);
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
    values ('e1900000-0000-4000-e000-00000000000a', v_c, 'adjust', 20, 120000, 'Opening');
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values ('e1900000-0000-4000-e000-00000000000a', v_c, 'e1900000-0000-4000-e000-0000000000a1',
            (select id from public.addresses where customer_id = v_c), '2027-03-02', 'active');
  end loop;
end $$;

-- ===========================================================================
-- Engine health + Freeze now by a manager
-- ===========================================================================
select set_config('app.now', '2027-03-01 21:30:00+05:30', true);
update public.engine_heartbeats set last_ok_at = private.now() where job in ('tiffin-lock-due-slots', 'tiffin-nightly', 'tiffin-owner-summary');
delete from cron.job_run_details;
select private.record_engine_error('e1900000-0000-4000-e000-00000000000a', 'lock', '2027-03-02', 'lunch', 'XX000', 'simulated lock failure');
select is((public.ops_health() -> 'checks' ->> 'engine_errors')::integer >= 1, true, 'an open lock error (wave 1) is counted by ops_health');
select is((public.ops_health() ->> 'ok')::boolean, false, 'and makes the platform unhealthy');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1900000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.freeze_slot('e1900000-0000-4000-e000-00000000000a', '2027-03-02', 'lunch') $$, '42501', 'forbidden',
  'staff cannot freeze');
select set_config('request.jwt.claims', '{"sub":"e1900000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select is((public.freeze_slot('e1900000-0000-4000-e000-00000000000a', '2027-03-02', 'lunch') ->> 'already_locked')::boolean, false,
  'a manager freezes the slot (wave 2 roles)');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select count(*) from public.count_snapshots where kitchen_id = 'e1900000-0000-4000-e000-00000000000a'
           and service_date = '2027-03-02' and slot = 'lunch'), 1::bigint, 'the count is frozen');
select is((select count(*) from public.engine_errors where kitchen_id = 'e1900000-0000-4000-e000-00000000000a' and resolved_at is null),
  0::bigint, 'and the lock error is closed');
select is((public.ops_health() -> 'checks' ->> 'engine_errors')::integer, 0, 'so ops_health no longer counts it');

-- ===========================================================================
-- Wave 4's plan-price job through run_job
-- ===========================================================================
select is((select count(*) from public.engine_heartbeats where job = 'tiffin-plan-prices'), 1::bigint, 'tiffin-plan-prices has a heartbeat row');
select is((select command from cron.job where jobname = 'tiffin-plan-prices'), 'select private.run_job(''tiffin-plan-prices'')',
  'and runs through private.run_job');
insert into public.plan_prices (kitchen_id, plan_id, price_per_meal_paise, effective_from, created_at)
values ('e1900000-0000-4000-e000-00000000000a', 'e1900000-0000-4000-e000-0000000000a1', 7000, '2027-03-02', private.now());
select set_config('app.now', '2027-03-02 00:05:00+05:30', true);
select lives_ok($$ select private.run_job('tiffin-plan-prices') $$, 'the job runs');
select is((select price_per_meal_paise from public.plans where id = 'e1900000-0000-4000-e000-0000000000a1'), 7000,
  'the scheduled price is today''s price (wave 4)');
select is((select last_ok_at from public.engine_heartbeats where job = 'tiffin-plan-prices'), private.now(), 'and the heartbeat is stamped (ops)');

-- ===========================================================================
-- Erasure: change requests (wave 2) and refused rider actions (held-back apps)
-- ===========================================================================
insert into public.change_requests (kitchen_id, customer_id, type, from_date, note, requested_by)
values ('e1900000-0000-4000-e000-00000000000a', (select v from ids where k = 'c1'), 'skip', '2027-03-05',
        'Esha goes to her aunt in Cuttack', 'e1900000-0000-4000-e000-000000000004');
update public.change_requests set decision_note = 'Esha called to confirm'
where customer_id = (select v from ids where k = 'c1');
insert into public.change_requests (kitchen_id, customer_id, type, from_date, note, requested_by)
values ('e1900000-0000-4000-e000-00000000000a', (select v from ids where k = 'c2'), 'skip', '2027-03-05',
        'Sam is away', 'e1900000-0000-4000-e000-000000000004');
insert into public.rider_sync_rejects (kitchen_id, rider_id, client_op, action, error_code, summary, acted_at, refused_at, customer_id)
values ('e1900000-0000-4000-e000-00000000000a', 'e1900000-0000-4000-e000-000000000004', gen_random_uuid(), 'complete', 'otp_wrong',
        '{"note":"Esha was not home","stop_label":"Erased Esha","proof":"otp"}', private.now(), private.now(), (select v from ids where k = 'c1'));
update public.rider_sync_rejects set resolution_note = 'Called Esha' where customer_id = (select v from ids where k = 'c1');
select is((select count(*) from public.audit_log a where a.table_name = 'change_requests' and a.action = 'UPDATE'
           and a.after ? 'decision_note' and not a.after ? 'from_date'), 1::bigint,
  'a change request update keeps only the changed keys (lean audit)');

update public.subscriptions set status = 'cancelled' where customer_id = (select v from ids where k = 'c1');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1900000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.erase_customer((select v from ids where k = 'c1')) $$, 'the owner erases Esha');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select coalesce(note, '') || coalesce(decision_note, '') from public.change_requests where customer_id = (select v from ids where k = 'c1')),
  '', 'her change request notes are blank');
select is((select note from public.change_requests where customer_id = (select v from ids where k = 'c2')), 'Sam is away',
  'another customer''s request is untouched');
select is((select summary from public.rider_sync_rejects where customer_id = (select v from ids where k = 'c1')), '{"proof":"otp"}'::jsonb,
  'the refused action keeps its facts, not the stop label or the rider''s note');
select is((select resolution_note from public.rider_sync_rejects where customer_id = (select v from ids where k = 'c1')), null,
  'nor the owner''s note');
select is((select count(*) from public.audit_log a where a.table_name in ('change_requests', 'rider_sync_rejects')
           and (a.before::text ~ '(Cuttack|Esha)' or a.after::text ~ '(Cuttack|Esha)')), 0::bigint,
  'no audit row still names her or her notes');

select * from finish();
rollback;
