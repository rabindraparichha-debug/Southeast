-- P5 tests: parent pays (payer rules, message routing, payer's page), veg days and Kartika inside the
-- daily engine (frozen slots untouched), festival specials, dispatch photo + QR stickers + wrong
-- tiffin, complaint scores and the first-complaint credit, weather alerts, churn, referrals, the
-- 90-minute alert, and the review fixes (client-op scoping, IST date on variance alerts).
-- Roles: owner, staff, rider, other kitchen's owner, admin, anon.
-- Calendar: Mon 2 Nov 2026 (inside Kartika 2026). Tuesday lunch locks Mon 21:00 IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen P (owner, staff, rider); 6 lunch customers near the kitchen.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(), now(), now()
from (values
  ('e5000000-0000-4000-e000-000000000001'::uuid, '919555000001'),
  ('e5000000-0000-4000-e000-000000000002'::uuid, '919555000002'),
  ('e5000000-0000-4000-e000-000000000003'::uuid, '919555000003')
) as u(id, phone);
insert into public.kitchens (id, name, slug, owner_id, lat, lng, weekly_off) values
  ('e5100000-0000-4000-e000-000000000001', 'Payer Kitchen', 'payer-kitchen', 'e5000000-0000-4000-e000-000000000001',
   20.3553, 85.8197, '{7}');
insert into public.kitchen_settings (kitchen_id) values ('e5100000-0000-4000-e000-000000000001');
insert into public.kitchen_payout_accounts (kitchen_id, razorpay_linked_account_id, kyc_status)
values ('e5100000-0000-4000-e000-000000000001', 'acc_TestPayerKitchen1', 'verified');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('e5100000-0000-4000-e000-000000000001', 'e5000000-0000-4000-e000-000000000001', 'owner', 'Owner P'),
  ('e5100000-0000-4000-e000-000000000001', 'e5000000-0000-4000-e000-000000000002', 'staff', 'Staff P'),
  ('e5100000-0000-4000-e000-000000000001', 'e5000000-0000-4000-e000-000000000003', 'rider', 'Rider P');
insert into public.plans (id, kitchen_id, name, slots, diet, days_of_week, price_per_meal_paise) values
  ('e5200000-0000-4000-e000-000000000001', 'e5100000-0000-4000-e000-000000000001', 'Non-veg Lunch', '{lunch}', 'nonveg', '{1,2,3,4,5,6}', 9000),
  ('e5200000-0000-4000-e000-000000000002', 'e5100000-0000-4000-e000-000000000001', 'Veg Lunch', '{lunch}', 'veg', '{1,2,3,4,5,6}', 7000);

select set_config('app.now', '2026-11-02 10:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
create temp table vals (k text primary key, v text);
grant select, insert on ids, vals to authenticated, anon;
do $$
declare r record; v_c uuid; v_a uuid;
begin
  for r in select * from (values
    ('c1', 'Arun Nonveg', '9555100001', 'nonveg', 'e5200000-0000-4000-e000-000000000001', 0.001, 20),
    ('c2', 'Bina Nonveg', '9555100002', 'nonveg', 'e5200000-0000-4000-e000-000000000001', 0.002, 20),
    ('c3', 'Chitra Nonveg', '9555100003', 'nonveg', 'e5200000-0000-4000-e000-000000000001', 0.003, 0),
    ('c4', 'Dev Parent', '9555100004', 'veg', 'e5200000-0000-4000-e000-000000000002', 0.004, 20),
    ('c5', 'Esha Student', '9555100005', 'veg', 'e5200000-0000-4000-e000-000000000002', 0.005, 20),
    ('c6', 'Farhan Veg', '9555100006', 'veg', 'e5200000-0000-4000-e000-000000000002', 0.006, 20)
  ) t(k, name, phone, diet, plan, dlat, bal) loop
    v_c := private.insert_customer('e5100000-0000-4000-e000-000000000001', r.name, '+91' || r.phone, r.diet::public.diet_type,
      'en', null, jsonb_build_object('line1', 'Flat ' || r.k, 'area', 'Patia', 'lat', 20.3553 + r.dlat, 'lng', 85.8197 + r.dlat),
      'vendor', 'vendor');
    select id into v_a from public.addresses where customer_id = v_c and is_default;
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values ('e5100000-0000-4000-e000-000000000001', v_c, r.plan::uuid, v_a, '2026-11-03', 'active');
    if r.bal > 0 then
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
      values ('e5100000-0000-4000-e000-000000000001', v_c, 'adjust', r.bal, r.bal * 7000, 'test balance');
    end if;
    insert into ids values (r.k, v_c);
  end loop;
end $$;
update public.customers set whatsapp_opt_in = true where kitchen_id = 'e5100000-0000-4000-e000-000000000001';
insert into ids select 'b1', id from public.customers where kitchen_id = '10000000-0000-4000-a000-00000000000b' order by name limit 1;

select ok((select bool_and(referral_code ~ '^[A-Z2-9]{8}$') from public.customers where kitchen_id = 'e5100000-0000-4000-e000-000000000001'),
  'every customer gets an 8-character referral code');
select isnt((select referral_code from public.customers where id = (select v from ids where k = 'c1')),
            (select referral_code from public.customers where id = (select v from ids where k = 'c2')), 'codes differ');

-- ===========================================================================
-- 1. Parent pays, student eats
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.set_payer((select v from ids where k = 'c5'), (select v from ids where k = 'c4')) $$,
  '42501', 'forbidden', 'staff cannot set a payer');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.set_payer((select v from ids where k = 'c5'), (select v from ids where k = 'c4')) $$,
  '42501', 'forbidden', 'another kitchen''s owner cannot set a payer');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.set_payer((select v from ids where k = 'c5'), (select v from ids where k = 'c4')) $$,
  'owner sets the parent as the student''s payer');
