-- Held-back vendor-first items: billing-aware customer messages and churn (item 1), import upgrades
-- (item 2), outbox reliability and mock sends (item 3).
-- Simulated time: 1 Nov … 16 Dec 2026, lunch locks for 2–8 Nov through the real engine.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen H (monthly by default, credit limit 30 meals so prepaid customers keep eating),
-- Lunch ₹60 (veg) and Dinner ₹40 (non-veg), every day.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'b1600000-0000-4000-b000-000000000001', 'authenticated', 'authenticated', '919316000001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1600000-0000-4000-b000-000000000002', 'authenticated', 'authenticated', '919316000002', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1600000-0000-4000-b000-000000000003', 'authenticated', 'authenticated', '919316000003', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1600000-0000-4000-b000-000000000004', 'authenticated', 'authenticated', '919316000004', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1600000-0000-4000-b000-000000000005', 'authenticated', 'authenticated', '919316000005', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('b1600000-0000-4000-b000-00000000000a', 'Held Kitchen', 'held-kitchen', 'b1600000-0000-4000-b000-000000000001', '{}'),
  ('b1600000-0000-4000-b000-00000000000b', 'Second Held', 'second-held', 'b1600000-0000-4000-b000-000000000001', '{}');
insert into public.kitchen_settings (kitchen_id, credit_limit_meals) values
  ('b1600000-0000-4000-b000-00000000000a', 30), ('b1600000-0000-4000-b000-00000000000b', 30);
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('b1600000-0000-4000-b000-00000000000a', 'b1600000-0000-4000-b000-000000000001', 'owner', 'Owner'),
  ('b1600000-0000-4000-b000-00000000000b', 'b1600000-0000-4000-b000-000000000001', 'owner', 'Owner'),
  ('b1600000-0000-4000-b000-00000000000a', 'b1600000-0000-4000-b000-000000000002', 'staff', 'Staff'),
  ('b1600000-0000-4000-b000-00000000000a', 'b1600000-0000-4000-b000-000000000003', 'rider', 'Rider'),
  ('b1600000-0000-4000-b000-00000000000a', 'b1600000-0000-4000-b000-000000000004', 'manager', 'Manager'),
  ('b1600000-0000-4000-b000-00000000000a', 'b1600000-0000-4000-b000-000000000005', 'accountant', 'Accountant');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise, diet) values
  ('b1600000-0000-4000-b000-0000000000a1', 'b1600000-0000-4000-b000-00000000000a', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 6000, 'veg'),
  ('b1600000-0000-4000-b000-0000000000a2', 'b1600000-0000-4000-b000-00000000000a', 'Dinner', '{dinner}', '{1,2,3,4,5,6,7}', 4000, 'nonveg');

select is((select dues_overdue_days from public.kitchen_settings where kitchen_id = 'b1600000-0000-4000-b000-00000000000a'), 40,
  'unpaid dues count as overdue after 40 days by default');

select set_config('app.now', '2026-11-01 10:00:00+05:30', true);
create temp table hx (name text primary key, cust uuid, sub uuid);
grant select on hx to authenticated;
create function pg_temp.mk(p_name text, p_phone text, p_plan text, p_mode public.billing_mode default null)
returns void language plpgsql as $$
declare v_c uuid; v_s uuid;
begin
  v_c := private.insert_customer('b1600000-0000-4000-b000-00000000000a', p_name, p_phone, 'veg', 'en', null,
                                 '{"line1":"Lane 2","area":"Patia"}', 'vendor', 'vendor', p_mode);
  if p_plan is not null then
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values ('b1600000-0000-4000-b000-00000000000a', v_c, ('b1600000-0000-4000-b000-0000000000' || p_plan)::uuid,
            (select id from public.addresses where customer_id = v_c), '2026-11-02', 'active')
    returning id into v_s;
  end if;
  insert into hx values (p_name, v_c, v_s);
end $$;

select pg_temp.mk('Mona Monthly', '+919316100001', 'a1');
select pg_temp.mk('Priya Prepaid', '+919316100002', 'a1', 'prepaid');
select pg_temp.mk('Pari Paid', '+919316100003', 'a1');
select pg_temp.mk('Lata Late', '+919316100004', 'a1');
select pg_temp.mk('Papa Payer', '+919316100005', null);
update public.customers set payer_customer_id = (select cust from hx where name = 'Papa Payer')
where id = (select cust from hx where name = 'Lata Late');
-- Priya starts with 4 prepaid meals.
insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note, created_at)
values ('b1600000-0000-4000-b000-00000000000a', (select cust from hx where name = 'Priya Prepaid'), 'adjust', 4, 24000, 'Opening', private.now());

