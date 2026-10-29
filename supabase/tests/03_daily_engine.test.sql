-- M2 tests: generation, skip/pause/resume/address/cancel, cutoffs (incl. phone-close rule),
-- idempotent lock, balance entries, permissions. Uses a simulated clock (app.now).
-- Calendar: 2026-11-01 is a Sunday; the test kitchen's weekly off is Sunday.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: test kitchen T with owner + staff, 20 lunch customers and 1 trial.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-c000-000000000001', 'authenticated', 'authenticated', '919111000001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-c000-000000000002', 'authenticated', 'authenticated', '919111000002', now(), now(), now());

insert into public.kitchens (id, name, slug, owner_id, weekly_off, capacity_lunch)
values ('30000000-0000-4000-c000-000000000001', 'Test Engine Kitchen', 'test-engine-kitchen',
        '00000000-0000-4000-c000-000000000001', '{7}', 100);
insert into public.kitchen_settings (kitchen_id) values ('30000000-0000-4000-c000-000000000001');
insert into public.members (kitchen_id, user_id, role) values
  ('30000000-0000-4000-c000-000000000001', '00000000-0000-4000-c000-000000000001', 'owner'),
  ('30000000-0000-4000-c000-000000000001', '00000000-0000-4000-c000-000000000002', 'staff');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('40000000-0000-4000-c000-000000000001', '30000000-0000-4000-c000-000000000001', 'Lunch', '{lunch}', '{1,2,3,4,5,6}', 7000);

select set_config('app.now', '2026-11-01 10:00:00+05:30', true);

create temp table t (n integer primary key, cust uuid, sub uuid);
grant select on t to authenticated;

do $$
declare
  i integer;
  v_cust uuid;
  v_sub uuid;
begin
  for i in 1..21 loop
    v_cust := private.insert_customer('30000000-0000-4000-c000-000000000001', 'Customer ' || i,
      '+9198700' || lpad(i::text, 5, '0'), 'veg', 'en', null,
      jsonb_build_object('line1', 'Flat ' || i, 'area', case when i % 2 = 0 then 'Patia' else 'Infocity' end),
      'vendor', 'vendor');
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values ('30000000-0000-4000-c000-000000000001', v_cust, '40000000-0000-4000-c000-000000000001',
            (select id from public.addresses where customer_id = v_cust), '2026-11-02',
            (case when i = 21 then 'trial' else 'active' end)::public.subscription_status)
    returning id into v_sub;
    insert into t values (i, v_cust, v_sub);
  end loop;
end $$;

-- ===========================================================================
-- Generation
-- ===========================================================================
select is((select count(*) from public.meal_orders where kitchen_id = '30000000-0000-4000-c000-000000000001'
           and service_date = '2026-11-03' and slot = 'lunch' and status = 'scheduled'), 20::bigint,
  'new subscriptions generate orders immediately (20 for Tue lunch)');
select is((select count(*) from public.meal_orders where kitchen_id = '30000000-0000-4000-c000-000000000001'
           and service_date = '2026-11-03' and slot = 'dinner'), 0::bigint, 'no dinner for a lunch-only plan');
select is((select count(*) from public.meal_orders where subscription_id = (select sub from t where n = 21)), 0::bigint,
  'trial subscriptions generate no meals');
select is((select count(distinct service_date) from public.meal_orders where subscription_id = (select sub from t where n = 1)),
  6::bigint, 'Mon–Sat generated inside the 7-day window (Sunday 1 Nov is before the start date)');
select is(private.refresh_orders('30000000-0000-4000-c000-000000000001', null, 7), 0,
  'refreshing again changes nothing (idempotent)');