select is((select payer_customer_id from public.customers where id = (select v from ids where k = 'c5')),
  (select v from ids where k = 'c4'), 'payer stored on the eater');
select throws_ok($$ select public.set_payer((select v from ids where k = 'c4'), (select v from ids where k = 'c4')) $$,
  '22023', 'payer_is_self', 'nobody pays for themselves');
select throws_ok($$ select public.set_payer((select v from ids where k = 'c4'), (select v from ids where k = 'c6')) $$,
  '22023', 'payer_chain', 'someone who pays for others cannot get a payer');
select throws_ok($$ select public.set_payer((select v from ids where k = 'c6'), (select v from ids where k = 'c5')) $$,
  '22023', 'payer_chain', 'a payer cannot have a payer (no chains)');
select throws_ok($$ select public.set_payer((select v from ids where k = 'c6'), (select v from ids where k = 'b1')) $$,
  '22023', 'invalid_payer', 'the payer must be a customer of the same kitchen');
reset role;
set local role anon;
select throws_ok($$ select public.set_payer((select v from ids where k = 'c6'), null) $$, '42501', null, 'anon cannot set payers');
reset role;

-- Money messages for the student go to the parent; others stay with the student.
select private.notify_customer('e5100000-0000-4000-e000-000000000001', (select v from ids where k = 'c5'), 'low_balance_reminder',
  '{"balance_meals":2}', 'test_low_balance:c5');
select private.notify_customer('e5100000-0000-4000-e000-000000000001', (select v from ids where k = 'c5'), 'tomorrow_menu',
  '{}', 'test_menu:c5');
select is((select recipient_id from public.notifications_outbox where dedupe_key = 'test_low_balance:c5'), (select v from ids where k = 'c4'),
  'low-balance alert for the student is addressed to the payer');
select is((select template from public.notifications_outbox where dedupe_key = 'test_low_balance:c5'), 'low_balance_reminder_payer',
  'with the payer template');
select is((select payload ->> 'eater_name' from public.notifications_outbox where dedupe_key = 'test_low_balance:c5'), 'Esha Student',
  'naming the student');
select ok((select payload ->> 'url' like '%/c/%' from public.notifications_outbox where dedupe_key = 'test_low_balance:c5'),
  'and linking the payer''s page');
select is((select recipient_id from public.notifications_outbox where dedupe_key = 'test_menu:c5'), (select v from ids where k = 'c5'),
  'the menu nudge still goes to the student');

-- Payment link for the student: Razorpay's contact is the payer.
select is(private.payment_link_record((select v from ids where k = 'c5'), 5, null) ->> 'customer_phone', '+919555100004',
  'payment link for the student uses the payer''s phone');

