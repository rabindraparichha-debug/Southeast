-- M7 tests: a Patia lead matches only kitchens within reach that have capacity; ranking by verified
-- rating and price fit; website lead → pick → trial → plan → renewal funnel; platform_sourced is
-- permanent and vendors can't change it; lead intake dedupe; growth automation; vendor applications;
-- public profile; permissions.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select set_config('app.now', '2026-11-02 10:00:00+05:30', true);
-- Keep every other kitchen (seed, or left by integration runs) out of the way.
update public.kitchens set accepts_platform_leads = false;

-- ===========================================================================
-- Setup: kitchens around Patia (20.3553, 85.8197). One owner user runs all of them.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'f2000000-0000-4000-f000-000000000001', 'authenticated', 'authenticated', '919777000001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f2000000-0000-4000-f000-000000000002', 'authenticated', 'authenticated', '919777000002', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, lat, lng, service_radius_km, fssai_no, capacity_lunch, status, accepts_platform_leads) values
  ('83000000-0000-4000-f000-000000000001', 'Patia Near', 'patia-near', 'f2000000-0000-4000-f000-000000000001', 20.364293, 85.8197, 3, '12026001009001', 40, 'active', true),
  ('83000000-0000-4000-f000-000000000002', 'Patia Full', 'patia-full', 'f2000000-0000-4000-f000-000000000001', 20.337314, 85.8197, 3, '12026001009002', 0, 'active', true),
  ('83000000-0000-4000-f000-000000000003', 'Far Kitchen', 'far-kitchen', 'f2000000-0000-4000-f000-000000000001', 20.400266, 85.8197, 3, '12026001009003', 40, 'active', true),
  ('83000000-0000-4000-f000-000000000004', 'Draft Kitchen', 'draft-kitchen', 'f2000000-0000-4000-f000-000000000001', 20.341810, 85.8197, 3, null, 40, 'draft', true),
  ('83000000-0000-4000-f000-000000000005', 'Wide Radius', 'wide-radius', 'f2000000-0000-4000-f000-000000000001', 20.3553, 85.858073, 5, '12026001009005', 40, 'active', true),
  ('83000000-0000-4000-f000-000000000006', 'Opted Out', 'opted-out', 'f2000000-0000-4000-f000-000000000001', 20.3553, 85.829293, 3, '12026001009006', 40, 'active', false),
  ('83000000-0000-4000-f000-000000000007', 'Non-veg Only', 'nonveg-only', 'f2000000-0000-4000-f000-000000000001', 20.3553, 85.810107, 3, '12026001009007', 40, 'active', true),
  ('83000000-0000-4000-f000-000000000008', 'Almost Full', 'almost-full', 'f2000000-0000-4000-f000-000000000001', 20.350804, 85.8197, 3, '12026001009008', 1, 'active', true);
insert into public.members (kitchen_id, user_id, role)
select id, 'f2000000-0000-4000-f000-000000000001', 'owner' from public.kitchens where id::text like '83000000-%';
insert into public.members (kitchen_id, user_id, role) values ('83000000-0000-4000-f000-000000000001', 'f2000000-0000-4000-f000-000000000002', 'staff');
insert into public.kitchen_settings (kitchen_id) select id from public.kitchens where id::text like '83000000-%';
insert into public.plans (kitchen_id, name, slots, diet, price_per_meal_paise)
select id, 'Veg Lunch', '{lunch}', 'veg', case when id = '83000000-0000-4000-f000-000000000001' then 9000 else 7000 end
from public.kitchens where id::text like '83000000-%' and id <> '83000000-0000-4000-f000-000000000007';
insert into public.plans (kitchen_id, name, slots, diet, price_per_meal_paise)
values ('83000000-0000-4000-f000-000000000007', 'Chicken Lunch', '{lunch}', 'nonveg', 8000);
-- "Almost Full" has one place and a trial waiting for payment holds it.
do $$
declare v_c uuid;
begin
  v_c := private.insert_customer('83000000-0000-4000-f000-000000000008', 'Holder', '+919777100001', 'veg', 'en', null, null, 'vendor', 'vendor');
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, start_date, status)
  select '83000000-0000-4000-f000-000000000008', v_c, id, '2026-11-03', 'trial' from public.plans where kitchen_id = '83000000-0000-4000-f000-000000000008';
