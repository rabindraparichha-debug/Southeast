-- Vendor-first wave 2: billing mode per customer with a rupee ledger (item 20, D-115), statements,
-- exports and the register (item 21), void / backdate / idempotency (item 22), import with billing.
-- Simulated month: Mon 2 Nov 2026 … Wed 2 Dec 2026, no weekly off, the real engine (nightly + locks).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen M (monthly by default), lunch plan ₹60 and dinner plan ₹40, every day.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'b1400000-0000-4000-b000-000000000001', 'authenticated', 'authenticated', '919314000001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1400000-0000-4000-b000-000000000002', 'authenticated', 'authenticated', '919314000002', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1400000-0000-4000-b000-000000000003', 'authenticated', 'authenticated', '919314000003', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1400000-0000-4000-b000-000000000004', 'authenticated', 'authenticated', '919314000004', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('b1400000-0000-4000-b000-00000000000a', 'Khata Kitchen', 'khata-kitchen', 'b1400000-0000-4000-b000-000000000001', '{}');
insert into public.kitchen_settings (kitchen_id) values ('b1400000-0000-4000-b000-00000000000a');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('b1400000-0000-4000-b000-00000000000a', 'b1400000-0000-4000-b000-000000000001', 'owner', 'Sujata'),
  ('b1400000-0000-4000-b000-00000000000a', 'b1400000-0000-4000-b000-000000000002', 'manager', 'Manoj'),
  ('b1400000-0000-4000-b000-00000000000a', 'b1400000-0000-4000-b000-000000000003', 'accountant', 'Asha'),
  ('b1400000-0000-4000-b000-00000000000a', 'b1400000-0000-4000-b000-000000000004', 'rider', 'Son');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('b1400000-0000-4000-b000-0000000000a1', 'b1400000-0000-4000-b000-00000000000a', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 6000),
  ('b1400000-0000-4000-b000-0000000000a2', 'b1400000-0000-4000-b000-00000000000a', 'Dinner', '{dinner}', '{1,2,3,4,5,6,7}', 4000);

select is((select default_billing_mode::text from public.kitchen_settings where kitchen_id = 'b1400000-0000-4000-b000-00000000000a'),
  'monthly', 'a new kitchen bills monthly (pay later) by default (D-115)');

select set_config('app.now', '2026-11-01 10:00:00+05:30', true);
create temp table bx (name text primary key, cust uuid, sub uuid, sub2 uuid);
grant select on bx to authenticated;
create function pg_temp.mk(p_name text, p_phone text, p_plans text[], p_mode public.billing_mode default null, p_start date default '2026-11-02')
returns void language plpgsql as $$
declare v_c uuid; v_s uuid[] := '{}'; p text; v_id uuid;
begin
  v_c := private.insert_customer('b1400000-0000-4000-b000-00000000000a', p_name, p_phone, 'veg', 'en', null,
                                 '{"line1":"Lane 1","area":"Sundarpada"}', 'vendor', 'vendor', p_mode);
  foreach p in array p_plans loop
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values ('b1400000-0000-4000-b000-00000000000a', v_c, ('b1400000-0000-4000-b000-0000000000' || p)::uuid,
            (select id from public.addresses where customer_id = v_c), p_start, 'active')
    returning id into v_id;
    v_s := v_s || v_id;
  end loop;
  insert into bx values (p_name, v_c, v_s[1], v_s[2]);
end $$;

select pg_temp.mk('Sujata Didi', '+919314100001', '{a1,a2}');          -- monthly (kitchen default), lunch ₹60 + dinner ₹40
select pg_temp.mk('Mitu', '+919314100002', '{a1}');                    -- monthly, pays the exact dues at the end
select pg_temp.mk('Prepaid Pinky', '+919314100003', '{a1}', 'prepaid'); -- prepaid, no balance
select pg_temp.mk('Converter', '+919314100004', '{a1}', null, '2027-01-04');  -- monthly, no meals yet