-- The payer's page shows dependents and lets them pay for them.
insert into vals values ('t4', private.issue_magic_link((select v from ids where k = 'c4'), 7));
insert into vals values ('t6', private.issue_magic_link((select v from ids where k = 'c6'), 7));
set local role anon;
select is((select jsonb_array_length(public.portal_get((select v from vals where k = 't4')) -> 'dependents')), 1,
  'payer page lists one dependent');
select is((public.portal_get((select v from vals where k = 't4')) -> 'dependents' -> 0 ->> 'balance_meals')::integer, 20,
  'with the dependent''s balance');
select is((public.portal_dependent_payment_link_record((select v from vals where k = 't4'), (select v from ids where k = 'c5'), 3)
           ->> 'meals')::integer, 3, 'payer creates a payment link for the dependent');
select throws_ok($$ select public.portal_dependent_payment_link_record((select v from vals where k = 't6'), (select v from ids where k = 'c5'), 3) $$,
  '42501', 'forbidden', 'someone else cannot pay through the dependent link');
select throws_ok($$ select public.portal_dependent_payment_link_record('bad-token', (select v from ids where k = 'c5'), 3) $$,
  '28000', 'invalid_link', 'a bad token is refused');
reset role;
select is((select customer_id from public.payments where kitchen_id = 'e5100000-0000-4000-e000-000000000001'
           and status = 'created' order by created_at desc limit 1), (select v from ids where k = 'c5'),
  'the payment is the eater''s (balance stays per eater)');

-- ===========================================================================
-- 2. Veg days and Kartika (inside refresh_orders)
-- ===========================================================================
select is((select diet::text from public.meal_orders where customer_id = (select v from ids where k = 'c1') and service_date = '2026-11-03'),
  'nonveg', 'before any opt-in, Tuesday is non-veg');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
update public.kitchen_settings set veg_days_enabled = true where kitchen_id = 'e5100000-0000-4000-e000-000000000001';
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is((select veg_days_enabled from public.kitchen_settings where kitchen_id = 'e5100000-0000-4000-e000-000000000001'), false,
  'staff cannot change kitchen settings');
update public.kitchen_settings set veg_days_enabled = true, kartika_veg_mode = true where kitchen_id = 'e5100000-0000-4000-e000-000000000001';
select is((select veg_days from public.kitchen_settings where kitchen_id = 'e5100000-0000-4000-e000-000000000001'), '{2,4}'::smallint[],
  'default veg days are Tuesday and Thursday');
select is(public.set_customer_food_prefs((select v from ids where k = 'c1'), p_veg_days => true) ->> 'observes_veg_days', 'true',
  'owner records that Arun observes veg days');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.set_customer_food_prefs((select v from ids where k = 'c2'), p_kartika => true) $$,
  '42501', 'forbidden', 'staff cannot change a customer''s opt-ins');
reset role;
insert into vals values ('t2', private.issue_magic_link((select v from ids where k = 'c2'), 7));
set local role anon;
select is(public.portal_set_food_prefs((select v from vals where k = 't2'), p_kartika => true) ->> 'observes_kartika', 'true',
  'Bina opts in to Kartika on her page');
reset role;

select is((select diet::text || '/' || veg_override from public.meal_orders where customer_id = (select v from ids where k = 'c1')
           and service_date = '2026-11-03'), 'veg/true', 'Arun''s Tuesday (veg day) is counted and packed as veg');
select is((select diet::text from public.meal_orders where customer_id = (select v from ids where k = 'c1') and service_date = '2026-11-04'),
  'nonveg', 'his Wednesday stays non-veg');
select is((select diet::text from public.meal_orders where customer_id = (select v from ids where k = 'c2') and service_date = '2026-11-04'),
  'veg', 'Bina''s Wednesday is veg (Kartika month)');
select is((select diet::text from public.meal_orders where customer_id = (select v from ids where k = 'c3') and service_date = '2026-11-03'),
  'nonveg', 'Chitra did not opt in: still non-veg');
select is((private.slot_totals('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch') ->> 'veg_switched')::integer, 2,
  'count breakdown shows 2 meals switched to veg on Tuesday');
select is((private.slot_totals('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch') -> 'by_diet' ->> 'nonveg')::integer, 1,
  'only Chitra is counted non-veg on Tuesday');

