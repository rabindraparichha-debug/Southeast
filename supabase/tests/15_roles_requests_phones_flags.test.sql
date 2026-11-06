-- Vendor-first wave 2: rider change requests approved by owner or manager (item 23, D-117), manager
-- alerts and invites, shared phones (D-118), outbox expiry and the phase-flag gate (item 13).
-- Calendar: Wed 11 Nov 2026 is the delivery day; lunch locks at 21:00 the evening before.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen R with an owner, a manager, an accountant, staff and its only rider; kitchen S with
-- its own rider.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'c1500000-0000-4000-c000-000000000001', 'authenticated', 'authenticated', '919315000001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1500000-0000-4000-c000-000000000002', 'authenticated', 'authenticated', '919315000002', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1500000-0000-4000-c000-000000000003', 'authenticated', 'authenticated', '919315000003', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1500000-0000-4000-c000-000000000004', 'authenticated', 'authenticated', '919315000004', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1500000-0000-4000-c000-000000000005', 'authenticated', 'authenticated', '919315000005', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1500000-0000-4000-c000-000000000006', 'authenticated', 'authenticated', '919315000006', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1500000-0000-4000-c000-000000000007', 'authenticated', 'authenticated', '919315000007', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('c1500000-0000-4000-c000-00000000000a', 'Rider Kitchen', 'rider-kitchen', 'c1500000-0000-4000-c000-000000000001', '{}'),
  ('c1500000-0000-4000-c000-00000000000b', 'Other Kitchen', 'other-kitchen-r', 'c1500000-0000-4000-c000-000000000007', '{}');
insert into public.kitchen_settings (kitchen_id) values ('c1500000-0000-4000-c000-00000000000a'), ('c1500000-0000-4000-c000-00000000000b');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('c1500000-0000-4000-c000-00000000000a', 'c1500000-0000-4000-c000-000000000001', 'owner', 'Owner R'),
  ('c1500000-0000-4000-c000-00000000000a', 'c1500000-0000-4000-c000-000000000002', 'manager', 'Manager R'),
  ('c1500000-0000-4000-c000-00000000000a', 'c1500000-0000-4000-c000-000000000003', 'accountant', 'Accountant R'),
  ('c1500000-0000-4000-c000-00000000000a', 'c1500000-0000-4000-c000-000000000004', 'rider', 'Rider R'),
  ('c1500000-0000-4000-c000-00000000000a', 'c1500000-0000-4000-c000-000000000005', 'staff', 'Staff R'),
  ('c1500000-0000-4000-c000-00000000000b', 'c1500000-0000-4000-c000-000000000007', 'owner', 'Owner S'),
  ('c1500000-0000-4000-c000-00000000000b', 'c1500000-0000-4000-c000-000000000006', 'rider', 'Rider S');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('c1500000-0000-4000-c000-0000000000a1', 'c1500000-0000-4000-c000-00000000000a', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 6000),
  ('c1500000-0000-4000-c000-0000000000a2', 'c1500000-0000-4000-c000-00000000000a', 'Lunch Extra', '{lunch}', '{1,2,3,4,5,6,7}', 3000);

select set_config('app.now', '2026-11-10 10:00:00+05:30', true);
create temp table rx (k text primary key, v uuid);
grant all on rx to authenticated;
do $$
declare v_c uuid; v_s uuid;
begin
  v_c := private.insert_customer('c1500000-0000-4000-c000-00000000000a', 'Door Customer', '+919315100001', 'veg', 'en', null,
                                 '{"line1":"House 1","area":"Patia"}', 'vendor', 'vendor');
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
  values ('c1500000-0000-4000-c000-00000000000a', v_c, 'c1500000-0000-4000-c000-0000000000a1',
          (select id from public.addresses where customer_id = v_c), '2026-11-11', 'active') returning id into v_s;
  insert into rx values ('door', v_c), ('door_sub', v_s);
  v_c := private.insert_customer('c1500000-0000-4000-c000-00000000000a', 'Two Plans', '+919315100002', 'veg', 'en', null,
                                 '{"line1":"House 2","area":"Patia"}', 'vendor', 'vendor');
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
  values ('c1500000-0000-4000-c000-00000000000a', v_c, 'c1500000-0000-4000-c000-0000000000a1',
          (select id from public.addresses where customer_id = v_c), '2026-11-11', 'active') returning id into v_s;
  insert into rx values ('two', v_c), ('two_sub1', v_s);
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
  values ('c1500000-0000-4000-c000-00000000000a', v_c, 'c1500000-0000-4000-c000-0000000000a2',
          (select id from public.addresses where customer_id = v_c), '2026-11-11', 'active') returning id into v_s;
  insert into rx values ('two_sub2', v_s);
