-- Vendor-first wave 1 (docs/VENDOR_FIRST_AUDIT.md items 7, 8, 11, 12, 14-19; D-116):
-- safe defaults, rider otp_sent, vendor changes on the real cutoff, skip after lock with
-- "don't charge", changes after lock reaching runs (planned and out, office stops, changed flag),
-- the lock job's per-kitchen errors / 7-day catch-up / engine_errors, cancel charging only its own
-- meals, address fixes, undo (revoke) and bounded resume, reactivation, closures and weekly off
-- per meal. Roles: owner, staff, rider, another kitchen's owner, admin, anon.
-- Calendar: Mon 9 Nov 2026. Lunch cutoff 21:00 the day before, dinner cutoff 12:00 the same day.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup. Kitchen V (owner, staff, rider): 14 lunch + dinner customers. K2 (engine failures),
-- K3 (outage), K4 (cancel during an outage). Same owner; V's staff is also K2 staff.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(), now(), now()
from (values
  ('f4000000-0000-4000-f000-000000000001'::uuid, '919666000001'),
  ('f4000000-0000-4000-f000-000000000002'::uuid, '919666000002'),
  ('f4000000-0000-4000-f000-000000000003'::uuid, '919666000003')
) as u(id, phone);
insert into public.kitchens (id, name, slug, owner_id, lat, lng, weekly_off) values
  ('84000000-0000-4000-f000-000000000001', 'Wave Kitchen', 'wave-kitchen', 'f4000000-0000-4000-f000-000000000001', 20.3553, 85.8197, '{7}'),
  ('84000000-0000-4000-f000-000000000002', 'Wave Two', 'wave-two', 'f4000000-0000-4000-f000-000000000001', 20.3553, 85.8197, '{7}'),
  ('84000000-0000-4000-f000-000000000003', 'Wave Three', 'wave-three', 'f4000000-0000-4000-f000-000000000001', 20.3553, 85.8197, '{7}'),
  ('84000000-0000-4000-f000-000000000004', 'Wave Four', 'wave-four', 'f4000000-0000-4000-f000-000000000001', 20.3553, 85.8197, '{7}');
-- Prepaid billing (the balance rules this suite was written for, D-115) and customer WhatsApp
-- switched on (the Phase 2 outbox gate, item 13), as in 04_money and 11_p5.
insert into public.kitchen_settings (kitchen_id, credit_limit_meals, default_billing_mode)
select id, 10, 'prepaid' from public.kitchens where id::text like '84000000-%';
update public.platform_settings set enabled = true where key = 'customer_whatsapp';
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('84000000-0000-4000-f000-000000000001', 'f4000000-0000-4000-f000-000000000001', 'owner', 'Owner V'),
  ('84000000-0000-4000-f000-000000000001', 'f4000000-0000-4000-f000-000000000002', 'staff', 'Staff V'),
  ('84000000-0000-4000-f000-000000000001', 'f4000000-0000-4000-f000-000000000003', 'rider', 'Rider V'),
  ('84000000-0000-4000-f000-000000000002', 'f4000000-0000-4000-f000-000000000001', 'owner', 'Owner V'),
  ('84000000-0000-4000-f000-000000000002', 'f4000000-0000-4000-f000-000000000002', 'staff', 'Staff V'),
  ('84000000-0000-4000-f000-000000000003', 'f4000000-0000-4000-f000-000000000001', 'owner', 'Owner V'),
  ('84000000-0000-4000-f000-000000000004', 'f4000000-0000-4000-f000-000000000001', 'owner', 'Owner V');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('85000000-0000-4000-f000-000000000001', '84000000-0000-4000-f000-000000000001', 'Both', '{lunch,dinner}', '{1,2,3,4,5,6}', 6000),
  ('85000000-0000-4000-f000-000000000002', '84000000-0000-4000-f000-000000000002', 'Both', '{lunch,dinner}', '{1,2,3,4,5,6}', 6000),
  ('85000000-0000-4000-f000-000000000003', '84000000-0000-4000-f000-000000000003', 'Both', '{lunch,dinner}', '{1,2,3,4,5,6}', 6000),
  ('85000000-0000-4000-f000-000000000004', '84000000-0000-4000-f000-000000000004', 'Lunch', '{lunch}', '{1,2,3,4,5,6}', 7000);

