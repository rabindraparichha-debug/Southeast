-- Vendor-first wave 2: regressions for the integration review fixes (migration 20261108000900).
-- Owed-meal valuation and billing-mode round trips, void after a switch, nightly auto-cancel (prepaid
-- only, error-isolated), bills net of voids, import of monthly opening meals, invites, the customer
-- message gate at send time, accountant address hiding, conversations after phone changes, the
-- manager's outbox view and owner alerts copied to managers.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen R (monthly by default; Lunch ₹60), owner, manager, accountant, staff, rider;
-- kitchen S (another owner) for isolation.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'd1600000-0000-4000-d000-000000000001', 'authenticated', 'authenticated', '919316000001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1600000-0000-4000-d000-000000000002', 'authenticated', 'authenticated', '919316000002', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1600000-0000-4000-d000-000000000003', 'authenticated', 'authenticated', '919316000003', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1600000-0000-4000-d000-000000000004', 'authenticated', 'authenticated', '919316000004', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1600000-0000-4000-d000-000000000005', 'authenticated', 'authenticated', '919316000005', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1600000-0000-4000-d000-000000000006', 'authenticated', 'authenticated', '919316000006', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('d1600000-0000-4000-d000-00000000000a', 'Review Kitchen', 'review-kitchen', 'd1600000-0000-4000-d000-000000000001', '{}'),
  ('d1600000-0000-4000-d000-00000000000b', 'Other Kitchen', 'other-kitchen-16', 'd1600000-0000-4000-d000-000000000006', '{}');
insert into public.kitchen_settings (kitchen_id) values
  ('d1600000-0000-4000-d000-00000000000a'), ('d1600000-0000-4000-d000-00000000000b');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('d1600000-0000-4000-d000-00000000000a', 'd1600000-0000-4000-d000-000000000001', 'owner', 'Owner R'),
  ('d1600000-0000-4000-d000-00000000000a', 'd1600000-0000-4000-d000-000000000002', 'manager', 'Manager R'),
  ('d1600000-0000-4000-d000-00000000000a', 'd1600000-0000-4000-d000-000000000003', 'accountant', 'Accountant R'),
  ('d1600000-0000-4000-d000-00000000000a', 'd1600000-0000-4000-d000-000000000004', 'staff', 'Staff R'),
  ('d1600000-0000-4000-d000-00000000000a', 'd1600000-0000-4000-d000-000000000005', 'rider', 'Rider R'),
  ('d1600000-0000-4000-d000-00000000000b', 'd1600000-0000-4000-d000-000000000006', 'owner', 'Owner S');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('d1600000-0000-4000-d000-0000000000a1', 'd1600000-0000-4000-d000-00000000000a', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 6000);

select set_config('app.now', '2026-11-20 10:00:00+05:30', true);
create temp table cx (name text primary key, cust uuid, sub uuid);
grant select on cx to authenticated;
create function pg_temp.mk(p_name text, p_phone text, p_mode public.billing_mode, p_start date default '2026-11-02',
                           p_status public.subscription_status default 'active')
returns uuid language plpgsql as $$
declare v_c uuid; v_s uuid;
begin
  v_c := private.insert_customer('d1600000-0000-4000-d000-00000000000a', p_name, p_phone, 'veg', 'en', null,
                                 '{"line1":"Plot 7","area":"Sundarpada","landmark":"Temple"}', 'vendor', 'vendor', p_mode);
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
  values ('d1600000-0000-4000-d000-00000000000a', v_c, 'd1600000-0000-4000-d000-0000000000a1',
          (select id from public.addresses where customer_id = v_c), p_start, p_status)
  returning id into v_s;
  insert into cx values (p_name, v_c, v_s);
  return v_c;
end $$;
-- A charged meal (as the lock posts it): 1 meal at its own price.
create function pg_temp.meal(p_name text, p_price integer) returns void language sql as $$
  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, created_at)
  select 'd1600000-0000-4000-d000-00000000000a', cust, 'meal', -1, -p_price, 'meal_order', gen_random_uuid(), private.now()
  from cx where name = p_name;