-- Lunch for 2–8 Nov: lock at 21:00 the day before, nightly at 00:30.
do $$
declare d date;
begin
  for d in select g::date from generate_series('2026-11-02'::date, '2026-11-08'::date, interval '1 day') g loop
    perform set_config('app.now', ((d - 1) + time '21:00:01')::timestamp at time zone 'Asia/Kolkata' || '', true);
    perform private.lock_slot('b1600000-0000-4000-b000-00000000000a', d, 'lunch');
    perform set_config('app.now', (d + time '00:30')::timestamp at time zone 'Asia/Kolkata' || '', true);
    perform private.nightly();
  end loop;
end $$;

-- ===========================================================================
-- Item 1: reminders know how the customer pays
-- ===========================================================================
select is((select private.rupee_balance(cust) from hx where name = 'Mona Monthly'), -42000::bigint,
  'a monthly customer owes 7 lunches at ₹60');
select is((select status::text from public.subscriptions where id = (select sub from hx where name = 'Mona Monthly')), 'active',
  'and stays active');
select ok((select count(*) from public.notifications_outbox where template = 'low_balance_reminder'
           and recipient_id = (select cust from hx where name = 'Priya Prepaid')) >= 1,
  'a prepaid customer running low still gets the daily low-balance reminder');
select ok((select count(*) from public.notifications_outbox where template = 'dues_reminder'
           and recipient_id = (select cust from hx where name = 'Priya Prepaid')) >= 1,
  'and the dues reminder once below zero');
select is((select count(*) from public.notifications_outbox
           where template in ('low_balance_reminder', 'dues_reminder', 'statement_ready')
             and recipient_id in (select cust from hx where name in ('Mona Monthly', 'Pari Paid', 'Lata Late', 'Papa Payer'))),
  0::bigint, 'monthly (pay-later) customers get no low-balance or day-1/3/7 dues messages mid-month');

-- Even a stale 'low_balance' status on a monthly subscription sends nothing.
update public.subscriptions set status = 'low_balance' where id = (select sub from hx where name = 'Mona Monthly');
select private.queue_customer_reminders();
select is((select count(*) from public.notifications_outbox where template = 'low_balance_reminder'
           and recipient_id = (select cust from hx where name = 'Mona Monthly')), 0::bigint,
  'the low-balance reminder checks the billing mode, not only the status');
select private.sync_balance_status('b1600000-0000-4000-b000-00000000000a', (select cust from hx where name = 'Mona Monthly'));
select is((select status::text from public.subscriptions where id = (select sub from hx where name = 'Mona Monthly')), 'active',
  'the next balance sync puts it back to active');

-- Receipts: monthly payments carry no meals, so the receipt says what is still to pay.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-b000-000000000001","role":"authenticated"}', true);
select set_config('app.now', '2026-11-20 10:00:00+05:30', true);
select lives_ok($$select public.record_payment((select cust from hx where name = 'Pari Paid'), 42000, 'cash')$$,
  'Pari pays November in full');
select lives_ok($$select public.record_payment((select cust from hx where name = 'Mona Monthly'), 12000, 'upi_manual')$$,
  'Mona pays part');
select lives_ok($$select public.record_payment((select cust from hx where name = 'Priya Prepaid'), 60000, 'cash', 10)$$,
  'Priya recharges 10 meals');
-- Owner sets the overdue window; it is checked.
select lives_ok($$update public.kitchen_settings set dues_overdue_days = 7 where kitchen_id = 'b1600000-0000-4000-b000-00000000000a'$$,
  'the owner sets the overdue window');
select throws_ok($$update public.kitchen_settings set dues_overdue_days = 3 where kitchen_id = 'b1600000-0000-4000-b000-00000000000a'$$,
  '23514', null, 'at least 7 days');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-b000-000000000002","role":"authenticated"}', true);
update public.kitchen_settings set dues_overdue_days = 365 where kitchen_id = 'b1600000-0000-4000-b000-00000000000a';
reset role;
select is((select dues_overdue_days from public.kitchen_settings where kitchen_id = 'b1600000-0000-4000-b000-00000000000a'), 7,
  'staff cannot change it');

