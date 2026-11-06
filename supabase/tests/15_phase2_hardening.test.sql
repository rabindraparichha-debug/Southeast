-- Phase 2 hardening (docs/VENDOR_FIRST_AUDIT.md Phase 2 steps 1-6; D-146..D-152): delivery codes
-- (lockout sticks, offline wrong code not delivered, codes not kept in audit_log / outbox / message
-- log), kitchen-scoped referral links, the AI budget, cancelled payment links, Google Ads mock
-- status, and the admin escalation queue. Roles: owner, staff, rider, another kitchen's owner, admin,
-- anon, service role.
-- Calendar: Mon 16 Nov 2026, 12:00 IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup. Kitchen P (owner, staff, rider), a second admin. Kitchen B (seed) is "another kitchen".
-- ===========================================================================
select set_config('app.now', '2026-11-16 12:00:00+05:30', true);
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(),
       jsonb_build_object('name', u.name), now(), now()
from (values
  ('f5000000-0000-4000-f000-000000000001'::uuid, '919555000001', 'Owner P'),
  ('f5000000-0000-4000-f000-000000000002'::uuid, '919555000002', 'Staff P'),
  ('f5000000-0000-4000-f000-000000000003'::uuid, '919555000003', 'Rider P'),
  ('f5000000-0000-4000-f000-000000000009'::uuid, '919555000009', 'Second Admin')
) as u(id, phone, name);
insert into public.platform_admins (user_id) values ('f5000000-0000-4000-f000-000000000009');
insert into public.kitchens (id, name, slug, owner_id, area, lat, lng, fssai_no, weekly_off) values
  ('95000000-0000-4000-f000-000000000001', 'Phase Two Kitchen', 'phase-two-kitchen', 'f5000000-0000-4000-f000-000000000001',
   'Patia', 20.3553, 85.8197, '12026001000999', '{}');
insert into public.kitchen_settings (kitchen_id) values ('95000000-0000-4000-f000-000000000001');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('95000000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000001', 'owner', 'Owner P'),
  ('95000000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000002', 'staff', 'Staff P'),
  ('95000000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000003', 'rider', 'Rider P');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('95100000-0000-4000-f000-000000000001', '95000000-0000-4000-f000-000000000001', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 7000);

create temp table ids (k text primary key, v uuid);
create temp table vals (k text primary key, v text);
create temp table inv (v jsonb);
create temp table q (v jsonb);
create temp table det (v jsonb);
create temp table live_claim (id uuid, gclid text, stage text, value_paise integer, occurred_at timestamptz, attempts integer);
grant select, insert on ids, vals, inv, q, det, live_claim to authenticated, anon, service_role;

do $$
declare
  v_c uuid;
  i integer := 0;
  k text;
begin
  foreach k in array array['p1', 'p2', 'p3'] loop
    i := i + 1;
    v_c := private.insert_customer('95000000-0000-4000-f000-000000000001', 'Phase ' || k, '+91955510000' || i, 'veg', 'en', null,
      jsonb_build_object('line1', 'Flat ' || k, 'area', 'Patia', 'lat', 20.3553 + i * 0.001, 'lng', 85.8197), 'vendor', 'vendor');
    insert into ids values (k, v_c);
  end loop;
end $$;

insert into public.delivery_routes (id, kitchen_id, slot, name, rider_id)
values ('95200000-0000-4000-f000-000000000001', '95000000-0000-4000-f000-000000000001', 'lunch', 'Patia', 'f5000000-0000-4000-f000-000000000003');
insert into public.delivery_runs (id, kitchen_id, route_id, service_date, slot, rider_id, status, started_at)
values ('95300000-0000-4000-f000-000000000001', '95000000-0000-4000-f000-000000000001', '95200000-0000-4000-f000-000000000001',
        '2026-11-16', 'lunch', 'f5000000-0000-4000-f000-000000000003', 'out', '2026-11-16 11:30:00+05:30');
insert into public.delivery_stops (id, kitchen_id, run_id, customer_id, address_id, seq, meal_count, otp)
select ('95400000-0000-4000-f000-00000000000' || n)::uuid, '95000000-0000-4000-f000-000000000001', '95300000-0000-4000-f000-000000000001',
       (select v from ids where k = 'p' || n), (select id from public.addresses where customer_id = (select v from ids where k = 'p' || n)),
       n, 1, '12' || n || '4'
from generate_series(1, 3) n;

-- ===========================================================================
-- Item 1: delivery codes
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.complete_stop('95400000-0000-4000-f000-000000000001', 'otp', p_otp => '0000') ->> 'otp_attempts_left', '4',
  'a wrong code online: the stop stays pending, 4 tries left');
