-- M1 tests: kitchen creation, invites, customer RPCs, platform_sourced guard,
-- append-only audit log, FSSAI gate, and the 50-row import with 3 bad rows.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Extra auth users for this test (rolled back at the end).
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-b000-000000000100', 'authenticated',
   'authenticated', '919000000100', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-b000-000000000101', 'authenticated',
   'authenticated', '919000000101', now(), now(), now());

-- ===========================================================================
-- create_kitchen
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-b000-000000000101","role":"authenticated"}', true);

select is((select count(*) from public.kitchens), 0::bigint, 'new user has no kitchens');
select lives_ok($$select public.create_kitchen('Ghar Ka Khana!', null, 'Nayapalli', null, null, null, null, 'Asha')$$,
  'new user creates a kitchen');
select is((select slug from public.kitchens), 'ghar-ka-khana', 'slug derived from name');
select is((select role::text from public.members), 'owner', 'creator is owner');
select is((select count(*) from public.kitchen_settings), 1::bigint, 'default settings created');
select is((select low_balance_meals from public.kitchen_settings), 3, 'low balance default is 3 meals');
select is((select cutoff_lunch::text || '/' || cutoff_lunch_prev_day::text from public.kitchens), '21:00:00/true',
  'lunch cutoff defaults to 21:00 the previous day');
select is((select cutoff_dinner::text || '/' || cutoff_dinner_prev_day::text from public.kitchens), '12:00:00/false',
  'dinner cutoff defaults to 12:00 the same day');
select throws_ok($$select public.create_kitchen('Another', 'maa-tarini-tiffin')$$, '23505', 'slug_taken',
  'explicit slug must be unique');
select throws_ok($$update public.kitchens set fssai_no = '123'$$, '23514', null,
  'FSSAI number must be 14 digits');

-- ===========================================================================
-- Invites and members (owner A)
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);

select is(public.invite_member('10000000-0000-4000-a000-00000000000a', '90000 00102', 'staff', 'New cook') ->> 'status',
  'invited', 'unknown phone gets a pending invite');
select is(public.invite_member('10000000-0000-4000-a000-00000000000a', '+91 90000 00012', 'rider', 'Mamata') ->> 'status',
  'added', 'existing user (kitchen B staff) is added directly');
select throws_ok($$select public.invite_member('10000000-0000-4000-a000-00000000000a', '+919000000012', 'rider')$$,
  '23505', 'already_member', 'cannot add the same person twice');
select throws_ok($$select public.invite_member('10000000-0000-4000-a000-00000000000a', '12345', 'staff')$$,
  '22023', 'invalid_phone', 'invalid phone rejected');
select throws_ok($$select public.invite_member('10000000-0000-4000-a000-00000000000a', '9000000103', 'owner')$$,
  '22023', 'cannot_invite_owner', 'cannot invite a second owner');
select throws_ok($$select public.set_member_role(
    (select id from public.members where role = 'owner' and kitchen_id = '10000000-0000-4000-a000-00000000000a'), 'staff')$$,
  '22023', 'owner_role_locked', 'owner cannot be demoted');
select lives_ok($$select public.set_member_role(
    (select id from public.members where user_id = '00000000-0000-4000-a000-000000000003'), 'staff')$$,
  'owner can change rider to staff');

-- The seeded rider invite for +919000000100 is claimed on that user's first login.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-b000-000000000100","role":"authenticated"}', true);
select is(public.claim_invites(), 1, 'pending invite claimed');
select is((select role::text from public.members where user_id = '00000000-0000-4000-b000-000000000100'), 'rider',
  'claimed invite becomes a rider membership');
select is(public.claim_invites(), 0, 'claiming again is a no-op');

-- Staff cannot manage members.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.invite_member('10000000-0000-4000-a000-00000000000a', '9000000104', 'staff')$$,
  '42501', 'forbidden', 'staff cannot invite');

-- ===========================================================================
-- Customer RPCs (owner A)
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);

select throws_ok($$select public.create_customer('10000000-0000-4000-a000-00000000000a', 'No Consent', '9876500001', false)$$,
  '22023', 'consent_required', 'consent is required');