select is((select template || '/' || (payload ->> 'due_paise') || '/' || (payload ->> 'amount_paise') from public.notifications_outbox
           where recipient_id = (select cust from hx where name = 'Mona Monthly') and template like 'payment_receipt%'),
  'payment_receipt_monthly/30000/12000', 'a monthly receipt: ₹120 paid, ₹300 still to pay');
select is((select template || '/' || (payload ->> 'due_paise') from public.notifications_outbox
           where recipient_id = (select cust from hx where name = 'Pari Paid') and template like 'payment_receipt%'),
  'payment_receipt_monthly/0', 'paid in full: nothing still to pay');
select is((select template || '/' || (payload ->> 'meals') from public.notifications_outbox
           where recipient_id = (select cust from hx where name = 'Priya Prepaid') and template like 'payment_receipt%'),
  'payment_receipt/10', 'a prepaid receipt still counts meals');

-- ===========================================================================
-- Item 1: churn — owing is normal for monthly customers; old unpaid dues are not
-- ===========================================================================
-- 20 Nov with a 7-day window: lunches up to 13 Nov count as old. Mona owes 42,000 − 12,000 paid.
select private.compute_churn('b1600000-0000-4000-b000-00000000000a');
select is((select array_to_string(reasons, ',') || '/' || (detail ->> 'overdue_paise') || '/' || (detail ->> 'oldest_unpaid')
           from public.churn_risks where customer_id = (select cust from hx where name = 'Mona Monthly')),
  'dues_overdue/30000/2026-11-04', 'with 7 days, Mona''s unpaid lunches are overdue (the payment settled 2 and 3 Nov)');
select is((select count(*) from public.churn_risks where customer_id = (select cust from hx where name = 'Pari Paid')), 0::bigint,
  'a monthly customer who paid is not at risk');
update public.kitchen_settings set dues_overdue_days = 40 where kitchen_id = 'b1600000-0000-4000-b000-00000000000a';
select private.compute_churn('b1600000-0000-4000-b000-00000000000a');
select is((select count(*) from public.churn_risks where customer_id in (select cust from hx where name in ('Mona Monthly', 'Lata Late'))),
  0::bigint, 'with the default 40 days, owing for this month''s meals is not a churn signal');
select ok((select 'balance_out' <> all (reasons) from public.churn_risks where customer_id = (select cust from hx where name = 'Priya Prepaid'))
          is not false, 'a prepaid customer who recharged is not balance_out');

-- ===========================================================================
-- Item 1: month-end statement message (Phase 2 only: needs customer_whatsapp)
-- ===========================================================================
select set_config('app.now', '2026-12-01 00:30:00+05:30', true);
select private.nightly();
select is((select count(*) from public.notifications_outbox where template like 'statement_ready%'
           and kitchen_id = 'b1600000-0000-4000-b000-00000000000a'), 0::bigint,
  'while customer WhatsApp is off, no statement messages are stored at all');

update public.platform_settings set enabled = true where key = 'customer_whatsapp';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-b000-000000000001","role":"authenticated"}', true);
select set_config('app.now', '2026-12-01 00:10:00+05:30', true);
select lives_ok($$select public.record_payment((select cust from hx where name = 'Lata Late'), 10000, 'cash')$$,
  'Lata pays ₹100 just after midnight');
reset role;
select set_config('app.now', '2026-12-02 00:30:00+05:30', true);
select private.nightly();
select is((select payload ->> 'amount_due_paise' || '/' || (payload ->> 'meals') || '/' || (payload ->> 'month') || '/' || status
           from public.notifications_outbox
           where recipient_id = (select cust from hx where name = 'Mona Monthly') and template = 'statement_ready'),
  '30000/7/2026-11/pending', 'on the 2nd, Mona''s November bill is queued: 7 meals, ₹300 still to pay');
select is((select template || '/' || (payload ->> 'amount_due_paise') || '/' || (payload ->> 'eater_name')
           from public.notifications_outbox where template like 'statement_ready%'
             and payload ->> 'eater_customer_id' = (select cust::text from hx where name = 'Lata Late')),
  'statement_ready_payer/32000/Lata Late', 'Lata''s bill goes to her payer, minus the ₹100 paid since the month ended');
