-- M4 tests: WhatsApp routing and dedupe, the 20:55 pause, outbox window/opt-in/retries, inbox
-- permissions, complaints (2h escalation, credit), customer page tokens, broadcasts, 7 pm nudge.
-- Calendar: Mon 2 Nov 2026; Tuesday lunch cutoff is Mon 21:00 IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup: kitchen W (owner + staff), 3 lunch customers; one also eats at seed kitchen B.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'f0000000-0000-4000-f000-000000000001', 'authenticated', 'authenticated', '919555000001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f0000000-0000-4000-f000-000000000002', 'authenticated', 'authenticated', '919555000002', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('80000000-0000-4000-f000-000000000001', 'WhatsApp Kitchen', 'whatsapp-kitchen', 'f0000000-0000-4000-f000-000000000001', '{7}');
insert into public.kitchen_settings (kitchen_id, broadcast_cap_monthly) values ('80000000-0000-4000-f000-000000000001', 1);
insert into public.kitchen_payout_accounts (kitchen_id) values ('80000000-0000-4000-f000-000000000001');
insert into public.members (kitchen_id, user_id, role) values
  ('80000000-0000-4000-f000-000000000001', 'f0000000-0000-4000-f000-000000000001', 'owner'),
  ('80000000-0000-4000-f000-000000000001', 'f0000000-0000-4000-f000-000000000002', 'staff');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('90000000-0000-4000-f000-000000000001', '80000000-0000-4000-f000-000000000001', 'Lunch', '{lunch}', '{1,2,3,4,5,6}', 7000);

select set_config('app.now', '2026-11-01 10:00:00+05:30', true);
create temp table w (n integer primary key, cust uuid, sub uuid);
grant select on w to authenticated, anon;
do $$
declare i integer; v_c uuid; v_s uuid;
begin
  for i in 1..3 loop
    v_c := private.insert_customer('80000000-0000-4000-f000-000000000001', 'WA Customer ' || i, '+91944400000' || i::text,
      'veg', case when i = 2 then 'hi' else 'en' end::public.language_code, null, '{"line1":"Flat 1","area":"Patia"}', 'vendor', 'vendor');
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, start_date, status)
    values ('80000000-0000-4000-f000-000000000001', v_c, '90000000-0000-4000-f000-000000000001', '2026-11-02', 'active') returning id into v_s;
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note)
    values ('80000000-0000-4000-f000-000000000001', v_c, 'adjust', 20, 140000, 'test balance');
    insert into w values (i, v_c, v_s);
  end loop;
end $$;
update public.customers set whatsapp_opt_in = true where id in (select cust from w where n in (1, 2));
-- Customer 3 also eats at kitchen B (same phone).
select private.insert_customer('10000000-0000-4000-a000-00000000000b', 'WA Customer 3 at B', '+919444000003',
  'veg', 'en', null, null, 'vendor', 'vendor');

-- ===========================================================================
-- Routing and dedupe
-- ===========================================================================
create temp table r (k text primary key, v jsonb);
grant select on r to authenticated, anon;
insert into r values ('c1', public.wa_receive('wamid.1', '919444000001', 'hi', '{}', 'Asha', null));
select is((select v ->> 'status' from r where k = 'c1'), 'matched', 'a customer is matched to their kitchen by phone');
select is(public.wa_receive('wamid.1', '919444000001', 'hi', '{}', 'Asha', null) ->> 'duplicate', 'true',
  'the same WhatsApp message id is processed once');
select is(public.wa_receive('wamid.2', '919000999999', 'hello', '{}', null, null) ->> 'status', 'unknown',
  'an unknown number gets the generic reply path');
insert into r values ('c3', public.wa_receive('wamid.3', '919444000003', 'hi', '{}', null, null));
select is((select v ->> 'status' from r where k = 'c3'), 'choose_kitchen', 'a customer of two kitchens is asked which one');
select is((select jsonb_array_length(v -> 'kitchens') from r where k = 'c3'), 2, 'both kitchens offered');
select is(public.wa_receive('wamid.4', '919444000003', 'Hi whatsapp-kitchen', '{}', null, 'whatsapp-kitchen') ->> 'status', 'matched',
  'a kitchen code from the invite link routes directly');
select is((select count(*) from public.messages where conversation_id = (select (v ->> 'conversation_id')::uuid from r where k = 'c1')), 1::bigint,
  'inbound message stored once');
select is((select (private.conversation_context((v ->> 'conversation_id')::uuid) -> 'kitchen' ->> 'name') from r where k = 'c1'), 'WhatsApp Kitchen',
  'bot context has the kitchen');
select is((select (private.conversation_context((v ->> 'conversation_id')::uuid) -> 'balance' ->> 'meals')::int from r where k = 'c1'), 20,
  'bot context has the balance');

-- ===========================================================================
-- M4 test 1: a WhatsApp pause at 20:55 drops tomorrow's lunch count by one and shows in the vendor feed.
-- ===========================================================================
select set_config('app.now', '2026-11-02 20:55:00+05:30', true);
select is((private.slot_totals('80000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch') ->> 'total_meals')::int, 3,
  'Tuesday lunch: 3 meals before the pause');