select is(public.complete_stop('95400000-0000-4000-f000-000000000001', 'otp', p_otp => '0001') ->> 'status', 'pending', 'second wrong code');
select is(public.complete_stop('95400000-0000-4000-f000-000000000001', 'otp', p_otp => '0002') ->> 'locked', 'false', 'third wrong code, not locked yet');
select is(public.complete_stop('95400000-0000-4000-f000-000000000001', 'otp', p_otp => '0003') ->> 'otp_attempts_left', '1', 'fourth wrong code');
select is(public.complete_stop('95400000-0000-4000-f000-000000000001', 'otp', p_otp => '0004') ->> 'locked', 'true',
  'the fifth wrong code locks OTP proof (answered, not raised)');
reset role;
select is((select otp_attempts from public.delivery_stops where id = '95400000-0000-4000-f000-000000000001'), 5::smallint,
  'the lockout sticks: all five attempts are saved');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.complete_stop('95400000-0000-4000-f000-000000000001', 'otp', p_otp => '1214') $$, '22023', 'otp_locked',
  'after the lockout even the right code is refused');
select is(public.complete_stop('95400000-0000-4000-f000-000000000001', 'none') ->> 'status', 'delivered',
  'the rider can still deliver without a code');

-- Offline: a queued wrong code is not delivered; it comes back pending (the queue parks it).
select is(public.complete_stop('95400000-0000-4000-f000-000000000002', 'otp', p_otp => '9999', p_at => '2026-11-16 11:50:00+05:30',
  p_client_op => '95500000-0000-4000-f000-000000000001', p_offline => true, p_cash_paise => 7000)::jsonb - 'stop_id',
  '{"status": "pending", "otp_ok": false, "conflict": false, "otp_attempts_left": 4, "locked": false}'::jsonb,
  'an offline submit with a wrong code is answered pending / otp_ok false (needs attention)');
reset role;
select is((select status::text || '/' || otp_attempts || '/' || coalesce(cash_payment_id::text, 'no cash')
           from public.delivery_stops where id = '95400000-0000-4000-f000-000000000002'),
  'pending/1/no cash', '...nothing recorded as delivered, no cash booked, the attempt counted');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.complete_stop('95400000-0000-4000-f000-000000000002', 'otp', p_otp => '1224', p_at => '2026-11-16 11:50:00+05:30',
  p_client_op => '95500000-0000-4000-f000-000000000002', p_offline => true) ->> 'otp_ok', 'true', 'an offline right code delivers');
reset role;

-- A wrong-code submit resent with the same op id (its answer was lost) is not counted twice (D-155).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.complete_stop('95400000-0000-4000-f000-000000000003', 'otp', p_otp => '0000',
  p_client_op => '95500000-0000-4000-f000-000000000031', p_offline => true) ->> 'otp_attempts_left', '4', 'a queued wrong code: 4 tries left');
select is(public.complete_stop('95400000-0000-4000-f000-000000000003', 'otp', p_otp => '0000',
  p_client_op => '95500000-0000-4000-f000-000000000031', p_offline => true) ->> 'otp_attempts_left', '4',
  'the same op sent again gets the same answer');
reset role;
select is((select otp_attempts from public.delivery_stops where id = '95400000-0000-4000-f000-000000000003'), 1::smallint,
  'and counts as one attempt');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is(public.complete_stop('95400000-0000-4000-f000-000000000003', 'otp', p_otp => '0001',
  p_client_op => '95500000-0000-4000-f000-000000000032') ->> 'otp_attempts_left', '3', 'a new wrong code is another attempt');
reset role;
update public.delivery_stops set otp_attempts = 0, otp_last_op = null where id = '95400000-0000-4000-f000-000000000003';

-- Other roles cannot use the rider RPC on this run.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.complete_stop('95400000-0000-4000-f000-000000000003', 'otp', p_otp => '0000') $$, '42501', 'forbidden',
  'staff cannot try codes');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.complete_stop('95400000-0000-4000-f000-000000000003', 'otp', p_otp => '0000') $$, '42501', 'forbidden',
  'another kitchen''s owner cannot try codes');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.complete_stop('95400000-0000-4000-f000-000000000003', 'otp', p_otp => '0000') $$, '42501', null,
  'anon cannot try codes');
reset role;

-- Codes never reach the audit log.
select is((select count(*) from public.audit_log where table_name = 'delivery_stops'
           and (after ->> 'otp' ~ '^[0-9]{4}$' or before ->> 'otp' ~ '^[0-9]{4}$')), 0::bigint, 'no delivery code in the audit log');
