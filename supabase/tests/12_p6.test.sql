-- P6 tests: platform commission (Route split, ledger, reports), kitchen switching with the flag OFF and
-- ON, shared riders across kitchens, office plans (one stop, counts per customer, statement), health
-- tags (consent, who sees them), and the notebook-import context. Roles: owner, staff, rider, other
-- kitchen, admin, anon. Calendar: Mon 2 Nov 2026; Tuesday lunch locks Mon 21:00 IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: two live kitchens 100 m apart with the same Veg Lunch price; a rider who works for both.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(), now(), now()
from (values
  ('e6000000-0000-4000-e000-000000000001'::uuid, '919555200001'),
  ('e6000000-0000-4000-e000-000000000002'::uuid, '919555200002'),
  ('e6000000-0000-4000-e000-000000000003'::uuid, '919555200003'),
  ('e6000000-0000-4000-e000-000000000004'::uuid, '919555200004')
) as u(id, phone);
insert into public.kitchens (id, name, slug, owner_id, lat, lng, weekly_off, fssai_no) values
  ('e6100000-0000-4000-e000-000000000001', 'Switch From', 'switch-from', 'e6000000-0000-4000-e000-000000000001', 20.3553, 85.8197, '{7}', '12026001009991'),
  ('e6100000-0000-4000-e000-000000000002', 'Switch To', 'switch-to', 'e6000000-0000-4000-e000-000000000002', 20.3560, 85.8205, '{7}', '12026001009992');
update public.kitchens set status = 'active' where id in ('e6100000-0000-4000-e000-000000000001', 'e6100000-0000-4000-e000-000000000002');
insert into public.kitchen_settings (kitchen_id) values ('e6100000-0000-4000-e000-000000000001'), ('e6100000-0000-4000-e000-000000000002');
insert into public.kitchen_payout_accounts (kitchen_id, razorpay_linked_account_id, kyc_status) values
  ('e6100000-0000-4000-e000-000000000001', 'acc_TestSwitchFrom1', 'verified'),
  ('e6100000-0000-4000-e000-000000000002', 'acc_TestSwitchTo01', 'verified');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('e6100000-0000-4000-e000-000000000001', 'e6000000-0000-4000-e000-000000000001', 'owner', 'Owner One'),
  ('e6100000-0000-4000-e000-000000000002', 'e6000000-0000-4000-e000-000000000002', 'owner', 'Owner Two'),
  ('e6100000-0000-4000-e000-000000000001', 'e6000000-0000-4000-e000-000000000003', 'staff', 'Staff One'),
  ('e6100000-0000-4000-e000-000000000001', 'e6000000-0000-4000-e000-000000000004', 'rider', 'Ravi Shared'),
  ('e6100000-0000-4000-e000-000000000002', 'e6000000-0000-4000-e000-000000000004', 'rider', 'Ravi Shared');
insert into public.plans (id, kitchen_id, name, slots, diet, days_of_week, price_per_meal_paise) values
  ('e6200000-0000-4000-e000-000000000001', 'e6100000-0000-4000-e000-000000000001', 'Veg Lunch', '{lunch}', 'veg', '{1,2,3,4,5,6}', 7000),
  ('e6200000-0000-4000-e000-000000000002', 'e6100000-0000-4000-e000-000000000002', 'Veg Lunch', '{lunch}', 'veg', '{1,2,3,4,5,6}', 7000),
  ('e6200000-0000-4000-e000-000000000003', 'e6100000-0000-4000-e000-000000000002', 'Veg Lunch Premium', '{lunch}', 'veg', '{1,2,3,4,5,6}', 9000);