select is((public.wa_apply_change((select (v ->> 'conversation_id')::uuid from r where k = 'c1'), (select sub from w where n = 1),
  'pause', '2026-11-03', null, null, null, false) ->> 'after_cutoff')::boolean, false, 'a pause at 20:55 is before the 21:00 cutoff');
select is((private.slot_totals('80000000-0000-4000-f000-000000000001', '2026-11-03', 'lunch') ->> 'total_meals')::int, 2,
  'Tuesday lunch drops to 2');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((select channel::text || '/' || type::text || '/' || after_cutoff::text from public.change_feed('80000000-0000-4000-f000-000000000001', '2026-11-01')
           limit 1), 'whatsapp/pause/false', 'the vendor feed shows the WhatsApp pause');
reset role;
select set_config('app.now', '2026-11-02 21:05:00+05:30', true);
insert into r values ('c2', public.wa_receive('wamid.5', '919444000002', 'skip', '{}', null, null));
select is((public.wa_apply_change((select (v ->> 'conversation_id')::uuid from r where k = 'c2'), (select sub from w where n = 2),
  'skip', '2026-11-03', null, null, null, true) -> 'affected' -> 0 ->> 'charged')::boolean, true,
  'at 21:05 the preview says the skip will be charged');
select throws_ok($$select public.wa_apply_change((select (v ->> 'conversation_id')::uuid from r where k = 'c2'), (select sub from w where n = 1),
  'skip', '2026-11-04')$$, '42501', 'forbidden', 'a WhatsApp conversation can only change its own subscriptions');
select throws_ok($$select public.wa_apply_change((select (v ->> 'conversation_id')::uuid from r where k = 'c2'), (select sub from w where n = 2),
  'cancel', '2026-11-04')$$, '22023', 'cancel_via_kitchen', 'cancellations go to the kitchen');

-- ===========================================================================
-- Outbox: 24h window, opt-in, retries
-- ===========================================================================
select set_config('app.now', '2026-11-02 21:10:00+05:30', true);
select public.wa_receive('wamid.6', '919444000001', 'thanks', '{}', null, null); -- customer 1 writes again: 24h window open
delete from public.notifications_outbox where kitchen_id = '80000000-0000-4000-f000-000000000001';
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, send_after) values
  ('80000000-0000-4000-f000-000000000001', 'whatsapp', 'customer', (select cust from w where n = 1), 'payment_receipt', '{"amount_paise":70000,"meals":10}', 't1', now() - interval '1 day'),
  ('80000000-0000-4000-f000-000000000001', 'whatsapp', 'customer', (select cust from w where n = 3), 'low_balance_reminder', '{"balance_meals":2}', 't3', now() - interval '1 day');
create temp table claimed as select * from public.wa_claim_outbox(10) where kitchen_id = '80000000-0000-4000-f000-000000000001';
select is((select count(*) from claimed), 2::bigint, 'due rows are claimed');
select is((select phone_e164 || '/' || in_window || '/' || opted_in from claimed where template = 'payment_receipt'), '+919444000001/true/true',
  'claim decrypts the phone and reports the 24h window and opt-in');
select is((select opted_in from claimed where template = 'low_balance_reminder'), false, 'customer 3 has not opted in');
select is((select count(*) from public.wa_claim_outbox(10) where kitchen_id = '80000000-0000-4000-f000-000000000001'), 0::bigint,
  'claimed rows are not handed out twice');
select public.wa_complete_outbox((select id from claimed where template = 'payment_receipt'), true, 'wamid.out1', null, 'Receipt text');
select is((select status from public.notifications_outbox where dedupe_key = 't1'), 'sent', 'sent rows are marked sent');
select is((select count(*) from public.messages where wa_message_id = 'wamid.out1' and direction = 'out'), 1::bigint,
  'sent customer messages appear in the conversation');
select public.wa_complete_outbox((select id from claimed where template = 'low_balance_reminder'), false, null, 'timeout', null);
select is((select status || '/' || attempts from public.notifications_outbox where dedupe_key = 't3'), 'pending/1',
  'a failed send is retried later (backoff)');
update public.notifications_outbox set attempts = 5 where dedupe_key = 't3';
select public.wa_complete_outbox((select id from claimed where template = 'low_balance_reminder'), false, null, 'timeout', null);
select is((select status from public.notifications_outbox where dedupe_key = 't3'), 'failed', 'after 5 attempts it is marked failed');
select public.wa_message_status('wamid.out1', 'read');
select public.wa_message_status('wamid.out1', 'delivered');
select is((select status from public.messages where wa_message_id = 'wamid.out1'), 'read', 'delivery statuses never go backwards');