select is((select billing_mode::text from public.customers where id = (select cust from bx where name = 'Sujata Didi')), 'monthly',
  'a new customer takes the kitchen default');
select is((select billing_mode::text from public.customers where id = (select cust from bx where name = 'Prepaid Pinky')), 'prepaid',
  'or the billing mode the vendor chose');

-- ===========================================================================
-- 31 days of the real engine: lunch locks at 21:00 the day before, nightly at 00:30, dinner locks at 12:00.
-- Mid-month (16 Nov, 10:00) the lunch price goes up to ₹70.
-- ===========================================================================
do $$
declare d date;
begin
  for d in select g::date from generate_series('2026-11-02'::date, '2026-12-02'::date, interval '1 day') g loop
    perform set_config('app.now', ((d - 1) + time '21:00:01')::timestamp at time zone 'Asia/Kolkata' || '', true);
    perform private.lock_slot('b1400000-0000-4000-b000-00000000000a', d, 'lunch');
    perform private.sync_balance_status('b1400000-0000-4000-b000-00000000000a', null);
    perform set_config('app.now', (d + time '00:30')::timestamp at time zone 'Asia/Kolkata' || '', true);
    perform private.nightly();
    if d = '2026-11-16' then
      perform set_config('app.now', (d + time '10:00')::timestamp at time zone 'Asia/Kolkata' || '', true);
      update public.plans set price_per_meal_paise = 7000 where id = 'b1400000-0000-4000-b000-0000000000a1';
    end if;
    perform set_config('app.now', (d + time '12:00:01')::timestamp at time zone 'Asia/Kolkata' || '', true);
    perform private.lock_slot('b1400000-0000-4000-b000-00000000000a', d, 'dinner');
    perform private.sync_balance_status('b1400000-0000-4000-b000-00000000000a', null);
  end loop;
end $$;
select set_config('app.now', '2026-12-02 15:00:00+05:30', true);

-- Item 20 test 1: a monthly customer with no payments stays active for 31 days, dues = Σ amount_paise.
select is((select status::text from public.subscriptions where id = (select sub from bx where name = 'Sujata Didi')), 'active',
  'Sujata (monthly, never paid) is still active after 31 days');
select is((select count(*) from public.subscription_events e join bx on bx.sub = e.subscription_id or bx.sub2 = e.subscription_id
           where bx.name = 'Sujata Didi' and e.to_status in ('low_balance', 'suspended', 'cancelled')), 0::bigint,
  'and was never moved to low balance, suspended or cancelled');
select is((select count(*) from public.meal_orders where customer_id = (select cust from bx where name = 'Sujata Didi')
           and locked_at is not null and (status <> 'skipped' or charged)), 62::bigint, 'she got all 62 meals (31 lunches, 31 dinners)');
select is((select amount_owed_paise from private.dues('b1400000-0000-4000-b000-00000000000a')
           where customer_id = (select cust from bx where name = 'Sujata Didi')),
          (select -sum(amount_paise)::integer from public.balance_entries where customer_id = (select cust from bx where name = 'Sujata Didi')),
  'dues = minus the sum of the ledger amounts');
select is((select -sum(amount_paise)::integer from public.balance_entries where customer_id = (select cust from bx where name = 'Sujata Didi')),
          (select sum(qty * price_per_meal_paise)::integer from public.meal_orders
           where customer_id = (select cust from bx where name = 'Sujata Didi') and locked_at is not null and (status <> 'skipped' or charged)),
  'which is the sum of each meal''s own price');
-- Item 20 test 2: lunch ₹60 + dinner ₹40, item 20 test 3: the price change affects only later meals.
select is((select amount_owed_paise from private.dues('b1400000-0000-4000-b000-00000000000a')
           where customer_id = (select cust from bx where name = 'Sujata Didi')), 15 * 6000 + 16 * 7000 + 31 * 4000,
  'Sujata owes 15 lunches at ₹60 + 16 at ₹70 + 31 dinners at ₹40 = ₹3,260');