select set_config('app.now', '2026-11-09 08:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
create temp table vals (k text primary key, v jsonb);
grant select, insert on ids, vals to authenticated, anon;

do $$
declare
  r record;
  i integer := 0;
  v_c uuid;
  v_s uuid;
begin
  for r in select * from (values
      ('c1', 1), ('c2', 1), ('c3', 1), ('c4', 1), ('c5', 1), ('c6', 1), ('c7', 1), ('c8', 1), ('c9', 1), ('c10', 1),
      ('c11', 1), ('c12', 1), ('cm', 1), ('ce', 1), ('k2c', 2), ('k3c', 3), ('d1', 4), ('d2', 4)) t(k, kn)
  loop
    i := i + 1;
    v_c := private.insert_customer(('84000000-0000-4000-f000-00000000000' || r.kn)::uuid, 'Wave ' || r.k,
      '+91966610' || lpad(i::text, 4, '0'), 'veg', 'en', null,
      case when r.k = 'c11' then null
           else jsonb_build_object('line1', 'Flat ' || r.k, 'area', 'Patia', 'lat', 20.3553 + i * 0.001, 'lng', 85.8197) end,
      'vendor', 'vendor');
    insert into ids values (r.k, v_c);
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values (('84000000-0000-4000-f000-00000000000' || r.kn)::uuid, v_c, ('85000000-0000-4000-f000-00000000000' || r.kn)::uuid,
            case when r.k = 'c12' then null else (select id from public.addresses where customer_id = v_c) end,
            '2026-11-09', 'active')
    returning id into v_s;
    insert into ids values ('s_' || r.k, v_s);
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
    values (('84000000-0000-4000-f000-00000000000' || r.kn)::uuid, v_c, 'adjust', 40, 240000, 'Opening balance (test)');
  end loop;
end $$;

-- Office: billed to cm, delivered to cm's own address; cm is not an office member, ce is.
insert into public.offices (id, kitchen_id, name, billing_customer_id, address_id)
values ('86000000-0000-4000-f000-000000000001', '84000000-0000-4000-f000-000000000001', 'Infy Tower',
        (select v from ids where k = 'cm'), (select id from public.addresses where customer_id = (select v from ids where k = 'cm')));
update public.customers set office_id = '86000000-0000-4000-f000-000000000001' where id = (select v from ids where k = 'ce');

-- ===========================================================================
-- Item 7: safe defaults
-- ===========================================================================
insert into public.kitchens (id, name, slug, owner_id) values
  ('84000000-0000-4000-f000-000000000009', 'Fresh Kitchen', 'fresh-kitchen', 'f4000000-0000-4000-f000-000000000001');
insert into public.kitchen_settings (kitchen_id) values ('84000000-0000-4000-f000-000000000009');
select is((select accepts_platform_leads from public.kitchens where id = '84000000-0000-4000-f000-000000000009'), false,
  'a new kitchen does not take marketplace leads until it opts in');
select is((select auto_credit_first_complaint from public.kitchen_settings where kitchen_id = '84000000-0000-4000-f000-000000000009'), false,
  'a new kitchen does not give a free meal for the first complaint until it opts in');

-- ===========================================================================
-- Item 14: addresses
-- ===========================================================================
select is((select address_id from public.subscriptions where id = (select v from ids where k = 's_c12')),
  (select id from public.addresses where customer_id = (select v from ids where k = 'c12')),
  'a subscription added without an address takes the customer''s default address');
select is((select count(*) from public.meal_orders where subscription_id = (select v from ids where k = 's_c11') and address_id is null),
  11::bigint, 'a customer with no address yet: meals have no address');
insert into public.addresses (kitchen_id, customer_id, line1, area, lat, lng)
values ('84000000-0000-4000-f000-000000000001', (select v from ids where k = 'c11'), 'Flat c11', 'Patia', 20.37, 85.82);
select is((select address_id from public.subscriptions where id = (select v from ids where k = 's_c11')),
  (select id from public.addresses where customer_id = (select v from ids where k = 'c11')),
  'the first address fills the subscription');
select is((select count(*) from public.meal_orders where subscription_id = (select v from ids where k = 's_c11') and address_id is null),
  0::bigint, 'and every meal');

-- A permanent move dated Friday leaves Tue–Thu on the old flat (audit test run, step 18).
insert into public.addresses (kitchen_id, customer_id, line1, area, is_default)
values ('84000000-0000-4000-f000-000000000001', (select v from ids where k = 'c2'), 'New flat c2', 'Patia', false);
insert into ids select 'c2_new', id from public.addresses where line1 = 'New flat c2';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
insert into vals select 'c2_move', public.request_schedule_change((select v from ids where k = 's_c2'), 'address', '2026-11-13',
  p_address => (select v from ids where k = 'c2_new'), p_dry_run => true);
select is((select min(a ->> 'date') from vals, jsonb_array_elements(v -> 'affected') a where k = 'c2_move'), '2026-11-13',
  'the preview of a move dated Friday lists Friday onwards only');
select lives_ok($$ select public.request_schedule_change((select v from ids where k = 's_c2'), 'address', '2026-11-13',
  p_address => (select v from ids where k = 'c2_new')) $$, 'owner records the dated move');
reset role;
select is((select string_agg(o.service_date || ':' || a.line1, ',' order by o.service_date)
           from public.meal_orders o join public.addresses a on a.id = o.address_id
           where o.subscription_id = (select v from ids where k = 's_c2') and o.slot = 'lunch'),
  '2026-11-10:Flat c2,2026-11-11:Flat c2,2026-11-12:Flat c2,2026-11-13:New flat c2,2026-11-14:New flat c2',
  'meals before the move stay on the old flat, from Friday on the new one');
select isnt((select address_id from public.subscriptions where id = (select v from ids where k = 's_c2')),
  (select v from ids where k = 'c2_new'), 'the subscription keeps the old address until the move starts');

-- "Make default" and apply it to the subscriptions.
insert into public.addresses (kitchen_id, customer_id, line1, area, is_default)
values ('84000000-0000-4000-f000-000000000001', (select v from ids where k = 'c3'), 'Office c3', 'Infocity', false);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.set_default_address((select id from public.addresses where line1 = 'Office c3'), true) $$,
  '42501', 'forbidden', 'staff cannot change default addresses');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((public.set_default_address((select id from public.addresses where line1 = 'Office c3'), true) ->> 'subscriptions_moved')::integer, 1,
  'owner makes the office the default and moves the subscription');