$$;
create function pg_temp.as_user(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;

-- ===========================================================================
-- 1. Owed meals keep their value; billing-mode round trips are exact
-- ===========================================================================
select pg_temp.mk('Opening Owes', '+919316100001', 'prepaid');
select pg_temp.mk('Khata Import', '+919316100002', 'monthly');
select pg_temp.mk('Odd Dues', '+919316100003', 'monthly');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000001","role":"authenticated"}', true);
-- Prepaid: a notebook opening of 10 meals owed, then 3 meals eaten at ₹60.
select lives_ok($$select public.add_balance_entry((select cust from cx where name = 'Opening Owes'), 'adjust', -10, 'Opening balance')$$,
  'owner records 10 meals owed from the notebook');
reset role;
select pg_temp.meal('Opening Owes', 6000);
select pg_temp.meal('Opening Owes', 6000);
select pg_temp.meal('Opening Owes', 6000);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000001","role":"authenticated"}', true);
select is((select meals_owed || '/' || amount_owed_paise from public.dues_list('d1600000-0000-4000-d000-00000000000a')
           where customer_id = (select cust from cx where name = 'Opening Owes')), '13/78000',
  'prepaid dues: 3 meals at their price + 10 owed meals at the price per meal = ₹780 (not ₹180)');
select is((public.customer_statement((select cust from cx where name = 'Opening Owes'), '2026-11-01') ->> 'amount_due_paise')::int, 78000,
  'the statement shows the same ₹780 due');

-- Monthly with ₹1,200 imported dues → prepaid → monthly keeps the ₹1,200.
select lives_ok($$select public.add_balance_entry((select cust from cx where name = 'Khata Import'), 'adjust', 0, 'Opening dues', -120000)$$,
  'monthly opening dues of ₹1,200');
select is((public.set_billing_mode((select cust from cx where name = 'Khata Import'), 'prepaid') ->> 'balance_meals')::int, -20,
  'to prepaid: ₹1,200 owed at ₹60 = 20 meals owed');
select is((select amount_owed_paise from public.dues_list('d1600000-0000-4000-d000-00000000000a')
           where customer_id = (select cust from cx where name = 'Khata Import')), 120000,
  'the dues list still says ₹1,200 (the conversion row carries the rupees)');
select is((public.set_billing_mode((select cust from cx where name = 'Khata Import'), 'monthly') ->> 'balance_paise')::int, -120000,
  'back to monthly: still ₹1,200 owed (nothing erased)');

-- ₹800 at ₹60 rounds up to 14 meals owed; the round trip gives back ₹800, not ₹840.
select lives_ok($$select public.add_balance_entry((select cust from cx where name = 'Odd Dues'), 'adjust', 0, 'Opening dues', -80000)$$,
  'monthly dues of ₹800');
select is((public.set_billing_mode((select cust from cx where name = 'Odd Dues'), 'prepaid') ->> 'balance_meals')::int, -14,
  'to prepaid: 14 meals owed (rounded up)');
select is((public.set_billing_mode((select cust from cx where name = 'Odd Dues'), 'monthly') ->> 'balance_paise')::int, -80000,
  'back to monthly: exactly ₹800 owed');

-- ===========================================================================
-- 2. Void after a billing-mode switch
-- ===========================================================================
reset role;
select pg_temp.mk('Switcher', '+919316100004', 'monthly');
select pg_temp.mk('Monthly Payer', '+919316100005', 'monthly');
create temp table px (k text primary key, v uuid);
grant all on px to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000001","role":"authenticated"}', true);
insert into px select 'sw', public.record_payment((select cust from cx where name = 'Switcher'), 60000, 'cash');
select is((public.set_billing_mode((select cust from cx where name = 'Switcher'), 'prepaid') ->> 'balance_meals')::int, 10,
  'paid ₹600 while monthly, then prepaid: 10 meals');
select throws_ok($$select public.void_payment((select v from px where k = 'sw'), 'wrong customer')$$,
  '22023', 'billing_mode_changed', 'a payment from before the switch cannot be voided (its money is in the meal lot)');
select is((public.unused_meals_value((select cust from cx where name = 'Switcher')) ->> 'meals')::int, 10,
  'nothing changed: the 10 meals are still paid for, and still refundable once');
-- A monthly customer's void stays exact in rupees.
insert into px select 'mp', public.record_payment((select cust from cx where name = 'Monthly Payer'), 50000, 'upi_manual');
insert into px select 'mp2', public.record_payment((select cust from cx where name = 'Monthly Payer'), 50000, 'upi_manual');
select is((public.void_payment((select v from px where k = 'mp2'), 'entered twice') ->> 'balance_paise')::int, 50000,
  'a monthly customer''s duplicate payment is voided');

-- ===========================================================================
-- 5. Bills and statements: paid net of voids
-- ===========================================================================
select is((select (b ->> 'paid_paise')::int || '/' || (b ->> 'adjust_paise')::int
           from jsonb_array_elements(public.monthly_bills('d1600000-0000-4000-d000-00000000000a', '2026-11-01') -> 'bills') b
           where b ->> 'name' = 'Monthly Payer'), '50000/0',
  'bills: paid ₹500 (the voided ₹500 is not paid, and its reversal is not an adjustment)');
select is((select (t ->> 'paid_paise')::int || '/' || (t ->> 'voided_paise')::int
           from (select public.customer_statement((select cust from cx where name = 'Monthly Payer'), '2026-11-01') -> 'totals' as t) x),
  '50000/50000', 'statement: paid ₹500, ₹500 voided shown apart');

-- ===========================================================================
-- 6. Import: opening meals on a monthly row need a plan; no 0/0 rows
-- ===========================================================================
select is((public.import_customers('d1600000-0000-4000-d000-00000000000a',
  '[{"name":"Asha Plan","phone":"9316200001","balance":"10"},
    {"name":"Zero Dues","phone":"9316200002","dues":"0","balance":"0"},
    {"name":"Lunch Asha","phone":"9316200003","balance":"10","plan":"Lunch"}]', true) -> 'errors'),
  '[{"row": 1, "errors": ["balance_needs_plan"]}]'::jsonb,
  'a monthly row with opening meals and no plan is refused (the meals would be lost)');
select is((select count(*) from public.balance_entries b join public.customers c on c.id = b.customer_id
           where c.name = 'Zero Dues'), 0::bigint, 'no meaningless 0/0 ledger row');
select is((select sum(b.amount_paise)::int from public.balance_entries b join public.customers c on c.id = b.customer_id
           where c.name = 'Lunch Asha'), 60000, 'with a plan, 10 opening meals become a ₹600 advance');

-- ===========================================================================
-- 7. Invites: never a direct add; membership only through claim_invites in a code session
-- ===========================================================================
reset role;
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'd1600000-0000-4000-d000-0000000000e1', 'authenticated', 'authenticated', '919316300001', null, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1600000-0000-4000-d000-0000000000e2', 'authenticated', 'authenticated', '919316300002', now(), now(), now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000001","role":"authenticated"}', true);
select is(public.invite_member('d1600000-0000-4000-d000-00000000000a', '9316300001', 'manager') ->> 'status', 'invited',
  'an existing (pre-registered) account gets a pending invite, not a membership');
select is(public.invite_member('d1600000-0000-4000-d000-00000000000a', '9316300002', 'accountant') ->> 'status', 'invited',
  'the same for an account that signed in with a code before');
select is((select count(*) from public.members where kitchen_id = 'd1600000-0000-4000-d000-00000000000a'
           and user_id in ('d1600000-0000-4000-d000-0000000000e1', 'd1600000-0000-4000-d000-0000000000e2')), 0::bigint,
  'nobody joins at invite time');
select throws_ok($$select public.invite_member('d1600000-0000-4000-d000-00000000000a', '9316000004', 'rider')$$,
  '23505', 'already_member', 'someone already in the team cannot be invited again');
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-0000000000e1","role":"authenticated","amr":[{"method":"otp","timestamp":1}]}', true);
select is(public.claim_invites(), 0, 'an unconfirmed phone (password sign-up while "Confirm phone" is on) never claims');
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-0000000000e2","role":"authenticated","amr":[{"method":"password","timestamp":1}]}', true);
select is(public.claim_invites(), 0, 'nor a session signed in without a code');
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-0000000000e2","role":"authenticated","amr":[{"method":"otp","timestamp":1}]}', true);
select is(public.claim_invites(), 1, 'a code session claims it');
reset role;
select is((select string_agg(role::text, ',') from public.members where kitchen_id = 'd1600000-0000-4000-d000-00000000000a'
           and user_id in ('d1600000-0000-4000-d000-0000000000e1', 'd1600000-0000-4000-d000-0000000000e2')), 'accountant',
  'only the code session joined');

-- ===========================================================================
-- 8. Customer messages switched off: also at send time, and no webhook replies
-- ===========================================================================
update public.platform_settings set enabled = true where key = 'customer_whatsapp';
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, send_after) values
  ('d1600000-0000-4000-d000-00000000000a', 'whatsapp', 'customer', (select cust from cx where name = 'Switcher'), 'tomorrow_menu', '{}', 'r16:cust', private.now() - interval '1 minute'),
  ('d1600000-0000-4000-d000-00000000000a', 'whatsapp', 'member', 'd1600000-0000-4000-d000-000000000001', 'owner_daily_summary', '{}', 'r16:member', private.now() - interval '1 minute');