select set_config('app.now', '2026-11-02 10:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
create temp table vals (k text primary key, v text);
grant select, insert on ids, vals to authenticated, anon;

-- Two platform customers at "Switch From" (via the normal lead path), each paid for 5 meals.
do $$
declare v_lead uuid; v_conv jsonb; v_pay uuid; r record;
begin
  for r in select * from (values ('pia', '+919555300001', 'Pia Platform'), ('raj', '+919555300002', 'Raj Platform')) t(k, phone, name) loop
    v_lead := private.upsert_lead(r.phone, 'website', null, null,
      jsonb_build_object('name', r.name, 'lat', 20.3555, 'lng', 85.8199, 'slots', '["lunch"]'::jsonb, 'diet', 'veg',
                         'budget_per_meal_paise', 7000), true, true);
    v_conv := private.convert_lead(v_lead, 'e6100000-0000-4000-e000-000000000001', 'e6200000-0000-4000-e000-000000000001', 'web');
    insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, paid_at, created_at)
    values ('e6100000-0000-4000-e000-000000000001', (v_conv ->> 'customer_id')::uuid, 'cash', 'paid', 35000, 5, now(), now())
    returning id into v_pay;
    perform private.post_recharge(v_pay);
    insert into ids values (r.k, (v_conv ->> 'customer_id')::uuid);
  end loop;
end $$;
-- A vendor's own customer, office customers (manager pays) and a customer at "Switch To".
do $$
declare r record; v_c uuid; v_a uuid;
begin
  for r in select * from (values
    ('own', 'e6100000-0000-4000-e000-000000000001', 'Omkar Own', '9555300010', 'e6200000-0000-4000-e000-000000000001', 0.001),
    ('mgr', 'e6100000-0000-4000-e000-000000000001', 'Meena Manager', '9555300011', null, 0.010),
    ('e1', 'e6100000-0000-4000-e000-000000000001', 'Eshan Employee', '9555300012', 'e6200000-0000-4000-e000-000000000001', 0.011),
    ('e2', 'e6100000-0000-4000-e000-000000000001', 'Ela Employee', '9555300013', 'e6200000-0000-4000-e000-000000000001', 0.012),
    ('to1', 'e6100000-0000-4000-e000-000000000002', 'Tara Two', '9555300020', 'e6200000-0000-4000-e000-000000000002', 0.002)
  ) t(k, kitchen, name, phone, plan, dlat) loop
    v_c := private.insert_customer(r.kitchen::uuid, r.name, '+91' || r.phone, 'veg', 'en', null,
      jsonb_build_object('line1', 'Home of ' || r.k, 'area', 'Patia', 'lat', 20.3553 + r.dlat, 'lng', 85.8197 + r.dlat), 'vendor', 'vendor');
    if r.plan is not null then
      select id into v_a from public.addresses where customer_id = v_c and is_default;
      insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
      values (r.kitchen::uuid, v_c, r.plan::uuid, v_a, '2026-11-03', 'active');
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
      values (r.kitchen::uuid, v_c, 'adjust', 10, 70000, 'test balance');
    end if;
    insert into ids values (r.k, v_c);
  end loop;
end $$;

-- ===========================================================================
-- 1. Platform commission via Route split
-- ===========================================================================
select is((private.payment_link_record((select v from ids where k = 'pia'), 2, null) ->> 'commission_paise')::integer, 0,
  'with the default rate 0 nothing changes');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_set_commission('e6100000-0000-4000-e000-000000000001', 1000) $$, '42501', 'forbidden',
  'owners cannot set their commission');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$ select public.admin_set_commission('e6100000-0000-4000-e000-000000000001', 3001) $$, '22023', 'invalid_commission',
  'at most 30%');
select lives_ok($$ select public.admin_set_commission('e6100000-0000-4000-e000-000000000001', 1000) $$, 'admin sets 10%');
reset role;
insert into vals values ('pl', private.payment_link_record((select v from ids where k = 'pia'), 10, null)::text);
select is((select v::jsonb ->> 'commission_paise' from vals where k = 'pl'), '7000', 'platform customer: 10% of ₹700 = ₹70');
select is((select v::jsonb ->> 'transfer_paise' from vals where k = 'pl'), '63000', 'the kitchen''s Route transfer is ₹630');
select is((private.payment_link_record((select v from ids where k = 'own'), 10, null) ->> 'commission_paise')::integer, 0,
  'the vendor''s own customers never pay commission');