-- ===========================================================================
-- Inbox permissions and vendor replies
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select ok((select count(*) from public.conversations where kitchen_id = '80000000-0000-4000-f000-000000000001') >= 2, 'owner sees the inbox');
select throws_ok('select phone_enc from public.conversations limit 1', '42501', null, 'conversation phone ciphertext is not selectable');
select lives_ok($$select public.send_vendor_message((select (v ->> 'conversation_id')::uuid from r where k = 'c1'), 'Hello from the kitchen')$$,
  'owner replies from the inbox');
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.conversations), 0::bigint, 'staff do not see the inbox (D-060)');
select throws_ok($$select public.send_vendor_message((select (v ->> 'conversation_id')::uuid from r where k = 'c1'), 'hi')$$,
  '42501', 'forbidden', 'staff cannot reply');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select is((select count(*) from public.messages where kitchen_id = '80000000-0000-4000-f000-000000000001'), 0::bigint,
  'another kitchen sees none of these messages');
select throws_ok($$select public.wa_receive('x', '919444000001', 'hi', '{}')$$, '42501', null, 'users cannot inject WhatsApp messages');
reset role;
select is((select template from public.notifications_outbox where template = 'vendor_message' and recipient_id = (select cust from w where n = 1)),
  'vendor_message', 'vendor reply is queued for sending');

-- ===========================================================================
-- Complaints: hand-off, 2-hour escalation, credit
-- ===========================================================================
select set_config('app.now', '2026-11-03 14:00:00+05:30', true);
create temp table cmp as select public.wa_create_complaint((select (v ->> 'conversation_id')::uuid from r where k = 'c2'), 'late', 'Came at 2pm') as id;
grant select on cmp to authenticated;
select is((select handoff_open from public.conversations where id = (select (v ->> 'conversation_id')::uuid from r where k = 'c2')), true,
  'a complaint hands the conversation to the kitchen');
select is((select count(*) from public.notifications_outbox where template = 'inbox_alert' and payload ->> 'complaint_id' = (select id::text from cmp)), 1::bigint,
  'the owner is alerted');
select is(private.escalate_complaints(), 0, 'not escalated within 2 hours');
select set_config('app.now', '2026-11-03 16:01:00+05:30', true);
select ok(private.escalate_complaints() >= 1, 'escalated after 2 hours without a response');
select is((select status from public.complaints where id = (select id from cmp)), 'escalated', 'complaint is escalated');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select lives_ok($$select public.resolve_complaint((select id from cmp), 'Sorry, the rider was stuck in traffic.', 1)$$,
  'owner resolves with a free meal');
reset role;
select is((select status || '/' || (refund_entry_id is not null)::text from public.complaints where id = (select id from cmp)), 'resolved/true',
  'resolution is linked to the credit entry');
select is((select meals || '/' || type from public.balance_entries where ref_type = 'complaint' and ref_id = (select id from cmp)), '1/credit',
  'one free meal credited');

-- ===========================================================================
-- Customer page (magic link)
-- ===========================================================================
create temp table tok as select public.wa_magic_link((select (v ->> 'conversation_id')::uuid from r where k = 'c1')) as token;
grant select on tok to anon, authenticated;
set local role anon;
select is((select public.portal_get((select token from tok)) -> 'customer' ->> 'name'), 'WA Customer 1', 'the page opens with the link, no login');
select is((select public.portal_get((select token from tok)) ->> 'phone_masked'), '+91 ••••••0001', 'the page shows only a masked phone');
select throws_ok($$select public.portal_get('not-a-real-token')$$, '28000', 'invalid_link', 'a wrong token is refused');
select lives_ok($$select public.portal_change((select token from tok), (select sub from w where n = 1), 'resume', '2026-11-05', null, null, null, false)$$,
  'the customer resumes from the page');
select throws_ok($$select public.portal_change((select token from tok), (select sub from w where n = 2), 'skip', '2026-11-05')$$,
  '42501', 'forbidden', 'the page cannot touch another customer');
select throws_ok($$select count(*) from public.customers$$, '42501', null, 'anon still cannot read tables');
reset role;
select is((select channel::text from public.schedule_changes where subscription_id = (select sub from w where n = 1) order by requested_at desc limit 1),
  'web', 'page changes are recorded with channel web');
select set_config('app.now', '2026-11-11 10:00:00+05:30', true);
set local role anon;
select throws_ok($$select public.portal_get((select token from tok))$$, '28000', 'invalid_link', 'links expire after 7 days');
reset role;

-- ===========================================================================
-- Broadcast cap and 7 pm nudge
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is(public.send_broadcast('80000000-0000-4000-f000-000000000001', 'Diwali special on Friday!'), 2,
  'broadcast goes to the 2 opted-in customers');
select throws_ok($$select public.send_broadcast('80000000-0000-4000-f000-000000000001', 'Another one')$$, '22023', 'broadcast_cap_reached',
  'monthly broadcast cap is enforced');
reset role;

select set_config('app.now', '2026-11-11 19:00:00+05:30', true);
select private.refresh_orders('80000000-0000-4000-f000-000000000001', null, 7);
select ok(private.queue_tomorrow_nudges() >= 1, '7 pm nudge queued');
select is((select count(*) from public.notifications_outbox where template = 'tomorrow_menu' and kitchen_id = '80000000-0000-4000-f000-000000000001'
           and recipient_id = (select cust from w where n = 3)), 0::bigint, 'no nudge to customers who did not opt in');
select is(private.queue_tomorrow_nudges(), 0, 'nudges are not queued twice');

select * from finish();
rollback;