end $$;

-- Lock Wednesday's lunch (runs are built at the lock), then it is Wednesday morning.
select set_config('app.now', '2026-11-10 21:00:01+05:30', true);
select private.lock_slot('c1500000-0000-4000-c000-00000000000a', '2026-11-11', 'lunch');
insert into rx select 'door_stop', s.id from public.delivery_stops s where s.customer_id = (select v from rx where k = 'door');
insert into rx select 'two_stop', s.id from public.delivery_stops s where s.customer_id = (select v from rx where k = 'two');
select is((select rider_id from public.delivery_runs where kitchen_id = 'c1500000-0000-4000-c000-00000000000a'),
  'c1500000-0000-4000-c000-000000000004'::uuid, 'the run went to the kitchen''s only rider');
select set_config('app.now', '2026-11-11 11:00:00+05:30', true);

-- ===========================================================================
-- Rider change requests
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000004","role":"authenticated"}', true);
create temp table req (k text primary key, r jsonb);
grant all on req to authenticated;
insert into req select 'skip', public.rider_request_change((select v from rx where k = 'door_stop'), 'skip', '2026-11-13',
  p_note => 'Customer travelling Friday', p_client_op => 'c1500000-0000-4000-c000-0000000000f1');
select is((select r ->> 'status' from req where k = 'skip'), 'pending', 'the rider records a skip request at the door');
select is((select (public.rider_request_change((select v from rx where k = 'door_stop'), 'skip', '2026-11-13',
  p_client_op => 'c1500000-0000-4000-c000-0000000000f1') ->> 'request_id')), (select r ->> 'request_id' from req where k = 'skip'),
  'a retry from the offline queue returns the same request');
select is((select count(*) from public.change_requests), 1::bigint, 'the rider sees their own request');
select is((select status || '/' || channel::text || '/' || type::text from public.change_requests), 'pending/rider/skip',
  'pending, channel rider');
select throws_ok($$select public.rider_request_change((select v from rx where k = 'door_stop'), 'skip', '2026-11-10')$$,
  '22023', 'date_in_past', 'not for past dates');
select throws_ok($$select public.rider_request_change((select v from rx where k = 'door_stop'), 'address', '2026-11-12')$$,
  '22023', 'note_required', 'an address request needs the new address in the note');
insert into req select 'two', public.rider_request_change((select v from rx where k = 'two_stop'), 'pause', '2026-11-14', '2026-11-20');
insert into req select 'addr', public.rider_request_change((select v from rx where k = 'door_stop'), 'address', '2026-11-12',
  p_note => 'Moved to Plot 9, Patia');
insert into req select 'reject', public.rider_request_change((select v from rx where k = 'door_stop'), 'cancel', '2026-11-20');
select throws_ok($$select public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'skip'))$$,
  '42501', 'forbidden', 'a rider cannot approve');
select is(jsonb_array_length(public.change_requests_list('c1500000-0000-4000-c000-00000000000a')), 4,
  'the rider lists their own requests');

select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000006","role":"authenticated"}', true);
select throws_ok($$select public.rider_request_change((select v from rx where k = 'door_stop'), 'skip', '2026-11-13')$$,
  '42501', 'forbidden', 'another kitchen''s rider cannot record a request on this stop');
select is((select count(*) from public.change_requests), 0::bigint, 'and sees no requests');
select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000005","role":"authenticated"}', true);
select throws_ok($$select public.rider_request_change((select v from rx where k = 'door_stop'), 'skip', '2026-11-13')$$,
  '42501', 'forbidden', 'staff cannot record rider requests');
select throws_ok($$select public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'skip'))$$,
  '42501', 'forbidden', 'staff cannot approve');
select is((select count(*) from public.change_requests), 0::bigint, 'staff see no requests');
select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'skip'))$$,
  '42501', 'forbidden', 'an accountant cannot approve');
