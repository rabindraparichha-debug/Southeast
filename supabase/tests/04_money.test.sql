-- M3 tests: Razorpay webhooks (idempotent), payment links, cash/UPI, rider cash, FIFO refunds,
-- cancel refund, balance-driven states, credit limit, dues + reminders, report, permissions.
-- Simulated week: Mon 2 Nov 2026 … Mon 9 Nov 2026 (Sunday off).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'e0000000-0000-4000-e000-000000000001', 'authenticated', 'authenticated', '919333000001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e0000000-0000-4000-e000-000000000002', 'authenticated', 'authenticated', '919333000002', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e0000000-0000-4000-e000-000000000003', 'authenticated', 'authenticated', '919333000003', now(), now(), now());

-- a1 money kitchen (verified payout), a2 states kitchen, a3 dues kitchen (credit 2 meals), a4 unverified payout
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('60000000-0000-4000-e000-0000000000a1', 'Money Kitchen', 'money-kitchen', 'e0000000-0000-4000-e000-000000000001', '{7}'),
  ('60000000-0000-4000-e000-0000000000a2', 'States Kitchen', 'states-kitchen', 'e0000000-0000-4000-e000-000000000001', '{7}'),
  ('60000000-0000-4000-e000-0000000000a3', 'Dues Kitchen', 'dues-kitchen', 'e0000000-0000-4000-e000-000000000001', '{7}'),
  ('60000000-0000-4000-e000-0000000000a4', 'Unverified Kitchen', 'unverified-kitchen', 'e0000000-0000-4000-e000-000000000001', '{7}');
insert into public.kitchen_settings (kitchen_id, credit_limit_meals) values
  ('60000000-0000-4000-e000-0000000000a1', 0), ('60000000-0000-4000-e000-0000000000a2', 0),
  ('60000000-0000-4000-e000-0000000000a3', 2), ('60000000-0000-4000-e000-0000000000a4', 0);
insert into public.kitchen_payout_accounts (kitchen_id, razorpay_linked_account_id, kyc_status) values
  ('60000000-0000-4000-e000-0000000000a1', 'acc_TestMoney001', 'verified'),
  ('60000000-0000-4000-e000-0000000000a2', null, 'not_started'),
  ('60000000-0000-4000-e000-0000000000a3', null, 'not_started'),
  ('60000000-0000-4000-e000-0000000000a4', 'acc_TestPending01', 'pending');
insert into public.members (kitchen_id, user_id, role)
select k, 'e0000000-0000-4000-e000-000000000001', 'owner'
from unnest(array['60000000-0000-4000-e000-0000000000a1', '60000000-0000-4000-e000-0000000000a2',
                  '60000000-0000-4000-e000-0000000000a3', '60000000-0000-4000-e000-0000000000a4']::uuid[]) k;
insert into public.members (kitchen_id, user_id, role) values
  ('60000000-0000-4000-e000-0000000000a1', 'e0000000-0000-4000-e000-000000000002', 'staff'),
  ('60000000-0000-4000-e000-0000000000a1', 'e0000000-0000-4000-e000-000000000003', 'rider');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise)
select ('70000000-0000-4000-e000-000000000' || right(k::text, 2) || n)::uuid, k, name, '{lunch}', '{1,2,3,4,5,6}', price
from unnest(array['60000000-0000-4000-e000-0000000000a1', '60000000-0000-4000-e000-0000000000a2',
                  '60000000-0000-4000-e000-0000000000a3', '60000000-0000-4000-e000-0000000000a4']::uuid[]) k
cross join (values ('1', 'Lunch', 7000), ('2', 'Premium', 10000)) as p(n, name, price);

select set_config('app.now', '2026-11-01 10:00:00+05:30', true);