-- Calendar: readable by any signed-in user, edited only by the platform team.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select ok((select count(*) from public.food_calendar where kind = 'kartika') >= 2, 'staff can read the food calendar');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_upsert_calendar_entry(null, 'festival', 'Test fest', '2026-11-05') $$,
  '42501', 'forbidden', 'owners cannot edit the platform calendar');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$ select public.admin_upsert_calendar_entry(null, 'festival', 'Bad', '2026-11-05', '2026-11-01') $$,
  '22023', 'invalid_calendar_entry', 'end before start is refused');
select lives_ok($$ insert into vals select 'fest', public.admin_upsert_calendar_entry(null, 'festival', 'Test veg festival', '2026-11-05', null, true)::text $$,
  'admin adds a veg-only festival on Thursday 5 Nov');
reset role;
set local role anon;
select throws_ok($$ select count(*) from public.food_calendar $$, '42501', null, 'anon cannot read the calendar table');
reset role;

-- Festival specials.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.create_festival_special('e5100000-0000-4000-e000-000000000001', '2026-11-08', 'lunch', 'Kheer') $$,
  '42501', 'forbidden', 'staff cannot add specials');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.create_festival_special('e5100000-0000-4000-e000-000000000001', '2026-11-01', 'lunch', 'Kheer') $$,
  '22023', 'date_in_past', 'specials are for today or later');
select is((public.create_festival_special('e5100000-0000-4000-e000-000000000001', '2026-11-08', 'lunch', 'Diwali kheer', 2000)
          ->> 'notified')::integer, 6, 'Diwali special announced to the 6 opted-in lunch customers');
select is((select payload ->> 'name' from public.notifications_outbox where template = 'festival_special'
           and recipient_id = (select v from ids where k = 'c1')), 'Diwali kheer', 'through the festival_special template');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select is(public.festival_specials_list('e5100000-0000-4000-e000-000000000001') -> 0 ->> 'addon_price_paise', null,
  'staff see the special without its price');
select is((select count(*) from public.festival_specials), 0::bigint, 'staff cannot read the specials table (price) directly');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is((public.festival_specials_list('e5100000-0000-4000-e000-000000000001') -> 0 ->> 'addon_price_paise')::integer, 2000,
  'the owner sees the add-on price');
reset role;
select is((public.portal_get((select v from vals where k = 't2')) -> 'specials' -> 0 ->> 'name'), 'Diwali kheer',
  'customers see upcoming specials on their page');

-- ===========================================================================
-- 7a. Referrals (before anyone recharges)
-- ===========================================================================
do $$
declare v_c uuid;
begin
  v_c := private.insert_customer('e5100000-0000-4000-e000-000000000001', 'Gita New', '+919555100007', 'veg', 'en', null, null,
    'vendor', 'vendor');
  insert into ids values ('c7', v_c);
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.apply_referral_code((select v from ids where k = 'c7'), 'ABCDEFGH') $$, '42501', 'forbidden',
  'staff cannot apply referral codes');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.apply_referral_code((select v from ids where k = 'c7'), 'ZZZZZZZZ') $$, '22023', 'invalid_referral_code',
  'unknown codes are refused');
select throws_ok($$ select public.apply_referral_code((select v from ids where k = 'c7'),
  (select referral_code from public.customers where id = (select v from ids where k = 'c7'))) $$, '22023', 'self_referral',
  'nobody refers themselves');
select lives_ok($$ select public.apply_referral_code((select v from ids where k = 'c7'),
  lower((select referral_code from public.customers where id = (select v from ids where k = 'c1')))) $$,
  'Gita joined with Arun''s code (case-insensitive)');
select throws_ok($$ select public.apply_referral_code((select v from ids where k = 'c7'),
  (select referral_code from public.customers where id = (select v from ids where k = 'c2'))) $$, '23505', 'already_referred',
  'a customer is referred once');
update public.kitchen_settings set referral_reward_meals = 2 where kitchen_id = 'e5100000-0000-4000-e000-000000000001';
select lives_ok($$ select public.record_payment((select v from ids where k = 'c7'), 14000, 'cash', 2) $$, 'Gita pays for 2 meals in cash');
select is((select status || ':' || reward_meals from public.referrals where referee_customer_id = (select v from ids where k = 'c7')),
  'rewarded:2', 'the first paid recharge rewards the referral');
