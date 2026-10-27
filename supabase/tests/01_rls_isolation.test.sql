-- M1 test: kitchen A can never read or write kitchen B, and roles only see what they should.
-- Users and kitchens come from supabase/seed.sql.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Fixed ids from seed.sql
--   kitchen A 10000000-0000-4000-a000-00000000000a, kitchen B …0b
--   A owner …01, A staff …02, A rider …03, B owner …11, admin …99

-- ===========================================================================
-- Kitchen A staff
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated"}', true);

select is((select count(*) from public.kitchens), 1::bigint, 'staff A sees only kitchen A');
select is((select count(*) from public.customers_v), 20::bigint, 'staff A sees the 20 kitchen A customers');
select is((select count(*) from public.customers_v where kitchen_id = '10000000-0000-4000-a000-00000000000b'), 0::bigint,
  'staff A sees no kitchen B customers (view)');
select is((select count(*) from public.customers where kitchen_id = '10000000-0000-4000-a000-00000000000b'), 0::bigint,
  'staff A sees no kitchen B customers (table)');
select is((select count(*) from public.addresses where kitchen_id = '10000000-0000-4000-a000-00000000000b'), 0::bigint,
  'staff A sees no kitchen B addresses');
select is((select count(*) from public.members where kitchen_id = '10000000-0000-4000-a000-00000000000b'), 0::bigint,
  'staff A sees no kitchen B members');
select is((select count(*) from public.plans), 0::bigint, 'staff cannot see plans (prices are money)');
select is((select count(*) from public.subscriptions), 0::bigint, 'staff cannot see subscriptions');
select is((select count(*) from public.audit_log), 0::bigint, 'staff cannot read the audit log');
select is((select count(*) from public.member_invites), 0::bigint, 'staff cannot see invites');

select throws_ok('select phone_enc from public.customers limit 1', '42501', null,
  'staff cannot select encrypted phone column');
select throws_ok('select phone_hash from public.customers limit 1', '42501', null,
  'staff cannot select phone hash column');
select ok((select bool_and(phone like '+91 ••••••%') from public.customers_v),
  'staff see masked phone numbers only');
select is(public.customer_phone((select id from public.customers_v limit 1)) like '+91 ••••••%', true,
  'customer_phone() masks for staff');
select throws_ok($$select public.reveal_customer_phone((select id from public.customers_v limit 1))$$,
  '42501', 'forbidden', 'staff cannot reveal a phone number');

select throws_ok($$select public.create_customer('10000000-0000-4000-a000-00000000000a', 'X', '9876543210', true)$$,
  '42501', 'forbidden', 'staff cannot create customers');
select throws_ok($$select public.search_customers('10000000-0000-4000-a000-00000000000b', '')$$,
  '42501', 'forbidden', 'staff A cannot search kitchen B');
select is((select count(*) from public.search_customers('10000000-0000-4000-a000-00000000000a', '9861000001')), 0::bigint,
  'staff cannot look customers up by full phone number');
select is((select count(*) from public.search_customers('10000000-0000-4000-a000-00000000000a', '0001')), 1::bigint,
  'staff can search by last 4 digits');

select throws_ok($$update public.customers set name = 'hacked'$$, '42501', null,
  'customers have no direct update grant');
select throws_ok($$insert into public.addresses (kitchen_id, customer_id, line1)
  select kitchen_id, id, 'x' from public.customers limit 1$$, '42501', null,
  'staff cannot add addresses');

-- Updates through RLS silently match zero rows; verify nothing changed afterwards.
select lives_ok($$update public.kitchens set name = 'Hijacked' where id = '10000000-0000-4000-a000-00000000000b'$$,
  'update on kitchen B runs');
select lives_ok($$update public.kitchens set name = 'Staff rename' where id = '10000000-0000-4000-a000-00000000000a'$$,
  'update on own kitchen as staff runs');