select is((select status from public.notifications_outbox where dedupe_key = 'r16:cust'), 'pending', 'queued while customer messages were on');
update public.platform_settings set enabled = false where key = 'customer_whatsapp';
select ok(exists (select 1 from public.wa_claim_outbox(100) c where c.template = 'owner_daily_summary'
                  and c.recipient_id = 'd1600000-0000-4000-d000-000000000001'), 'member alerts are still sent');
select is((select status || '/' || last_error from public.notifications_outbox where dedupe_key = 'r16:cust'),
  'cancelled/customer_messages_off', 'a customer row queued before the switch-off is not sent');
select is((public.wa_receive('wamid.r16_1', '919316100004', 'hi', '{}') ->> 'customer_messages')::boolean, false,
  'the webhook is told not to answer customers while the flag is off');
update public.platform_settings set enabled = true where key = 'customer_whatsapp';
select is((public.wa_receive('wamid.r16_2', '919316100004', 'hi', '{}') ->> 'customer_messages')::boolean, true,
  'and to answer them once it is on');
update public.platform_settings set enabled = false where key = 'customer_whatsapp';

-- ===========================================================================
-- 9. Accountants get no addresses from search_customers or register_sheet
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.search_customers('d1600000-0000-4000-d000-00000000000a', '', 200)
           where line1 is not null or area is not null or landmark is not null or lat is not null), 0::bigint,
  'accountant: no address fields in the customer search');