select is((select count(*) from public.balance_entries where customer_id = (select cust from bx where name = 'Sujata Didi')
           and type = 'meal' and amount_paise = -6000), 15::bigint, 'lunches locked before the price change stay at ₹60');
select is((select count(*) from public.balance_entries where customer_id = (select cust from bx where name = 'Sujata Didi')
           and type = 'meal' and amount_paise = -7000), 16::bigint, 'only later lunches cost ₹70');
select is((select count(*) from public.balance_entries where customer_id = (select cust from bx where name = 'Sujata Didi')
           and type = 'meal' and amount_paise = -4000), 31::bigint, 'dinners at ₹40');
select is(private.customer_unit_price((select cust from bx where name = 'Sujata Didi')), 5500,
  'price per meal for converting rupees is the meal-weighted average of her plans (₹70 + ₹40) / 2');

-- Item 20 test 5: prepaid still suspends (and is cancelled after the grace days).
select ok((select count(*) from public.subscription_events where subscription_id = (select sub from bx where name = 'Prepaid Pinky')
           and to_status = 'suspended') >= 1, 'a prepaid customer with no balance is suspended');
select is((select status::text from public.subscriptions where id = (select sub from bx where name = 'Prepaid Pinky')), 'cancelled',
  'and cancelled when the grace days run out (prepaid keeps the M3 rules)');
select is((select count(*) from public.meal_orders where customer_id = (select cust from bx where name = 'Prepaid Pinky')), 1::bigint,
  'the suspended prepaid customer got only the first meal');

-- Statement (item 21): November for Sujata, by service date.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000003","role":"authenticated"}', true);
create temp table st as select public.customer_statement((select cust from bx where name = 'Sujata Didi'), '2026-11-15') as s;
select is((select (s -> 'totals' ->> 'meals_charged')::int from st), 58, 'November statement: 29 lunches + 29 dinners');
select is((select (s -> 'totals' ->> 'charged_paise')::int from st), 15 * 6000 + 14 * 7000 + 29 * 4000,
  'charged at each meal''s own price');
select is((select (s -> 'opening' ->> 'paise')::bigint + (s -> 'totals' ->> 'net_paise')::bigint from st),
          (select (s -> 'closing' ->> 'paise')::bigint from st), 'opening + the month = closing');
select is((select (s -> 'lines' -> -1 ->> 'balance_paise')::bigint from st), (select (s -> 'closing' ->> 'paise')::bigint from st),
  'the last line''s running balance is the closing balance');
select is((select sum((l ->> 'amount_paise')::int) from st, jsonb_array_elements(s -> 'lines') l), (select (s -> 'totals' ->> 'net_paise')::bigint from st)::bigint,
  'the lines add up to the month total');
select is((select (s -> 'amount_due_paise')::int from st), 15 * 6000 + 14 * 7000 + 29 * 4000, 'amount due at the end of November');
insert into st select public.customer_statement((select cust from bx where name = 'Sujata Didi'), '2026-12-01');
select is((select s -> 'customer' ->> 'phone' from st limit 1), '+91 ••••••0001', 'an accountant sees the phone masked on the statement');
reset role;
select is((select (s -> 'closing' ->> 'paise')::bigint from st where s ->> 'month' = '2026-12'),
          private.rupee_balance((select cust from bx where name = 'Sujata Didi')), 'December''s closing balance is the ledger balance');

-- Item 20 test 4: paying the exact dues leaves 0 owed and the customer stays active.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.record_payment((select cust from bx where name = 'Mitu'),
  (select amount_owed_paise from public.dues_list('b1400000-0000-4000-b000-00000000000a') where customer_id = (select cust from bx where name = 'Mitu')),
  'cash')$$, 'the manager records Mitu paying her dues in cash');