-- ===========================================================================
-- M2 test 1: 20 customers, 3 skip before cutoff and 1 after -> locked count 17, late skip charged
-- Tue 3 Nov lunch, cutoff Mon 2 Nov 21:00 IST.
-- ===========================================================================
select set_config('app.now', '2026-11-02 20:55:00+05:30', true);
select is((private.apply_change((select sub from t where n = 1), 'skip', '2026-11-03', null, null, null, 'whatsapp', false, null, false, null)
          ->> 'after_cutoff')::boolean, false, 'skip at 20:55 is before the cutoff');
select private.apply_change((select sub from t where n = 2), 'skip', '2026-11-03', null, null, null, 'whatsapp', false, null, false, null);
select private.apply_change((select sub from t where n = 3), 'skip', '2026-11-03', null, 'lunch', null, 'web', false, null, false, null);
select is((private.slot_totals('30000000-0000-4000-c000-000000000001', '2026-11-03', 'lunch') ->> 'total_meals')::integer, 17,
  'live count drops to 17 after 3 skips');

select set_config('app.now', '2026-11-02 21:00:30+05:30', true);
select ok(private.run_due_locks() >= 1, 'the lock job runs at the cutoff');
select is((select (totals ->> 'total_meals')::integer from public.count_snapshots
           where kitchen_id = '30000000-0000-4000-c000-000000000001' and service_date = '2026-11-03' and slot = 'lunch'), 17,
  'locked count is 17');

select set_config('app.now', '2026-11-02 21:05:00+05:30', true);
select is((private.apply_change((select sub from t where n = 4), 'skip', '2026-11-03', null, null, null, 'whatsapp', false, null, false, null)
          ->> 'after_cutoff')::boolean, true, 'skip at 21:05 is after the cutoff');
select is((select status::text || '/' || charged::text from public.meal_orders
           where subscription_id = (select sub from t where n = 4) and service_date = '2026-11-03'), 'skipped/true',
  'late skip is marked charged');
select is((select (totals ->> 'total_meals')::integer from public.count_snapshots
           where kitchen_id = '30000000-0000-4000-c000-000000000001' and service_date = '2026-11-03' and slot = 'lunch'), 17,
  'locked count stays 17');
select is((private.slot_totals('30000000-0000-4000-c000-000000000001', '2026-11-03', 'lunch') ->> 'to_deliver')::integer, 16,
  'but only 16 tiffins go out');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where o.kitchen_id = '30000000-0000-4000-c000-000000000001' and o.service_date = '2026-11-03' and b.type = 'meal'), 17::bigint,
  '17 meal balance entries posted (late skip included)');
select is((select sum(b.meals) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where o.subscription_id = (select sub from t where n = 4) and o.service_date = '2026-11-03'), -1::bigint,
  'late-skipping customer is charged the Tue lunch');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where o.subscription_id = (select sub from t where n = 1) and o.service_date = '2026-11-03'), 0::bigint,
  'on-time skipper is not charged for Tue lunch');
select is((select b.amount_paise from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where o.subscription_id = (select sub from t where n = 5) and o.service_date = '2026-11-03'), -7000,
  'meal entry carries the plan price (₹70)');
select is((select count(*) from public.count_snapshots where kitchen_id = '30000000-0000-4000-c000-000000000001'
           and service_date = '2026-11-02' and slot = 'lunch'), 1::bigint,
  'the same job also locked Monday lunch, which was due too');

-- ===========================================================================
-- M2 test 2: run the lock job twice -> nothing duplicated
-- ===========================================================================
select is(private.lock_slot('30000000-0000-4000-c000-000000000001', '2026-11-03', 'lunch'),
  (select id from public.count_snapshots where kitchen_id = '30000000-0000-4000-c000-000000000001'
   and service_date = '2026-11-03' and slot = 'lunch'), 'locking again returns the same snapshot');
select is(private.run_due_locks(), 0, 'the lock job finds nothing left to lock');
select is((select count(*) from public.count_snapshots where kitchen_id = '30000000-0000-4000-c000-000000000001'
           and service_date = '2026-11-03' and slot = 'lunch'), 1::bigint, 'still one snapshot');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where o.kitchen_id = '30000000-0000-4000-c000-000000000001' and o.service_date = '2026-11-03'), 17::bigint,
  'still 17 meal entries');