select throws_ok($$select public.change_requests_list('c1500000-0000-4000-c000-00000000000a')$$, '42501', 'forbidden',
  'an accountant cannot list requests');

-- The manager previews, then approves: applied through apply_change (channel rider), never a second path.
select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000002","role":"authenticated"}', true);
select is(jsonb_array_length(public.change_requests_list('c1500000-0000-4000-c000-00000000000a')), 4, 'the manager sees 4 pending requests');
select is((public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'skip'), p_dry_run => true)
           -> 'affected' -> 0 ->> 'charged')::boolean, false, 'preview: the Friday skip is free (before the cutoff)');
select is((select status from public.change_requests where id = (select (r ->> 'request_id')::uuid from req where k = 'skip')), 'pending',
  'a preview changes nothing');
select lives_ok($$select public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'skip'))$$, 'the manager approves');
select is((public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'skip')) ->> 'already')::boolean, true,
  'approving twice is a no-op');
select throws_ok($$select public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'two'))$$,
  '22023', 'subscription_required', 'with two live plans the approver picks the subscription');
select lives_ok($$select public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'two'),
  p_subscription => (select v from rx where k = 'two_sub2'))$$, 'approved for the chosen plan');
select throws_ok($$select public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'addr'))$$,
  '22023', 'invalid_address', 'an address request needs the address picked by the approver');
select lives_ok($$select public.reject_change_request((select (r ->> 'request_id')::uuid from req where k = 'reject'), 'Confirmed by phone: not cancelling')$$,
  'the manager rejects a request');
select throws_ok($$select public.approve_change_request((select (r ->> 'request_id')::uuid from req where k = 'reject'))$$,
  '22023', 'not_pending', 'a rejected request cannot be approved');
reset role;
select is((select status || '/' || (change_id is not null)::text || '/' || decided_by::text from public.change_requests
           where id = (select (r ->> 'request_id')::uuid from req where k = 'skip')),
  'approved/true/c1500000-0000-4000-c000-000000000002', 'approved, linked to the schedule change, decided by the manager');
select is((select channel::text || '/' || requested_by::text from public.schedule_changes
           where id = (select change_id from public.change_requests where id = (select (r ->> 'request_id')::uuid from req where k = 'skip'))),
  'rider/c1500000-0000-4000-c000-000000000004', 'the schedule change is recorded as the rider''s, channel rider');
select is((select status::text || '/' || skip_reason from public.meal_orders where subscription_id = (select v from rx where k = 'door_sub')
           and service_date = '2026-11-13'), 'skipped/skip', 'Friday''s meal is skipped');
select is((select count(*) from public.meal_orders where subscription_id = (select v from rx where k = 'two_sub2')
           and service_date between '2026-11-14' and '2026-11-16' and status = 'skipped'), 3::bigint, 'the pause applies to the chosen plan only');
select is((select count(*) from public.meal_orders where subscription_id = (select v from rx where k = 'two_sub1')
           and service_date between '2026-11-14' and '2026-11-16' and status = 'skipped'), 0::bigint, 'the other plan keeps its meals');
select is((select status || '/' || decision_note from public.change_requests where id = (select (r ->> 'request_id')::uuid from req where k = 'reject')),
  'rejected/Confirmed by phone: not cancelling', 'the rejection is recorded with its reason');
select ok((select count(*) from public.audit_log where table_name = 'change_requests') >= 4, 'requests are audited');

-- ===========================================================================
-- Managers get owner alerts; invites for the new roles; inbox stays owner-only
-- ===========================================================================
select private.notify_owners('c1500000-0000-4000-c000-00000000000a', 'inbox_alert', '{}'::jsonb, 'test_alert');
select is((select array_agg(recipient_id order by recipient_id) from public.notifications_outbox where dedupe_key like 'test_alert:%'),
  array['c1500000-0000-4000-c000-000000000001', 'c1500000-0000-4000-c000-000000000002']::uuid[], 'owner alerts go to the owner and the manager');
select is((select status from public.notifications_outbox where dedupe_key like 'test_alert:%' limit 1), 'pending',
  'member alerts are not affected by the customer-message flag');