reset role;
select is(private.rupee_balance((select cust from bx where name = 'Mitu')), 0::bigint, 'Mitu owes nothing');
select is((select count(*) from private.dues('b1400000-0000-4000-b000-00000000000a') where customer_id = (select cust from bx where name = 'Mitu')),
  0::bigint, 'and is off the dues list');
select is((select status::text from public.subscriptions where id = (select sub from bx where name = 'Mitu')), 'active', 'and still active');
select is((select meals from public.payments where customer_id = (select cust from bx where name = 'Mitu')), 0,
  'a monthly payment is rupees only (0 meals)');
select is((select meals || '/' || amount_paise from public.balance_entries where customer_id = (select cust from bx where name = 'Mitu') and type = 'recharge'),
  '0/' || (15 * 6000 + 16 * 7000), 'its ledger row adds rupees, not meals');

-- Monthly customers get no day-1/3/7 dues reminders (month-end statement instead).
select is((select count(*) from public.notifications_outbox where template = 'dues_reminder'
           and recipient_id = (select cust from bx where name = 'Sujata Didi')), 0::bigint, 'no dues reminders for a monthly customer');
select private.compute_churn('b1400000-0000-4000-b000-00000000000a');
select ok(not exists (select 1 from public.churn_risks where customer_id = (select cust from bx where name = 'Sujata Didi')
                      and 'balance_out' = any (reasons)), 'a monthly customer below zero is not flagged "balance out"');

-- ===========================================================================
-- Credits, adjustments, rider cash (monthly)
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000001","role":"authenticated"}', true);
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
insert into ids select 'credit', public.add_balance_entry((select cust from bx where name = 'Sujata Didi'), 'credit', 1, 'Late lunch');
select is((select meals || '/' || amount_paise from public.balance_entries where id = (select v from ids where k = 'credit')), '1/5500',
  'a free meal for a monthly customer is worth her price per meal');
select throws_ok($$select public.add_balance_entry((select cust from bx where name = 'Sujata Didi'), 'adjust', 0, 'Opening dues')$$,
  '22023', 'invalid_amount', 'a monthly adjustment needs a rupee amount');
insert into ids select 'adjust', public.add_balance_entry((select cust from bx where name = 'Sujata Didi'), 'adjust', null, 'Old khata', -50000);
select is((select meals || '/' || amount_paise from public.balance_entries where id = (select v from ids where k = 'adjust')), '0/-50000',
  'opening dues for a monthly customer are rupees');
reset role;

-- Rider cash at the door for a monthly customer: pending, rupees only; confirmed by the manager.
select set_config('app.now', '2026-12-02 13:00:00+05:30', true);
insert into ids select 'order', id from public.meal_orders where customer_id = (select cust from bx where name = 'Sujata Didi')
  and service_date = '2026-12-02' and slot = 'lunch';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000004","role":"authenticated"}', true);
insert into ids select 'cash', public.record_cash_at_door((select v from ids where k = 'order'), 50000, 'Paid at the door');
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000002","role":"authenticated"}', true);
select lives_ok($$select public.confirm_payment((select v from ids where k = 'cash'), 7)$$, 'the manager confirms rider cash');
reset role;
select is((select meals || '/' || status from public.payments where id = (select v from ids where k = 'cash')), '0/paid',
  'rider cash for a monthly customer carries no meals, even if meals are typed');
select is((select meals || '/' || amount_paise from public.balance_entries where ref_id = (select v from ids where k = 'cash') and type = 'recharge'),
  '0/50000', 'and adds ₹500 to her khata');

-- ===========================================================================
-- Item 22: idempotency, backdating, void
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000001","role":"authenticated"}', true);
insert into ids select 'p1', public.record_payment((select cust from bx where name = 'Converter'), 70000, 'upi_manual',
  p_client_op => 'b1400000-0000-4000-b000-0000000000c1', p_paid_at => '2026-11-28 18:00:00+05:30');