reset role;
select is((select a.line1 from public.meal_orders o join public.addresses a on a.id = o.address_id
           where o.subscription_id = (select v from ids where k = 's_c3') and o.service_date = '2026-11-10' and o.slot = 'lunch'),
  'Office c3', 'future meals go to the new default');
select is((select is_default from public.addresses where line1 = 'Office c3'), true, 'and it is the default');

-- ===========================================================================
-- Item 15: undo one skip or pause; resume honours its end date
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
insert into vals select 'p4', public.request_schedule_change((select v from ids where k = 's_c4'), 'pause', '2026-11-20', '2026-12-05');
insert into vals select 'p5', public.request_schedule_change((select v from ids where k = 's_c5'), 'pause', '2026-11-20', '2026-12-05');
insert into vals select 'p6', public.request_schedule_change((select v from ids where k = 's_c6'), 'pause', '2026-11-12', '2026-11-13');
insert into vals select 'k6', public.request_schedule_change((select v from ids where k = 's_c6'), 'skip', '2026-11-14');
insert into vals select 'p7', public.request_schedule_change((select v from ids where k = 's_c7'), 'pause', '2026-11-10');
-- A resume ends holds requested before it (one simulated minute later here).
select set_config('app.now', '2026-11-09 08:01:00+05:30', true);
insert into vals select 'r7', public.request_schedule_change((select v from ids where k = 's_c7'), 'resume', '2026-11-11', '2026-11-11');
select is((select count(*) from public.subscription_holds((select v from ids where k = 's_c6'))), 2::bigint,
  'the upcoming list shows the pause and the skip');
select is(jsonb_array_length(public.revoke_schedule_change((select (v ->> 'change_id')::uuid from vals where k = 'k6'), p_dry_run => true) -> 'affected'),
  2, 'preview: undoing Saturday''s skip brings back 2 meals');
select lives_ok($$ select public.revoke_schedule_change((select (v ->> 'change_id')::uuid from vals where k = 'k6'), 'Customer changed plans') $$,
  'owner undoes the skip');
select lives_ok($$ select public.revoke_schedule_change((select (v ->> 'change_id')::uuid from vals where k = 'p4')) $$,
  'owner undoes the pause from 20 Nov to 5 Dec, recorded earlier');
select throws_ok($$ select public.revoke_schedule_change((select (v ->> 'change_id')::uuid from vals where k = 'p4')) $$,
  '22023', 'already_revoked', 'a change can be undone only once');
select throws_ok($$ select public.revoke_schedule_change((select (v ->> 'change_id')::uuid from vals where k = 'r7')) $$,
  '22023', 'cannot_revoke', 'only skips and pauses can be undone');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.subscription_holds((select v from ids where k = 's_c6'))), 1::bigint,
  'staff can read the upcoming list (the undone skip is gone)');
select throws_ok($$ select public.revoke_schedule_change((select (v ->> 'change_id')::uuid from vals where k = 'p6')) $$,
  '42501', 'forbidden', 'staff cannot undo changes');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok($$ select public.revoke_schedule_change((select (v ->> 'change_id')::uuid from vals where k = 'p6')) $$,
  '42501', 'forbidden', 'another kitchen cannot undo changes');
select throws_ok($$ select public.subscription_holds((select v from ids where k = 's_c6')) $$,
  '42501', 'forbidden', 'another kitchen cannot read the upcoming list');
reset role;
select is((select string_agg(service_date || ':' || status, ',' order by service_date) from public.meal_orders
           where subscription_id = (select v from ids where k = 's_c6') and slot = 'lunch' and service_date >= '2026-11-12'),
  '2026-11-12:skipped,2026-11-13:skipped,2026-11-14:scheduled', 'undoing the skip leaves the other pause in place');
select is((select string_agg(service_date || ':' || status, ',' order by service_date) from public.meal_orders
           where subscription_id = (select v from ids where k = 's_c7') and slot = 'lunch' and service_date between '2026-11-10' and '2026-11-12'),
  '2026-11-10:skipped,2026-11-11:scheduled,2026-11-12:skipped', 'a resume with an end date brings back only those days');
select is((select type::text from public.schedule_changes where revokes_change_id = (select (v ->> 'change_id')::uuid from vals where k = 'k6')),
  'revoke', 'the undo is its own row in the change log');

-- ===========================================================================
-- Item 16: reactivate a cancelled subscription
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.request_schedule_change((select v from ids where k = 's_c8'), 'cancel', '2026-11-09') $$,
  'owner cancels c8 from today');
select throws_ok($$ select public.reactivate_subscription((select v from ids where k = 's_c9')) $$, '22023', 'not_cancelled',
  'only a cancelled subscription can be reactivated');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.reactivate_subscription((select v from ids where k = 's_c8')) $$, '42501', 'forbidden',
  'staff cannot reactivate');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