end $$;
-- Five verified 5★ reviews for "Wide Radius".
do $$
declare i integer; v_c uuid;
begin
  for i in 1..5 loop
    v_c := private.insert_customer('83000000-0000-4000-f000-000000000005', 'Reviewer ' || i, '+91977710010' || i, 'veg', 'en', null, null, 'vendor', 'vendor');
    insert into public.kitchen_reviews (kitchen_id, customer_id, rating, verified) values ('83000000-0000-4000-f000-000000000005', v_c, 5, true);
  end loop;
end $$;

-- ===========================================================================
-- M7 test 1: a Patia lead matches only kitchens within 3 km that have capacity.
-- ===========================================================================
create temp table t (k text primary key, v jsonb);
grant select, insert on t to anon, authenticated;
set local role anon;
select throws_ok($$ select public.submit_lead('Asha', '9861999001', 'Patia', p_consent => false) $$, '22023', 'consent_required',
  'the website form needs consent');
select throws_ok($$ select public.submit_lead('Asha', '12345', 'Patia', p_consent => true) $$, '22023', 'invalid_phone',
  'and a valid phone');
insert into t values ('lead', public.submit_lead('Asha Pattnaik', '9861999001', 'Patia', '{lunch}', 'veg', 7000,
  '2026-11-04', p_consent => true, p_whatsapp_opt_in => true, p_campaign => 'web-test'));
select ok((select v ->> 'token' from t where k = 'lead') is not null, 'the browser gets a lead token');
select is((select v ->> 'status' from t where k = 'lead'), 'matched', 'a Patia lead with meal times is qualified and matched');
select throws_ok($$ select count(*) from public.leads $$, '42501', null, 'anon cannot read leads');
reset role;

create temp table lead as select id from public.leads where phone_last4 = '9001' and source = 'website';
grant select on lead to anon, authenticated;
select is((select lat || ',' || lng from public.leads where id = (select id from lead)), '20.3553,85.8197',
  'the typed area "Patia" gives the area centre (no geocoding API)');
select is(
  (select array_agg(kitchen_name order by kitchen_name) from private.match_kitchens((select id from lead), 50)),
  array['Patia Near', 'Wide Radius'],
  'only active, opted-in kitchens with a matching plan, spare capacity and the lead inside their radius');
select ok((select bool_and(distance_km <= 3 or kitchen_name = 'Wide Radius') from private.match_kitchens((select id from lead), 50)),
  'everything within 3 km (Wide Radius serves 5 km)');
select is((select count(*) from private.match_kitchens((select id from lead), 50) where kitchen_name in
  ('Patia Full', 'Almost Full')), 0::bigint, 'full kitchens (including a place held by an unpaid trial) are left out');
select is((select count(*) from private.match_kitchens((select id from lead), 50) where kitchen_name in
  ('Far Kitchen', 'Draft Kitchen', 'Opted Out', 'Non-veg Only')), 0::bigint,
  'too far, no FSSAI (draft), not taking leads, or no veg plan: left out');
select is((select string_agg(kitchen_name, ',' order by rank) from public.lead_matches m join public.kitchens k on k.id = m.kitchen_id
           cross join lateral (select k.name as kitchen_name) x where m.lead_id = (select id from lead)),
  'Wide Radius,Patia Near', 'ranked by verified rating and price fit: 5★ at the budget beats closer but pricier');
select is((select jsonb_array_length(v -> 'kitchens') from t where k = 'lead'), 2, 'the website shows both kitchens');
select ok((select v -> 'kitchens' -> 0 ->> 'profile_url' like '%/k/wide-radius' from t where k = 'lead'), 'with profile links');

