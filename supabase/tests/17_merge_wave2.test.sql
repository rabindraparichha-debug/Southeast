-- Merge of vendor-first wave 2 (D-156) into m9-p5-p6 (wave 1, held-back apps, wave 4):
-- 20261130000100_merge_wave2.sql and the cross-wave behaviour it must keep.
--   * wave 1 + wave 2: private.nightly keeps wave 1's error isolation and wave 2's prepaid-only auto-cancel;
--   * wave 4 + wave 2: dues after a dated price change keep each meal's own price (D-144) for prepaid and
--     monthly customers; managers set prices, accountants read them, neither exports the kitchen (D-142);
--     the export carries billing_mode;
--   * held-back apps + wave 2: a manager who delivers can report a refused action and read the list;
--   * role helper overloads stay executable for the RLS policies that call them.
-- Roles: owner, manager, accountant, staff, rider, another kitchen's owner, anon.
-- Calendar: Mon 9 Nov 2026; lunch cutoff 21:00 the day before.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen M (owner, manager, accountant, staff, rider) and kitchen N (owner).
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(), now(), now()
from (values
  ('e1700000-0000-4000-e000-000000000001'::uuid, '919317000001'),   -- owner M
  ('e1700000-0000-4000-e000-000000000002'::uuid, '919317000002'),   -- manager M
  ('e1700000-0000-4000-e000-000000000003'::uuid, '919317000003'),   -- accountant M
  ('e1700000-0000-4000-e000-000000000004'::uuid, '919317000004'),   -- staff M
  ('e1700000-0000-4000-e000-000000000005'::uuid, '919317000005'),   -- rider M
  ('e1700000-0000-4000-e000-000000000006'::uuid, '919317000006')    -- owner N
) as u(id, phone);
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('e1700000-0000-4000-e000-00000000000a', 'Merge Kitchen', 'merge-kitchen-w2', 'e1700000-0000-4000-e000-000000000001', '{}'),
  ('e1700000-0000-4000-e000-00000000000b', 'Other Merge Kitchen', 'other-merge-kitchen-w2', 'e1700000-0000-4000-e000-000000000006', '{}');
insert into public.kitchen_settings (kitchen_id, credit_limit_meals) values
  ('e1700000-0000-4000-e000-00000000000a', 100), ('e1700000-0000-4000-e000-00000000000b', 100);
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('e1700000-0000-4000-e000-00000000000a', 'e1700000-0000-4000-e000-000000000001', 'owner', 'Owner M'),
  ('e1700000-0000-4000-e000-00000000000a', 'e1700000-0000-4000-e000-000000000002', 'manager', 'Manager M'),
  ('e1700000-0000-4000-e000-00000000000a', 'e1700000-0000-4000-e000-000000000003', 'accountant', 'Accountant M'),
  ('e1700000-0000-4000-e000-00000000000a', 'e1700000-0000-4000-e000-000000000004', 'staff', 'Staff M'),
  ('e1700000-0000-4000-e000-00000000000a', 'e1700000-0000-4000-e000-000000000005', 'rider', 'Rider M'),
  ('e1700000-0000-4000-e000-00000000000b', 'e1700000-0000-4000-e000-000000000006', 'owner', 'Owner N');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('e1700000-0000-4000-e000-0000000000a1', 'e1700000-0000-4000-e000-00000000000a', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 7000);