select ok((select count(*) from public.search_customers('d1600000-0000-4000-d000-00000000000a', '', 200)) > 0,
  'accountant still gets the customers (names, masked phones)');
select is((select count(*) from public.search_customers('d1600000-0000-4000-d000-00000000000a', 'Sundarpada', 200)), 0::bigint,
  'accountant cannot search by area');
select is((select count(*) from jsonb_array_elements(public.register_sheet('d1600000-0000-4000-d000-00000000000a', '2026-11-16', 7) -> 'rows') r
           where r ->> 'area' is not null or r ->> 'landmark' is not null), 0::bigint, 'accountant: no areas in the register');
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000004","role":"authenticated"}', true);
select ok((select count(*) from public.search_customers('d1600000-0000-4000-d000-00000000000a', 'Sundarpada', 200)) > 0,
  'staff still search by area (packing)');
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000001","role":"authenticated"}', true);
select ok((select count(*) from public.search_customers('d1600000-0000-4000-d000-00000000000a', '', 200) where area = 'Sundarpada') > 0,
  'owner sees addresses');
select ok((select count(*) from jsonb_array_elements(public.register_sheet('d1600000-0000-4000-d000-00000000000a', '2026-11-16', 7) -> 'rows') r
           where r ->> 'area' = 'Sundarpada') > 0, 'owner sees areas in the register');
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000006","role":"authenticated"}', true);
select throws_ok($$select public.search_customers('d1600000-0000-4000-d000-00000000000a', '', 10)$$, '42501', 'forbidden',
  'another kitchen''s owner cannot search');
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000005","role":"authenticated"}', true);
select throws_ok($$select public.register_sheet('d1600000-0000-4000-d000-00000000000a', '2026-11-16', 7)$$, '42501', 'forbidden',
  'a rider cannot read the register');