select private.queue_owner_summaries();
select is((select count(*) from public.notifications_outbox where template = 'owner_daily_summary'
           and kitchen_id = 'c1500000-0000-4000-c000-00000000000a'), 2::bigint, 'the 22:00 summary goes to the owner and the manager');

insert into public.conversations (id, kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4)
select 'c1500000-0000-4000-c000-0000000000c1', kitchen_id, id, phone_hash, phone_enc, phone_last4 from public.customers
where id = (select v from rx where k = 'door');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.conversations), 0::bigint, 'the manager cannot read the inbox (D-060, owner only)');
select throws_ok($$select public.send_vendor_message('c1500000-0000-4000-c000-0000000000c1', 'Hello')$$, '42501', 'forbidden',
  'nor answer it');
select throws_ok($$select public.invite_member('c1500000-0000-4000-c000-00000000000a', '9315000099', 'staff')$$, '42501', 'forbidden',
  'the manager cannot invite');
select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.conversations), 1::bigint, 'the owner reads the inbox');
select is(public.invite_member('c1500000-0000-4000-c000-00000000000a', '9315000098', 'accountant', 'New accountant') ->> 'status', 'invited',
  'the owner invites an accountant');
select is(public.invite_member('c1500000-0000-4000-c000-00000000000a', '9315000097', 'manager', 'New manager') ->> 'status', 'invited',
  'and a manager');
select lives_ok($$select public.set_member_role((select id from public.members where user_id = 'c1500000-0000-4000-c000-000000000005'), 'manager')$$,
  'the owner promotes staff to manager');
reset role;
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'c1500000-0000-4000-c000-000000000098', 'authenticated', 'authenticated', '919315000098', now(), now(), now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000098","role":"authenticated","amr":[{"method":"otp","timestamp":1}]}', true);
select is(public.claim_invites(), 1, 'the invited accountant claims the invite after a code sign-in');
select is((select role::text from public.members where user_id = 'c1500000-0000-4000-c000-000000000098'), 'accountant', 'as an accountant');
reset role;
update public.members set role = 'staff' where user_id = 'c1500000-0000-4000-c000-000000000005';

-- ===========================================================================
-- D-118: customers sharing a phone
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000001","role":"authenticated"}', true);
insert into rx select 'sib1', public.create_customer('c1500000-0000-4000-c000-00000000000a', 'Elder Sibling', '9315200001', true);
select throws_ok($$select public.create_customer('c1500000-0000-4000-c000-00000000000a', 'Younger Sibling', '9315200001', true)$$,
  '23505', 'phone_in_use', 'a second person on the same phone needs confirmation');
insert into rx select 'sib2', public.create_customer('c1500000-0000-4000-c000-00000000000a', 'Younger Sibling', '9315200001', true,
  p_allow_shared_phone => true);
select throws_ok($$select public.create_customer('c1500000-0000-4000-c000-00000000000a', 'elder  sibling', '9315200001', true,
  p_allow_shared_phone => true)$$, '23505', 'already_exists', 'the same name on the same phone is still a duplicate');
select is((select count(*) from public.search_customers('c1500000-0000-4000-c000-00000000000a', '93152 00001')), 2::bigint,
  'a phone search returns everyone on that number');
select throws_ok($$select public.update_customer((select v from rx where k = 'door'), '{"phone":"9315200001"}')$$,
  '23505', 'phone_in_use', 'moving a customer onto a shared phone needs confirmation');
select lives_ok($$select public.update_customer((select v from rx where k = 'door'), '{"phone":"9315200001","allow_shared_phone":true}')$$,
  'and works once confirmed');
select lives_ok($$select public.update_customer((select v from rx where k = 'door'), '{"phone":"9315100001"}')$$, 'moved back');
reset role;
update public.customers set created_at = '2020-01-01' where id = (select v from rx where k = 'sib1');
update public.platform_settings set enabled = true where key = 'customer_whatsapp';
create temp table wa (k text primary key, r jsonb);
insert into wa select 'in', public.wa_receive('wamid.d118.1', '919315200001', 'hi', '{}', 'Sibling phone', null);
select is((select r ->> 'status' from wa where k = 'in'), 'matched', 'a message from a shared phone is routed (no too_many_rows)');
select is((select customer_id from public.conversations where id = (select (r ->> 'conversation_id')::uuid from wa where k = 'in')),
  (select v from rx where k = 'sib1'), 'to the oldest customer on that phone (deterministic)');