select is((select count(*) from public.notifications_outbox where kitchen_id = '30000000-0000-4000-c000-000000000001'
           and template = 'production_sheet' and payload ->> 'service_date' = '2026-11-03'), 1::bigint,
  'production sheet queued once for the owner');
select is((select count(*) from public.audit_log where table_name = 'count_snapshots'
           and kitchen_id = '30000000-0000-4000-c000-000000000001'),
  (select count(*) from public.count_snapshots where kitchen_id = '30000000-0000-4000-c000-000000000001'),
  'each lock is audited exactly once');

-- ===========================================================================
-- Phone-close rule: vendor-entered changes close at 19:00 the evening before
-- ===========================================================================
select set_config('app.now', '2026-11-03 19:30:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-c000-000000000001","role":"authenticated"}', true);
select is((public.request_schedule_change((select sub from t where n = 5), 'skip', '2026-11-04', p_dry_run => true) -> 'affected' -> 0 ->> 'charged')::boolean,
  true, 'preview tells the vendor a 19:30 phone skip will be charged');
select is((select count(*) from public.schedule_changes where subscription_id = (select sub from t where n = 5)), 0::bigint,
  'preview writes nothing');
select lives_ok($$select public.request_schedule_change((select sub from t where n = 5), 'skip', '2026-11-04')$$,
  'owner records the late phone skip');
select lives_ok($$select public.request_schedule_change((select sub from t where n = 6), 'skip', '2026-11-04', p_waive_late => true)$$,
  'owner records a late phone skip and waives the charge');
reset role;
select is((select status::text || '/' || charged::text from public.meal_orders
           where subscription_id = (select sub from t where n = 5) and service_date = '2026-11-04'), 'skipped/true',
  'late phone skip is charged');
select is((select status::text || '/' || charged::text from public.meal_orders
           where subscription_id = (select sub from t where n = 6) and service_date = '2026-11-04'), 'skipped/false',
  'waived late phone skip is not charged (slot still open)');
select is((select late_waived from public.schedule_changes where subscription_id = (select sub from t where n = 6)), true,
  'waiver is recorded');
select is((private.apply_change((select sub from t where n = 7), 'skip', '2026-11-04', null, null, null, 'whatsapp', false, null, false, null)
          ->> 'after_cutoff')::boolean, false, 'WhatsApp skip at 19:30 is still on time');
select set_config('app.now', '2026-11-03 21:00:30+05:30', true);
select private.run_due_locks();
select is((select (totals ->> 'total_meals')::integer from public.count_snapshots
           where kitchen_id = '30000000-0000-4000-c000-000000000001' and service_date = '2026-11-04' and slot = 'lunch'), 18,
  'Wed lunch: 20 minus waived and WhatsApp skips = 18 (charged phone skip counted)');

-- ===========================================================================
-- Pause and resume
-- ===========================================================================
select set_config('app.now', '2026-11-03 21:30:00+05:30', true);
select private.apply_change((select sub from t where n = 8), 'pause', '2026-11-05', null, null, null, 'web', false, null, false, null);
select is((select string_agg(service_date || ':' || status, ',' order by service_date) from public.meal_orders
           where subscription_id = (select sub from t where n = 8) and service_date >= '2026-11-04'),
  '2026-11-04:locked,2026-11-05:skipped,2026-11-06:skipped,2026-11-07:skipped,2026-11-09:skipped',
  'open-ended pause skips every meal from its start date (Wed already locked)');
select is((select status::text from public.subscriptions where id = (select sub from t where n = 8)), 'active',
  'status stays active until the pause starts');
select set_config('app.now', '2026-11-05 00:30:00+05:30', true);
select private.nightly();
select is((select status::text from public.subscriptions where id = (select sub from t where n = 8)), 'paused',
  'nightly job moves the subscription to paused');