create temp table cx (name text primary key, kitchen uuid, cust uuid, sub uuid);
grant select on cx to authenticated;
create function pg_temp.mk(p_kitchen uuid, p_name text, p_plan text, p_status text, p_qty integer default 1)
returns void language plpgsql as $$
declare v_c uuid; v_s uuid;
begin
  v_c := private.insert_customer(p_kitchen, p_name, '+91988' || lpad((select count(*) + 1 from cx)::text, 7, '0'),
                                 'veg', 'en', null, '{"line1":"Flat 1","area":"Patia"}', 'vendor', 'vendor');
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status, qty)
  values (p_kitchen, v_c, ('70000000-0000-4000-e000-000000000' || right(p_kitchen::text, 2) || p_plan)::uuid,
          (select id from public.addresses where customer_id = v_c), '2026-11-02', p_status::public.subscription_status, p_qty)
  returning id into v_s;
  insert into cx values (p_name, p_kitchen, v_c, v_s);
end $$;

select pg_temp.mk('60000000-0000-4000-e000-0000000000a1', 'Asha', '1', 'active');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a1', 'Bikash', '2', 'active');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a1', 'Chitra', '1', 'active');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a1', 'Gita', '1', 'active', 3);
select pg_temp.mk('60000000-0000-4000-e000-0000000000a1', 'Hari', '1', 'active');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a1', 'Ira', '1', 'active');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a2', 'Sunil', '1', 'active');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a2', 'Tara', '1', 'trial');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a2', 'Uma', '1', 'trial');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a2', 'Vikas', '1', 'active');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a3', 'Dinesh', '1', 'active');
select pg_temp.mk('60000000-0000-4000-e000-0000000000a4', 'Kavya', '1', 'active');

-- ===========================================================================
-- Payment links + webhooks
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
create temp table links (name text primary key, rec jsonb);
grant insert, select on links to authenticated;
insert into links values ('asha30', public.create_payment_link_record((select cust from cx where name = 'Asha'), 30));
insert into links values ('asha10', public.create_payment_link_record((select cust from cx where name = 'Asha'), 10));
insert into links values ('bikash20', public.create_payment_link_record((select cust from cx where name = 'Bikash'), 20));
select is((select (rec ->> 'amount_paise')::integer from links where name = 'asha30'), 210000, 'link for 30 meals at ₹70 = ₹2,100');
select is((select rec ->> 'linked_account_id' from links where name = 'asha30'), 'acc_TestMoney001', 'link routes to the kitchen account');
select throws_ok($$select public.create_payment_link_record((select cust from cx where name = 'Kavya'), 10)$$,
  '22023', 'payout_account_not_verified', 'no online payments until the kitchen payout account is verified');
select throws_ok($$select public.create_payment_link_record((select cust from cx where name = 'Asha'), 0)$$,
  '22023', 'invalid_meals', 'meals must be 1–200');
reset role;

-- M3 test 1: a ₹2,000 test payment creates exactly one recharge, even if the webhook fires twice.
create function pg_temp.ev(p_type text, p_payment uuid, p_amount integer, p_rzp text) returns jsonb language sql as $$
  select jsonb_build_object('event', p_type, 'payload', jsonb_build_object(
    'payment_link', jsonb_build_object('entity', jsonb_build_object('id', 'plink_x', 'reference_id', p_payment)),
    'payment', jsonb_build_object('entity', jsonb_build_object('id', p_rzp, 'amount', p_amount, 'currency', 'INR',
                                                              'method', 'upi', 'notes', jsonb_build_object('payment_id', p_payment)))));
$$;
select is(public.razorpay_process_event('evt_b1',
  pg_temp.ev('payment_link.paid', (select (rec ->> 'payment_id')::uuid from links where name = 'bikash20'), 200000, 'pay_B1')),
  'paid', '₹2,000 payment_link.paid event is applied');
select is(public.razorpay_process_event('evt_b1',
  pg_temp.ev('payment_link.paid', (select (rec ->> 'payment_id')::uuid from links where name = 'bikash20'), 200000, 'pay_B1')),
  'duplicate', 'the same event delivered again is ignored');