select set_config('app.now', '2026-11-09 08:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
create temp table vals (k text primary key, v jsonb);
grant select, insert, update on ids, vals to authenticated, anon;

-- One prepaid and one monthly customer, both from Tuesday 10 Nov, nothing paid.
do $$
declare
  v_c uuid;
  v_mode text;
begin
  foreach v_mode in array array['prepaid', 'monthly'] loop
    v_c := private.insert_customer('e1700000-0000-4000-e000-00000000000a', 'Merge ' || v_mode,
      case v_mode when 'prepaid' then '+919317100001' else '+919317100002' end, 'veg', 'en', null,
      jsonb_build_object('line1', 'House ' || v_mode, 'area', 'Patia'), 'vendor', 'vendor');
    update public.customers set billing_mode = v_mode::public.billing_mode where id = v_c;
    insert into ids values (v_mode, v_c);
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values ('e1700000-0000-4000-e000-00000000000a', v_c, 'e1700000-0000-4000-e000-0000000000a1',
            (select id from public.addresses where customer_id = v_c), '2026-11-10', 'active');
  end loop;
end $$;
select is((select array_agg(billing_mode::text order by billing_mode::text) from public.customers
           where kitchen_id = 'e1700000-0000-4000-e000-00000000000a'), array['monthly', 'prepaid'], 'one customer of each billing mode');

-- ===========================================================================
-- 1. Dated plan prices (wave 4) with wave 2's roles.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000002","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into vals select 'p12', public.set_plan_price('e1700000-0000-4000-e000-0000000000a1', 8000, '2026-11-12');
select is((select (v ->> 'scheduled')::boolean from vals where k = 'p12'), true, 'a manager schedules ₹80 from Thursday 12 Nov');
select is((select count(*) from public.plan_prices where plan_id = 'e1700000-0000-4000-e000-0000000000a1'), 2::bigint,
  'and reads the dated prices');
select throws_ok($$ select public.export_kitchen('e1700000-0000-4000-e000-00000000000a', 'customers') $$, '42501', 'forbidden',
  'a manager cannot export the kitchen (exact owner, D-142)');

select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000003","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select count(*) from public.plan_prices where plan_id = 'e1700000-0000-4000-e000-0000000000a1'), 2::bigint,
  'an accountant reads the dated prices (plans and money are theirs to read)');
select throws_ok($$ select public.set_plan_price('e1700000-0000-4000-e000-0000000000a1', 9000, '2026-11-20') $$, '42501', 'forbidden',
  'but cannot change them');
select throws_ok($$ select public.export_kitchen('e1700000-0000-4000-e000-00000000000a', 'payments') $$, '42501', 'forbidden',
  'and never exports the kitchen');

select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000004","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select count(*) from public.plan_prices), 0::bigint, 'staff see no prices');
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000005","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select count(*) from public.plan_prices), 0::bigint, 'riders see no prices');
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000006","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select count(*) from public.plan_prices where kitchen_id = 'e1700000-0000-4000-e000-00000000000a'), 0::bigint,
  'another kitchen''s owner sees none of them');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select count(*) from public.plan_prices $$, '42501', null, 'anon cannot read prices');
reset role;

-- Export (owner): the customers part carries wave 2's billing_mode.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000001","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into vals select 'exp', public.export_kitchen('e1700000-0000-4000-e000-00000000000a', 'customers');
reset role;
select is((select array_agg(r ->> 'billing_mode' order by r ->> 'billing_mode') from vals, jsonb_array_elements(v -> 'rows') r where k = 'exp'),
  array['monthly', 'prepaid'], 'the owner''s export has each customer''s billing mode');

-- ===========================================================================
-- 2. Dues after the price change keep each meal's own price (D-144), both billing modes.
-- ===========================================================================
select private.lock_slot('e1700000-0000-4000-e000-00000000000a', d::date, 'lunch')
from generate_series('2026-11-10'::date, '2026-11-12'::date, interval '1 day') d;
select is((select array_agg(o.price_per_meal_paise order by o.service_date) from public.meal_orders o
           where o.customer_id = (select v from ids where k = 'prepaid') and o.locked_at is not null),
  array[7000, 7000, 8000], 'Tue and Wed at ₹70, Thu at ₹80');
select set_config('app.now', '2026-11-12 00:10:00+05:30', true);
select is(private.apply_plan_prices(), 1, 'the daily job makes ₹80 the plan price');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000001","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select amount_owed_paise from public.dues_list('e1700000-0000-4000-e000-00000000000a') where customer_id = (select v from ids where k = 'prepaid')),
  2 * 7000 + 8000, 'prepaid dues: owed meals at their own prices, not today''s ₹80');