select is((select count(*) from public.notifications_outbox where template like 'statement_ready%'
           and recipient_id in (select cust from hx where name in ('Pari Paid', 'Priya Prepaid'))), 0::bigint,
  'nothing for a monthly customer who paid, nor for a prepaid customer');
select set_config('app.now', '2026-12-03 00:30:00+05:30', true);
select private.nightly();
select is((select count(*) from public.notifications_outbox where template like 'statement_ready%'
           and kitchen_id = 'b1600000-0000-4000-b000-00000000000a'), 2::bigint, 'once per customer per month');

-- 15 Dec, default 40 days (lunches up to 5 Nov are old): Mona and Lata are overdue now.
select set_config('app.now', '2026-12-15 10:00:00+05:30', true);
select private.compute_churn('b1600000-0000-4000-b000-00000000000a');
select is((select (detail ->> 'overdue_paise') || '/' || (detail ->> 'oldest_unpaid') || '/' || (detail ->> 'overdue_days')
           from public.churn_risks where customer_id = (select cust from hx where name = 'Mona Monthly')),
  '12000/2026-11-04/40', 'Mona: 4 and 5 Nov are older than 40 days and unpaid');
select is((select (detail ->> 'overdue_paise') from public.churn_risks where customer_id = (select cust from hx where name = 'Lata Late')),
  '14000', 'Lata: 4 old lunches (₹240) minus ₹100 paid');

-- ===========================================================================
-- Item 2: import — chunks, status, two plans, repeated rows, diet, IST start date
-- ===========================================================================
-- 02:00 IST on 16 Dec is still 15 Dec in UTC: the default start date must be the IST date.
select set_config('app.now', '2026-12-16 02:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-b000-000000000001","role":"authenticated"}', true);
create temp table imp (k text primary key, r jsonb);
grant select, insert on imp to authenticated;
insert into imp select 'c1', public.import_customers('b1600000-0000-4000-b000-00000000000a', '[
  {"name":"Rina Ray","phone":"9316200001","plan":"Lunch","plan_2":"Dinner"},
  {"name":"Sanu Sahu","phone":"9316200002","plan":"Lunch","status":"Paused","paused_from":"2026-12-01"},
  {"name":"Gopal Giri","phone":"9316200003","plan":"Lunch","status":"Stopped","dues":"500"}
]'::jsonb, true, 'register.xlsx', 'b1600000-0000-4000-b000-0000000000f1', 1, 13);
create temp table chunk2 as select '[
  {"name":"rina  ray","phone":"9316200001","plan":"Dinner"},
  {"name":"Sanu Sahu","phone":"+91 93162 00002","plan":"Dinner","qty":"2"},
  {"name":"Gopal Giri","phone":"9316200003"},
  {"name":"Meera Mohanty","phone":"9316200004","diet":"Non-veg","plan":"Lunch"},
  {"name":"Tara","phone":"9316200005","status":"holiday"},
  {"name":"Uma","phone":"9316200006","status":"active","paused_from":"2026-12-20"},
  {"name":"Sanu Sahu","phone":"9316200002","plan":"Dinner","balance":"5"},
  {"name":"Vik","phone":"9316200007","plan":"Lunch","paused_from":"2026-12-20","start_date":"2026-12-18"},
  {"name":"Wasim","phone":"9316200008","plan":"Lunch","plan_2":"lunch"},
  {"name":"Xena","phone":"9316200009","plan":"Lunch","plan_2":"Gold"}
]'::jsonb as rows;
grant select on chunk2 to authenticated;
insert into imp select 'c2', public.import_customers('b1600000-0000-4000-b000-00000000000a', (select rows from chunk2), true,
  'register.xlsx', 'b1600000-0000-4000-b000-0000000000f1', 4, 13);
insert into imp select 'c2again', public.import_customers('b1600000-0000-4000-b000-00000000000a', (select rows from chunk2), true,
  'register.xlsx', 'b1600000-0000-4000-b000-0000000000f1', 4, 13);
select throws_ok($$select public.import_customers('b1600000-0000-4000-b000-00000000000b', '[{"name":"A","phone":"9316209999"}]'::jsonb, true,
  null, 'b1600000-0000-4000-b000-0000000000f1', 20)$$, '22023', 'invalid_batch', 'a batch belongs to one kitchen');
select throws_ok($$select public.import_customers('b1600000-0000-4000-b000-00000000000a', '[]'::jsonb, true, null, null, 0)$$,
  '22023', 'invalid_batch', 'row positions start at 1');