reset role;
set local role anon;
select throws_ok($$select public.search_customers('d1600000-0000-4000-d000-00000000000a', '', 10)$$, '42501', null,
  'anon cannot search customers');
reset role;

-- ===========================================================================
-- 10. Conversations follow phone changes and erasures
-- ===========================================================================
select pg_temp.mk('Old Number', '+919316400001', 'monthly');
select is((public.wa_receive('wamid.r16_3', '919316400001', 'hi', '{}') ->> 'status'), 'matched', 'Old Number chats from their phone');
create temp table tok (k text primary key, v text);
grant all on tok to authenticated, anon;
insert into tok select 'old', private.issue_magic_link((select cust from cx where name = 'Old Number'), 7);
select lives_ok($$select public.portal_get((select v from tok where k = 'old'))$$, 'their customer page opens');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.update_customer((select cust from cx where name = 'Old Number'), '{"phone":"9316400002"}')$$,
  'the owner changes their number');
reset role;
select is((select customer_id from public.conversations where kitchen_id = 'd1600000-0000-4000-d000-00000000000a'
           and wa_phone_hash = private.phone_hash('+919316400001')), null::uuid,
  'the old number''s conversation no longer points at them');
set local role anon;
select lives_ok($$select public.portal_get((select v from tok where k = 'old'))$$,
  'their customer page still opens after the number change (no forbidden)');
reset role;
-- A new customer on the old number gets that conversation, never the previous owner's data.
select pg_temp.mk('New Owner Of Number', '+919316400001', 'monthly');
select is((public.wa_receive('wamid.r16_4', '919316400001', 'hi', '{}') ->> 'status'), 'matched', 'the new customer messages');
select is((select customer_id from public.conversations where kitchen_id = 'd1600000-0000-4000-d000-00000000000a'
           and wa_phone_hash = private.phone_hash('+919316400001')), (select cust from cx where name = 'New Owner Of Number'),
  'the conversation is about the new customer');
-- Siblings on one phone: erasing the older one moves the chat to the younger one.
select pg_temp.mk('Elder Sibling', '+919316400003', 'monthly');
select pg_temp.mk('Younger Sibling', '+919316400003', 'monthly');
select is((public.wa_receive('wamid.r16_5', '919316400003', 'hi', '{}') ->> 'status'), 'matched', 'the family phone chats');
update public.subscriptions set status = 'cancelled', cancelled_at = private.now()
where id = (select sub from cx where name = 'Elder Sibling');  -- erasure needs no live plan
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.erase_customer((select cust from cx where name = 'Elder Sibling'))$$, 'the elder sibling is erased');
reset role;
select is((select customer_id from public.conversations where kitchen_id = 'd1600000-0000-4000-d000-00000000000a'
           and wa_phone_hash = private.phone_hash('+919316400003')), (select cust from cx where name = 'Younger Sibling'),
  'the chat moves to the sibling still on that phone');