select lives_ok($$ select public.record_payment((select v from ids where k = 'c7'), 14000, 'cash', 2) $$, 'a second payment');
reset role;
select is((select count(*) from public.balance_entries where ref_type in ('referral_referee', 'referral_referrer')
           and ref_id = (select id from public.referrals where referee_customer_id = (select v from ids where k = 'c7'))), 2::bigint,
  'exactly one credit each for referee and referrer (idempotent)');
select is((select sum(meals)::integer from public.balance_entries where customer_id = (select v from ids where k = 'c1')
           and ref_type = 'referral_referrer'), 2, 'Arun gets 2 free meals');
select is((select count(*) from public.notifications_outbox where template = 'referral_reward'
           and recipient_id in ((select v from ids where k = 'c1'), (select v from ids where k = 'c7'))), 2::bigint,
  'both are told on WhatsApp');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.apply_referral_code((select v from ids where k = 'c7'),
  (select referral_code from public.customers where id = (select v from ids where k = 'c3'))) $$, '23505', 'already_referred',
  'still referred once');
select lives_ok($$ select public.record_payment((select v from ids where k = 'c6'), 7000, 'cash', 1) $$, 'Farhan recharges');
select throws_ok($$ select public.apply_referral_code((select v from ids where k = 'c6'),
  (select referral_code from public.customers where id = (select v from ids where k = 'c1'))) $$, '22023', 'referral_too_late',
  'a customer who already recharged cannot be referred');
select is(jsonb_array_length(public.referrals_list('e5100000-0000-4000-e000-000000000001')), 1, 'owner lists referrals');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select is((select count(*) from public.referrals where kitchen_id = 'e5100000-0000-4000-e000-000000000001'), 0::bigint,
  'another kitchen sees no referrals');
reset role;
-- A lead with campaign "ref-CODE" carries the code.
insert into vals values ('lead', private.upsert_lead('+919555100099', 'referral',
  'ref-' || (select referral_code from public.customers where id = (select v from ids where k = 'c1')), null, '{"name":"Lead Friend"}', true, false)::text);
select is((select referral_code from public.leads where id = (select v::uuid from vals where k = 'lead')),
  (select referral_code from public.customers where id = (select v from ids where k = 'c1')), 'lead campaign ref-CODE sets the referral code');
select is((public.portal_get((select v from vals where k = 't2')) -> 'referral' ->> 'code'),
  (select referral_code from public.customers where id = (select v from ids where k = 'c2')), 'the customer page shows the referral code');

-- ===========================================================================
-- 4. Complaints: first food/delivery complaint credited once
-- ===========================================================================
insert into vals values ('t1', private.issue_magic_link((select v from ids where k = 'c1'), 7));
insert into vals values ('t3', private.issue_magic_link((select v from ids where k = 'c3'), 7));
set local role anon;
select lives_ok($$ insert into vals select 'cp1', public.portal_complaint((select v from vals where k = 't1'), 'quality', 'Too salty')::text $$,
  'Arun complains (quality)');
select lives_ok($$ insert into vals select 'cp2', public.portal_complaint((select v from vals where k = 't1'), 'late', 'Late again')::text $$,
  'and again (late)');
select lives_ok($$ insert into vals select 'cp3', public.portal_complaint((select v from vals where k = 't3'), 'other', 'Question')::text $$,
  'Chitra asks something (other)');
reset role;
select is((select meals || '/' || type from public.balance_entries where ref_type = 'complaint_auto'
           and ref_id = (select v::uuid from vals where k = 'cp1')), '1/credit', 'the first complaint gets a 1-meal credit');
select is((select count(*) from public.balance_entries where ref_type = 'complaint_auto' and customer_id = (select v from ids where k = 'c1')),
  1::bigint, 'only the first complaint is credited');
select isnt((select auto_credit_entry_id from public.complaints where id = (select v::uuid from vals where k = 'cp1')), null,
  'the complaint links its credit');
select is((select count(*) from public.balance_entries where ref_type = 'complaint_auto' and customer_id = (select v from ids where k = 'c3')),
  0::bigint, '"other" complaints are not credited');
select is((select count(*) from public.notifications_outbox where template = 'complaint_credit'
           and recipient_id = (select v from ids where k = 'c1')), 1::bigint, 'the customer is told about the credit');
select ok(exists (select 1 from public.audit_log where table_name = 'complaints' and row_id = (select v from vals where k = 'cp1')
                  and action = 'UPDATE' and after ? 'auto_credit_entry_id'), 'the credit link is in the audit log');