-- Who may import: owner and manager (D-117); not staff, riders, accountants, another kitchen or anon.
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-b000-000000000004","role":"authenticated"}', true);
select lives_ok($$select public.import_customers('b1600000-0000-4000-b000-00000000000a', '[{"name":"By Manager","phone":"9316209001"}]'::jsonb,
  true, null, 'b1600000-0000-4000-b000-0000000000f2', 1, 1)$$, 'a manager imports');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-b000-000000000005","role":"authenticated"}', true);
select throws_ok($$select public.import_customers('b1600000-0000-4000-b000-00000000000a', '[]'::jsonb, true)$$, '42501', 'forbidden',
  'an accountant cannot import');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-b000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.import_customers('b1600000-0000-4000-b000-00000000000a', '[]'::jsonb, true)$$, '42501', 'forbidden',
  'staff cannot import');
select set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-b000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.import_customers('b1600000-0000-4000-b000-00000000000a', '[]'::jsonb, true)$$, '42501', 'forbidden',
  'riders cannot import');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.import_customers('b1600000-0000-4000-b000-00000000000a', '[]'::jsonb, true, null,
  'b1600000-0000-4000-b000-0000000000f1', 99)$$, '42501', 'forbidden', 'another kitchen''s owner cannot import here or reuse its batch');
set local role anon;
select throws_ok($$select public.import_customers('b1600000-0000-4000-b000-00000000000a', '[]'::jsonb, true)$$, '42501', null,
  'anon cannot import');
reset role;

select is((select (r ->> 'imported') || '/' || (r ->> 'customers') || '/' || (r -> 'warnings')::text from imp where k = 'c1'),
  '3/3/[{"row": 3, "warnings": ["stopped_plan_ignored"]}]', 'chunk 1: 3 customers; the stopped customer''s plan is ignored');
select is((select r -> 'errors' from imp where k = 'c2'),
  '[{"row": 4, "errors": ["same_plan_twice"]}, {"row": 6, "errors": ["duplicate_in_file"]}, {"row": 8, "errors": ["invalid_status"]}, {"row": 9, "errors": ["paused_from_needs_paused"]}, {"row": 10, "errors": ["balance_on_repeated_row"]}, {"row": 12, "errors": ["same_plan_twice"]}, {"row": 13, "errors": ["unknown_second_plan"]}]'::jsonb,
  'chunk 2: errors are reported with file-wide row numbers');
select is((select (r ->> 'imported') || '/' || (r ->> 'customers') || '/' || (r ->> 'merged') || '/' || (r -> 'warnings')::text from imp where k = 'c2'),
  '3/2/1/[{"row": 7, "warnings": ["diet_differs_from_plan"]}]', 'chunk 2: 2 new customers, 1 repeated row added a plan, 1 diet warning');
select is((select (r ->> 'already_done') || '/' || (r ->> 'imported') || '/' || (r ->> 'customers') || '/' || (r ->> 'merged') from imp where k = 'c2again'),
  '10/3/2/1', 'a retried chunk creates nothing twice and reports the first outcome (new customers and merges)');
select is((select r -> 'errors' from imp where k = 'c2again'), (select r -> 'errors' from imp where k = 'c2'), 'with the same errors');
select is((select r -> 'warnings' from imp where k = 'c2again'), (select r -> 'warnings' from imp where k = 'c2'), 'and the same warnings');
select is((select string_agg(name, ',' order by name) from public.customers
           where kitchen_id = 'b1600000-0000-4000-b000-00000000000a' and source = 'import' and name <> 'By Manager'),
  'Gopal Giri,Meera Mohanty,Rina Ray,Sanu Sahu,Vik', 'five imported customers in all');
select is((select imported_rows || '/' || error_rows || '/' || total_rows from public.import_batches where id = 'b1600000-0000-4000-b000-0000000000f1'),
  '6/7/13', 'one batch for the whole file');

select is((select string_agg(p.name || ':' || s.status || ':' || s.start_date, ',' order by p.name)
           from public.subscriptions s join public.plans p on p.id = s.plan_id join public.customers c on c.id = s.customer_id
           where c.name = 'Rina Ray'), 'Dinner:active:2026-12-16,Lunch:active:2026-12-16',
  'two plans on one row; the default start date is the IST date');