-- The cancellation refunded the unused meals, so the balance is 0: low balance (limit 10 meals).
select is(public.reactivate_subscription((select v from ids where k = 's_c8')) ->> 'status', 'low_balance',
  'owner reactivates c8; the result reports the balance state');
reset role;
select is((select count(*) from public.meal_orders where subscription_id = (select v from ids where k = 's_c8')
           and service_date = '2026-11-10'), 2::bigint, 'meals are generated again');
select ok(exists (select 1 from public.subscription_events where subscription_id = (select v from ids where k = 's_c8')
                  and from_status = 'cancelled' and to_status = 'active' and reason = 'reactivated'), 'the reactivation is logged');

-- ===========================================================================
-- Item 17: closures and weekly off per meal
-- ===========================================================================
insert into vals select 'thu_before', to_jsonb((select count(*) from public.meal_orders
  where kitchen_id = '84000000-0000-4000-f000-000000000001' and service_date = '2026-11-12'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.set_kitchen_closure('84000000-0000-4000-f000-000000000001', '2026-11-12') $$,
  '42501', 'forbidden', 'staff cannot close the kitchen');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select ok((public.set_kitchen_closure('84000000-0000-4000-f000-000000000001', '2026-11-12', null, 'Diwali', true) ->> 'meals')::integer > 0,
  'preview counts the meals a closure removes');
select lives_ok($$ select public.set_kitchen_closure('84000000-0000-4000-f000-000000000001', '2026-11-12', null, 'Diwali') $$,
  'owner closes Thursday');
select is((select count(*) from public.meal_orders where kitchen_id = '84000000-0000-4000-f000-000000000001'
           and service_date = '2026-11-12'), 0::bigint, 'a closed day has no meals');
select lives_ok($$ select public.remove_kitchen_closure('84000000-0000-4000-f000-000000000001', '2026-11-12') $$,
  'owner reopens Thursday');
select is((select count(*) from public.meal_orders where kitchen_id = '84000000-0000-4000-f000-000000000001'
           and service_date = '2026-11-12'), (select (v #>> '{}')::bigint from vals where k = 'thu_before'),
  'reopening brings every meal back');
select lives_ok($$ select public.set_kitchen_closure('84000000-0000-4000-f000-000000000001', '2026-11-11', 'dinner', 'Rath Yatra') $$,
  'owner closes Wednesday dinner only');
select throws_ok($$ select public.set_kitchen_closure('84000000-0000-4000-f000-000000000001', '2026-11-09', 'lunch') $$,
  '22023', 'slot_locked', 'a meal past its cutoff cannot be closed');
select throws_ok($$ select public.remove_kitchen_closure('84000000-0000-4000-f000-000000000001', '2026-11-12') $$,
  'P0002', 'not_found', 'removing a closure that is not there');
update public.kitchens set weekly_off_dinner = '{6}' where id = '84000000-0000-4000-f000-000000000001';
select is((public.slot_summary('84000000-0000-4000-f000-000000000001', '2026-11-11', 'dinner') ->> 'closure_reason'), 'Rath Yatra',
  'the slot summary shows the closure');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.kitchen_closures where kitchen_id = '84000000-0000-4000-f000-000000000001'), 1::bigint,
  'staff can see the closures');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select is((select count(*) from public.kitchen_closures where kitchen_id = '84000000-0000-4000-f000-000000000001'), 0::bigint,
  'another kitchen cannot');
select throws_ok($$ select public.set_kitchen_closure('84000000-0000-4000-f000-000000000001', '2026-11-13') $$,
  '42501', 'forbidden', 'or close it');
reset role;
set local role anon;
select throws_ok($$ select count(*) from public.kitchen_closures $$, '42501', null, 'anon cannot read closures');
reset role;
select is((select string_agg(slot::text || ':' || count, ',' order by slot) from (
             select slot, count(*) from public.meal_orders
             where kitchen_id = '84000000-0000-4000-f000-000000000001' and service_date = '2026-11-11' group by slot) x),
  'lunch:14', 'Wednesday: lunch for everyone, no dinner');
select is((select count(*) from public.meal_orders where kitchen_id = '84000000-0000-4000-f000-000000000001'
           and service_date = '2026-11-14' and slot = 'dinner'), 0::bigint, 'weekly off for one meal: no Saturday dinner');
select ok((select count(*) from public.meal_orders where kitchen_id = '84000000-0000-4000-f000-000000000001'
           and service_date = '2026-11-14' and slot = 'lunch') > 0, 'Saturday lunch stays');

-- ===========================================================================
-- Item 11: vendor-entered changes use the slot's real cutoff
-- ===========================================================================
select set_config('app.now', '2026-11-09 09:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((public.request_schedule_change((select v from ids where k = 's_c1'), 'skip', '2026-11-09', p_slot => 'dinner', p_dry_run => true)
           -> 'affected' -> 0 ->> 'charged')::boolean, false, 'a 09:00 phone skip of tonight''s dinner (cutoff 12:00) is free');
select lives_ok($$ select public.request_schedule_change((select v from ids where k = 's_c1'), 'skip', '2026-11-09', p_slot => 'dinner') $$,
  'owner records it');