select ok((select count(*) from public.audit_log where table_name = 'delivery_stops' and row_id = '95400000-0000-4000-f000-000000000001') > 0,
  'the stops are still audited (without the code)');
select is(private.audit_redacted_columns() @> array['otp', 'phone_enc', 'phone_hash', 'token_hash'], true, 'otp is a redacted audit column');

-- Outbox: the code is kept only while the row can still be sent.
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
values ('95000000-0000-4000-f000-000000000001', 'whatsapp', 'customer', (select v from ids where k = 'p3'), 'on_the_way',
        '{"otp": "1234", "rider_name": "Rider", "stop": 3, "stops": 3, "slot": "lunch"}', 'test_otw:p3');
select is((select payload ->> 'otp' from public.notifications_outbox where dedupe_key = 'test_otw:p3'), '1234', 'a pending row keeps the code to send it');
update public.notifications_outbox set status = 'sending' where dedupe_key = 'test_otw:p3';
select is((select payload ->> 'otp' from public.notifications_outbox where dedupe_key = 'test_otw:p3'), '1234', 'and while it is being sent');
update public.notifications_outbox set status = 'sent', sent_at = now() where dedupe_key = 'test_otw:p3';
select is((select payload ? 'otp' from public.notifications_outbox where dedupe_key = 'test_otw:p3'), false, 'once sent, the code is gone');
select is((select payload ->> 'rider_name' from public.notifications_outbox where dedupe_key = 'test_otw:p3'), 'Rider', 'the rest of the payload stays');
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, status)
values ('95000000-0000-4000-f000-000000000001', 'whatsapp', 'customer', (select v from ids where k = 'p3'), 'on_the_way',
        '{"otp": "5678"}', 'test_otw:p3b', 'cancelled');
select is((select payload ? 'otp' from public.notifications_outbox where dedupe_key = 'test_otw:p3b'), false,
  'a row stored as cancelled never keeps the code');

-- The logged copy of a sent "on the way" message hides the code.
insert into public.conversations (id, kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4)
select '95600000-0000-4000-f000-000000000001', kitchen_id, id, phone_hash, phone_enc, phone_last4
from public.customers where id = (select v from ids where k = 'p1');
insert into public.conversations (id, kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4)
select '95600000-0000-4000-f000-000000000002', kitchen_id, id, phone_hash, phone_enc, phone_last4
from public.customers where id = (select v from ids where k = 'p2');
select public.wa_log_outbound('95600000-0000-4000-f000-000000000001',
  'Phase Two Kitchen: your lunch is on the way with Rider (stop 3 of 12). Delivery code: 1234. Share it only when you receive your tiffin.',
  '{"template": "on_the_way"}', null, 'system', 'sent', 'on_the_way');
select is((select body from public.messages where conversation_id = '95600000-0000-4000-f000-000000000001' order by created_at desc limit 1),
  'Phase Two Kitchen: your lunch is on the way with Rider (stop 3 of 12). Delivery code: ••••. Share it only when you receive your tiffin.',
  'the message log masks the code and keeps the rest');
select public.wa_log_outbound('95600000-0000-4000-f000-000000000001', 'Your total is ₹ 1234: thanks', '{}', null, 'bot', 'sent', 'balance');
select is((select count(*) from public.messages where conversation_id = '95600000-0000-4000-f000-000000000001' and body like '%1234%'), 1::bigint,
  'other messages are left alone');

-- ===========================================================================
-- Item 2: referral links stay with the kitchen
-- ===========================================================================
insert into vals select 'code_p1', referral_code from public.customers where id = (select v from ids where k = 'p1');
insert into vals select 'code_p2', referral_code from public.customers where id = (select v from ids where k = 'p2');
insert into vals select 'code_b', referral_code from public.customers where kitchen_id = '10000000-0000-4000-a000-00000000000b'
  and deleted_at is null order by created_at limit 1;
select ok((select v from vals where k = 'code_b') is not null, 'kitchen B has a customer with a code');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.referral_invite('phase-two-kitchen', (select v from vals where k = 'code_p1')) $$, '22023', 'feature_disabled',
  'the join page is off while the customer page is off');
reset role;
update public.platform_settings set enabled = true where key = 'customer_portal';

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
insert into inv select public.referral_invite('phase-two-kitchen', lower((select v from vals where k = 'code_p1'))) as v;
select is((select v ->> 'code_status' from inv), 'ok', 'a friend''s code opens that kitchen''s join page (any case)');
select is((select v -> 'kitchen' ->> 'name' from inv), 'Phase Two Kitchen', 'only that kitchen is shown');
select is((select jsonb_array_length(v -> 'plans') from inv), 1, 'with its plans');
select ok((select not (v::text ~ 'Saheed|Maa Tarini') from inv), 'no other kitchen appears');
select throws_ok($$ select public.referral_invite('phase-two-kitchen', (select v from vals where k = 'code_b')) $$, 'P0002', 'not_found',
  'a kitchen that is not listed stays hidden without one of its own codes');