insert into ids select 'p1again', public.record_payment((select cust from bx where name = 'Converter'), 70000, 'upi_manual',
  p_client_op => 'b1400000-0000-4000-b000-0000000000c1', p_paid_at => '2026-11-28 18:00:00+05:30');
select is((select v from ids where k = 'p1again'), (select v from ids where k = 'p1'), 'the same key twice returns the first payment');
select is((select count(*) from public.payments where customer_id = (select cust from bx where name = 'Converter')), 1::bigint,
  'and creates one payment');
select throws_ok($$select public.record_payment((select cust from bx where name = 'Mitu'), 100, 'cash', p_client_op => 'b1400000-0000-4000-b000-0000000000c1')$$,
  '22023', 'invalid_client_op', 'a key used for another customer is refused');
select is((select (paid_at at time zone 'Asia/Kolkata')::text from public.payments where id = (select v from ids where k = 'p1')),
  '2026-11-28 18:00:00', 'a payment can be backdated');
select is((select (created_at at time zone 'Asia/Kolkata')::text from public.balance_entries where ref_id = (select v from ids where k = 'p1') and type = 'recharge'),
  '2026-11-28 18:00:00', 'and its ledger row carries that date');
select throws_ok($$select public.record_payment((select cust from bx where name = 'Mitu'), 100, 'cash', p_paid_at => '2026-12-05 10:00:00+05:30')$$,
  '22023', 'invalid_paid_at', 'not into the future');
select throws_ok($$select public.record_payment((select cust from bx where name = 'Mitu'), 100, 'cash', p_paid_at => '2024-01-01 10:00:00+05:30')$$,
  '22023', 'invalid_paid_at', 'nor more than 400 days back');

-- Billing switch both ways: ₹700 advance at ₹70 → 10 prepaid meals worth ₹700 → back to ₹700.
reset role;
select is(private.customer_unit_price((select cust from bx where name = 'Converter')), 7000, 'Converter''s price per meal is ₹70');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000001","role":"authenticated"}', true);
select is((public.set_billing_mode((select cust from bx where name = 'Converter'), 'prepaid') ->> 'balance_meals')::int, 10,
  'monthly → prepaid: a ₹700 advance becomes 10 meals');
select is(public.unused_meals_value((select cust from bx where name = 'Converter')) - 'balance_paise',
  '{"meals": 10, "amount_paise": 70000, "billing_mode": "prepaid"}'::jsonb, 'worth exactly the advance (FIFO)');
select is((public.set_billing_mode((select cust from bx where name = 'Converter'), 'monthly') ->> 'balance_paise')::int, 70000,
  'prepaid → monthly: back to a ₹700 advance');
-- Refund part of a monthly advance (rupees).
insert into ids select 'refund', public.refund_unused_meals((select cust from bx where name = 'Converter'), p_amount_paise => 30000);
select is((select meals || '/' || amount_paise || '/' || status from public.refunds where id = (select v from ids where k = 'refund')), '0/30000/pending',
  'a monthly customer''s advance is refunded in rupees');
select throws_ok($$select public.refund_unused_meals((select cust from bx where name = 'Converter'), p_amount_paise => 50000)$$,
  '22023', 'refund_exceeds_balance', 'never more than the advance');
reset role;
select is(private.rupee_balance((select cust from bx where name = 'Converter')), 40000::bigint, '₹400 advance left');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000001","role":"authenticated"}', true);

-- Void: restores the balance, append-only reversal, audit with the reason.
select is((public.void_payment((select v from ids where k = 'p1'), 'Entered twice by mistake') ->> 'balance_paise')::int, -30000,
  'voiding the ₹700 payment takes it back off the khata');
select is((select status::text || '/' || void_reason from public.payments where id = (select v from ids where k = 'p1')),
  'voided/Entered twice by mistake', 'the payment is voided with the reason');