select is(public.razorpay_process_event('evt_b2',
  pg_temp.ev('payment.captured', (select (rec ->> 'payment_id')::uuid from links where name = 'bikash20'), 200000, 'pay_B1')),
  'already_paid', 'a second event type for the same payment does not recharge again');
select is((select count(*) from public.balance_entries where customer_id = (select cust from cx where name = 'Bikash') and type = 'recharge'),
  1::bigint, 'exactly one recharge');
select is((select meals || '/' || amount_paise from public.balance_entries
           where customer_id = (select cust from cx where name = 'Bikash') and type = 'recharge'), '20/200000',
  'recharge is 20 meals worth ₹2,000');
select is((select status::text || '/' || razorpay_payment_id || '/' || settled_to_account from public.payments
           where id = (select (rec ->> 'payment_id')::uuid from links where name = 'bikash20')), 'paid/pay_B1/acc_TestMoney001',
  'payment marked paid and settled to the kitchen account');
select is((select count(*) from public.notifications_outbox where template = 'payment_receipt'
           and recipient_id = (select cust from cx where name = 'Bikash')), 1::bigint, 'one receipt queued for the customer');

select is(public.razorpay_process_event('evt_a1',
  pg_temp.ev('payment_link.paid', (select (rec ->> 'payment_id')::uuid from links where name = 'asha30'), 210000, 'pay_A1')),
  'paid', 'Asha pays ₹2,100');
select is(public.razorpay_process_event('evt_a2',
  pg_temp.ev('payment_link.paid', (select (rec ->> 'payment_id')::uuid from links where name = 'asha10'), 50000, 'pay_A2')),
  'amount_mismatch', 'a payment for the wrong amount is held for review');
select is((select status::text from public.payments where id = (select (rec ->> 'payment_id')::uuid from links where name = 'asha10')),
  'review', 'mismatched payment status is review');
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Asha')), 30::bigint,
  'mismatched payment adds no meals');
select is(public.razorpay_process_event('evt_x', pg_temp.ev('payment.captured', gen_random_uuid(), 100, 'pay_unknown')),
  'unmatched', 'events for unknown payments are stored but change nothing');
select is((select count(*) from public.webhook_events where provider = 'razorpay' and event_id in ('evt_b1', 'evt_b2', 'evt_a1', 'evt_a2', 'evt_x')),
  5::bigint, 'every distinct event is stored once');

-- ===========================================================================
-- Cash / UPI entries and rider cash
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.record_payment((select cust from cx where name = 'Chitra'), 140000, 'cash')$$, 'owner records ₹1,400 cash');
select lives_ok($$select public.record_payment((select cust from cx where name = 'Ira'), 200000, 'upi_manual')$$, 'owner records ₹2,000 UPI');
select lives_ok($$select public.record_payment((select cust from cx where name = 'Gita'), 210000, 'cash', 30)$$, 'Gita prepays 30 meals');
select lives_ok($$select public.record_payment((select cust from cx where name = 'Hari'), 60000, 'cash', 10)$$, 'Hari buys 10 meals at ₹60');
select lives_ok($$select public.record_payment((select cust from cx where name = 'Hari'), 80000, 'cash', 10)$$, 'then 10 meals at ₹80');
select throws_ok($$select public.record_payment((select cust from cx where name = 'Chitra'), 1000, 'razorpay_link')$$,
  '22023', 'invalid_method', 'online methods cannot be entered by hand');
reset role;
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Chitra')), 20::bigint,
  '₹1,400 at ₹70 = 20 meals');
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Ira')), 28::bigint,
  '₹2,000 at ₹70 = 28 meals (rounded down)');

-- The rider gets the order id from their stop list (M5); riders cannot browse meal_orders.
create temp table chitra_order as
  select o.id from public.meal_orders o join cx on cx.sub = o.subscription_id where cx.name = 'Chitra' order by o.service_date limit 1;