-- A cheaper lunch + dinner plan is not offered to a lunch-only lead.
insert into public.plans (kitchen_id, name, slots, diet, price_per_meal_paise)
values ('83000000-0000-4000-f000-000000000005', 'Two Meals', '{lunch,dinner}', 'veg', 5000);
select is((select plan_name from private.match_kitchens((select id from lead), 50) where kitchen_name = 'Wide Radius'), 'Veg Lunch',
  'a lunch-only lead is offered the lunch plan, not a cheaper two-meal plan');

-- Capacity is live: once Patia Near is full it drops out.
update public.kitchens set capacity_lunch = 0 where id = '83000000-0000-4000-f000-000000000001';
select is((select count(*) from private.match_kitchens((select id from lead), 50) where kitchen_name = 'Patia Near'), 0::bigint,
  'a kitchen that fills up is no longer offered');
update public.kitchens set capacity_lunch = 40 where id = '83000000-0000-4000-f000-000000000001';

-- A lead with no kitchen nearby is waitlisted and shows up as a demand gap.
select is(public.lead_ingest('google_ads', 'g-1', 'Bikram', '+919861999002', 'Khandagiri', 'gads-x', false, '{"slots":["lunch"]}') ->> 'duplicate',
  'false', 'Google Ads lead ingested');
select is(public.lead_ingest('google_ads', 'g-1', 'Bikram', '+919861999002', 'Khandagiri', 'gads-x', false, '{"slots":["lunch"]}') ->> 'duplicate',
  'true', 'the same Google Ads lead id is ingested once');
select is((select status::text from public.leads where external_id = 'g-1'), 'waitlist', 'no kitchen in Khandagiri: waitlist');
select is((select count(*) from public.notifications_outbox where template = 'lead_welcome' and recipient_id = (select id from public.leads where external_id = 'g-1')),
  0::bigint, 'no WhatsApp welcome without opt-in');
select is(public.lead_ingest('justdial', 'jd-9', 'Mita', '+919861999003', 'Patia', null, true, '{"slots":["lunch"]}') ->> 'duplicate',
  'false', 'Justdial lead with WhatsApp opt-in');
select is((select count(*) from public.notifications_outbox where template = 'lead_welcome' and recipient_type = 'lead'
           and recipient_id = (select id from public.leads where external_id = 'jd-9')), 1::bigint, 'gets the welcome template');

-- ===========================================================================
-- M7 test 2: a converted lead keeps platform_sourced = true, and the vendor can't change it.
-- ===========================================================================
set local role anon;
select throws_ok(format($$ select public.lead_choose(%L, '83000000-0000-4000-f000-000000000003') $$, (select v ->> 'token' from t where k = 'lead')),
  '22023', 'kitchen_not_available', 'a lead can only pick a kitchen from its shortlist');
select throws_ok($$ select public.lead_choose('not-a-token', '83000000-0000-4000-f000-000000000001') $$, '22023', 'invalid_link',
  'a wrong token is refused');
insert into t select 'chose', public.lead_choose((select v ->> 'token' from t where k = 'lead'), '83000000-0000-4000-f000-000000000001');
select is((select (v ->> 'trial_amount_paise')::int from t where k = 'chose'), 18000, 'trial: 2 meals × ₹90');
select ok((select v ->> 'portal_url' like '%/c/%' from t where k = 'chose'), 'and a customer-page link to pay');
select throws_ok(format($$ select public.lead_choose(%L, '83000000-0000-4000-f000-000000000001') $$, (select v ->> 'token' from t where k = 'lead')),
  '22023', 'already_converted', 'picking twice is refused');
select is((public.submit_lead('Asha Pattnaik', '9861999001', 'Patia', p_consent => true) -> 'kitchens' -> 0 ->> 'name'), 'Patia Near',
  'submitting the form again after picking shows the chosen kitchen with its name');