select is(public.razorpay_process_event('evt_p6_1', jsonb_build_object('event', 'payment_link.paid', 'payload', jsonb_build_object(
  'payment_link', jsonb_build_object('entity', jsonb_build_object('id', 'plink_p6_1', 'reference_id', (select v::jsonb ->> 'payment_id' from vals where k = 'pl'))),
  'payment', jsonb_build_object('entity', jsonb_build_object('id', 'pay_p6_1', 'amount', 70000, 'currency', 'INR'))))), 'paid',
  'the payment is captured');
select is(public.razorpay_process_event('evt_p6_2', jsonb_build_object('event', 'payment.captured', 'payload', jsonb_build_object(
  'payment', jsonb_build_object('entity', jsonb_build_object('id', 'pay_p6_1', 'amount', 70000, 'currency', 'INR',
    'notes', jsonb_build_object('payment_id', (select v::jsonb ->> 'payment_id' from vals where k = 'pl'))))))), 'already_paid',
  'a second event for the same payment');
select is((select count(*)::integer || ':' || sum(commission_paise) || ':' || sum(transfer_paise) from public.platform_commissions
           where payment_id = (select (v::jsonb ->> 'payment_id')::uuid from vals where k = 'pl')), '1:7000:63000',
  'exactly one commission ledger row (idempotent on the payment)');
select throws_ok($$ update public.platform_commissions set commission_paise = 1 $$, 'P0001', null, 'the commission ledger is append-only');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select is((public.admin_commission_report('2026-10-01', '2026-12-31') ->> 'total_commission_paise')::integer >= 7000, true,
  'admin report totals the commission');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_commission_report('2026-10-01', '2026-12-31') $$, '42501', 'forbidden', 'owners cannot run the admin report');
select is((public.commission_statement('e6100000-0000-4000-e000-000000000001', '2026-10-01', '2026-12-31') ->> 'commission_paise')::integer,
  (select sum(commission_paise)::integer from public.platform_commissions where kitchen_id = 'e6100000-0000-4000-e000-000000000001'),
  'owners see what the platform kept from their payments');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.commission_statement('e6100000-0000-4000-e000-000000000001', '2026-10-01', '2026-12-31') $$, '42501', 'forbidden',
  'staff cannot see commission');
select is((select count(*) from public.platform_commissions), 0::bigint, 'nor read the ledger');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.platform_commissions where kitchen_id = 'e6100000-0000-4000-e000-000000000001'), 0::bigint,
  'another kitchen cannot read it');
reset role;

-- ===========================================================================
-- 2. Kitchen switching: flag OFF everywhere
-- ===========================================================================
insert into vals values ('tp', private.issue_magic_link((select v from ids where k = 'pia'), 7));
insert into vals values ('tr', private.issue_magic_link((select v from ids where k = 'raj'), 7));
insert into vals values ('to', private.issue_magic_link((select v from ids where k = 'own'), 7));
select is((select enabled from public.platform_settings where key = 'kitchen_switching'), false, 'kitchen switching is off by default');
set local role anon;
select throws_ok($$ select public.portal_switch_options((select v from vals where k = 'tp')) $$, '22023', 'feature_disabled',
  'flag off: no switch options');
select throws_ok($$ select public.portal_request_switch((select v from vals where k = 'tp'), 'e6100000-0000-4000-e000-000000000002') $$,
  '22023', 'feature_disabled', 'flag off: no switch requests');
select is((public.portal_get((select v from vals where k = 'tp')) ->> 'kitchen_switching'), 'false', 'the page hides switching');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$ select public.admin_switch_requests() $$, '22023', 'feature_disabled', 'flag off: no admin list');
select throws_ok($$ select public.admin_decide_switch(gen_random_uuid(), true) $$, '22023', 'feature_disabled', 'flag off: no approvals');
select throws_ok($$ select public.admin_set_platform_flag('no_such_flag', true) $$, '22023', 'invalid_flag', 'unknown flags are refused');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_set_platform_flag('kitchen_switching', true) $$, '42501', 'forbidden', 'owners cannot turn it on');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select lives_ok($$ select public.admin_set_platform_flag('kitchen_switching', true) $$, 'the platform team turns it on');
reset role;