grant select on chitra_order to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
create temp table rider_cash (id uuid);
grant insert, select on rider_cash to authenticated;
insert into rider_cash select public.record_cash_at_door((select id from chitra_order), 70000);
select is((select count(*) from public.payments), 1::bigint, 'rider sees only the cash they collected');
select is((select status::text from public.payments), 'pending', 'rider cash waits for owner confirmation');
select throws_ok($$select public.record_payment((select cust from cx where name = 'Chitra'), 1000, 'cash')$$,
  '42501', 'forbidden', 'riders cannot record payments directly');
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.confirm_payment((select id from rider_cash))$$, 'owner confirms rider cash');
select throws_ok($$select public.confirm_payment((select id from rider_cash))$$, '22023', 'not_pending', 'cannot confirm twice');
reset role;
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Chitra')), 30::bigint,
  'confirmed rider cash adds 10 meals');

-- ===========================================================================
-- Balance-driven states (States kitchen) and trial payment
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select public.record_payment((select cust from cx where name = 'Sunil'), 35000, 'cash');   -- 5 meals
select public.record_payment((select cust from cx where name = 'Tara'), 70000, 'cash');    -- trial pays 10 meals
select public.record_payment((select cust from cx where name = 'Vikas'), 7000, 'cash');    -- 1 meal
select public.record_payment((select cust from cx where name = 'Dinesh'), 7000, 'cash');   -- 1 meal (credit limit 2)
reset role;
select is((select status::text from public.subscriptions where id = (select sub from cx where name = 'Tara')), 'active',
  'a trial becomes active when the customer pays');
select is((select reason from public.subscription_events where subscription_id = (select sub from cx where name = 'Tara')
           order by id desc limit 1), 'trial_paid', 'trial payment transition logged');
select is((select status::text from public.subscriptions where id = (select sub from cx where name = 'Vikas')), 'low_balance',
  '1 meal left is low balance (threshold 3)');

-- Run the week: generate the evening before, lock at 21:00.
do $$
declare d date;
begin
  for d in select g::date from generate_series('2026-11-02'::date, '2026-11-09'::date, interval '1 day') g loop
    continue when extract(isodow from d) = 7;
    perform set_config('app.now', (((d - 1) + time '18:00') at time zone 'Asia/Kolkata')::text, true);
    perform private.nightly();
    perform set_config('app.now', (((d - 1) + time '21:00:30') at time zone 'Asia/Kolkata')::text, true);
    perform private.run_due_locks();
  end loop;
end $$;

select set_config('app.now', '2026-11-09 00:30:00+05:30', true);
select private.nightly();

select is((select string_agg(to_status::text, ' > ' order by id) from public.subscription_events
           where subscription_id = (select sub from cx where name = 'Sunil')), 'active > low_balance > suspended',
  'Sunil: 5 meals -> low balance at 3 -> suspended at 0');
select is((select count(*) from public.meal_orders o where o.subscription_id = (select sub from cx where name = 'Sunil')
           and o.locked_at is null), 0::bigint, 'a suspended subscription has no future meals');
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Sunil')), 0::bigint,
  'and never goes below zero without credit');

select set_config('app.now', '2026-11-09 10:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select public.record_payment((select cust from cx where name = 'Sunil'), 70000, 'cash');
reset role;
select is((select status::text from public.subscriptions where id = (select sub from cx where name = 'Sunil')), 'active',
  'recharge brings a suspended subscription back to active');
select ok((select count(*) from public.meal_orders o where o.subscription_id = (select sub from cx where name = 'Sunil')
           and o.status = 'scheduled') > 0, 'and its meals are generated again');

select is((select status::text from public.subscriptions where id = (select sub from cx where name = 'Vikas')), 'cancelled',
  'Vikas: suspended after Monday, cancelled when the 7 grace days ran out');
select is((select reason from public.subscription_events where subscription_id = (select sub from cx where name = 'Vikas')
           order by id desc limit 1), 'grace_expired', 'grace cancellation logged');


-- Credit limit (Dues kitchen allows 2 meals of credit)
select is((select string_agg(to_status::text, ' > ' order by id) from public.subscription_events
           where subscription_id = (select sub from cx where name = 'Dinesh')),
  'active > low_balance > suspended', 'Dinesh: suspended only when credit of 2 meals is used up');
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Dinesh')), -2::bigint,
  'balance stops at -2');