-- ===========================================================================
-- Kitchen A rider
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.customers_v), 0::bigint, 'rider sees no customers in M1');
select is((select count(*) from public.addresses), 0::bigint, 'rider sees no addresses in M1');
select is((select count(*) from public.kitchens), 1::bigint, 'rider sees own kitchen');

-- ===========================================================================
-- Kitchen A owner
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.customers_v), 20::bigint, 'owner A sees 20 customers');
select is((select phone from public.customers_v where name = 'Subhashree Mohanty'), '+919861000001',
  'owner sees full phone number');
select is((select count(*) from public.plans), 3::bigint, 'owner A sees own 3 plans');
select is((select count(*) from public.subscriptions), 20::bigint, 'owner A sees own 20 subscriptions');
select ok((select count(*) from public.audit_log) > 0, 'owner can read own audit log');
select is((select count(*) from public.audit_log where kitchen_id = '10000000-0000-4000-a000-00000000000b'), 0::bigint,
  'owner A cannot read kitchen B audit log');
select is((select count(*) from public.search_customers('10000000-0000-4000-a000-00000000000a', '+91 98610 00001')), 1::bigint,
  'owner can find a customer by full phone number');
select is((select count(*) from public.search_customers('10000000-0000-4000-a000-00000000000a', 'patia')), 6::bigint,
  'owner can search by area');
select throws_ok($$update public.kitchens set status = 'active'$$, '42501', null,
  'owner cannot change kitchen status (column grant)');
select throws_ok($$insert into public.plans (kitchen_id, name, slots, price_per_meal_paise)
  values ('10000000-0000-4000-a000-00000000000b', 'Sneaky', '{lunch}', 100)$$, '42501', null,
  'owner A cannot create a plan in kitchen B');
select throws_ok($$select public.create_customer('10000000-0000-4000-a000-00000000000b', 'X', '9876543210', true)$$,
  '42501', 'forbidden', 'owner A cannot create customers in kitchen B');
select throws_ok($$select public.import_customers('10000000-0000-4000-a000-00000000000b', '[]'::jsonb, true)$$,
  '42501', 'forbidden', 'owner A cannot import into kitchen B');
select is(public.customer_phone((select id from public.customers where kitchen_id = '10000000-0000-4000-a000-00000000000b' limit 1)),
  null, 'owner A gets nothing from customer_phone() for a kitchen B customer');

-- ===========================================================================
-- Kitchen B owner
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select is((select count(*) from public.customers_v), 10::bigint, 'owner B sees 10 customers');
select is((select count(*) from public.customers_v where kitchen_id = '10000000-0000-4000-a000-00000000000a'), 0::bigint,
  'owner B sees no kitchen A customers');

-- ===========================================================================
-- Platform admin
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select is((select count(*) from public.customers_v), 30::bigint, 'admin sees all kitchens');
select ok((select bool_and(phone like '+91 ••••••%') from public.customers_v), 'admin sees masked phones by default');
select is(public.reveal_customer_phone((select id from public.customers where name = 'Ankit Das')), '+919861000002',
  'admin can reveal a phone number');

-- ===========================================================================
-- Anonymous
-- ===========================================================================
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok('select count(*) from public.customers', '42501', null, 'anon cannot read customers');
select throws_ok('select count(*) from public.kitchens', '42501', null, 'anon cannot read kitchens');
select throws_ok($$select public.create_kitchen('Anon kitchen')$$, '42501', null, 'anon cannot create kitchens');

-- ===========================================================================
-- Verify as postgres
-- ===========================================================================
reset role;
select is((select name from public.kitchens where id = '10000000-0000-4000-a000-00000000000b'), 'Saheed Nagar Mess',
  'kitchen B name unchanged by staff A');
select is((select name from public.kitchens where id = '10000000-0000-4000-a000-00000000000a'), 'Maa Tarini Tiffin',
  'kitchen A name unchanged by staff A');
select is((select count(*) from public.audit_log where action = 'ACCESS' and table_name = 'customers'
           and actor_id = '00000000-0000-4000-a000-000000000099'), 1::bigint,
  'admin phone reveal is logged');

select * from finish();
rollback;
