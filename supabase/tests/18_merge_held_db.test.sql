-- Merge of the held-back DB items (D-157) into m9-p5-p6: 20261130000200_merge_held_db.sql and the
-- cross-wave behaviour it must keep.
--   * wave 1 + held/db: rider_today keeps wave 1's changed / changed_at, and otp_sent counts only a
--     real send (never pending or mock);
--   * wave 2 + held/db: the chunked, idempotent import (held/db) still refuses a monthly opening meal
--     balance without a plan and writes no 0/0 opening row (wave 2 review fix 6);
--   * wave 2 + held/db: the outbox claim stamps claimed_at (held/db's stuck-row sweep) and still cancels
--     customer rows queued before customer_whatsapp was switched off (wave 2 review fix 8).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.src(p_schema text, p_name text) returns text language sql as
  $$ select string_agg(p.prosrc, E'\n') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = p_schema and p.proname = p_name $$;

-- ===========================================================================
-- rider_today: wave 1's body survives held/db's otp_sent patch
-- ===========================================================================
select ok(pg_temp.src('public', 'rider_today') ~ 'changed_at' and pg_temp.src('public', 'rider_today') ~ $$'changed'$$,
  'rider_today still returns changed / changed_at (wave 1)');
select ok(pg_temp.src('public', 'rider_today') ~ $$n\.status = 'sent'$$
          and pg_temp.src('public', 'rider_today') !~ $$'pending', 'sent', 'sending'$$,
  'rider_today: otp_sent only for a real send (held/db: mock is not sent)');

-- ===========================================================================
-- Setup: kitchen I (monthly by default), Lunch ₹60.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'e1800000-0000-4000-e000-000000000001', 'authenticated', 'authenticated', '919318000001', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('e1800000-0000-4000-e000-00000000000a', 'Merge Held Kitchen', 'merge-held-kitchen', 'e1800000-0000-4000-e000-000000000001', '{}');
insert into public.kitchen_settings (kitchen_id, default_billing_mode) values ('e1800000-0000-4000-e000-00000000000a', 'monthly');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('e1800000-0000-4000-e000-00000000000a', 'e1800000-0000-4000-e000-000000000001', 'owner', 'Owner');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise, diet) values
  ('e1800000-0000-4000-e000-0000000000a1', 'e1800000-0000-4000-e000-00000000000a', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 6000, 'veg');

-- ===========================================================================
-- Import: held/db chunks + wave 2's balance rules
-- ===========================================================================
select set_config('app.now', '2026-11-09 10:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1800000-0000-4000-e000-000000000001","role":"authenticated"}', true);
create temp table imp (k text primary key, r jsonb);
grant select, insert on imp to authenticated;
create temp table rows1 as select '[
  {"name":"Nila No Plan","phone":"9318100001","balance":"5"},
  {"name":"Zero Zero","phone":"9318100002","plan":"Lunch","balance":"2","dues":"120"},
  {"name":"Owes Some","phone":"9318100003","plan":"Lunch","dues":"300"},
  {"name":"Zero Zero","phone":"9318100002","plan":"Lunch"}
]'::jsonb as rows;
grant select on rows1 to authenticated;
insert into imp select 'c1', public.import_customers('e1800000-0000-4000-e000-00000000000a', (select rows from rows1), true,
  'merge.csv', 'e1800000-0000-4000-e000-0000000000f1', 1, 4);
insert into imp select 'c1again', public.import_customers('e1800000-0000-4000-e000-00000000000a', (select rows from rows1), true,
  'merge.csv', 'e1800000-0000-4000-e000-0000000000f1', 1, 4);

select is((select r -> 'errors' -> 0 -> 'errors' from imp where k = 'c1'), '["balance_needs_plan"]'::jsonb,
  'a monthly opening meal balance without a plan is refused (wave 2)');
select is((select (r ->> 'imported')::int || '/' || (r ->> 'failed')::int from imp where k = 'c1'), '2/2',
  'the other new rows are saved');
select is((select r -> 'errors' -> 1 -> 'errors' from imp where k = 'c1'), '["same_plan_twice"]'::jsonb,
  'a repeated row (same phone and name) is checked against the plans it would add (held/db)');
select is((select count(*) from public.balance_entries b join public.customers c on c.id = b.customer_id
           where c.kitchen_id = 'e1800000-0000-4000-e000-00000000000a' and c.name = 'Zero Zero'), 0::bigint,
  '2 meals at ₹60 against ₹120 dues writes no 0/0 opening row (wave 2)');
select is((select sum(b.amount_paise) from public.balance_entries b join public.customers c on c.id = b.customer_id
           where c.kitchen_id = 'e1800000-0000-4000-e000-00000000000a' and c.name = 'Owes Some'), -30000::bigint,
  'opening dues are a rupee debt (wave 2)');
select is((select (r ->> 'already_done')::int || '/' || (r ->> 'imported')::int || '/' || (r ->> 'failed')::int from imp where k = 'c1again'),
  '4/2/2', 'a retried chunk reports the stored outcome (held/db)');
select is((select count(*) from public.customers where kitchen_id = 'e1800000-0000-4000-e000-00000000000a'), 2::bigint,
  'and creates nobody twice');
reset role;
select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Outbox claim: claimed_at (held/db) + send-time customer_whatsapp gate (wave 2)
-- ===========================================================================
update public.platform_settings set enabled = true where key = 'customer_whatsapp';
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, send_after)
values
  ('e1800000-0000-4000-e000-00000000000a', 'whatsapp', 'customer',
   (select id from public.customers where kitchen_id = 'e1800000-0000-4000-e000-00000000000a' and name = 'Owes Some'),
   'vendor_message', '{"text":"hi"}', 'm18-customer', private.now() - interval '1 minute'),
  ('e1800000-0000-4000-e000-00000000000a', 'whatsapp', 'member', 'e1800000-0000-4000-e000-000000000001',
   'vendor_message', '{"text":"hi"}', 'm18-member', private.now() - interval '1 minute');
select is((select status from public.notifications_outbox where dedupe_key = 'm18-customer'), 'pending',
  'queued while customer WhatsApp is on');
update public.platform_settings set enabled = false where key = 'customer_whatsapp';
create temp table claimed as select * from public.wa_claim_outbox(100);
select is((select status || '/' || last_error from public.notifications_outbox where dedupe_key = 'm18-customer'),
  'cancelled/customer_messages_off', 'switched off before the send: the customer row is cancelled at claim time (wave 2)');
select is((select count(*) from claimed c join public.notifications_outbox o on o.id = c.id where o.dedupe_key = 'm18-customer'), 0::bigint,
  'and never handed to the worker');
select is((select status || '/' || (claimed_at = private.now())::text from public.notifications_outbox where dedupe_key = 'm18-member'),
  'sending/true', 'a member alert is claimed and stamped for the stuck-row sweep (held/db)');

select * from finish();
rollback;