select throws_ok($$select public.create_customer('10000000-0000-4000-a000-00000000000a', 'Bad Phone', '12345', true)$$,
  '22023', 'invalid_phone', 'invalid phone rejected');
select throws_ok($$select public.create_customer('10000000-0000-4000-a000-00000000000a', 'Dup', '098610 00001', true)$$,
  '23505', 'already_exists', 'duplicate phone in the same kitchen rejected (any format)');
select lives_ok($$select public.create_customer('10000000-0000-4000-a000-00000000000a', 'Mitali Kar', '+91-98765-00001', true,
  'jain', 'or', 'Less spicy', '{"line1":"Flat 3B","area":"Patia","landmark":"Near water tank","lat":20.355,"lng":85.82}')$$,
  'owner creates a customer with address');
select is((select phone from public.customers_v where name = 'Mitali Kar'), '+919876500001', 'phone stored normalised');
select is((select landmark from public.customers_v where name = 'Mitali Kar'), 'Near water tank', 'default address saved');
select is((select count(*) from public.consents c join public.customers_v v on v.id = c.customer_id
           where v.name = 'Mitali Kar'), 1::bigint, 'consent recorded');

select lives_ok($$select public.update_customer((select id from public.customers_v where name = 'Mitali Kar'),
  '{"phone":"9876500002","notes":"Extra roti"}')$$, 'owner updates phone and notes');
select is((select phone from public.customers_v where name = 'Mitali Kar'), '+919876500002', 'phone updated');
select throws_ok($$select public.erase_customer((select id from public.customers_v where name = 'Ankit Das'))$$,
  '22023', 'has_live_subscription', 'cannot erase a customer with a live subscription');
select lives_ok($$select public.erase_customer((select id from public.customers_v where name = 'Mitali Kar'))$$,
  'owner erases a customer without subscriptions');
select is((select count(*) from public.customers_v where name = 'Mitali Kar'), 0::bigint, 'erased customer hidden');

-- Address default switching
select lives_ok($$insert into public.addresses (kitchen_id, customer_id, line1, area, is_default)
  select kitchen_id, id, 'Office', 'Infocity', true from public.customers_v where name = 'Ankit Das'$$,
  'owner adds a second address as default');
select is((select count(*) from public.addresses a join public.customers_v v on v.id = a.customer_id
           where v.name = 'Ankit Das' and a.is_default), 1::bigint, 'only one default address');

-- Subscriptions: owner cannot set engine-owned states.
select throws_ok($$insert into public.subscriptions (kitchen_id, customer_id, plan_id, start_date, status)
  select kitchen_id, id, '20000000-0000-4000-a000-0000000000a1', current_date, 'paused'
  from public.customers_v where name = 'Ankit Das'$$, '22023', 'invalid_initial_status',
  'new subscriptions start as trial or active only');
select throws_ok($$insert into public.subscriptions (kitchen_id, customer_id, plan_id, start_date)
  select kitchen_id, id, '20000000-0000-4000-a000-0000000000b1', current_date
  from public.customers_v where name = 'Ankit Das'$$, '23503', null,
  'cannot subscribe a kitchen A customer to a kitchen B plan (composite FK)');

-- ===========================================================================
-- Import: 50 rows, 3 bad -> 47 saved, 3 reported
-- ===========================================================================
create temp table import_result as
select public.import_customers(
  '10000000-0000-4000-a000-00000000000a',
  (
    select jsonb_agg(
      case i
        when 10 then jsonb_build_object('name', 'Bad Phone', 'phone', '12345')
        when 25 then jsonb_build_object('name', '', 'phone', '9777000025')
        when 40 then jsonb_build_object('name', 'Duplicate Of Row 1', 'phone', '9777000001')
        else jsonb_build_object(
          'name', 'Import Customer ' || i,
          'phone', '9777' || lpad(i::text, 6, '0'),
          'diet', case when i % 5 = 0 then 'Non-Veg' else 'veg' end,
          'language', 'Odia',
          'area', 'Patia', 'landmark', 'Lane ' || i,
          'plan', case when i % 2 = 0 then 'veg lunch' end,
          'start_date', case when i % 2 = 0 then '2026-11-02' end)
      end order by i)
    from generate_series(1, 50) i
  ),
  true,
  'customers.xlsx') as r;