select throws_ok($$ select public.referral_invite('no-such-kitchen', 'ABCDEFGH') $$, 'P0002', 'not_found', 'unknown kitchen');
reset role;
update public.kitchens set status = 'active' where id = '95000000-0000-4000-f000-000000000001';
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.referral_invite('phase-two-kitchen', (select v from vals where k = 'code_b')) ->> 'code_status', 'other_kitchen',
  'a code from another kitchen is named as such');
select is(public.referral_invite('phase-two-kitchen', (select v from vals where k = 'code_b')) -> 'plans', '[]'::jsonb,
  '...and shows no plans to join with');
select is(public.referral_invite('phase-two-kitchen', 'ZZZZZZZZ') ->> 'code_status', 'invalid', 'an unknown code');

-- Joining.
select throws_ok($$ select public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_b'), 'Friend', '+919555200001',
  '95100000-0000-4000-f000-000000000001', 'House 1, Patia', p_consent => true) $$, '22023', 'referral_other_kitchen',
  'joining with another kitchen''s code says so');
select throws_ok($$ select public.referral_join('phase-two-kitchen', 'ZZZZZZZZ', 'Friend', '+919555200001',
  '95100000-0000-4000-f000-000000000001', 'House 1, Patia', p_consent => true) $$, '22023', 'invalid_referral_code', 'unknown code');
select throws_ok($$ select public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Friend', '+919555200001',
  '95100000-0000-4000-f000-000000000001', 'House 1, Patia') $$, '22023', 'consent_required', 'consent is required');
select throws_ok($$ select public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Friend', '12345',
  '95100000-0000-4000-f000-000000000001', 'House 1, Patia', p_consent => true) $$, '22023', 'invalid_phone', 'phone checked');
select throws_ok($$ select public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Friend', '+919555200001',
  '20000000-0000-4000-a000-0000000000b1', 'House 1, Patia', p_consent => true) $$, '22023', 'no_plan', 'only this kitchen''s plans');
select throws_ok($$ select public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Friend', '+919555200001',
  '95100000-0000-4000-f000-000000000001', 'House 1, Patia', p_start_date => '2027-02-01', p_consent => true) $$, '22023', 'invalid_date',
  'start within 30 days');
select throws_ok($$ select public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), repeat('x', 81), '+919555200001',
  '95100000-0000-4000-f000-000000000001', 'House 1, Patia', p_consent => true) $$, '22023', 'invalid_name', 'name length checked');
select is(public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Friend One', '+919555200001',
  '95100000-0000-4000-f000-000000000001', 'House 1, Patia', 'Patia', 'Near temple', p_consent => true),
  '{"ok": true, "kitchen_name": "Phase Two Kitchen", "trial_meals": 2}'::jsonb, 'a friend joins');
reset role;
insert into ids select 'f1', id from public.customers where kitchen_id = '95000000-0000-4000-f000-000000000001' and name = 'Friend One';
select is((select source::text || '/' || platform_sourced::text || '/' || whatsapp_opt_in::text from public.customers where id = (select v from ids where k = 'f1')),
  'web/false/false', 'as the kitchen''s own customer (not platform-sourced, no commission), WhatsApp off');
select is((select status::text || '/' || start_date::text from public.subscriptions where customer_id = (select v from ids where k = 'f1')),
  'trial/2026-11-17', 'with a trial from tomorrow');
select is((select r.source || '/' || (r.referrer_customer_id = (select v from ids where k = 'p1'))::text from public.referrals r
           where r.referee_customer_id = (select v from ids where k = 'f1')), 'link/true', 'the referral is recorded');
select is((select count(*) from public.notifications_outbox where template = 'referral_customer'
           and recipient_id = 'f5000000-0000-4000-f000-000000000001'), 1::bigint, 'the owner is told');
select is((select line1 || '/' || landmark from public.addresses where customer_id = (select v from ids where k = 'f1')), 'House 1, Patia/Near temple',
  'with the address given');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Somebody', '+919555200001',
  '95100000-0000-4000-f000-000000000001', 'Elsewhere 9', p_consent => true),
  '{"ok": true, "kitchen_name": "Phase Two Kitchen", "trial_meals": 2}'::jsonb, 'the same number again gets the same answer...');