-- Flag ON
set local role anon;
select is((public.portal_get((select v from vals where k = 'tp')) ->> 'kitchen_switching'), 'true', 'the page offers switching');
select ok(public.portal_switch_options((select v from vals where k = 'tp')) -> 'options' @> '[{"name":"Switch To","plan_name":"Veg Lunch"}]',
  'a nearby kitchen with the same-price plan is offered (not its ₹90 plan)');
select ok((select bool_and((o ->> 'price_per_meal_paise')::integer = 7000 and o ->> 'name' <> 'Switch From')
           from jsonb_array_elements(public.portal_switch_options((select v from vals where k = 'tp')) -> 'options') o),
  'every option has exactly the current price, and never the current kitchen');
select ok(not (public.portal_switch_options((select v from vals where k = 'tp')) -> 'options' @> '[{"name":"Infocity Home Kitchen"}]'),
  'a kitchen whose price differs is not offered');
select throws_ok($$ select public.portal_switch_options((select v from vals where k = 'to')) $$, '22023', 'switch_not_allowed',
  'a vendor''s own customer cannot be moved by the platform');
select throws_ok($$ select public.portal_request_switch((select v from vals where k = 'tp'), '10000000-0000-4000-a000-00000000000c') $$,
  '22023', 'kitchen_not_available', 'only offered kitchens');
select lives_ok($$ insert into vals select 'req1', public.portal_request_switch((select v from vals where k = 'tp'),
  'e6100000-0000-4000-e000-000000000002', 'Closer to my office')::text $$, 'Pia asks to switch');
select throws_ok($$ select public.portal_request_switch((select v from vals where k = 'tp'), 'e6100000-0000-4000-e000-000000000002') $$,
  '23505', 'already_requested', 'one open request at a time');
select lives_ok($$ insert into vals select 'req2', public.portal_request_switch((select v from vals where k = 'tr'),
  'e6100000-0000-4000-e000-000000000002')::text $$, 'Raj asks too');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.kitchen_switch_requests), 0::bigint, 'the old kitchen cannot read switch requests');
select throws_ok($$ select public.admin_decide_switch((select v::uuid from vals where k = 'req1'), true) $$, '42501', 'forbidden',
  'owners cannot approve');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select is(jsonb_array_length(public.admin_switch_requests()), 2, 'admin sees both requests');
select is((public.admin_switch_requests() -> 0 ->> 'balance_meals')::integer >= 5, true, 'with the customer''s balance');
insert into vals select 'dec', public.admin_decide_switch((select v::uuid from vals where k = 'req1'), true, 'OK')::text;
select is((select v::jsonb ->> 'effective_date' from vals where k = 'dec'), '2026-11-03', 'approved from the first open date (Tuesday)');
select is(public.admin_decide_switch((select v::uuid from vals where k = 'req2'), false, 'Kitchen is full') ->> 'status', 'rejected',
  'admin rejects the other');
select throws_ok($$ select public.admin_decide_switch((select v::uuid from vals where k = 'req1'), true) $$, '22023', 'not_pending',
  'a decided request cannot be decided again');
reset role;
select is((select string_agg(distinct status::text, ',') from public.subscriptions where customer_id = (select v from ids where k = 'pia')),
  'cancelled', 'the old kitchen''s subscription ends (nothing frozen after today)');
select is((select meals from public.refunds where customer_id = (select v from ids where k = 'pia')), 15,
  'all 15 unused meals are refunded through create_refund (we hold no money)');
select is((select coalesce(sum(meals), 0)::integer from public.balance_entries where customer_id = (select v from ids where k = 'pia')), 0,
  'the old balance is now zero');
select is((select platform_sourced::text || ':' || kitchen_id from public.customers where id = (select (v::jsonb ->> 'new_customer_id')::uuid from vals where k = 'dec')),
  'true:e6100000-0000-4000-e000-000000000002', 'the customer joins the new kitchen as platform-sourced');