-- ===========================================================================
-- 11. Managers do not read inbox replies through the outbox; 13. owner alerts reach managers
-- ===========================================================================
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key) values
  ('d1600000-0000-4000-d000-00000000000a', 'whatsapp', 'customer', (select cust from cx where name = 'Switcher'), 'vendor_message',
   '{"text":"private reply"}', 'r16:vm');
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key) values
  ('d1600000-0000-4000-d000-00000000000a', 'whatsapp', 'member', 'd1600000-0000-4000-d000-000000000001', 'production_sheet',
   '{"slot":"lunch"}', 'r16:sheet:owner');
select is((select count(*) from public.notifications_outbox where template = 'production_sheet'
           and recipient_id = 'd1600000-0000-4000-d000-000000000002'), 1::bigint, 'the manager gets a copy of the production sheet');
select is((select count(*) from public.notifications_outbox where template = 'production_sheet'
           and recipient_id in ('d1600000-0000-4000-d000-000000000003', 'd1600000-0000-4000-d000-000000000004')), 0::bigint,
  'accountant and staff do not');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.notifications_outbox where template = 'vendor_message'), 0::bigint,
  'the manager cannot read the owner''s inbox replies');
select ok((select count(*) from public.notifications_outbox where template = 'production_sheet') > 0, 'but reads other kitchen alerts');
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.notifications_outbox where template = 'vendor_message'), 1::bigint, 'the owner can');
select set_config('request.jwt.claims', '{"sub":"d1600000-0000-4000-d000-000000000006","role":"authenticated"}', true);
select is((select count(*) from public.notifications_outbox where kitchen_id = 'd1600000-0000-4000-d000-00000000000a'), 0::bigint,
  'another kitchen''s owner reads none');
reset role;
select ok(not has_function_privilege('authenticated', 'private.relink_conversations()', 'execute')
          and not has_function_privilege('anon', 'private.copy_owner_alert_to_managers()', 'execute'),
  'the new trigger functions are not callable from the API');

-- ===========================================================================
-- 3. Nightly: prepaid-only auto-cancel, one failing subscription does not block the rest
-- ===========================================================================
select set_config('app.now', '2026-11-30 00:30:00+05:30', true);
select pg_temp.mk('Monthly Trial', '+919316500001', 'monthly', '2026-11-02', 'trial');
select pg_temp.mk('Prepaid Trial', '+919316500002', 'prepaid', '2026-11-02', 'trial');
select pg_temp.mk('Prepaid Trial Boom', '+919316500003', 'prepaid', '2026-11-02', 'trial');
create function pg_temp.boom() returns trigger language plpgsql as $$
begin
  if new.status = 'cancelled' and new.id = (select sub from cx where name = 'Prepaid Trial Boom') then
    raise exception 'test boom';
  end if;
  return new;
end $$;
create trigger r16_boom before update on public.subscriptions for each row execute function pg_temp.boom();
select lives_ok($$select private.nightly()$$, 'the nightly job runs through a failing auto-cancel');
select is((select status::text from public.subscriptions where id = (select sub from cx where name = 'Monthly Trial')), 'trial',
  'a monthly customer''s unpaid trial is never cancelled automatically (D-115)');
select is((select status::text from public.subscriptions where id = (select sub from cx where name = 'Prepaid Trial')), 'cancelled',
  'a prepaid unpaid trial ends after the grace days');
select is((select status::text from public.subscriptions where id = (select sub from cx where name = 'Prepaid Trial Boom')), 'trial',
  'the failing one is left as it was');
select ok(exists (select 1 from public.engine_errors where kitchen_id = 'd1600000-0000-4000-d000-00000000000a'
                  and job = 'nightly_cancel' and resolved_at is null), 'and recorded in engine_errors (wave 1, D-123)');
drop trigger r16_boom on public.subscriptions;

select * from finish();
rollback;