select is(public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Somebody', '+919555100002',
  '95100000-0000-4000-f000-000000000001', 'Elsewhere 9', p_consent => true) ->> 'ok', 'true',
  '...and so does an existing customer''s number (nothing to learn about who is a customer)');
reset role;
select is((select count(*) from public.customers where kitchen_id = '95000000-0000-4000-f000-000000000001'), 4::bigint,
  'no customer was added or changed by those');
select is((select name from public.customers where id = (select v from ids where k = 'p2')), 'Phase p2', 'the existing customer is untouched');
select is((select string_agg(payload ->> 'existing_name' || '<-' || (payload ->> 'customer_name'), ',' order by payload ->> 'existing_name')
           from public.notifications_outbox where template = 'referral_existing' and recipient_id = 'f5000000-0000-4000-f000-000000000001'),
  'Friend One<-Somebody,Phase p2<-Somebody', 'but the owner is told each time, to call them back (D-155)');

-- 5 attempts per code per day, whatever the number (3 used above).
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Friend ' || n, '+91955520000' || n,
  '95100000-0000-4000-f000-000000000001', 'House ' || n, p_consent => true, p_whatsapp_opt_in => true) from generate_series(2, 3) n;
select throws_ok($$ select public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Friend 6', '+919555200006',
  '95100000-0000-4000-f000-000000000001', 'House 6', p_consent => true) $$, '22023', 'too_many_requests', 'a sixth attempt on one code in a day is refused');
select throws_ok($$ select public.referral_join('phase-two-kitchen', (select v from vals where k = 'code_p1'), 'Somebody', '+919555100002',
  '95100000-0000-4000-f000-000000000001', 'House 6', p_consent => true) $$, '22023', 'too_many_requests',
  '...and so is an existing customer''s number: the limit tells nothing about who is a customer (D-155)');
reset role;
select is((select count(*) from public.referral_join_attempts where kitchen_id = '95000000-0000-4000-f000-000000000001'), 5::bigint,
  'refused attempts are not stored');
insert into ids select 'f2', id from public.customers where kitchen_id = '95000000-0000-4000-f000-000000000001' and name = 'Friend 2';
select is((select whatsapp_opt_in::text || '/' || (notes like '%Asked for WhatsApp updates%')::text from public.customers where id = (select v from ids where k = 'f2')),
  'false/true', 'a ticked WhatsApp box is passed on as a wish, not recorded as opt-in (the page cannot prove who holds the phone)');
select is((select count(*) from public.consents where customer_id = (select v from ids where k = 'f2') and purpose = 'whatsapp'), 0::bigint,
  'no WhatsApp consent row from the join page');
select is((select payload ->> 'whatsapp_requested' from public.notifications_outbox where dedupe_key like 'referral_customer:' || (select v from ids where k = 'f2') || ':%'),
  'true', 'the owner sees the wish');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.referral_join_attempts), 0::bigint, 'owners cannot read join attempts');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select is((select count(*) from public.referral_join_attempts where kitchen_id = '95000000-0000-4000-f000-000000000001'), 5::bigint,
  'the platform team can');
select throws_ok($$ insert into public.referral_join_attempts (kitchen_id, referrer_customer_id) values ('95000000-0000-4000-f000-000000000001', (select v from ids where k = 'p1')) $$,
  '42501', null, 'nobody writes join attempts directly');
reset role;

-- Customer page: card hidden at reward 0, kitchen-scoped link otherwise; other-kitchen codes named.
insert into vals values ('tok_p2', private.issue_magic_link((select v from ids where k = 'p2'), 7));
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.portal_get((select v from vals where k = 'tok_p2')) -> 'referral', 'null'::jsonb, 'no referral card while the reward is 0');
reset role;
update public.kitchen_settings set referral_reward_meals = 2 where kitchen_id = '95000000-0000-4000-f000-000000000001';
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.portal_get((select v from vals where k = 'tok_p2')) -> 'referral' ->> 'url',
  'http://localhost:3000/k/phase-two-kitchen/join?ref=' || (select v from vals where k = 'code_p2'),
  'the share link opens this kitchen''s join page');
select throws_ok($$ select public.portal_apply_referral((select v from vals where k = 'tok_p2'), (select v from vals where k = 'code_b')) $$,
  '22023', 'referral_other_kitchen', 'a code from another kitchen on the customer page says so');
select is(public.referral_invite('phase-two-kitchen', (select v from vals where k = 'code_p1')) ->> 'reward_meals', '2', 'the join page shows the reward');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.apply_referral_code((select v from ids where k = 'p3'), (select v from vals where k = 'code_b')) $$,
  '22023', 'referral_other_kitchen', 'and for the owner');