select is((select status::text || ':' || plan_id from public.subscriptions where customer_id = (select (v::jsonb ->> 'new_customer_id')::uuid from vals where k = 'dec')),
  'trial:e6200000-0000-4000-e000-000000000002', 'on the same-price plan, as a trial to pay');
select is((select count(*) from public.notifications_outbox where template = 'kitchen_switch_approved'), 1::bigint, 'the customer is told');
select is((select count(*) from public.notifications_outbox where template = 'customer_switched_out'
           and kitchen_id = 'e6100000-0000-4000-e000-000000000001'), 1::bigint, 'the old kitchen''s owner is told');
select is((select status::text from public.leads where customer_id = (select v from ids where k = 'pia')), 'converted',
  'the old (closed) lead keeps its funnel stage');
select is((select campaign || ':' || source from public.leads where customer_id = (select (v::jsonb ->> 'new_customer_id')::uuid from vals where k = 'dec')),
  'kitchen_switch:other', 'the move went through a new lead (convert path)');
select is((select status from public.kitchen_switch_requests where id = (select v::uuid from vals where k = 'req2')), 'rejected',
  'Raj stays where he is');
-- Back OFF: everything refuses again.
update public.platform_settings set enabled = false where key = 'kitchen_switching';
set local role anon;
select throws_ok($$ select public.portal_cancel_switch((select v from vals where k = 'tr')) $$, '22023', 'feature_disabled',
  'flag off again: refused');
reset role;

-- ===========================================================================
-- 4. Office plans (+ 5. health tags)
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.upsert_office('e6100000-0000-4000-e000-000000000001', 'Infy Block A', (select v from ids where k = 'mgr')) $$,
  '42501', 'forbidden', 'staff cannot create offices');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.upsert_office('e6100000-0000-4000-e000-000000000001', 'Infy', (select v from ids where k = 'mgr'),
  p_contact_phone => '12345') $$, '22023', 'invalid_phone', 'contact phone is validated');
select lives_ok($$ insert into vals select 'office', public.upsert_office('e6100000-0000-4000-e000-000000000001', 'Infy Block A',
  (select v from ids where k = 'mgr'), 'Block A, gate 2', 'Infocity', 'Reception', 20.3480, 85.8100, 'Front desk', '9437012345')::text $$,
  'owner creates an office billed to the manager');
select lives_ok($$ select public.set_customer_office((select v from ids where k = 'e1'), (select v::uuid from vals where k = 'office')) $$,
  'Eshan joins the office');
select lives_ok($$ select public.set_customer_office((select v from ids where k = 'e2'), (select v::uuid from vals where k = 'office')) $$,
  'Ela joins the office');
select is((select count(*) from public.customers where office_id = (select v::uuid from vals where k = 'office')
           and payer_customer_id = (select v from ids where k = 'mgr')), 2::bigint, 'the manager is now both employees'' payer');
select is((public.offices_list('e6100000-0000-4000-e000-000000000001') -> 0 ->> 'contact_phone'), '+919437012345', 'owner sees the contact phone');
select throws_ok($$ select public.set_health_tags((select v from ids where k = 'e1'), '{diabetic,low_salt}', false) $$, '22023', 'consent_required',
  'health tags need consent');
select throws_ok($$ select public.set_health_tags((select v from ids where k = 'e1'), '{keto}', true) $$, '22023', 'invalid_tags',
  'only known tags');
select is(public.set_health_tags((select v from ids where k = 'e1'), '{low_salt,diabetic,diabetic}', true), '{diabetic,low_salt}'::text[],
  'owner records Eshan''s tags with consent');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.set_health_tags((select v from ids where k = 'e2'), '{soft_food}', true) $$, '42501', 'forbidden',
  'staff cannot record health data');
select is((select tags from public.customer_health where customer_id = (select v from ids where k = 'e1')), '{diabetic,low_salt}'::text[],
  'staff can read health tags (packing)');
select is((public.offices_list('e6100000-0000-4000-e000-000000000001') -> 0 ->> 'contact_phone'), '+91 ••••••2345', 'staff see it masked');
select is((public.offices_list('e6100000-0000-4000-e000-000000000001') -> 0 ->> 'billing_customer_id'), null, 'and no billing details');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000004","role":"authenticated"}', true);
select is((select count(*) from public.customer_health), 0::bigint, 'riders never see health data');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.customer_health where kitchen_id = 'e6100000-0000-4000-e000-000000000001'), 0::bigint,
  'another kitchen sees none');