-- ===========================================================================
-- Dues and reminders
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is((select meals_owed || '/' || amount_owed_paise || '/' || since from public.dues_list('60000000-0000-4000-e000-0000000000a3')),
  '2/14000/2026-11-02', 'dues: 2 meals = ₹140, owed since the day the balance went below zero');
reset role;
select is((select string_agg(payload ->> 'day', ',' order by (payload ->> 'day')::int) from public.notifications_outbox
           where template = 'dues_reminder' and recipient_id = (select cust from cx where name = 'Dinesh')), '1,3,7',
  'dues reminders on day 1, 3 and 7 only');
select is(private.queue_customer_reminders() >= 0, true, 'reminder job runs');
select is((select count(*) from public.notifications_outbox where template = 'dues_reminder'
           and recipient_id = (select cust from cx where name = 'Dinesh')), 3::bigint, 'and never duplicates');
select ok((select count(*) from public.notifications_outbox where template = 'low_balance_reminder') > 0,
  'low-balance reminders queued');

-- ===========================================================================
-- FIFO valuation and refunds
-- ===========================================================================
-- Hari: 10 meals at ₹60 then 10 at ₹80; 7 meals eaten (oldest lot first) -> 3 at ₹60 + 10 at ₹80 left.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is(public.unused_meals_value((select cust from cx where name = 'Hari')), '{"meals": 13, "amount_paise": 98000}'::jsonb,
  'FIFO: 13 unused meals worth ₹980 (3×₹60 + 10×₹80)');
select lives_ok($$select public.refund_unused_meals((select cust from cx where name = 'Hari'), 3, 'Customer asked')$$,
  'partial refund of 3 meals');
select is((select amount_paise from public.refunds where customer_id = (select cust from cx where name = 'Hari')), 18000,
  'partial refund takes the oldest remaining meals (3×₹60)');
select is(public.unused_meals_value((select cust from cx where name = 'Hari')), '{"meals": 10, "amount_paise": 80000}'::jsonb,
  'remaining 10 meals still valued at ₹80');
select throws_ok($$select public.refund_unused_meals((select cust from cx where name = 'Hari'), 11)$$,
  '22023', 'refund_exceeds_balance', 'cannot refund more meals than are left');

-- M3 test 2: cancelling with 9 meals left gives the correct refund, visible to both sides.
-- Gita prepaid 30 meals (₹2,100) and takes 3 tiffins a day: 7 lunches = 21 meals -> 9 left.
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Gita')), 9::bigint,
  'Gita has 9 meals left after the week');
select lives_ok($$select public.request_schedule_change((select sub from cx where name = 'Gita'), 'cancel', '2026-11-09')$$,
  'owner records the cancellation (effective today)');
select is((select meals || '/' || amount_paise || '/' || status from public.refunds where customer_id = (select cust from cx where name = 'Gita')),
  '9/63000/pending', 'refund of 9 meals = ₹630 is created');
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Gita')), 0::bigint,
  'the 9 meals leave the balance');
select ok((select count(*) from public.notifications_outbox where template = 'refund_notice'
           and recipient_id = (select cust from cx where name = 'Gita') and (payload ->> 'amount_paise')::int = 63000) = 1,
  'the customer is told (refund notice queued)');
select lives_ok($$select public.mark_refund_paid((select id from public.refunds where customer_id = (select cust from cx where name = 'Gita')), 'cash')$$,
  'owner pays the refund in cash');