select is(public.referral_invite('phase-two-kitchen', (select v from vals where k = 'code_p1')) ->> 'code_status', 'ok', 'signed-in users can open it too');
reset role;

-- ===========================================================================
-- Item 3: AI budget
-- ===========================================================================
set local role service_role;
select is(public.wa_ai_take('95600000-0000-4000-f000-000000000001', 2, 3), true, 'first AI call of the day');
select is(public.wa_ai_take('95600000-0000-4000-f000-000000000001', 2, 3), true, 'second');
select is(public.wa_ai_take('95600000-0000-4000-f000-000000000001', 2, 3), false, 'the conversation cap stops the third');
select is(public.wa_ai_take('95600000-0000-4000-f000-000000000002', 2, 3), true, 'another conversation still can');
select is(public.wa_ai_take('95600000-0000-4000-f000-000000000002', 2, 3), false, 'until the platform''s daily cap');
select is(public.wa_ai_take('95600000-0000-4000-f000-000000000002', 0, 0), false, 'caps of 0 switch the model off');
select is(public.wa_ai_take(gen_random_uuid(), 2, 3), false, 'unknown conversation');
reset role;
select is((select sum(calls)::integer from public.ai_usage where day = '2026-11-16'), 3, 'three calls counted for the IST day');
select set_config('app.now', '2026-11-17 09:00:00+05:30', true);
set local role service_role;
select is(public.wa_ai_take('95600000-0000-4000-f000-000000000001', 2, 3), true, 'a new day, a new budget');
reset role;
select set_config('app.now', '2026-11-16 12:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.wa_ai_take('95600000-0000-4000-f000-000000000001', 9, 9) $$, '42501', null, 'owners cannot take AI budget');
select is((select count(*) from public.ai_usage), 0::bigint, 'owners cannot read AI usage');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select ok((select count(*) from public.ai_usage) >= 3, 'the platform team can read AI usage');
reset role;

-- ===========================================================================
-- Item 4: a payment link Razorpay never created is cancelled
-- ===========================================================================
insert into public.payments (id, kitchen_id, customer_id, method, status, amount_paise, meals) values
  ('95700000-0000-4000-f000-000000000001', '95000000-0000-4000-f000-000000000001', (select v from ids where k = 'p1'), 'razorpay_link', 'created', 70000, 10),
  ('95700000-0000-4000-f000-000000000002', '95000000-0000-4000-f000-000000000001', (select v from ids where k = 'p1'), 'razorpay_link', 'created', 70000, 10),
  ('95700000-0000-4000-f000-000000000003', '95000000-0000-4000-f000-000000000001', (select v from ids where k = 'p1'), 'cash', 'pending', 7000, 1);
update public.payments set razorpay_payment_link_id = 'plink_test_95_2', short_url = 'https://rzp.io/x' where id = '95700000-0000-4000-f000-000000000002';
set local role service_role;
select is(public.cancel_payment_link_record('95700000-0000-4000-f000-000000000001', 'gateway_error: 502'), true, 'the link failed: row cancelled');
select is(public.cancel_payment_link_record('95700000-0000-4000-f000-000000000001', 'again'), false, 'calling it twice changes nothing');
select is(public.cancel_payment_link_record('95700000-0000-4000-f000-000000000002', 'late'), false, 'a row that has its link is never cancelled');
select is(public.cancel_payment_link_record('95700000-0000-4000-f000-000000000003', 'x'), false, 'cash is never touched');
reset role;
select is((select status::text || '|' || note from public.payments where id = '95700000-0000-4000-f000-000000000001'),
  'failed|Payment link not created: gateway_error: 502', 'marked failed with the reason');
select is((select status::text from public.payments where id = '95700000-0000-4000-f000-000000000002'), 'created', 'the linked row stays open');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(public.portal_get((select v from vals where k = 'tok_p2')) -> 'payments', '[]'::jsonb, '(another customer''s page shows none of it)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.cancel_payment_link_record('95700000-0000-4000-f000-000000000002', 'x') $$, '42501', null,
  'owners cannot cancel links directly');
reset role;

-- ===========================================================================
-- Item 6: Google Ads mock conversions
-- ===========================================================================
insert into public.leads (id, source, gclid) values
  ('95800000-0000-4000-f000-000000000001', 'google_ads', 'gclid-phase2-0001'),
  ('95800000-0000-4000-f000-000000000002', 'google_ads', 'gclid-phase2-0002');
insert into public.ad_conversions (id, lead_id, gclid, stage, value_paise, occurred_at) values
  ('95900000-0000-4000-f000-000000000001', '95800000-0000-4000-f000-000000000001', 'gclid-phase2-0001', 'trial', 14000, '2026-11-15 10:00:00+05:30'),
  ('95900000-0000-4000-f000-000000000002', '95800000-0000-4000-f000-000000000002', 'gclid-phase2-0002', 'trial', 14000, '2026-11-15 11:00:00+05:30');
update public.ad_conversions set status = 'sent' where status = 'pending' and id::text not like '95900000-%';
set local role service_role;
select is((select count(*) from public.ads_claim_conversions(10)), 2::bigint, 'pending conversions are claimed');
select public.ads_complete_conversion(id, false, null, false, true) from public.ad_conversions where id::text like '95900000-%';
reset role;
select is((select string_agg(status || '/' || attempts || '/' || coalesce(sent_at::text, 'never'), ',' order by id) from public.ad_conversions
           where id::text like '95900000-%'), 'mock/0/never,mock/0/never', 'in mock mode they are marked mock, not sent');
set local role service_role;
select is((select count(*) from public.ads_claim_conversions(10)), 0::bigint, 'the mock uploader does not claim them again');
insert into live_claim select * from public.ads_claim_conversions(1, true);
select is((select attempts from live_claim), 1, 'the live uploader claims mock rows, attempts from zero');
select public.ads_complete_conversion(id, true) from live_claim;
reset role;
select is((select count(*) from public.ad_conversions where id::text like '95900000-%' and status = 'sent' and sent_at is not null), 1::bigint,
  'and marks them sent once uploaded');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_requeue_mock_conversions() $$, '42501', 'forbidden', 'owners cannot requeue');