select set_config('app.now', '2026-11-09 12:01:00+05:30', true);
select is((public.request_schedule_change((select v from ids where k = 's_c9'), 'skip', '2026-11-09', p_slot => 'dinner', p_dry_run => true)
           -> 'affected' -> 0 ->> 'charged')::boolean, true, 'at 12:01 the same skip is late and charged');
select lives_ok($$ select public.request_schedule_change((select v from ids where k = 's_c9'), 'skip', '2026-11-09', p_slot => 'dinner') $$,
  'owner records the late skip');
reset role;
select is((select status::text || '/' || charged::text from public.meal_orders where subscription_id = (select v from ids where k = 's_c1')
           and service_date = '2026-11-09' and slot = 'dinner'), 'skipped/false', 'the 09:00 skip is not charged');
select is((select status::text || '/' || charged::text from public.meal_orders where subscription_id = (select v from ids where k = 's_c9')
           and service_date = '2026-11-09' and slot = 'dinner'), 'skipped/true', 'the 12:01 skip is charged');
select ok(private.run_due_locks() >= 2, 'the lock job locks Monday lunch and dinner');
select set_config('app.now', '2026-11-09 20:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((public.request_schedule_change((select v from ids where k = 's_c10'), 'skip', '2026-11-10', p_slot => 'lunch')
           ->> 'after_cutoff')::boolean, false, 'a lunch skip at 20:00 the evening before is on time (cutoff 21:00)');
reset role;

-- ===========================================================================
-- Tuesday lunch locks: runs are built (office stop included)
-- ===========================================================================
select set_config('app.now', '2026-11-09 21:00:30+05:30', true);
select private.run_due_locks();
insert into ids select 'run_tue', id from public.delivery_runs
where kitchen_id = '84000000-0000-4000-f000-000000000001' and service_date = '2026-11-10' and slot = 'lunch';
select is((select count(*) from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000001'), 0::bigint,
  'no engine errors for kitchen V');
select is((select meal_count::integer || '/' || (office_id is not null)::text from public.delivery_stops
           where run_id = (select v from ids where k = 'run_tue') and customer_id = (select v from ids where k = 'cm')),
  '2/true', 'office: the billing customer''s own meal and the member''s meal share one stop (no double hit)');
select is((select rider_id from public.delivery_runs where id = (select v from ids where k = 'run_tue')),
  'f4000000-0000-4000-f000-000000000003'::uuid, 'the run belongs to the kitchen''s rider');

-- ===========================================================================
-- Item 19: skip a locked meal, charge or don't charge
-- ===========================================================================
select set_config('app.now', '2026-11-09 21:30:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
insert into vals select 'w1_preview', public.request_schedule_change((select v from ids where k = 's_c1'), 'skip', '2026-11-10',
  p_slot => 'lunch', p_waive_late => true, p_dry_run => true);
select is((select (v -> 'affected' -> 0 ->> 'charged') || '/' || (v -> 'affected' -> 0 ->> 'credited') from vals where k = 'w1_preview'),
  'false/true', 'preview: a skip after the lock with "don''t charge" is credited');
select lives_ok($$ select public.request_schedule_change((select v from ids where k = 's_c1'), 'skip', '2026-11-10',
  p_slot => 'lunch', p_waive_late => true) $$, 'owner skips c1''s locked lunch, don''t charge');
select lives_ok($$ select public.request_schedule_change((select v from ids where k = 's_c1'), 'skip', '2026-11-10',
  p_slot => 'lunch', p_waive_late => true) $$, 'a retry is harmless');
select lives_ok($$ select public.request_schedule_change((select v from ids where k = 's_c2'), 'skip', '2026-11-10', p_slot => 'lunch') $$,
  'owner skips c2''s locked lunch, charged');
select lives_ok($$ select public.request_schedule_change((select v from ids where k = 's_c2'), 'skip', '2026-11-10',
  p_slot => 'lunch', p_waive_late => true) $$, 'and then decides not to charge it after all');
reset role;
select is((select status::text || '/' || charged::text || '/' || charge_waived::text from public.meal_orders
           where subscription_id = (select v from ids where k = 's_c1') and service_date = '2026-11-10' and slot = 'lunch'),
  'skipped/true/true', 'the meal stays counted (it was cooked) and its charge is waived');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where b.ref_type = 'meal_order_waiver' and o.subscription_id = (select v from ids where k = 's_c1')), 1::bigint,
  '"don''t charge" posts exactly one credit, even on retry');
select is((select sum(b.meals)::integer from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where o.subscription_id = (select v from ids where k = 's_c1') and o.service_date = '2026-11-10' and o.slot = 'lunch'),
  0, 'the meal charge and its credit cancel out');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where b.ref_type = 'meal_order_waiver' and o.subscription_id = (select v from ids where k = 's_c2')), 1::bigint,
  'a charged late skip can be waived afterwards, once');
select is((select count(*) from public.delivery_stops where run_id = (select v from ids where k = 'run_tue')
           and customer_id in ((select v from ids where k = 'c1'), (select v from ids where k = 'c2'))), 0::bigint,
  'the skipped meals'' stops leave the run');