select is((select count(*) from public.offices where kitchen_id = 'e6100000-0000-4000-e000-000000000001'), 0::bigint,
  'nor its offices');
reset role;
select ok(exists (select 1 from public.consents where customer_id = (select v from ids where k = 'e1') and purpose = 'health_data'
                  and withdrawn_at is null), 'the consent is recorded');
select ok(exists (select 1 from public.audit_log where table_name = 'customer_health'), 'health data changes are audited');

-- ===========================================================================
-- Lock Tuesday lunch: office grouping, shared rider across kitchens
-- ===========================================================================
select set_config('app.now', '2026-11-02 21:01:00+05:30', true);
select private.run_due_locks();
create temp table os as
select s.* from public.delivery_stops s join public.delivery_runs r on r.id = s.run_id
where r.kitchen_id = 'e6100000-0000-4000-e000-000000000001' and r.service_date = '2026-11-03' and s.office_id is not null;
grant select on os to authenticated;
select is((select count(*) from os), 1::bigint, 'the office''s customers share one stop');
select is((select meal_count::integer from os), 2, 'with the sum of their meals');
select is((select customer_id from os), (select v from ids where k = 'mgr'), 'addressed to the office (billing customer)');
select is((select count(*) from public.meal_orders where stop_id = (select id from os)), 2::bigint, 'both orders point at the office stop');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where b.type = 'meal' and o.stop_id = (select id from os)), 2::bigint, 'counts and meal charges stay per customer');
select is((private.slot_totals('e6100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch') -> 'by_health' ->> 'diabetic')::integer, 1,
  'the count breakdown includes health tags');

select set_config('app.now', '2026-11-03 11:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select is((select health_tags from public.packing_list('e6100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch')
           where customer_name = 'Eshan Employee'), '{diabetic,low_salt}'::text[], 'the packing list shows health tags');
select is((select office_name from public.packing_list('e6100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch')
           where customer_name = 'Ela Employee'), 'Infy Block A', 'and the office');
select is((select x -> 'health_tags' from jsonb_array_elements(public.sticker_sheet('e6100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch')) x
           where (x ->> 'office')::boolean), '["diabetic", "low_salt"]'::jsonb, 'the office sticker carries the health tags');
select is((select jsonb_array_length(x -> 'eaters') from jsonb_array_elements(public.sticker_sheet('e6100000-0000-4000-e000-000000000001', '2026-11-03', 'lunch')) x
           where (x ->> 'office')::boolean), 2, 'and lists each eater');

-- 3. The shared rider sees today's runs of both kitchens, only their own stops, masked.
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000004","role":"authenticated"}', true);
select is((select jsonb_agg(distinct r ->> 'kitchen_name' order by r ->> 'kitchen_name') from jsonb_array_elements(public.rider_today()) r),
  '["Switch From", "Switch To"]'::jsonb, 'a rider in two kitchens gets today''s runs of both');
select is(cardinality(private.my_run_ids()), 2, 'my_run_ids covers both kitchens');
select is((select count(distinct kitchen_id) from public.delivery_runs), 2::bigint, 'RLS lets the rider read both runs');
select ok(not (public.rider_today()::text ~ '(9555300|diabetic|low_salt)'), 'phones stay masked and no health data reaches the rider');
select ok(exists (select 1 from jsonb_array_elements(public.rider_today()) r, jsonb_array_elements(r -> 'stops') s
                  where s ->> 'name' = 'Infy Block A'), 'the office stop shows the office name');
-- Kitchen-fault failure at the office stop credits each employee.
select is(public.fail_stop((select id from os), 'kitchen_late') ->> 'status', 'failed', 'the rider marks the office stop failed (kitchen late)');
reset role;
select is((select count(*) from public.balance_entries where ref_type = 'delivery_stop_order' and customer_id in
           ((select v from ids where k = 'e1'), (select v from ids where k = 'e2'))), 2::bigint, 'each employee gets their meal back');