reset role;
create temp table cust as select (v ->> 'customer_id')::uuid as id from t where k = 'chose';
grant select on cust to authenticated;
select is((select platform_sourced::text || '/' || source::text from public.customers where id = (select id from cust)), 'true/platform',
  'the new customer is platform-sourced');
select is((select status::text from public.subscriptions where customer_id = (select id from cust)), 'trial', 'on a trial subscription');
select is((select count(*) from public.notifications_outbox where template = 'new_platform_customer'
           and kitchen_id = '83000000-0000-4000-f000-000000000001'), 1::bigint, 'the owner is told');
select is((select count(*) from public.consents where customer_id = (select id from cust)), 2::bigint,
  'the customer''s own consent (service + WhatsApp) is recorded');

-- Paid trial → plan → month-2 renewal.
create temp table pay (n integer, id uuid);
do $$
declare v uuid;
begin
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, paid_at, created_at)
  values ('83000000-0000-4000-f000-000000000001', (select id from cust), 'cash', 'paid', 18000, 2, private.now(), private.now()) returning id into v;
  perform private.post_recharge(v);
end $$;
select is((select status::text from public.leads where id = (select id from lead)), 'trial', 'the trial payment moves the lead to trial');
select is((select status::text from public.subscriptions where customer_id = (select id from cust)), 'low_balance',
  'and the subscription starts (2 meals is a low balance, so the plan offer matters)');
select set_config('app.now', '2026-11-05 10:00:00+05:30', true);
select ok((private.growth_tick() ->> 'followups')::int >= 1, 'day 2 of the trial: the plan offer goes out');
select ok((select payload ->> 'url' like '%/c/%' and (payload ->> 'meals')::int = 24 from public.notifications_outbox
           where template = 'trial_followup' and recipient_id = (select id from cust)), 'with a month of the plan (6 days × 4 weeks) and a payment link');
select is((private.growth_tick() ->> 'followups')::int, 0, 'only once');
do $$
declare v uuid;
begin
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, paid_at, created_at)
  values ('83000000-0000-4000-f000-000000000001', (select id from cust), 'cash', 'paid', 216000, 24, private.now(), private.now()) returning id into v;
  perform private.post_recharge(v);
end $$;
select is((select status::text from public.leads where id = (select id from lead)), 'converted', 'buying the plan converts the lead');
select set_config('app.now', '2026-12-02 10:00:00+05:30', true);
do $$
declare v uuid;
begin
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, paid_at, created_at)
  values ('83000000-0000-4000-f000-000000000001', (select id from cust), 'cash', 'paid', 216000, 24, private.now(), private.now()) returning id into v;
  perform private.post_recharge(v);
end $$;
select is((select status::text from public.leads where id = (select id from lead)), 'renewed', 'the month-2 recharge is a renewal');
select is((select string_agg(event, ',' order by id) from public.lead_events where lead_id = (select id from lead)
           and event in ('created', 'matched', 'chose_kitchen', 'trial_paid', 'trial_followup', 'converted', 'renewed')),
  'created,matched,chose_kitchen,trial_paid,trial_followup,converted,renewed', 'every funnel step is logged');

-- The vendor can't change the flag, by any route.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f2000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ update public.customers set platform_sourced = false where id = (select id from cust) $$, '42501', null,
  'the owner cannot update platform_sourced through the API');
select lives_ok($$ select public.update_customer((select id from cust), '{"name":"Asha P."}') $$, 'the owner can still edit the customer');
select throws_ok($$ insert into public.customers (kitchen_id, name, platform_sourced) values ('83000000-0000-4000-f000-000000000001', 'Fake', true) $$,
  '42501', null, 'the owner cannot create platform-sourced customers');
reset role;
select is((select platform_sourced from public.customers where id = (select id from cust)), true, 'still platform-sourced after the edit');
select throws_ok($$ update public.customers set platform_sourced = false where id = (select id from cust) $$, '42501',
  'platform_sourced_is_permanent', 'even with full database rights the flag cannot be cleared');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f2000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.leads), 0::bigint, 'vendors cannot read the platform''s leads');