update public.kitchen_settings set auto_credit_first_complaint = false where kitchen_id = 'e5100000-0000-4000-e000-000000000001';
set local role anon;
select lives_ok($$ select public.portal_complaint((select v from vals where k = 't3'), 'missing', 'No roti') $$,
  'Chitra''s first food complaint with the setting off');
reset role;
select is((select count(*) from public.balance_entries where ref_type = 'complaint_auto' and customer_id = (select v from ids where k = 'c3')),
  0::bigint, 'no credit when the kitchen turned it off');
update public.kitchen_settings set auto_credit_first_complaint = true where kitchen_id = 'e5100000-0000-4000-e000-000000000001';
-- Resolving with a manual credit still works (different ledger ref).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.resolve_complaint((select v::uuid from vals where k = 'cp1'), 'Sorry', 1) $$,
  'owner resolves the credited complaint with another free meal');
select is((public.vendor_complaint_score('e5100000-0000-4000-e000-000000000001') ->> 'complaints')::integer, 4,
  'vendor score counts 4 complaints in 30 days');
select ok((public.vendor_complaint_score('e5100000-0000-4000-e000-000000000001') ->> 'median_first_response_minutes') is not null,
  'with a median first-response time');
select is((public.customer_complaint_score((select v from ids where k = 'c1')) ->> 'complaints')::integer, 2, 'customer score: Arun 2');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.vendor_complaint_score('e5100000-0000-4000-e000-000000000001') $$, '42501', 'forbidden',
  'staff cannot see scores');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.customer_complaint_score((select v from ids where k = 'c1')) $$, '42501', 'forbidden',
  'another kitchen cannot see a customer''s score');
select throws_ok($$ select public.admin_complaint_scores() $$, '42501', 'forbidden', 'owners cannot list all kitchens'' scores');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select is((public.vendor_complaint_score('e5100000-0000-4000-e000-000000000001') ->> 'complaints')::integer, 4, 'admins can see it');
select ok(jsonb_array_length(public.admin_complaint_scores()) >= 3, 'admins list every kitchen''s score');
reset role;

-- ===========================================================================
-- 5. Weather alerts (service role)
-- ===========================================================================
select ok(not has_function_privilege('authenticated', 'public.weather_record_alert(uuid, date, public.meal_slot, text, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.weather_kitchens()', 'execute'), 'weather RPCs are for the service role only');
select ok(has_function_privilege('service_role', 'public.weather_record_alert(uuid, date, public.meal_slot, text, jsonb)', 'execute'),
  'the Edge Function (service role) may record alerts');
select ok(public.weather_kitchens() @> '[{"name":"Payer Kitchen"}]', 'kitchens with a location are checked');
select is(public.weather_record_alert('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch', 'rain', '{"max_rain_mm":12}') ->> 'created',
  'true', 'a heavy-rain alert is recorded');
select is(public.weather_record_alert('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch', 'rain', '{}') ->> 'created',
  'false', 'at most once per kitchen/date/slot');
select is((select count(*) from public.notifications_outbox where template = 'weather_alert' and kitchen_id = 'e5100000-0000-4000-e000-000000000001'),
  1::bigint, 'the owner is alerted once');
select is((select count(*) from public.notifications_outbox where template = 'weather_delay_notice'), 0::bigint,
  'customers are not told unless the kitchen opts in');
update public.kitchen_settings set weather_customer_notice = true where kitchen_id = 'e5100000-0000-4000-e000-000000000001';
select is((public.weather_record_alert('e5100000-0000-4000-e000-000000000001', '2026-11-04', 'lunch', 'heat', '{"max_temp_c":41}')
           ->> 'customers_notified')::integer, 6, 'with the opt-in, customers with Wednesday lunch hear it may be late');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.weather_alerts_list('e5100000-0000-4000-e000-000000000001') $$, '42501', 'forbidden', 'staff: no alert list');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is(jsonb_array_length(public.weather_alerts_list('e5100000-0000-4000-e000-000000000001')), 2, 'owner sees both alerts');
reset role;

-- ===========================================================================
-- Lock Tuesday lunch (Mon 21:01): veg switch frozen, runs built with QR codes
-- ===========================================================================
select set_config('app.now', '2026-11-02 21:01:00+05:30', true);
select private.run_due_locks();
select ok(exists (select 1 from public.count_snapshots where kitchen_id = 'e5100000-0000-4000-e000-000000000001'
                  and service_date = '2026-11-03' and slot = 'lunch'), 'Tuesday lunch is locked');