select is((select count(*) from public.balance_entries where ref_type = 'delivery_stop_order' and customer_id = (select v from ids where k = 'mgr')),
  0::bigint, 'not the manager');
-- Finished runs feed separate rider-pay reports per kitchen.
update public.delivery_stops set status = 'delivered', proof_type = 'none', done_at = now()
where run_id in (select id from public.delivery_runs where rider_id = 'e6000000-0000-4000-e000-000000000004') and status = 'pending';
update public.delivery_runs set status = 'done', started_at = now(), finished_at = now() where rider_id = 'e6000000-0000-4000-e000-000000000004';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select is((select stops_delivered from public.rider_stats('e6100000-0000-4000-e000-000000000002', '2026-11-01')), 1,
  'kitchen Two''s rider report counts only its own stop');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is((select stops_delivered + stops_failed from public.rider_stats('e6100000-0000-4000-e000-000000000001', '2026-11-01')),
  (select count(*)::integer from public.delivery_stops s join public.delivery_runs r on r.id = s.run_id
   where r.kitchen_id = 'e6100000-0000-4000-e000-000000000001'), 'kitchen One''s report counts only its stops');
-- Office statement.
select is((public.office_statement((select v::uuid from vals where k = 'office'), '2026-11-01') -> 'totals' ->> 'meals')::integer, 2,
  'office statement: 2 meals charged in November');
select is(jsonb_array_length(public.office_statement((select v::uuid from vals where k = 'office'), '2026-11-01') -> 'members'), 2,
  'listed per member');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.office_statement((select v::uuid from vals where k = 'office'), '2026-11-01') $$, '42501', 'forbidden',
  'staff cannot see the statement (money)');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.set_customer_office((select v from ids where k = 'e2'), null) $$, 'Ela leaves the office');
select is((select payer_customer_id from public.customers where id = (select v from ids where k = 'e2')), null, 'and pays for herself again');
reset role;
-- Withdrawal on the customer page deletes the data.
insert into vals values ('te1', private.issue_magic_link((select v from ids where k = 'e1'), 7));
set local role anon;
select is(public.portal_get((select v from vals where k = 'te1')) -> 'health_tags', '["diabetic", "low_salt"]'::jsonb,
  'the customer sees their own tags');
select is(public.portal_set_health_tags((select v from vals where k = 'te1'), '{}'), '{}'::text[], 'and withdraws them');
reset role;
select is((select count(*) from public.customer_health where customer_id = (select v from ids where k = 'e1')), 0::bigint, 'the data is deleted');
select ok(exists (select 1 from public.consents where customer_id = (select v from ids where k = 'e1') and purpose = 'health_data'
                  and withdrawn_at is not null), 'and the consent marked withdrawn');

-- ===========================================================================
-- 6. Notebook import context
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select is(public.notebook_import_context('e6100000-0000-4000-e000-000000000001', 'e6100000-0000-4000-e000-000000000001/page1.jpg') -> 'plans',
  '["Veg Lunch"]'::jsonb, 'owner gets the plan names for matching');
select throws_ok($$ select public.notebook_import_context('e6100000-0000-4000-e000-000000000001', 'e6100000-0000-4000-e000-000000000002/x.jpg') $$,
  '22023', 'invalid_photo', 'the photo must be in the kitchen''s folder');
select throws_ok($$ select public.notebook_import_context('e6100000-0000-4000-e000-000000000001', 'e6100000-0000-4000-e000-000000000001/../x.jpg') $$,
  '22023', 'invalid_photo', 'no path tricks');
select set_config('request.jwt.claims', '{"sub":"e6000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.notebook_import_context('e6100000-0000-4000-e000-000000000001', 'e6100000-0000-4000-e000-000000000001/p.jpg') $$,
  '42501', 'forbidden', 'staff cannot import customers');
reset role;
select is((select public from storage.buckets where id = 'imports'), false, 'the imports bucket is private');

select * from finish();
rollback;