select is((select meals || '/' || amount_paise from public.balance_entries where ref_type = 'payment_void' and ref_id = (select v from ids where k = 'p1')),
  '0/-70000', 'one reversal row in the ledger (nothing edited)');
select is((public.void_payment((select v from ids where k = 'p1'), 'again') ->> 'already')::boolean, true, 'voiding twice is a no-op');
select is((select count(*) from public.balance_entries where ref_type = 'payment_void' and ref_id = (select v from ids where k = 'p1')),
  1::bigint, 'still one reversal');
select throws_ok($$select public.void_payment((select v from ids where k = 'p1'), ' ')$$, '22023', 'reason_required', 'a reason is required');
reset role;
select is((select after ->> 'void_reason' from public.audit_log where table_name = 'payments' and row_id = (select v from ids where k = 'p1')::text
           and action = 'UPDATE' order by id desc limit 1), 'Entered twice by mistake', 'the audit log carries the reason');
select is((select actor_id from public.audit_log where table_name = 'payments' and row_id = (select v from ids where k = 'p1')::text
           and action = 'UPDATE' order by id desc limit 1), 'b1400000-0000-4000-b000-000000000001'::uuid, 'and who voided it');
insert into public.payments (id, kitchen_id, customer_id, method, status, amount_paise, meals, paid_at)
values ('b1400000-0000-4000-b000-0000000000d1', 'b1400000-0000-4000-b000-00000000000a', (select cust from bx where name = 'Converter'),
        'razorpay_link', 'paid', 10000, 1, private.now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.void_payment('b1400000-0000-4000-b000-0000000000d1', 'x')$$, '22023', 'not_voidable',
  'online payments are refunded, not voided');
reset role;

-- Prepaid FIFO skips a voided lot: 10 meals at ₹60, 10 at ₹80, void the first → 10 left worth ₹800.
select pg_temp.mk('Fifo Fakir', '+919314100005', '{a1}', 'prepaid', '2027-01-04');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000001","role":"authenticated"}', true);
insert into ids select 'f1', public.record_payment((select cust from bx where name = 'Fifo Fakir'), 60000, 'cash', 10);
insert into ids select 'f2', public.record_payment((select cust from bx where name = 'Fifo Fakir'), 80000, 'cash', 10);
select lives_ok($$select public.void_payment((select v from ids where k = 'f1'), 'Wrong customer')$$, 'void the first prepaid payment');
select is(public.unused_meals_value((select cust from bx where name = 'Fifo Fakir')) - 'balance_paise' - 'billing_mode',
  '{"meals": 10, "amount_paise": 80000}'::jsonb, 'FIFO ignores the voided lot: 10 meals worth ₹800');
reset role;

-- Automatic refund on cancel stays prepaid-only: cancelling the monthly Converter refunds nothing.
select set_config('app.now', '2026-12-02 16:00:00+05:30', true);
update public.subscriptions set status = 'cancelled', cancelled_at = private.now() where id = (select sub from bx where name = 'Converter');
select is((select count(*) from public.refunds where customer_id = (select cust from bx where name = 'Converter')), 1::bigint,
  'cancelling a monthly customer creates no automatic refund (only the manual one above)');

-- Idempotent purchases and waste.
insert into public.items (id, kitchen_id, name, unit) values
  ('b1400000-0000-4000-b000-0000000000e1', 'b1400000-0000-4000-b000-00000000000a', 'Rice', 'kg'),
  ('b1400000-0000-4000-b000-0000000000e2', 'b1400000-0000-4000-b000-00000000000a', 'Dal', 'kg');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000002","role":"authenticated"}', true);
create temp table pur (n integer, r jsonb);
grant all on pur to authenticated;
insert into pur select 1, public.record_purchase('b1400000-0000-4000-b000-00000000000a',
  '[{"item_id":"b1400000-0000-4000-b000-0000000000e1","qty":10,"amount_paise":50000}]', p_client_op => 'b1400000-0000-4000-b000-0000000000f1');