select is(public.wa_select_kitchen((select (r ->> 'conversation_id')::uuid from wa where k = 'in'), 'c1500000-0000-4000-c000-00000000000a'),
  (select (r ->> 'conversation_id')::uuid from wa where k = 'in'), 'picking the kitchen keeps the same conversation');
select is((select (public.portal_get(private.issue_magic_link((select v from rx where k = 'sib2'))) -> 'customer' ->> 'name')),
  'Younger Sibling', 'the younger sibling''s page shows their own data');
select is((select (public.portal_get(private.issue_magic_link((select v from rx where k = 'sib1'))) -> 'customer' ->> 'name')),
  'Elder Sibling', 'and the elder''s page theirs');
select is((select count(*) from public.conversations where kitchen_id = 'c1500000-0000-4000-c000-00000000000a'
           and wa_phone_hash = (select phone_hash from public.customers where id = (select v from rx where k = 'sib1'))), 1::bigint,
  'one conversation for the shared phone');
delete from public.notifications_outbox where kitchen_id = 'c1500000-0000-4000-c000-00000000000a';
select private.notify_customer('c1500000-0000-4000-c000-00000000000a', (select v from rx where k = 'sib2'), 'payment_receipt',
  '{"amount_paise":1000,"meals":0}', 'sib2_receipt');
select is((select in_window from public.wa_claim_outbox(10) where recipient_id = (select v from rx where k = 'sib2')), true,
  'a message to the younger sibling uses the shared phone''s 24-hour window');
update public.platform_settings set enabled = false where key = 'customer_whatsapp';

-- ===========================================================================
-- Item 13: phase flags, the customer-message gate, expiry
-- ===========================================================================
select is((select array_agg(key order by key) from public.platform_settings
           where key in ('customer_whatsapp', 'customer_portal', 'online_payments', 'marketplace', 'growth', 'extras') and not enabled),
  array['customer_portal', 'customer_whatsapp', 'extras', 'growth', 'marketplace', 'online_payments'], 'all phase flags exist and are off');
delete from public.notifications_outbox where kitchen_id = 'c1500000-0000-4000-c000-00000000000a';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1500000-0000-4000-c000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.record_payment((select v from rx where k = 'door'), 30000, 'cash')$$, 'cash from an offline customer');
reset role;
select is((select status || '/' || last_error from public.notifications_outbox where template = 'payment_receipt'
           and recipient_id = (select v from rx where k = 'door')), 'cancelled/customer_messages_off',
  'its WhatsApp receipt is stored as cancelled while customer messages are off');
select private.notify_owners('c1500000-0000-4000-c000-00000000000a', 'inbox_alert', '{}'::jsonb, 'test_alert_2');
select is((select count(*) from public.notifications_outbox where dedupe_key like 'test_alert_2:%' and status = 'pending'), 2::bigint,
  'member alerts stay pending');
select is((select expires_at - greatest(send_after, private.now()) from public.notifications_outbox where dedupe_key like 'test_alert_2:%' limit 1),
  interval '48 hours', 'messages expire 48 hours after they were due (or queued)');
insert into public.leads (id, phone_enc, phone_hash, phone_last4, source) values
  ('c1500000-0000-4000-c000-0000000000e1', private.encrypt_phone('+919315300001'), private.phone_hash('+919315300001'), '0001', 'website');
insert into public.notifications_outbox (channel, recipient_type, recipient_id, template, payload, dedupe_key) values
  ('whatsapp', 'lead', 'c1500000-0000-4000-c000-0000000000e1', 'lead_welcome', '{}', 'gate_lead');
select is((select status from public.notifications_outbox where dedupe_key = 'gate_lead'), 'cancelled', 'messages to leads are gated too');
-- Payer routing does not mint a payer link for a gated message.
update public.customers set payer_customer_id = (select v from rx where k = 'two') where id = (select v from rx where k = 'door');
select private.notify_customer('c1500000-0000-4000-c000-00000000000a', (select v from rx where k = 'door'), 'low_balance_reminder',
  '{"balance_meals":1}', 'gated_payer');