grant select on import_result to authenticated;

select is((select (r ->> 'imported')::int from import_result), 47, '47 rows imported');
select is((select (r ->> 'failed')::int from import_result), 3, '3 rows failed');
select is((select jsonb_path_query_array(r, '$.errors[*].row') from import_result), '[10, 25, 40]'::jsonb,
  'the bad rows are reported by row number');
select is((select r -> 'errors' -> 0 -> 'errors' from import_result), '["invalid_phone"]'::jsonb, 'row 10: invalid phone');
select is((select r -> 'errors' -> 1 -> 'errors' from import_result), '["name_required"]'::jsonb, 'row 25: name required');
select is((select r -> 'errors' -> 2 -> 'errors' from import_result), '["duplicate_in_file"]'::jsonb, 'row 40: duplicate in file');
select is((select count(*) from public.customers_v where name like 'Import Customer %'), 47::bigint,
  '47 imported customers visible');
select is((select count(*) from public.subscriptions s join public.customers_v v on v.id = s.customer_id
           where v.name like 'Import Customer %'), 23::bigint, 'subscriptions created for good rows with a plan (25 even rows minus bad rows 10 and 40)');
select is((select count(*) from public.customers_v where name like 'Import Customer %' and diet = 'nonveg'), 7::bigint,
  'diet parsed from free text (multiples of 5, minus bad rows 10, 25, 40)');
select is((select imported_rows || '/' || error_rows from public.import_batches where file_name = 'customers.xlsx'), '47/3',
  'batch totals recorded');
select is((select count(*) from public.import_rows where raw ? 'phone'), 0::bigint,
  'import rows never store the full phone number');

-- Re-importing the same file: every row is now a duplicate of an existing customer.
select is((public.import_customers('10000000-0000-4000-a000-00000000000a',
  '[{"name":"Import Customer 1","phone":"9777000001"},{"name":"Bad plan","phone":"9777000099","plan":"Gold"}]'::jsonb,
  true) -> 'errors'), '[{"row":1,"errors":["already_exists"]},{"row":2,"errors":["unknown_plan"]}]'::jsonb,
  'existing phones and unknown plans are reported');

-- ===========================================================================
-- Guards (checked as postgres with a user's JWT claims, so table grants don't mask the trigger)
-- ===========================================================================
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok($$update public.customers set platform_sourced = true where name = 'Ankit Das'$$,
  '42501', 'platform_sourced_protected', 'an owner cannot mark a customer platform-sourced');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select lives_ok($$update public.customers set platform_sourced = true where name = 'Ankit Das'$$,
  'platform admin can mark a customer platform-sourced');
select throws_ok($$update public.customers set platform_sourced = false where name = 'Ankit Das'$$,
  '42501', 'platform_sourced_is_permanent', 'platform_sourced can never be turned off');

select throws_ok($$update public.audit_log set action = 'DELETE'$$, 'P0001', 'audit_log is append-only',
  'audit log rows cannot be edited');
select throws_ok($$delete from public.audit_log$$, 'P0001', 'audit_log is append-only',
  'audit log rows cannot be deleted');
select is((select count(*) from public.audit_log where after ? 'phone_enc' or before ? 'phone_enc'), 0::bigint,
  'audit log never contains phone ciphertext');
select ok((select count(*) from public.audit_log where table_name = 'customers' and action = 'UPDATE'
           and actor_id = '00000000-0000-4000-a000-000000000001') >= 1, 'customer updates are audited with the actor');

-- FSSAI gate
set local role authenticated;
select throws_ok($$select public.set_kitchen_status('10000000-0000-4000-a000-00000000000b', 'active')$$,
  '23514', null, 'a kitchen without FSSAI cannot go live');
select lives_ok($$select public.set_kitchen_status('10000000-0000-4000-a000-00000000000a', 'active')$$,
  'a kitchen with FSSAI can go live');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.set_kitchen_status('10000000-0000-4000-a000-00000000000a', 'suspended')$$,
  '42501', 'forbidden', 'only platform admins change kitchen status');

select * from finish();
rollback;