select is((select status::text || '/' || method from public.refunds where customer_id = (select cust from cx where name = 'Gita')),
  'processed/cash', 'refund processed');
select ok((select count(*) from public.notifications_outbox where template = 'refund_receipt'
           and recipient_id = (select cust from cx where name = 'Gita')) = 1, 'and the customer gets a refund receipt');
select throws_ok($$select public.mark_refund_paid((select id from public.refunds where customer_id = (select cust from cx where name = 'Gita')), 'cash')$$,
  '22023', 'not_pending', 'a refund is paid out only once');

-- Online refund path (Razorpay): refund_for_gateway + webhook
select lives_ok($$select public.request_schedule_change((select sub from cx where name = 'Bikash'), 'cancel', '2026-11-09')$$,
  'Bikash cancels; he paid online');
select is((public.refund_for_gateway((select id from public.refunds where customer_id = (select cust from cx where name = 'Bikash'))) ->> 'razorpay_payment_id'),
  'pay_B1', 'refund goes back to the original Razorpay payment');
select throws_ok($$select public.mark_refund_submitted((select id from public.refunds where customer_id = (select cust from cx where name = 'Bikash')), 'rfnd_1')$$,
  '42501', null, 'only the Edge Function (service role) can submit refunds');
reset role;
select public.mark_refund_submitted((select id from public.refunds where customer_id = (select cust from cx where name = 'Bikash')), 'rfnd_B1');
select is(public.razorpay_process_event('evt_r1', jsonb_build_object('event', 'refund.processed', 'payload',
  jsonb_build_object('refund', jsonb_build_object('entity', jsonb_build_object('id', 'rfnd_B1', 'amount', 130000))))),
  'refund_processed', 'refund.processed webhook closes the refund');
select is((select status::text from public.refunds where customer_id = (select cust from cx where name = 'Bikash')), 'processed',
  'online refund processed');


-- Cancelling after a meal's cutoff but before the lock job ran: that meal is charged, not refunded.
reset role;
select set_config('app.now', '2026-11-09 22:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Ira')), 21::bigint,
  'Ira has 21 meals left before Tuesday lunch is locked');
select lives_ok($$select public.request_schedule_change((select sub from cx where name = 'Ira'), 'cancel', '2026-11-09')$$,
  'Ira cancels at 22:00, after Tuesday lunch cutoff');
select is((select meals from public.refunds where customer_id = (select cust from cx where name = 'Ira')), 20,
  'Tuesday lunch (already being cooked) is charged; 20 meals refunded');
reset role;
select private.run_due_locks();
select is((select sum(meals) from public.balance_entries where customer_id = (select cust from cx where name = 'Ira')), 0::bigint,
  'the lock job does not charge it again: balance is exactly 0');

select set_config('app.now', '2026-11-10 00:30:00+05:30', true);
select private.nightly();
select is((select status::text from public.subscriptions where id = (select sub from cx where name = 'Uma')), 'cancelled',
  'an unpaid trial ends as cancelled after the grace days');

-- ===========================================================================
-- Credits, adjustments, report
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.add_balance_entry((select cust from cx where name = 'Asha'), 'credit', 1, 'Late delivery')$$,
  'owner credits a free meal');
select throws_ok($$select public.add_balance_entry((select cust from cx where name = 'Asha'), 'credit', 1, ' ')$$,
  '22023', 'reason_required', 'credits need a reason');
select throws_ok($$select public.add_balance_entry((select cust from cx where name = 'Asha'), 'credit', -1, 'x')$$,
  '22023', 'invalid_meals', 'credits cannot be negative');
select lives_ok($$select public.add_balance_entry((select cust from cx where name = 'Asha'), 'adjust', 5, 'Opening balance')$$,
  'owner enters an opening balance');
select is((select amount_paise from public.balance_entries where customer_id = (select cust from cx where name = 'Asha') and note = 'Opening balance'),
  35000, 'opening balance is valued at the plan price (for refunds)');