select is((select diet::text from public.customers where name = 'Rina Ray'), 'veg', 'a blank diet takes the first plan''s diet');
select is((select diet::text from public.customers where name = 'Meera Mohanty'), 'nonveg', 'a given diet is kept');
select is((select string_agg(distinct o.diet::text, ',') from public.meal_orders o join public.customers c on c.id = o.customer_id
           where c.name = 'Meera Mohanty'), 'veg', '(meals are cooked to the plan''s diet: hence the warning)');
select is((select string_agg(p.name || ':' || s.status || ':' || s.qty, ',' order by p.name)
           from public.subscriptions s join public.plans p on p.id = s.plan_id join public.customers c on c.id = s.customer_id
           where c.name = 'Sanu Sahu'), 'Dinner:active:2,Lunch:paused:1',
  'a repeated row adds its plan; the paused row''s plan is paused');
select is((select sc.from_date || '/' || coalesce(sc.to_date::text, 'open') || '/' || sc.channel from public.schedule_changes sc
           join public.subscriptions s on s.id = sc.subscription_id join public.customers c on c.id = s.customer_id
           where c.name = 'Sanu Sahu' and sc.type = 'pause'), '2026-12-16/open/vendor', 'a past paused-from date pauses from today');
select is((select count(*) from public.meal_orders o join public.subscriptions s on s.id = o.subscription_id
           join public.customers c on c.id = s.customer_id
           where c.name = 'Sanu Sahu' and s.plan_id = 'b1600000-0000-4000-b000-0000000000a1' and o.status <> 'skipped'), 0::bigint,
  'no lunch is counted for the paused plan');
select is((select count(s.id) || '/' || private.rupee_balance(c.id) from public.customers c
           left join public.subscriptions s on s.customer_id = c.id where c.name = 'Gopal Giri' group by c.id),
  '0/-50000', 'a stopped customer keeps the dues but gets no subscription');
select is((select sc.from_date || '/' || s.status || '/' || s.start_date from public.schedule_changes sc
           join public.subscriptions s on s.id = sc.subscription_id join public.customers c on c.id = s.customer_id
           where c.name = 'Vik'), '2026-12-20/active/2026-12-18', 'a paused-from date alone means paused, from that date');
select is((select count(*) from public.import_rows where raw ? 'phone'), 0::bigint, 'import rows still never keep the full phone');

-- ===========================================================================
-- Item 3: outbox — stuck rows, never twice, mock sends
-- ===========================================================================
select set_config('app.now', '2026-12-16 03:00:00+05:30', true);
-- Member alerts (not gated) for the stuck tests; customer rows (customer WhatsApp is on) for completion.
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, send_after)
select 'b1600000-0000-4000-b000-00000000000a', 'whatsapp', x.rt, x.rid, x.tpl, '{}', x.k, private.now() - interval '1 minute'
from (values
  ('h3-stuck', 'member', 'b1600000-0000-4000-b000-000000000001'::uuid, 'owner_daily_summary'),
  ('h3-stuck5', 'member', 'b1600000-0000-4000-b000-000000000001'::uuid, 'owner_daily_summary'),
  ('h3-provider', 'member', 'b1600000-0000-4000-b000-000000000001'::uuid, 'owner_daily_summary'),
  ('h3-mock', 'customer', (select cust from hx where name = 'Mona Monthly'), 'vendor_message'),
  ('h3-real', 'customer', (select cust from hx where name = 'Mona Monthly'), 'vendor_message'),
  ('h3-fail', 'customer', (select cust from hx where name = 'Mona Monthly'), 'vendor_message'),
  ('h3-callback', 'member', 'b1600000-0000-4000-b000-000000000001'::uuid, 'owner_daily_summary'),
  ('h3-race', 'customer', (select cust from hx where name = 'Mona Monthly'), 'vendor_message')
) as x(k, rt, rid, tpl);
insert into public.conversations (kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4)
select kitchen_id, id, phone_hash, phone_enc, phone_last4 from public.customers where id = (select cust from hx where name = 'Mona Monthly');

create temp table cl as select * from public.wa_claim_outbox(100) where kitchen_id = 'b1600000-0000-4000-b000-00000000000a';
create function pg_temp.oid_of(p text) returns uuid language sql as $$ select id from public.notifications_outbox where dedupe_key = p $$;
create function pg_temp.st(p text) returns text language sql as $$ select status from public.notifications_outbox where dedupe_key = p $$;
select is((select count(*) from cl join public.notifications_outbox o on o.id = cl.id where o.dedupe_key like 'h3-%'), 8::bigint,
  'eight rows claimed');