reset role;

-- A lead that is already the kitchen's own customer is not claimed by the platform.
do $$
declare v_l uuid;
begin
  perform private.insert_customer('83000000-0000-4000-f000-000000000005', 'Own Customer', '+919861999010', 'veg', 'en', null, null, 'vendor', 'vendor');
  v_l := private.upsert_lead('+919861999010', 'website', null, null, '{"name":"Own","area":"Patia","slots":["lunch"],"diet":"veg"}', true, false);
  perform private.refresh_lead_matches(v_l);
  insert into t values ('own', jsonb_build_object('lead', v_l));
end $$;
select throws_ok($$ select private.convert_lead((select (v ->> 'lead')::uuid from t where k = 'own'), '83000000-0000-4000-f000-000000000005', null, 'web') $$,
  '23505', 'already_customer', 'an existing customer of that kitchen cannot become platform-sourced');

-- ===========================================================================
-- Reminders, vendor applications and their nudges
-- ===========================================================================
select set_config('app.now', '2026-11-02 10:00:00+05:30', true);
do $$
declare v_l uuid;
begin
  v_l := private.upsert_lead('+919861999020', 'instagram', 'ig-1', null, '{"name":"Rina","area":"Patia","slots":["lunch"],"diet":"veg"}', true, true);
  perform private.refresh_lead_matches(v_l);
end $$;
select set_config('app.now', '2026-11-03 11:00:00+05:30', true);
select ok((private.growth_tick() ->> 'reminders')::int >= 1, 'a lead shown kitchens 24 h ago gets one reminder');
select is((select count(*) from public.notifications_outbox where template = 'lead_reminder'
           and recipient_id = (select id from public.leads where phone_last4 = '9020')), 1::bigint, 'exactly one');

select set_config('app.now', '2026-11-02 10:00:00+05:30', true);
set local role anon;
select throws_ok($$ select public.submit_vendor_application('Gita', '9861999030', p_consent => true, p_fssai => '123') $$, '22023', 'invalid_fssai',
  'a wrong FSSAI number is caught at sign-up');
insert into t select 'app', to_jsonb(public.submit_vendor_application('Gita Sahu', '9777000002', 'Gita''s Kitchen', 'Khandagiri', 30,
  p_consent => true, p_whatsapp_opt_in => true));