select is((select amount_paise from public.balance_entries where customer_id = (select cust from cx where name = 'Asha') and note = 'Late delivery'),
  0, 'a credit is a free meal (no value)');

select is((select (r ->> 'collected_paise')::int from (select public.money_report('60000000-0000-4000-e000-0000000000a1', '2026-11-01', '2026-11-01') r) x),
  1170000, 'report: ₹11,700 collected on 1 Nov');
select is((select r -> 'by_method' from (select public.money_report('60000000-0000-4000-e000-0000000000a1', '2026-11-01', '2026-11-01') r) x),
  '{"cash": 560000, "upi_manual": 200000, "razorpay_link": 410000}'::jsonb,
  'report: by method (cash ₹5,600 incl. confirmed rider cash, UPI ₹2,000, links ₹4,100)');
select is((select (r ->> 'refunded_paise')::int from (select public.money_report('60000000-0000-4000-e000-0000000000a1', '2026-11-09', '2026-11-09') r) x),
  63000 + 130000, 'report: refunds paid out on 9 Nov (Gita cash, Bikash online)');
select ok((select (r ->> 'liability_paise')::int from (select public.money_report('60000000-0000-4000-e000-0000000000a1', '2026-11-01', '2026-11-10') r) x) > 0,
  'report: prepaid-meal liability');

-- ===========================================================================
-- Permissions
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.payments), 0::bigint, 'staff cannot see payments');
select is((select count(*) from public.refunds), 0::bigint, 'staff cannot see refunds');
select throws_ok($$select public.record_payment((select cust from cx where name = 'Asha'), 7000, 'cash')$$, '42501', 'forbidden', 'staff cannot record payments');
select throws_ok($$select public.money_report('60000000-0000-4000-e000-0000000000a1', '2026-11-01', '2026-11-30')$$, '42501', 'forbidden', 'staff cannot see the money report');
select throws_ok($$select public.record_cash_at_door((select o.id from public.meal_orders o limit 1), 100)$$, '42501', 'forbidden', 'staff cannot record door cash');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.payments where kitchen_id = '60000000-0000-4000-e000-0000000000a1'), 0::bigint, 'another kitchen sees no payments');
select throws_ok($$select public.refund_unused_meals((select cust from cx where name = 'Asha'))$$, '42501', 'forbidden', 'another kitchen cannot refund');
select throws_ok($$select public.dues_list('60000000-0000-4000-e000-0000000000a3')$$, '42501', 'forbidden', 'another kitchen cannot read dues');
select throws_ok($$select count(*) from public.webhook_events$$, '42501', null, 'webhook events are not readable through the API');
select throws_ok($$select public.razorpay_process_event('evt_fake', '{}'::jsonb)$$, '42501', null, 'users cannot inject provider events');
select throws_ok($$select public.attach_payment_link(gen_random_uuid(), 'plink', 'http://x', now())$$, '42501', null, 'users cannot attach payment links');
select throws_ok($$select public.set_payout_account('60000000-0000-4000-e000-0000000000a4', 'acc_Hack000001', 'verified')$$, '42501', 'forbidden', 'owners cannot verify their own payout account');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$select public.set_payout_account('60000000-0000-4000-e000-0000000000a4', 'not-an-id', 'verified')$$, '22023', 'invalid_account_id', 'payout account id is validated');
select lives_ok($$select public.set_payout_account('60000000-0000-4000-e000-0000000000a4', 'acc_TestVerified1', 'verified')$$, 'admin verifies a payout account');
set local role anon;
select throws_ok($$select count(*) from public.payments$$, '42501', null, 'anon cannot read payments');
reset role;

select throws_ok($$delete from public.webhook_events$$, 'P0001', 'webhook_events is append-only', 'webhook log cannot be deleted');
select throws_ok($$update public.balance_entries set meals = 1000$$, 'P0001', 'balance_entries is append-only', 'ledger stays append-only');

select * from finish();
rollback;