select throws_ok($$ select public.ads_claim_conversions(10) $$, '42501', null, 'users cannot claim uploads');
reset role;
-- A row with no conversion action id for its stage (usual before go-live) is not lost (D-155).
insert into public.leads (id, source, gclid) values ('95800000-0000-4000-f000-000000000003', 'google_ads', 'gclid-phase2-0003');
insert into public.ad_conversions (id, lead_id, gclid, stage, value_paise, occurred_at, status, last_error) values
  ('95900000-0000-4000-f000-000000000003', '95800000-0000-4000-f000-000000000003', 'gclid-phase2-0003', 'renewal', 14000,
   '2026-11-15 12:00:00+05:30', 'skipped', 'no conversion action for renewal');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select is(public.admin_requeue_mock_conversions(), 2, 'the platform team requeues mock and skipped rows after going live');
reset role;
select is((select count(*) from public.ad_conversions where id::text like '95900000-%' and status = 'pending' and attempts = 0), 2::bigint, 'back to pending');

-- ===========================================================================
-- Item 7: escalated complaints
-- ===========================================================================
insert into public.complaints (id, kitchen_id, customer_id, conversation_id, category, description, channel, status, escalated_at, created_at)
values ('95a00000-0000-4000-f000-000000000001', '95000000-0000-4000-f000-000000000001', (select v from ids where k = 'p1'),
        '95600000-0000-4000-f000-000000000001', 'quality', 'Rice was cold', 'whatsapp', 'escalated',
        '2026-11-16 10:15:00+05:30', '2026-11-16 08:00:00+05:30');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
insert into q select public.admin_escalations();
select is((select jsonb_array_length(v -> 'complaints') from q), 1, 'the escalation queue lists the complaint');
select is((select v -> 'complaints' -> 0 -> 'kitchen' ->> 'name' from q), 'Phase Two Kitchen', 'with the kitchen');
select is((select v -> 'complaints' -> 0 -> 'customer' ->> 'phone_masked' from q), '+91 ••••••0001',
  'and the customer, phone masked');
select ok((select v -> 'complaints' -> 0 -> 'kitchen' ->> 'owner_phone_masked' from q) !~ '919555000001', 'the owner''s phone is masked too');
select is((select jsonb_array_length(v -> 'team') from q), 2, 'the team to hand it to');
select is(public.admin_reveal_complaint_phone('95a00000-0000-4000-f000-000000000001', 'customer'), '+919555100001', 'reveal the customer''s number');
select is(public.admin_reveal_complaint_phone('95a00000-0000-4000-f000-000000000001', 'owner'), '+919555000001', 'reveal the owner''s number');
select throws_ok($$ select public.admin_reveal_complaint_phone('95a00000-0000-4000-f000-000000000001', 'rider') $$, '22023', 'invalid_input', 'only those two');
select is(public.admin_assign_complaint('95a00000-0000-4000-f000-000000000001') ->> 'assigned_to', '00000000-0000-4000-a000-000000000099', 'take it');
select is(public.admin_assign_complaint('95a00000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000009', 'Odia speaker')
  ->> 'name', 'Second Admin', 'hand it to another team member');