select is((select recipient_id::text || '/' || template from public.notifications_outbox where dedupe_key = 'gated_payer'),
  (select v from rx where k = 'door')::text || '/low_balance_reminder', 'a gated message is not rerouted to the payer');
update public.customers set payer_customer_id = null where id = (select v from rx where k = 'door');
-- Expired rows are never claimed.
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, send_after, expires_at) values
  ('c1500000-0000-4000-c000-00000000000a', 'whatsapp', 'member', 'c1500000-0000-4000-c000-000000000001', 'inbox_alert', '{}', 'expired_one',
   private.now() - interval '3 days', private.now() - interval '1 hour');
select is((select count(*) from public.wa_claim_outbox(100) where template = 'inbox_alert'
           and kitchen_id = 'c1500000-0000-4000-c000-00000000000a'), 2::bigint, 'the claim returns the two fresh alerts only (owner, manager)');
select is((select status || '/' || last_error from public.notifications_outbox where dedupe_key = 'expired_one'), 'cancelled/expired',
  'the expired row is cancelled, never sent');
-- Flag on: customer messages are queued again.
update public.platform_settings set enabled = true where key = 'customer_whatsapp';
select private.notify_customer('c1500000-0000-4000-c000-00000000000a', (select v from rx where k = 'door'), 'payment_receipt', '{}', 'flag_on');
select is((select status from public.notifications_outbox where dedupe_key = 'flag_on'), 'pending', 'with customer_whatsapp on, customer messages queue');
update public.platform_settings set enabled = false where key = 'customer_whatsapp';

-- Growth and customer crons check their flags.
select is(private.cron_growth_tick(), '{"skipped": "growth_off"}'::jsonb, 'tiffin-growth does nothing while growth is off');
select is(private.cron_tomorrow_nudges(), 0, 'tiffin-tomorrow-nudge does nothing while customer WhatsApp is off');
insert into public.complaints (kitchen_id, customer_id, category, channel, created_at) values
  ('c1500000-0000-4000-c000-00000000000a', (select v from rx where k = 'door'), 'late', 'vendor', private.now() - interval '3 hours');
select is(private.cron_escalate_complaints(), 0, 'complaint escalation does nothing while customer channels are off');
update public.platform_settings set enabled = true where key = 'customer_portal';
select is(private.cron_escalate_complaints(), 1, 'and escalates once the customer page is on');
update public.platform_settings set enabled = true where key = 'growth';
select ok(private.cron_growth_tick() ? 'followups', 'tiffin-growth runs once growth is on');
update public.platform_settings set enabled = false where key in ('customer_portal', 'growth');
select is((select command from cron.job where jobname = 'tiffin-growth'), 'select private.cron_growth_tick()', 'the growth cron goes through its flag check');
select is((select command from cron.job where jobname = 'tiffin-tomorrow-nudge'), 'select private.cron_tomorrow_nudges()', 'so does the nudge');
select is((select command from cron.job where jobname = 'tiffin-ad-conversions'), 'select private.cron_ad_conversions()', 'and the ads upload');
select is((select command from cron.job where jobname = 'tiffin-escalate-complaints'), 'select private.cron_escalate_complaints()', 'and escalation');
-- Weather: owner alerts keep working; the customer notice needs customer WhatsApp.
update public.kitchens set lat = 20.35, lng = 85.82 where id = 'c1500000-0000-4000-c000-00000000000a';
update public.kitchen_settings set weather_customer_notice = true where kitchen_id = 'c1500000-0000-4000-c000-00000000000a';
select is((select (k ->> 'customer_notice')::boolean from jsonb_array_elements(public.weather_kitchens()) k
           where k ->> 'kitchen_id' = 'c1500000-0000-4000-c000-00000000000a'), false, 'weather: no customer notice while customer WhatsApp is off');
select is((public.weather_record_alert('c1500000-0000-4000-c000-00000000000a', '2026-11-12', 'lunch', 'rain') ->> 'customers_notified')::int, 0,
  'a rain alert tells no customers');
select ok(exists (select 1 from public.notifications_outbox where template = 'weather_alert' and kitchen_id = 'c1500000-0000-4000-c000-00000000000a'
                  and status = 'pending'), 'but the owner is alerted');

select * from finish();
rollback;