select is(((select totals from public.count_snapshots where kitchen_id = 'e5100000-0000-4000-e000-000000000001'
            and service_date = '2026-11-03') ->> 'veg_switched')::integer, 2, 'the locked count keeps the veg switch');
update public.kitchen_settings set veg_days_enabled = false, kartika_veg_mode = false where kitchen_id = 'e5100000-0000-4000-e000-000000000001';
select is((select diet::text from public.meal_orders where customer_id = (select v from ids where k = 'c1') and service_date = '2026-11-03'),
  'veg', 'turning veg days off later does not touch the frozen Tuesday');
select is((select diet::text from public.meal_orders where customer_id = (select v from ids where k = 'c2') and service_date = '2026-11-04'),
  'nonveg', 'but re-plans open days (Bina''s Wednesday back to non-veg)');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where b.type = 'meal' and o.kitchen_id = 'e5100000-0000-4000-e000-000000000001'), 6::bigint,
  'the lock posted one meal entry per order (no second path)');
select ok((select bool_and(qr_token ~ '^[A-Z2-9]{10}$') from public.delivery_stops s join public.delivery_runs r on r.id = s.run_id
           where r.kitchen_id = 'e5100000-0000-4000-e000-000000000001'), 'every stop has a 10-character sticker code');

-- ===========================================================================
-- 3. Dispatch photo, sticker sheet, scanned tiffins (Tue 11:00)
-- ===========================================================================
select set_config('app.now', '2026-11-03 11:00:00+05:30', true);
create temp table st as
select s.id, s.seq, s.qr_token, s.run_id from public.delivery_stops s join public.delivery_runs r on r.id = s.run_id
where r.kitchen_id = 'e5100000-0000-4000-e000-000000000001' and r.service_date = '2026-11-03';
grant select on st to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.record_dispatch_photo('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch',
  'e5100000-0000-4000-e000-000000000001/d.jpg') $$, '42501', 'forbidden', 'riders do not record dispatch photos');
select throws_ok($$ select public.sticker_sheet('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch') $$, '42501', 'forbidden',
  'riders cannot print sticker sheets');
select ok((select bool_and(s ? 'qr_token') from jsonb_array_elements(public.rider_today() -> 0 -> 'stops') s),
  'the rider''s offline cache has each stop''s sticker code');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.record_dispatch_photo('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch',
  'someone-else/d.jpg') $$, '22023', 'invalid_photo', 'photo must be in the kitchen''s folder');
select lives_ok($$ select public.record_dispatch_photo('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch',
  'e5100000-0000-4000-e000-000000000001/2026-11-03-lunch.jpg') $$, 'staff record the packed-meals photo');
select is(jsonb_array_length(public.sticker_sheet('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch')), 6,
  'sticker sheet has one sticker per stop');
select ok(not (public.sticker_sheet('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch')::text ~ '(9555|phone)'),
  'and no phone numbers');
select ok((select bool_and((x ->> 'veg_day')::boolean) from jsonb_array_elements(public.sticker_sheet('e5100000-0000-4000-e000-000000000001',
  '2026-11-03', 'lunch')) x where x ->> 'name' in ('Arun Nonveg', 'Bina Nonveg')), 'veg-day stickers are marked');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.sticker_sheet('e5100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch') $$, '42501', 'forbidden',
  'another kitchen cannot print our stickers');

select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.complete_stop((select id from st where seq = 1), 'none', p_scan_token => 'TFN:WRONG23456') $$,
  '22023', 'wrong_tiffin', 'a sticker from another stop is refused');
select is((select status::text from public.delivery_stops where id = (select id from st where seq = 1)), 'pending', 'and the stop stays pending');
select is(public.complete_stop((select id from st where seq = 1), 'none', p_scan_token => 'TFN:' || (select qr_token from st where seq = 1))
  ->> 'status', 'delivered', 'the right sticker delivers the stop');
select is(public.complete_stop((select id from st where seq = 2), 'none') ->> 'status', 'delivered',
  'callers without a scan (offline queue) work as before');
select is(public.complete_stop((select id from st where seq = 3), 'none', p_client_op => 'e5900000-0000-4000-e000-000000000001')
  ->> 'status', 'delivered', 'an op id delivers stop 3');