reset role;
select is((select status::text from public.vendor_applications where id = (select (v #>> '{}')::uuid from t where k = 'app')), 'new',
  'the vendor application is recorded');
select is((select count(*) from public.notifications_outbox where template = 'vendor_welcome' and recipient_type = 'vendor_application'),
  (select count(*) from public.vendor_applications where whatsapp_opt_in)::bigint, 'each applicant who opted in gets a welcome');
select set_config('app.now', '2026-11-03 11:00:00+05:30', true);
select ok((private.growth_tick() ->> 'vendor_nudges')::int >= 1, 'day 1: a nudge');
select is((select payload ->> 'next_step' from public.notifications_outbox where template = 'vendor_nudge'
           and recipient_id = (select (v #>> '{}')::uuid from t where k = 'app')), 'signup', 'telling them to sign up');
-- The applicant signs up in the app with the same number (they are user f2…02).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f2000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
insert into t select 'kitchen', to_jsonb(public.create_kitchen('Gita''s Kitchen', p_area => 'Khandagiri'));
reset role;
select is((select status::text || '/' || (kitchen_id is not null)::text from public.vendor_applications
           where id = (select (v #>> '{}')::uuid from t where k = 'app')), 'onboarding/true', 'signing up links the application (onboarding)');
select ok(jsonb_array_length(private.kitchen_checklist((select (v ->> 'id')::uuid from t where k = 'kitchen'))) = 9, 'the onboarding checklist has 9 steps');
update public.kitchens set fssai_no = '12026001009999', status = 'active' where id = (select (v ->> 'id')::uuid from t where k = 'kitchen');
select is((select status::text from public.vendor_applications where id = (select (v #>> '{}')::uuid from t where k = 'app')), 'live',
  'going live closes the application');

-- ===========================================================================
-- Public profile and reviews
-- ===========================================================================
set local role anon;
select is(public.kitchen_profile('draft-kitchen'), null, 'draft kitchens have no public page');
insert into t select 'profile', public.kitchen_profile('wide-radius');
select is((select v ->> 'fssai_no' from t where k = 'profile'), '12026001009005', 'the profile shows the FSSAI number');
select is((select (v -> 'rating' ->> 'reviews')::int from t where k = 'profile'), 5, 'and verified ratings');
select ok((select not (v::text ~ '\+91') from t where k = 'profile'), 'no phone numbers on the public page');
select ok(jsonb_array_length(public.kitchen_directory('Patia')) >= 2, 'the directory lists kitchens serving Patia');
reset role;
update public.kitchen_reviews set hidden = true where kitchen_id = '83000000-0000-4000-f000-000000000005'
  and customer_id = (select id from public.customers where name = 'Reviewer 1');
select is((public.kitchen_profile('wide-radius') -> 'rating' ->> 'reviews')::int, 4, 'hidden reviews no longer count');
-- A trial customer with no meals yet can review, but it isn't verified.
do $$ begin perform public.portal_review(private.issue_magic_link((select id from public.customers where name = 'Holder')), 1, 'never came'); end $$;
select is((select verified from public.kitchen_reviews where customer_id = (select id from public.customers where name = 'Holder')), false,
  'a review without a delivered meal is not verified');
select is((public.kitchen_profile('almost-full') -> 'rating' ->> 'reviews')::int, 0, 'and does not count');

-- ===========================================================================
-- Admin console
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f2000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_leads() $$, '42501', 'forbidden', 'owners cannot open the lead console');
select throws_ok($$ select * from public.lead_funnel() $$, '42501', 'forbidden', 'or the funnel');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select ok(jsonb_array_length(public.admin_leads()) >= 5, 'admins see leads');
select ok((select bool_and(x ->> 'phone' ~ '^XXXXXX') from jsonb_array_elements(public.admin_leads()) x), 'with masked phones');
select is(public.admin_reveal_lead_phone((select id from lead)), '+919861999001', 'an admin can reveal a number...');
reset role;
select ok(exists (select 1 from public.audit_log where action = 'ACCESS' and table_name = 'leads' and row_id = (select id from lead)::text),
  '...and the reveal is logged');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select ok((select renewed = 1 from public.lead_funnel() where source = 'website' and campaign = 'web-test'), 'the funnel counts the renewal per campaign');
select ok((select waiting >= 1 from public.demand_gaps() where area = 'Khandagiri'), 'Khandagiri shows as a demand gap');
insert into t select 'call', public.admin_create_lead('Caller', '9861999040', 'call', null, 'Patia', '{lunch}', 'veg', 7000);
select ok(jsonb_array_length((select v -> 'kitchens' from t where k = 'call')) >= 1, 'a call logged by the team is matched straight away');
select is((public.admin_assign_lead((select (v ->> 'lead_id')::uuid from t where k = 'call'), '83000000-0000-4000-f000-000000000001') ->> 'plan_name'),
  'Veg Lunch', 'the team can place a lead with a kitchen by hand');
select throws_ok($$ select public.admin_set_lead_status((select id from lead), 'converted') $$, '22023', 'invalid_status',
  'funnel stages after matching only come from real events');
reset role;

-- Outbox: lead and applicant recipients resolve to their phone numbers.
update public.notifications_outbox set status = 'cancelled' where status = 'pending' and template not in ('lead_welcome');
select is((select phone_e164 from public.wa_claim_outbox(100) where template = 'lead_welcome' limit 1), '+919861999003',
  'the outbox worker gets the lead''s number');

select * from finish();
rollback;