select throws_ok($$ select public.admin_assign_complaint('95a00000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000001') $$,
  '22023', 'invalid_admin', 'only to the platform team');
select lives_ok($$ select public.admin_note_complaint('95a00000-0000-4000-f000-000000000001', 'Called the kitchen, no answer') $$, 'a team note');
select throws_ok($$ select public.admin_note_complaint('95a00000-0000-4000-f000-000000000001', '  ') $$, '22023', 'note_required', 'notes need text');
insert into det select public.admin_complaint_detail('95a00000-0000-4000-f000-000000000001');
select is((select jsonb_array_length(v -> 'events') from det), 5, 'the detail shows the team log (2 reveals, 2 assigns, 1 note)');
select ok((select jsonb_array_length(v -> 'messages') from det) >= 1, 'and the conversation');
select is((select v -> 'customer' ->> 'name' from det), 'Phase p1', 'and the customer');
select lives_ok($$ select public.admin_resolve_complaint('95a00000-0000-4000-f000-000000000001', 'Kitchen will replace the meal tomorrow') $$,
  'the team resolves it');
select throws_ok($$ select public.admin_resolve_complaint('95a00000-0000-4000-f000-000000000001', 'again') $$, '22023', 'not_pending', 'once');
select throws_ok($$ select public.admin_assign_complaint('95a00000-0000-4000-f000-000000000001') $$, '22023', 'not_pending',
  'a resolved complaint is not reassigned');
select is(jsonb_array_length(public.admin_escalations() -> 'complaints'), 0, 'the queue is empty');
select is(jsonb_array_length(public.admin_escalations('resolved') -> 'complaints'), 1, 'it is in the resolved list');
select throws_ok($$ select public.admin_escalations('nope') $$, '22023', 'invalid_status', 'status checked');
reset role;
select is((select status || '/' || (resolved_by = '00000000-0000-4000-a000-000000000099')::text || '/' || resolution_note from public.complaints
           where id = '95a00000-0000-4000-f000-000000000001'), 'resolved/true/Kitchen will replace the meal tomorrow', 'resolved by the team, with the note');
select is((select count(*) from public.balance_entries where ref_type = 'complaint' and ref_id = '95a00000-0000-4000-f000-000000000001'), 0::bigint,
  'the team never credits the kitchen''s meals');
select is((select count(*) from public.audit_log where action = 'ACCESS' and row_id in ((select v from ids where k = 'p1')::text, '95000000-0000-4000-f000-000000000001')
           and after ->> 'reason' = 'admin_complaint'), 2::bigint, 'both reveals are in the audit log');
select throws_ok($$ update public.complaint_admin_events set note = 'x' $$, 'P0001', null, 'the team log cannot be edited');
select set_config('tiffin.audit_scrub', 'on', true);
select throws_ok($$ update public.complaint_admin_events set note = 'x' $$, 'P0001', null,
  'not even in scrub mode, except blanking a note');
select set_config('tiffin.audit_scrub', '', true);

-- Nobody else sees the queue or the log.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_escalations() $$, '42501', 'forbidden', 'the owner cannot open the queue');
select throws_ok($$ select public.admin_reveal_complaint_phone('95a00000-0000-4000-f000-000000000001', 'customer') $$, '42501', 'forbidden',
  'the owner cannot use the team reveal');
select is((select count(*) from public.complaint_admin_events), 0::bigint, 'the owner cannot read the team log');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.admin_complaint_detail('95a00000-0000-4000-f000-000000000001') $$, '42501', 'forbidden', 'staff cannot');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.admin_resolve_complaint('95a00000-0000-4000-f000-000000000001', 'x') $$, '42501', 'forbidden', 'riders cannot');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.admin_assign_complaint('95a00000-0000-4000-f000-000000000001') $$, '42501', 'forbidden',
  'another kitchen''s owner cannot');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.admin_escalations() $$, '42501', null, 'anon cannot');
reset role;

-- Erasing the customer blanks the team's notes on their complaints; the log rows stay (D-155).
update public.customers set deleted_at = private.now() where id = (select v from ids where k = 'p1');
select is((select count(*) || '/' || count(note) from public.complaint_admin_events where complaint_id = '95a00000-0000-4000-f000-000000000001'),
  '6/0', 'an erased customer''s complaint keeps its team log, without the notes');

select * from finish();
rollback;