-- ===========================================================================
-- Item 18: a late address change reaches the planned run and is flagged for the rider
-- ===========================================================================
insert into public.addresses (kitchen_id, customer_id, line1, area, is_default)
values ('84000000-0000-4000-f000-000000000001', (select v from ids where k = 'c5'), 'Temp c5', 'Patia', false);
select private.apply_change((select v from ids where k = 's_c5'), 'address', '2026-11-10', '2026-11-10', 'lunch',
  (select id from public.addresses where line1 = 'Temp c5'), 'vendor', false, null, false, null);
select is((select a.line1 || '/' || (s.changed_at is not null)::text from public.delivery_stops s join public.addresses a on a.id = s.address_id
           where s.run_id = (select v from ids where k = 'run_tue') and s.customer_id = (select v from ids where k = 'c5')),
  'Temp c5/true', 'the stop moves to the new address and is marked changed');
select is((select count(*) from public.delivery_stops where run_id = (select v from ids where k = 'run_tue')
           and customer_id = (select v from ids where k = 'c5')), 1::bigint, 'the old stop is gone');

-- ===========================================================================
-- Rider: Tuesday morning (items 8 and 18)
-- ===========================================================================
select set_config('app.now', '2026-11-10 08:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
insert into vals select 'today1', public.rider_today();
select is((select s ->> 'changed' from vals, jsonb_array_elements(v) r, jsonb_array_elements(r -> 'stops') s
           where k = 'today1' and s ->> 'customer_id' = (select v::text from ids where k = 'c5')), 'true',
  'rider_today flags the changed stop');
select is((select s ->> 'changed' from vals, jsonb_array_elements(v) r, jsonb_array_elements(r -> 'stops') s
           where k = 'today1' and s ->> 'customer_id' = (select v::text from ids where k = 'c3')), 'false',
  'and not the others');
select lives_ok($$ select public.start_run((select v from ids where k = 'run_tue')) $$, 'the rider starts the run');
select is((select count(*) from vals, jsonb_array_elements(public.rider_today()) r, jsonb_array_elements(r -> 'stops') s
           where k = 'today1' and (s ->> 'otp_sent')::boolean), 0::bigint,
  'codes only queued (not sent) do not count as sent: otp_sent is false');
reset role;
select is((select count(*) from public.notifications_outbox where template = 'on_the_way' and status = 'pending'
           and recipient_id = (select v from ids where k = 'c3')), 1::bigint, 'the code message is pending');
update public.notifications_outbox set status = 'sent', sent_at = private.now()
where template = 'on_the_way' and recipient_id = (select v from ids where k = 'c3');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is((select s ->> 'otp_sent' from jsonb_array_elements(public.rider_today()) r, jsonb_array_elements(r -> 'stops') s
           where s ->> 'customer_id' = (select v::text from ids where k = 'c3')), 'true', 'once it is sent, otp_sent is true');
reset role;

-- Changes on a run that is already out: a late skip removes the pending stop; an address change
-- moves it (new stop with a delivery code and the customer's message).
select private.apply_change((select v from ids where k = 's_c6'), 'skip', '2026-11-10', null, 'lunch', null, 'vendor', false, null, false, null);
select is((select count(*) from public.delivery_stops where run_id = (select v from ids where k = 'run_tue')
           and customer_id = (select v from ids where k = 'c6')), 0::bigint, 'a late skip removes the pending stop from the out run');
insert into public.addresses (kitchen_id, customer_id, line1, area, is_default)
values ('84000000-0000-4000-f000-000000000001', (select v from ids where k = 'c12'), 'Office c12', 'Infocity', false);
select private.apply_change((select v from ids where k = 's_c12'), 'address', '2026-11-10', '2026-11-10', 'lunch',
  (select id from public.addresses where line1 = 'Office c12'), 'vendor', false, null, false, null);
select is((select a.line1 || '/' || s.status || '/' || (s.otp is not null)::text || '/' || (s.changed_at is not null)::text
           from public.delivery_stops s join public.addresses a on a.id = s.address_id
           where s.run_id = (select v from ids where k = 'run_tue') and s.customer_id = (select v from ids where k = 'c12')),
  'Office c12/pending/true/true', 'an address change on the out run: one new pending stop with a code, marked changed');
select is((select status::text from public.meal_orders where subscription_id = (select v from ids where k = 's_c12')
           and service_date = '2026-11-10' and slot = 'lunch'), 'out', 'its meal is out with the rider');
select is((select count(*) from public.notifications_outbox n join public.delivery_stops s on n.dedupe_key = 'on_the_way:' || s.id
           where s.run_id = (select v from ids where k = 'run_tue') and s.customer_id = (select v from ids where k = 'c12')), 1::bigint,
  'the customer gets the code message for the new stop');
select is((select count(*) from public.delivery_stops where run_id = (select v from ids where k = 'run_tue') and status = 'pending'), 8::bigint,
  'the other stops are untouched (c3, c4, c5, c8, c9, c11, c12 and the office)');

-- ===========================================================================
-- Item 12: lock job errors per kitchen, recorded failures, 7-day catch-up, cancel charging
-- ===========================================================================
create function public.test_boom() returns trigger language plpgsql as $$ begin raise exception 'test boom'; end $$;
-- Take the strongest lock first: the drop below then needs no upgrade, so a pg_cron job
-- touching this table waits for the rollback instead of deadlocking with the test.
lock table public.count_snapshots in access exclusive mode;
create trigger test_boom_lock before insert on public.count_snapshots
  for each row when (new.kitchen_id = '84000000-0000-4000-f000-000000000002') execute function public.test_boom();
select set_config('app.now', '2026-11-10 21:00:30+05:30', true);
select lives_ok($$ select private.run_due_locks() $$, 'the lock job survives a failing kitchen');
select ok(exists (select 1 from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000001'
                  and service_date = '2026-11-11' and slot = 'lunch'), 'the other kitchens still lock');
-- Its first due slot (Tuesday dinner) fails; its later slots wait for the next run, in order.
select is((select string_agg(job || '/' || service_date || '/' || slot || '/' || message || '/' || attempts, ',')
           from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000002' and resolved_at is null),
  'lock/2026-11-10/dinner/test boom/1', 'the failure is recorded once, for the first slot');
select private.run_due_locks();
select is((select attempts from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000002' and job = 'lock'
           and resolved_at is null), 2, 'a repeat bumps the same row');
drop trigger test_boom_lock on public.count_snapshots;
select private.run_due_locks();
select ok(exists (select 1 from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000002'
                  and service_date = '2026-11-11' and slot = 'lunch'), 'once fixed, the kitchen locks on the next run');
select is((select count(*) from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000002' and job = 'lock'
           and resolved_at is null), 0::bigint, 'and the error is resolved');

-- Run building fails: the lock still happens; the failure is recorded and shown on the slot.
-- Take the strongest lock first: the drop below then needs no upgrade, so a pg_cron job
-- touching this table waits for the rollback instead of deadlocking with the test.
lock table public.delivery_runs in access exclusive mode;
create trigger test_boom_runs before insert on public.delivery_runs
  for each row when (new.kitchen_id = '84000000-0000-4000-f000-000000000002') execute function public.test_boom();
select set_config('app.now', '2026-11-11 12:00:30+05:30', true);
select private.run_due_locks();
select ok(exists (select 1 from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000002'
                  and service_date = '2026-11-11' and slot = 'dinner'), 'a run-building failure never blocks the lock');
select is((select message from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000002' and job = 'build_runs'
           and service_date = '2026-11-11' and slot = 'dinner' and resolved_at is null), 'test boom', 'the run-building failure is recorded');
select is((select (totals ->> 'closed') || '/' || (totals ->> 'total_meals') from public.count_snapshots
           where kitchen_id = '84000000-0000-4000-f000-000000000001' and service_date = '2026-11-11' and slot = 'dinner'), 'true/0',
  'the closed Wednesday dinner locks empty');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where o.kitchen_id = '84000000-0000-4000-f000-000000000001' and o.service_date = '2026-11-11' and o.slot = 'dinner'),
  0::bigint, 'and charges nobody');
drop trigger test_boom_runs on public.delivery_runs;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((public.slot_summary('84000000-0000-4000-f000-000000000002', '2026-11-11', 'dinner') ->> 'engine_error'), 'test boom',
  'the slot summary shows the open error');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000002' and resolved_at is null),
  1::bigint, 'staff see their kitchen''s open errors');