select is((select reason from public.subscription_events where subscription_id = (select sub from t where n = 8)
           order by id desc limit 1), 'pause_started', 'transition is logged');
select set_config('app.now', '2026-11-05 10:00:00+05:30', true);
select private.apply_change((select sub from t where n = 8), 'resume', '2026-11-07', null, null, null, 'web', false, null, false, null);
select is((select string_agg(service_date || ':' || status, ',' order by service_date) from public.meal_orders
           where subscription_id = (select sub from t where n = 8) and service_date between '2026-11-06' and '2026-11-07'),
  '2026-11-06:skipped,2026-11-07:scheduled', 'resume brings meals back from its date');
select set_config('app.now', '2026-11-07 00:30:00+05:30', true);
select private.nightly();
select is((select status::text from public.subscriptions where id = (select sub from t where n = 8)), 'active',
  'nightly job moves it back to active');
select is((select count(*) from public.meal_orders where kitchen_id = '30000000-0000-4000-c000-000000000001'
           and service_date = '2026-11-08'), 0::bigint, 'no meals on the weekly off (Sunday)');
select is((select count(*) from public.meal_orders where kitchen_id = '30000000-0000-4000-c000-000000000001'
           and service_date = '2026-11-09' and status = 'scheduled'), 20::bigint,
  'after the resume, all 20 Monday meals are scheduled');

-- ===========================================================================
-- Address change (temporary) and cancel with notice — run on a fresh clock
-- ===========================================================================
select set_config('app.now', '2026-11-07 10:00:00+05:30', true);
insert into public.addresses (kitchen_id, customer_id, line1, area, is_default)
values ('30000000-0000-4000-c000-000000000001', (select cust from t where n = 9), 'Office, Tower B', 'Infocity', false);
select private.apply_change((select sub from t where n = 9), 'address', '2026-11-10', '2026-11-10', null,
  (select id from public.addresses where line1 = 'Office, Tower B'), 'vendor', false, null, false, null);
select is((select a.line1 from public.meal_orders o join public.addresses a on a.id = o.address_id
           where o.subscription_id = (select sub from t where n = 9) and o.service_date = '2026-11-10'), 'Office, Tower B',
  'temporary address applies to that day');
select is((select a.line1 from public.meal_orders o join public.addresses a on a.id = o.address_id
           where o.subscription_id = (select sub from t where n = 9) and o.service_date = '2026-11-11'), 'Flat 9',
  'and not to the next day');
select isnt((select address_id from public.subscriptions where id = (select sub from t where n = 9)),
  (select id from public.addresses where line1 = 'Office, Tower B'), 'subscription default address unchanged');

select throws_ok($$select private.apply_change((select sub from t where n = 9), 'skip', '2026-11-01', null, null, null, 'vendor', false, null, false, null)$$,
  '22023', 'date_in_past', 'cannot skip a past date');
select throws_ok($$select private.apply_change((select sub from t where n = 9), 'skip', '2026-11-10', null, 'dinner', null, 'vendor', false, null, false, null)$$,
  '22023', 'slot_not_in_plan', 'cannot skip a slot the plan does not have');

select set_config('app.now', '2026-11-07 10:00:00+05:30', true);
select is((private.apply_change((select sub from t where n = 10), 'cancel', null, null, null, null, 'vendor', false, null, false, null)
          ->> 'from_date'), '2026-11-08', 'cancel takes effect after the 1-day notice');
select is((select end_date::text from public.subscriptions where id = (select sub from t where n = 10)), '2026-11-07',
  'end date set to the day before');
select is((select count(*) from public.meal_orders where subscription_id = (select sub from t where n = 10)
           and service_date > '2026-11-07'), 0::bigint, 'future meals removed');
select private.apply_change((select sub from t where n = 11), 'cancel', '2026-11-07', null, null, null, 'vendor', false, null, false, null);
select is((select status::text from public.subscriptions where id = (select sub from t where n = 11)), 'cancelled',
  'cancel effective today cancels now');