insert into pur select 2, public.record_purchase('b1400000-0000-4000-b000-00000000000a',
  '[{"item_id":"b1400000-0000-4000-b000-0000000000e1","qty":10,"amount_paise":50000}]', p_client_op => 'b1400000-0000-4000-b000-0000000000f1');
select is((select r ->> 'purchase_id' from pur where n = 2), (select r ->> 'purchase_id' from pur where n = 1), 'a retried bill returns the first one');
select is((select (r ->> 'duplicate')::boolean from pur where n = 2), true, 'flagged as a duplicate');
select lives_ok($$select public.record_waste('b1400000-0000-4000-b000-0000000000e1', 1, 'Spilt', null, 'b1400000-0000-4000-b000-0000000000f2')$$, 'waste recorded');
select lives_ok($$select public.record_waste('b1400000-0000-4000-b000-0000000000e1', 1, 'Spilt', null, 'b1400000-0000-4000-b000-0000000000f2')$$, 'and retried');
select throws_ok($$select public.record_waste('b1400000-0000-4000-b000-0000000000e2', 1, 'Spilt', null, 'b1400000-0000-4000-b000-0000000000f2')$$,
  '22023', 'invalid_client_op', 'the same key on another item is refused');
reset role;
select is((select count(*) from public.purchases where kitchen_id = 'b1400000-0000-4000-b000-00000000000a'), 1::bigint, 'one purchase');
select is((select private.item_stock('b1400000-0000-4000-b000-0000000000e1')), 9.000, 'one waste move: 10 kg − 1 kg');

-- ===========================================================================
-- Import with billing mode and opening balances
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000001","role":"authenticated"}', true);
create temp table imp as select public.import_customers('b1400000-0000-4000-b000-00000000000a', '[
  {"name":"Khata One","phone":"9314200001","billing":"pay later","dues":"1250.50"},
  {"name":"Advance Two","phone":"9314200002","plan":"Lunch","billing":"prepaid","balance":"5"},
  {"name":"Wrong Dues","phone":"9314200003","billing":"prepaid","dues":"100"},
  {"name":"Weekly","phone":"9314200004","billing":"weekly"},
  {"name":"Bad Dues","phone":"9314200005","dues":"abc"},
  {"name":"Khata One Sister","phone":"9314200001"},
  {"name":"khata  one","phone":"9314200001"},
  {"name":"Old Card","phone":"9314200006","plan":"Lunch","balance":"4"}
]'::jsonb, true) as r;
grant select on imp to authenticated;
select is((select (r ->> 'imported')::int from imp), 4, '4 rows imported');
select is((select r -> 'errors' from imp),
  '[{"row":3,"errors":["dues_need_monthly"]},{"row":4,"errors":["invalid_billing"]},{"row":5,"errors":["invalid_dues"]},{"row":7,"errors":["duplicate_in_file"]}]'::jsonb,
  'bad billing, dues on a prepaid row, bad dues and a same-name duplicate are reported');
reset role;
select is((select billing_mode::text || '/' || private.rupee_balance(id) from public.customers where name = 'Khata One'), 'monthly/-125050',
  'monthly with ₹1,250.50 opening dues');
select is((select billing_mode::text || '/' || (select sum(meals) from public.balance_entries where customer_id = c.id) from public.customers c where name = 'Advance Two'),
  'prepaid/5', 'prepaid with 5 meals');
select is((select billing_mode::text from public.customers where name = 'Khata One Sister'), 'monthly',
  'a sister on the same phone is imported (D-118)');
select is((select private.rupee_balance(id) from public.customers where name = 'Old Card'), 4 * 7000::bigint,
  'meals already paid by a monthly customer become a rupee advance at the plan price');