select is((select count(*) from public.notifications_outbox where dedupe_key like 'h3-%' and claimed_at = private.now()), 8::bigint,
  'the claim records when');

-- Mock mode: recorded as mock, shown as mock in the conversation.
select public.wa_complete_outbox(pg_temp.oid_of('h3-mock'), true, 'wamid.mock_h3', null, 'Hello (mock)', false, true);
select is(pg_temp.st('h3-mock'), 'mock', 'a mock send is recorded as mock, not sent');
select is((select status from public.messages where wa_message_id = 'wamid.mock_h3'), 'mock', 'and the conversation shows it as mock');
select public.wa_complete_outbox(pg_temp.oid_of('h3-mock'), false, null, 'timeout', null);
select is(pg_temp.st('h3-mock'), 'mock', 'a late failure report cannot re-queue it');

-- Real send: the provider id is kept; repeats and late failures change nothing.
select public.wa_complete_outbox(pg_temp.oid_of('h3-real'), true, 'wamid.real_h3', null, 'Hello');
select public.wa_complete_outbox(pg_temp.oid_of('h3-real'), true, 'wamid.real_h3', null, 'Hello');
select public.wa_complete_outbox(pg_temp.oid_of('h3-real'), false, null, 'lost response', null);
select is((select status || '/' || provider_message_id || '/' || attempts from public.notifications_outbox where dedupe_key = 'h3-real'),
  'sent/wamid.real_h3/1', 'sent once, with the provider id; a duplicate completion or failure report changes nothing');
select is((select count(*) from public.messages where wa_message_id = 'wamid.real_h3'), 1::bigint, 'logged once');

-- The status webhook records the send before the worker does: the worker's late success report
-- changes no status but still logs the message in the conversation, once.
select public.wa_message_status('wamid.race_h3', 'sent', 'outbox:' || pg_temp.oid_of('h3-race'));
select public.wa_complete_outbox(pg_temp.oid_of('h3-race'), true, 'wamid.race_h3', null, 'Hello (race)');
select public.wa_complete_outbox(pg_temp.oid_of('h3-race'), true, 'wamid.race_h3', null, 'Hello (race)');
select is((select status || '/' || provider_message_id from public.notifications_outbox where dedupe_key = 'h3-race'),
  'sent/wamid.race_h3', 'webhook first: the row stays sent with its provider id');
select is((select count(*) || '/' || min(body) from public.messages where wa_message_id = 'wamid.race_h3'), '1/Hello (race)',
  'and the late completion still logs it in the conversation, once');
select public.wa_complete_outbox(pg_temp.oid_of('h3-race'), true, 'wamid.other', null, 'Other');
select is((select count(*) from public.messages where wa_message_id = 'wamid.other'), 0::bigint,
  'a completion with a different provider id logs nothing');

-- A real failure is retried later.
select public.wa_complete_outbox(pg_temp.oid_of('h3-fail'), false, null, 'timeout', null);
select is((select status || '/' || attempts || '/' || (send_after > private.now()) from public.notifications_outbox where dedupe_key = 'h3-fail'),
  'pending/1/true', 'a failed send goes back to pending with backoff');

-- Meta's status webhook carries the row id (biz_opaque_callback_data): proof it was sent.
select public.wa_message_status('wamid.cb_h3', 'sent', 'outbox:' || pg_temp.oid_of('h3-callback'));
select is((select status || '/' || provider_message_id from public.notifications_outbox where dedupe_key = 'h3-callback'),
  'sent/wamid.cb_h3', 'a status webhook for an unrecorded send marks the row sent');
select public.wa_message_status('wamid.cb_h3b', 'sent', 'outbox:not-a-uuid');
select public.wa_message_status('wamid.cb_h3c', 'failed', 'outbox:' || pg_temp.oid_of('h3-stuck'));
select is(pg_temp.st('h3-stuck'), 'sending', 'a malformed callback or a failed status changes nothing');

-- 11 minutes later the worker has not come back: stuck rows.
update public.notifications_outbox set attempts = 5 where dedupe_key = 'h3-stuck5';
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, status, created_at)
values ('b1600000-0000-4000-b000-00000000000a', 'push', 'member', 'b1600000-0000-4000-b000-000000000001', 'owner_daily_summary', '{}',
        'h3-push', 'sending', private.now() - interval '1 hour');