select throws_ok($$select private.apply_change((select sub from t where n = 11), 'skip', '2026-11-10', null, null, null, 'vendor', false, null, false, null)$$,
  '22023', 'subscription_cancelled', 'no changes on a cancelled subscription');
select set_config('app.now', '2026-11-08 00:30:00+05:30', true);
select private.nightly();
select is((select status::text from public.subscriptions where id = (select sub from t where n = 10)), 'cancelled',
  'nightly job cancels once the end date has passed');

-- ===========================================================================
-- Permissions
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-c000-000000000002","role":"authenticated"}', true);
select ok((select count(*) from public.meal_orders) > 0, 'staff can read meal orders (counts, packing)');
select throws_ok('select price_per_meal_paise from public.meal_orders limit 1', '42501', null, 'staff cannot read meal prices');
select is((select count(*) from public.balance_entries), 0::bigint, 'staff cannot see balances');
select is((select count(*) from public.customer_balances), 0::bigint, 'staff cannot see balances (view)');
select ok((public.slot_summary('30000000-0000-4000-c000-000000000001', '2026-11-03', 'lunch') ->> 'locked')::boolean,
  'staff can read slot summaries');
select is((select count(*) from public.packing_list('30000000-0000-4000-c000-000000000001', '2026-11-03', 'lunch')), 17::bigint,
  'packing list has the 17 counted orders (the late skip is listed, marked do-not-deliver)');
select throws_ok($$select public.request_schedule_change((select sub from t where n = 12), 'skip', '2026-11-12')$$,
  '42501', 'forbidden', 'staff cannot record customer changes');
select throws_ok($$insert into public.balance_entries (kitchen_id, customer_id, type, meals)
  values ('30000000-0000-4000-c000-000000000001', (select cust from t where n = 12), 'recharge', 100)$$,
  '42501', null, 'nobody can write balance entries through the API');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-c000-000000000001","role":"authenticated"}', true);
select ok((select count(*) from public.customer_balances) > 0, 'owner sees balances');
select throws_ok($$update public.meal_orders set status = 'delivered'$$, '42501', null, 'owner cannot edit orders directly');
select throws_ok($$select public.request_schedule_change((select sub from t where n = 12), 'skip', '2026-11-12', p_channel => 'whatsapp')$$,
  '42883', null, 'owner cannot claim a WhatsApp channel (vendor RPC has no channel argument)');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select is((select count(*) from public.meal_orders where kitchen_id = '30000000-0000-4000-c000-000000000001'), 0::bigint,
  'another kitchen cannot see these orders');
select throws_ok($$select public.slot_summary('30000000-0000-4000-c000-000000000001', '2026-11-03', 'lunch')$$,
  '42501', 'forbidden', 'another kitchen cannot read the count');
select throws_ok($$select public.request_schedule_change((select sub from t where n = 12), 'skip', '2026-11-12')$$,
  '42501', 'forbidden', 'another kitchen cannot change the subscription');

set local role anon;
select throws_ok('select count(*) from public.meal_orders', '42501', null, 'anon cannot read orders');
reset role;

-- Ledgers and logs are append-only, even for postgres.
select throws_ok($$update public.balance_entries set meals = 100$$, 'P0001', 'balance_entries is append-only', 'balance ledger is append-only');
select throws_ok($$delete from public.count_snapshots$$, 'P0001', 'count_snapshots is append-only', 'snapshots are append-only');
select throws_ok($$delete from public.schedule_changes$$, 'P0001', 'schedule_changes is append-only', 'change log is append-only');

-- Owner summary is queued once per day.
select set_config('app.now', '2026-11-09 22:00:00+05:30', true);
select ok(private.queue_owner_summaries() >= 1, 'owner summary queued at 22:00');
select is(private.queue_owner_summaries(), 0, 'and not queued twice');

select * from finish();
rollback;