select throws_ok($$ select public.dismiss_engine_error((select id from public.engine_errors where job = 'build_runs' and resolved_at is null)) $$,
  '42501', 'forbidden', 'staff cannot dismiss them');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000003","role":"authenticated"}', true);
select is((select count(*) from public.engine_errors), 0::bigint, 'riders see no engine errors');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select is((select count(*) from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000002'), 0::bigint,
  'another kitchen sees none');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select ok((select count(*) from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000002') >= 2,
  'the platform team sees them all');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select ok(public.plan_runs('84000000-0000-4000-f000-000000000002', '2026-11-11', 'dinner') >= 1, 'owner presses Plan / refresh runs');
select is((select count(*) from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000002' and resolved_at is null),
  0::bigint, 'which resolves the recorded failure');
select throws_ok($$ insert into public.engine_errors (kitchen_id, job, message) values ('84000000-0000-4000-f000-000000000002', 'lock', 'x') $$,
  '42501', null, 'nobody writes engine errors through the API');
reset role;
set local role anon;
select throws_ok($$ select count(*) from public.engine_errors $$, '42501', null, 'anon cannot read engine errors');
reset role;

-- Stock use fails at the lock: recorded, never blocks it.
insert into public.items (id, kitchen_id, name, unit) values ('87000000-0000-4000-f000-000000000001', '84000000-0000-4000-f000-000000000002', 'Rice', 'kg');
insert into public.dishes (id, kitchen_id, name) values ('88000000-0000-4000-f000-000000000001', '84000000-0000-4000-f000-000000000002', 'Rice');
insert into public.recipe_lines (kitchen_id, dish_id, item_id, qty_per_portion)
values ('84000000-0000-4000-f000-000000000002', '88000000-0000-4000-f000-000000000001', '87000000-0000-4000-f000-000000000001', 0.1);
insert into public.menus (kitchen_id, service_date, slot, dishes, published)
values ('84000000-0000-4000-f000-000000000002', '2026-11-12', 'lunch', '{Rice}', true);
-- Take the strongest lock first: the drop below then needs no upgrade, so a pg_cron job
-- touching this table waits for the rollback instead of deadlocking with the test.
lock table public.stock_moves in access exclusive mode;
create trigger test_boom_stock before insert on public.stock_moves
  for each row when (new.kitchen_id = '84000000-0000-4000-f000-000000000002') execute function public.test_boom();
select set_config('app.now', '2026-11-11 21:00:30+05:30', true);
select private.run_due_locks();
drop trigger test_boom_stock on public.stock_moves;
select ok(exists (select 1 from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000002'
                  and service_date = '2026-11-12' and slot = 'lunch'), 'a stock failure never blocks the lock');
select is((select job || '/' || message from public.engine_errors where kitchen_id = '84000000-0000-4000-f000-000000000002'
           and service_date = '2026-11-12' and slot = 'lunch' and resolved_at is null), 'consume/test boom', 'the stock failure is recorded');

-- Saturday 00:30: the dated move from Friday becomes c2's own address (item 14).
select set_config('app.now', '2026-11-14 00:30:00+05:30', true);
select private.nightly();
select is((select address_id from public.subscriptions where id = (select v from ids where k = 's_c2')),
  (select v from ids where k = 'c2_new'), 'once the move has started, it is the subscription''s address');
select is((select count(*) from public.engine_errors where job like 'nightly%' and resolved_at is null), 0::bigint,
  'the nightly job records no errors');

-- An outage from Wednesday night to Saturday night (no lock job ran). Cancelling d1 charges only
-- d1's own due meals, not the rest of the kitchen.
select set_config('app.now', '2026-11-14 22:00:00+05:30', true);
select private.apply_change((select v from ids where k = 's_d1'), 'cancel', '2026-11-14', null, null, null, 'vendor', false, null, false, null);
select is((select (locked_at is not null)::text || '/' || exists (select 1 from public.balance_entries b where b.type = 'meal' and b.ref_id = o.id)::text
           from public.meal_orders o where o.subscription_id = (select v from ids where k = 's_d1') and o.service_date = '2026-11-13'),
  'true/true', 'the cancelled customer''s due meal is frozen and charged');
select is((select (locked_at is null)::text || '/' || exists (select 1 from public.balance_entries b where b.type = 'meal' and b.ref_id = o.id)::text
           from public.meal_orders o where o.subscription_id = (select v from ids where k = 's_d2') and o.service_date = '2026-11-13'),
  'true/false', 'the other customer of that slot is not charged by the cancellation');
select is((select count(*) from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000004'
           and service_date = '2026-11-13'), 0::bigint, 'and the kitchen''s slot is not locked by it');

select is((select count(*) from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000003'
           and (service_date, slot) in (('2026-11-12', 'dinner'), ('2026-11-13', 'lunch'), ('2026-11-13', 'dinner'),
                                        ('2026-11-14', 'lunch'), ('2026-11-14', 'dinner'), ('2026-11-15', 'lunch'))), 0::bigint,
  'outage: six slots of K3 were never locked');
select private.run_due_locks();
select is((select count(*) from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000003'
           and (service_date, slot) in (('2026-11-12', 'dinner'), ('2026-11-13', 'lunch'), ('2026-11-13', 'dinner'),
                                        ('2026-11-14', 'lunch'), ('2026-11-14', 'dinner'), ('2026-11-15', 'lunch'))), 6::bigint,
  'the catch-up locks every missed slot, including Thursday dinner two days back');
select is((select count(*) from public.meal_orders o where o.kitchen_id = '84000000-0000-4000-f000-000000000003'
           and o.service_date between '2026-11-12' and '2026-11-14'
           and (select count(*) from public.balance_entries b where b.type = 'meal' and b.ref_id = o.id) = 1), 6::bigint,
  'each missed meal is charged exactly once');
insert into vals select 'k3_snaps', to_jsonb((select count(*) from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000003'));
select private.run_due_locks();
select is((select count(*) from public.count_snapshots where kitchen_id = '84000000-0000-4000-f000-000000000003'),
  (select (v #>> '{}')::bigint from vals where k = 'k3_snaps'), 'running again locks nothing twice');
select is((select count(*) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where b.type = 'meal' and o.subscription_id = (select v from ids where k = 's_d1') and o.service_date = '2026-11-13'), 1::bigint,
  'the cancelled customer''s meal is still charged once after the lock');

-- Item 15, later: the undone pause delivers 20 Nov onwards; the other pause still skips.
select set_config('app.now', '2026-11-19 10:00:00+05:30', true);
select private.refresh_orders('84000000-0000-4000-f000-000000000001', null, 7);
select is((select status::text from public.meal_orders where subscription_id = (select v from ids where k = 's_c4')
           and service_date = '2026-11-20' and slot = 'lunch'), 'scheduled', 'the undone pause: 20 Nov is delivered');
select is((select status::text from public.meal_orders where subscription_id = (select v from ids where k = 's_c5')
           and service_date = '2026-11-20' and slot = 'lunch'), 'skipped', 'the pause that was not undone still skips');

select * from finish();
rollback;