update public.notifications_outbox set provider_message_id = 'wamid.prov_h3' where dedupe_key = 'h3-provider';
select set_config('app.now', '2026-12-16 03:11:00+05:30', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
create temp table m as select public.platform_metrics() as j;
select is((select (j -> 'open' ->> 'outbox_stuck')::int from m),
  (select count(*)::int from public.notifications_outbox where channel = 'whatsapp' and status = 'sending'
     and coalesce(claimed_at, created_at) < private.now() - interval '10 minutes'),
  'admin metrics count stuck WhatsApp rows (not other channels)');
select ok((select (j -> 'open' ->> 'outbox_failed')::int >= (j -> 'open' ->> 'outbox_stuck')::int and (j -> 'open' ->> 'outbox_stuck')::int >= 3 from m),
  'and the failure count includes them');
select ok((select (j -> 'last_7_days' ->> 'whatsapp_mock')::int >= 1 from m), 'mock sends are counted apart from real ones');
select set_config('request.jwt.claims', '', true);
select ok(private.release_stuck_outbox() >= 3, 'the cron releases stuck rows');
select is((select status || '/' || last_error || '/' || attempts from public.notifications_outbox where dedupe_key = 'h3-stuck'),
  'pending/stuck_sending/1', 'a stuck row goes back to pending (the claim counted as an attempt)');
select is(pg_temp.st('h3-stuck5'), 'failed', 'after 5 attempts it is failed');
select is(pg_temp.st('h3-provider'), 'sent', 'a stuck row with a provider id was sent: never again');
select is(pg_temp.st('h3-callback'), 'sent', 'the webhook-confirmed row stays sent');
select is(pg_temp.st('h3-push'), 'sending', 'the WhatsApp sweep leaves other channels alone');
select is((select count(*) from cron.job where jobname = 'tiffin-outbox-stuck'), 1::bigint, 'the stuck-row job is scheduled');

-- Riders see "code sent" only for a real send.
insert into public.delivery_routes (id, kitchen_id, slot, name, rider_id) values
  ('b1600000-0000-4000-b000-0000000000d1', 'b1600000-0000-4000-b000-00000000000a', 'lunch', 'Held route', 'b1600000-0000-4000-b000-000000000003');
insert into public.delivery_runs (id, kitchen_id, route_id, service_date, slot, rider_id, status) values
  ('b1600000-0000-4000-b000-0000000000d2', 'b1600000-0000-4000-b000-00000000000a', 'b1600000-0000-4000-b000-0000000000d1',
   '2026-12-16', 'lunch', 'b1600000-0000-4000-b000-000000000003', 'out');
insert into public.delivery_stops (id, kitchen_id, run_id, customer_id, seq, meal_count) values
  ('b1600000-0000-4000-b000-0000000000d3', 'b1600000-0000-4000-b000-00000000000a', 'b1600000-0000-4000-b000-0000000000d2',
   (select cust from hx where name = 'Mona Monthly'), 1, 1);
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, status)
values ('b1600000-0000-4000-b000-00000000000a', 'whatsapp', 'customer', (select cust from hx where name = 'Mona Monthly'), 'on_the_way',
        '{"otp":"1234"}', 'on_the_way:b1600000-0000-4000-b000-0000000000d3:1', 'pending');
create function pg_temp.otp_sent() returns boolean language plpgsql as $$
declare v boolean;
begin
  perform set_config('request.jwt.claims', '{"sub":"b1600000-0000-4000-b000-000000000003","role":"authenticated"}', true);
  select (public.rider_today() -> 0 -> 'stops' -> 0 ->> 'otp_sent')::boolean into v;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
select is(pg_temp.otp_sent(), false, 'a pending "on the way" message is not a code the customer has');
update public.notifications_outbox set status = 'mock' where dedupe_key = 'on_the_way:b1600000-0000-4000-b000-0000000000d3:1';
select is(pg_temp.otp_sent(), false, 'nor is a mock send');
update public.notifications_outbox set status = 'sent' where dedupe_key = 'on_the_way:b1600000-0000-4000-b000-0000000000d3:1';
select is(pg_temp.otp_sent(), true, 'a real send is');

select * from finish();
rollback;