-- ===========================================================================
-- Exports (item 21)
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000003","role":"authenticated"}', true);
select is(split_part(public.export_payments_csv('b1400000-0000-4000-b000-00000000000a', '2026-11-01', '2026-12-31'), E'\n', 1),
  'date,customer,billing_mode,method,status,amount_rupees,meals,collected_by,confirmed_by,note,void_reason,payment_id', 'payments CSV header');
select ok(public.export_payments_csv('b1400000-0000-4000-b000-00000000000a', '2026-11-01', '2026-12-31') like '%"Converter",monthly,upi_manual,voided,700.00,0,%"Entered twice by mistake"%',
  'a voided payment is exported with its reason');
select ok(public.export_dues_aging_csv('b1400000-0000-4000-b000-00000000000a') like E'%\n"Sujata Didi",monthly,%', 'dues aging lists Sujata');
select ok(public.export_rider_cash_csv('b1400000-0000-4000-b000-00000000000a', '2026-12-01', '2026-12-02') like E'%\n2026-12-02,"Son","Sujata Didi",500.00,paid,"Manoj",%',
  'rider cash lists who collected and who confirmed');
select throws_ok($$select public.export_payments_csv('b1400000-0000-4000-b000-00000000000a', '2025-01-01', '2026-12-31')$$,
  '22023', 'range_too_long', 'at most a year at a time');
select ok(jsonb_array_length(public.monthly_bills('b1400000-0000-4000-b000-00000000000a', '2026-11-01') -> 'bills') >= 3, 'bills for November');
reset role;
select is(private.csv_text('=HYPERLINK("x")'), '"''=HYPERLINK(""x"")"', 'cells cannot inject spreadsheet formulas');

-- Register (item 21): 180 customers × 2 slots × 7 days = 2,520 marks in one document (no 1,000-row cap).
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('b1400000-0000-4000-b000-00000000000b', 'Big Mess', 'big-mess', 'b1400000-0000-4000-b000-000000000001', '{}');
insert into public.kitchen_settings (kitchen_id) values ('b1400000-0000-4000-b000-00000000000b');
insert into public.members (kitchen_id, user_id, role) values ('b1400000-0000-4000-b000-00000000000b', 'b1400000-0000-4000-b000-000000000001', 'owner');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('b1400000-0000-4000-b000-0000000000b1', 'b1400000-0000-4000-b000-00000000000b', 'Thali', '{lunch,dinner}', '{1,2,3,4,5,6,7}', 6000);
select set_config('app.now', '2027-01-03 10:00:00+05:30', true);
do $$
declare i integer; v_c uuid;
begin
  for i in 1..180 loop
    v_c := private.insert_customer('b1400000-0000-4000-b000-00000000000b', 'Mess member ' || i, '+9193143' || lpad(i::text, 5, '0'),
                                   'veg', 'en', null, null, 'vendor', 'vendor');
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, start_date, status)
    values ('b1400000-0000-4000-b000-00000000000b', v_c, 'b1400000-0000-4000-b000-0000000000b1', '2027-01-04', 'active');
  end loop;
end $$;
select private.refresh_orders('b1400000-0000-4000-b000-00000000000b', null, 8);
select is((select count(*) from public.meal_orders where kitchen_id = 'b1400000-0000-4000-b000-00000000000b'
           and service_date between '2027-01-04' and '2027-01-10'), 2520::bigint, '2,520 orders that week');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1400000-0000-4000-b000-000000000001","role":"authenticated"}', true);
create temp table reg as select public.register_sheet('b1400000-0000-4000-b000-00000000000b', '2027-01-04', 7) as r;
select is((select jsonb_array_length(r -> 'rows') from reg), 180, 'the register lists all 180 customers');
select is((select count(*) from reg, jsonb_array_elements(r -> 'rows') x, jsonb_each(x -> 'marks') d, jsonb_each(d.value) s), 2520::bigint,
  'and all 2,520 meals');
select is((select jsonb_array_length(r -> 'days') from reg), 7, 'for 7 days');
reset role;

select * from finish();
rollback;