select is(public.complete_stop((select id from st where seq = 3), 'none', p_client_op => 'e5900000-0000-4000-e000-000000000001',
  p_scan_token => 'WRONG23456') ->> 'conflict', 'false', 'its retry returns stop 3''s own result');
select throws_ok($$ select public.complete_stop((select id from st where seq = 4), 'none', p_client_op => 'e5900000-0000-4000-e000-000000000001') $$,
  '22023', 'invalid_client_op', 'the same op id on another stop is refused (no foreign result)');
select throws_ok($$ select public.fail_stop((select id from st where seq = 4), 'not_home', p_client_op => 'e5900000-0000-4000-e000-000000000001') $$,
  '22023', 'invalid_client_op', 'also for failed deliveries');
select is((select status::text from public.delivery_stops where id = (select id from st where seq = 4)), 'pending', 'stop 4 is untouched');
reset role;

-- ===========================================================================
-- 8. Prepared → delivered alert
-- ===========================================================================
select set_config('app.now', '2026-11-03 12:29:00+05:30', true);
select is(private.queue_late_delivery_alerts(), 0, 'no alert before 90 minutes');
select set_config('app.now', '2026-11-03 12:31:00+05:30', true);
select is(private.queue_late_delivery_alerts(), 1, '90 minutes after the dispatch photo with stops pending: one alert per run');
select is((select (payload ->> 'pending_stops')::integer from public.notifications_outbox where template = 'late_delivery_alert'
           and kitchen_id = 'e5100000-0000-4000-e000-000000000001'), 3, 'naming the 3 stops still pending');
select private.queue_late_delivery_alerts();
select is((select count(*) from public.notifications_outbox where template = 'late_delivery_alert'
           and kitchen_id = 'e5100000-0000-4000-e000-000000000001'), 1::bigint, 'and only once');

-- ===========================================================================
-- 6. Churn
-- ===========================================================================
select ok(private.compute_churn('e5100000-0000-4000-e000-000000000001') >= 1, 'nightly churn finds at-risk customers');
select ok((select reasons from public.churn_risks where customer_id = (select v from ids where k = 'c3')) @> '{balance_out,open_complaint}',
  'Chitra: balance out with no recharge, open complaint');
select is((select count(*) from public.churn_risks where customer_id = (select v from ids where k = 'c6')), 0::bigint,
  'Farhan (recharged, nothing wrong) is not at risk');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select ok((select count(*) from public.at_risk_customers('e5100000-0000-4000-e000-000000000001', true)) >= 1, 'owner lists them');
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select * from public.at_risk_customers('e5100000-0000-4000-e000-000000000001') $$, '42501', 'forbidden',
  'staff cannot list at-risk customers');
select is((select count(*) from public.churn_risks), 0::bigint, 'nor read the table');
reset role;
select private.queue_owner_summaries();
select ok((select (payload ->> 'at_risk_customers')::integer >= 1 from public.notifications_outbox where template = 'owner_daily_summary'
           and kitchen_id = 'e5100000-0000-4000-e000-000000000001'), 'the 10 pm summary carries the at-risk count');

-- ===========================================================================
-- Review fix: variance alert date is the IST day
-- ===========================================================================
insert into public.items (id, kitchen_id, name, unit) values ('e5300000-0000-4000-e000-000000000001', 'e5100000-0000-4000-e000-000000000001', 'Rice', 'kg');
insert into public.stock_takes (id, kitchen_id, status, started_at, closed_at)
values ('e5400000-0000-4000-e000-000000000001', 'e5100000-0000-4000-e000-000000000001', 'closed', '2026-11-02 18:00:00+00', '2026-11-02 19:00:00+00');
insert into public.stock_take_lines (stock_take_id, kitchen_id, item_id, expected_qty, counted_qty, reason)
values ('e5400000-0000-4000-e000-000000000001', 'e5100000-0000-4000-e000-000000000001', 'e5300000-0000-4000-e000-000000000001', 10, 7, 'spilled');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is((select x ->> 'date' from jsonb_array_elements(public.inventory_alerts('e5100000-0000-4000-e000-000000000001')) x
           where x ->> 'type' = 'variance'), '2026-11-03', 'a stock-take closed at 00:30 IST shows the IST date');
reset role;

select * from finish();
rollback;