select is((select amount_owed_paise from public.dues_list('e1700000-0000-4000-e000-00000000000a') where customer_id = (select v from ids where k = 'monthly')),
  2 * 7000 + 8000, 'monthly dues: the rupee ledger');
select is((select meals_owed from public.dues_list('e1700000-0000-4000-e000-00000000000a') where customer_id = (select v from ids where k = 'prepaid')),
  3, 'the prepaid customer owes 3 meals');
reset role;
select is((select status::text from public.subscriptions where customer_id = (select v from ids where k = 'monthly')), 'active',
  'the monthly customer is never stopped');

-- ===========================================================================
-- 3. Nightly: wave 1's error isolation + wave 2's prepaid-only auto-cancel.
-- ===========================================================================
select ok((select prosrc ~ 'record_engine_error' and prosrc ~ 'billing_mode' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname = 'nightly'), 'private.nightly has both waves');
select lives_ok($$ select private.nightly() $$, 'the nightly job runs');
select is((select count(*) from public.engine_errors where kitchen_id = 'e1700000-0000-4000-e000-00000000000a' and resolved_at is null),
  0::bigint, 'and records no errors for this kitchen');

-- ===========================================================================
-- 4. Held-back apps: a manager who delivers reports refused actions and reads the list.
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000002","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into ids select 'rej', public.report_sync_reject('e1700000-0000-4000-e000-0000000000f1', 'complete', 'already_done');
select isnt((select v from ids where k = 'rej'), null, 'a manager''s report without a kitchen finds their kitchen');
select is((select count(*) from public.sync_rejects('e1700000-0000-4000-e000-00000000000a')), 1::bigint, 'and the manager reads the list');
-- A rider's queued change request (wave 2, queue kind 'request') that the server refused is reported too.
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000005","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into ids select 'rej_req', public.report_sync_reject('e1700000-0000-4000-e000-0000000000f3', 'request', 'date_in_past',
  p_kitchen => 'e1700000-0000-4000-e000-00000000000a', p_summary => '{"note":"going home"}');
select isnt((select v from ids where k = 'rej_req'), null, 'a refused rider change request is reported');
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000001","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select action from public.sync_rejects('e1700000-0000-4000-e000-00000000000a') where id = (select v from ids where k = 'rej_req')),
  'request', 'and the owner sees it as a request');
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000003","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.report_sync_reject('e1700000-0000-4000-e000-0000000000f2', 'complete', 'already_done') $$, 'P0002', 'not_found',
  'an accountant has no delivery kitchen to report for');
select throws_ok($$ select * from public.sync_rejects('e1700000-0000-4000-e000-00000000000a') $$, '42501', 'forbidden',
  'nor reads the list');
select is((select count(*) from public.rider_sync_rejects), 0::bigint, 'nor the table');
select set_config('request.jwt.claims', '{"sub":"e1700000-0000-4000-e000-000000000004","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select count(*) from public.rider_sync_rejects), 0::bigint, 'staff see no reports (cash is money)');
reset role;

-- ===========================================================================
-- 5. Grants: the role helper overloads used by wave 2's exact-owner policies.
-- ===========================================================================
select ok(has_function_privilege('authenticated', 'private.kitchen_ids(public.member_role[], boolean)', 'execute'),
  'authenticated may run private.kitchen_ids(roles, exact)');
select ok(has_function_privilege('authenticated', 'private.has_role(uuid, public.member_role[], boolean)', 'execute'),
  'authenticated may run private.has_role(kitchen, roles, exact)');
select ok(has_function_privilege('authenticated', 'private.owner_kitchen_ids()', 'execute'),
  'authenticated may run private.owner_kitchen_ids() (wave 4)');
select ok(not has_function_privilege('anon', 'public.export_kitchen(uuid, text, integer, integer)', 'execute'),
  'anon cannot run export_kitchen');

select * from finish();
rollback;
