-- Merge of vendor-first wave 3 safety (D-180 – D-187) into m9-p5-p6: 20261130000500_merge_safety.sql and
-- the cross-wave behaviour it must keep (D-188).
--   * wave 2 + safety: the kitchen pick sends only a WhatsApp confirmation, which wave 2's gate cancels
--     while customer_whatsapp is off, so lead_choose refuses then (feature_disabled) and works with both
--     flags on (the lead_confirm row is pending, not cancelled);
--   * wave 2 + safety: wave 2's shared-phone customer page (portal_get) goes through safety's
--     customer_portal gate and revocable links;
--   * ops / wave 4 + safety: feature_flags() exposes the phase flags only (never retention or
--     open_vendor_signup); the three form RPCs stay off the anon list;
--   * riders + safety: the transfer_failed member alert has its own push text.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select set_config('app.now', '2026-11-12 10:00:00+05:30', true);
create temp table t (k text primary key, v jsonb);
grant select, insert, update on t to anon, authenticated, service_role;

-- ===========================================================================
-- Flags and grants
-- ===========================================================================
select is((select array_agg(k order by k) from jsonb_object_keys(public.feature_flags()) k),
  array['customer_portal', 'customer_whatsapp', 'extras', 'growth', 'kitchen_switching', 'marketplace', 'online_payments'],
  'feature_flags exposes the phase flags only (never ops'' retention or wave 4''s open_vendor_signup)');
select ok(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
          and has_function_privilege('service_role', p.oid, 'execute'),
  p.proname || ' is reached only through the public-forms function')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('submit_lead', 'lead_choose', 'submit_vendor_application') order by p.proname;
select ok(has_function_privilege('anon', 'public.lead_confirm(text)', 'execute'), 'the confirmation link stays anon');

-- ===========================================================================
-- Setup: a live, verified kitchen far from the seed kitchens.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'e2100000-0000-4000-e000-000000000001', 'authenticated', 'authenticated', '919321000001', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, lat, lng, service_radius_km, fssai_no, capacity_lunch, status, verified_at,
                             accepts_platform_leads) values
  ('e2100000-0000-4000-e000-00000000000a', 'Merge Konark Kitchen', 'merge-konark-kitchen', 'e2100000-0000-4000-e000-000000000001',
   19.8876, 86.0945, 5, '12026001009991', 30, 'active', now(), true);
insert into public.members (kitchen_id, user_id, role) values
  ('e2100000-0000-4000-e000-00000000000a', 'e2100000-0000-4000-e000-000000000001', 'owner');
insert into public.kitchen_settings (kitchen_id) values ('e2100000-0000-4000-e000-00000000000a');
insert into public.kitchen_payout_accounts (kitchen_id) values ('e2100000-0000-4000-e000-00000000000a');
insert into public.plans (kitchen_id, name, slots, diet, price_per_meal_paise)
values ('e2100000-0000-4000-e000-00000000000a', 'Veg Lunch', '{lunch}', 'veg', 8000);

update public.platform_settings set enabled = false where key = any (private.phase_flag_keys());
update public.platform_settings set enabled = true where key in ('marketplace', 'growth');

-- ===========================================================================
-- Lead pick: marketplace needs customer WhatsApp too (D-188)
-- ===========================================================================
set local role service_role;
select set_config('request.headers', '{"x-tiffin-client-ip":"192.0.2.210"}', true);
insert into t select 'lead', public.submit_lead('Konark Lead', '9321100001', p_lat => 19.8880, p_lng => 86.0950, p_consent => true);
select is((select v -> 'kitchens' -> 0 ->> 'name' from t where k = 'lead'), 'Merge Konark Kitchen', 'the shortlist shows the kitchen');
select throws_ok(format($$ select public.lead_choose(%L, 'e2100000-0000-4000-e000-00000000000a') $$, (select v ->> 'token' from t where k = 'lead')),
  '22023', 'feature_disabled', 'marketplace on, customer WhatsApp off: the pick is refused instead of a confirmation that never arrives');
reset role;
select is((select count(*) from public.notifications_outbox o join public.leads l on l.id = o.recipient_id
           where o.template = 'lead_confirm' and l.phone_last4 = '0001' and o.recipient_type = 'lead'), 0::bigint,
  'and nothing is queued');

update public.platform_settings set enabled = true where key = 'customer_whatsapp';
set local role service_role;
select is((public.lead_choose((select v ->> 'token' from t where k = 'lead'), 'e2100000-0000-4000-e000-00000000000a') ->> 'status'),
  'confirm_sent', 'with both flags on the pick sends the confirmation (safety)');
reset role;
select is((select o.status from public.notifications_outbox o join public.leads l on l.id = o.recipient_id
           where o.template = 'lead_confirm' and o.recipient_type = 'lead' and l.phone_last4 = '0001'), 'pending',
  'and the confirmation is queued, not cancelled by wave 2''s gate');

-- ===========================================================================
-- Wave 2's shared-phone customer page behind safety's gate and revocable links
-- ===========================================================================
insert into t select 'elder', to_jsonb(private.insert_customer('e2100000-0000-4000-e000-00000000000a', 'Elder Share', '+919321100009', 'veg', 'en',
  null, '{"line1":"House 4","area":"Konark"}', 'vendor', 'vendor'));
insert into t select 'younger', to_jsonb(private.insert_customer('e2100000-0000-4000-e000-00000000000a', 'Younger Share', '+919321100009', 'veg', 'en',
  null, '{"line1":"House 4","area":"Konark"}', 'vendor', 'vendor'));
insert into t select 'elder_link', to_jsonb(private.issue_magic_link((select (v #>> '{}')::uuid from t where k = 'elder')));
insert into t select 'younger_link', to_jsonb(private.issue_magic_link((select (v #>> '{}')::uuid from t where k = 'younger')));
set local role anon;
select throws_ok(format($$ select public.portal_get(%L) $$, (select v #>> '{}' from t where k = 'elder_link')), '22023', 'feature_disabled',
  'customer_portal off: no customer page (safety)');
reset role;
update public.platform_settings set enabled = true where key = 'customer_portal';
set local role anon;
select is((public.portal_get((select v #>> '{}' from t where k = 'elder_link')) #>> '{customer,name}'), 'Elder Share',
  'customer_portal on: each sibling on the shared phone opens their own page (wave 2)');
select is((public.portal_get((select v #>> '{}' from t where k = 'younger_link')) #>> '{customer,name}'), 'Younger Share',
  'and the other sibling''s page shows the other customer');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e2100000-0000-4000-e000-000000000001","role":"authenticated"}', true);
select lives_ok(format($$ select public.revoke_customer_page_links(%L) $$, (select v #>> '{}' from t where k = 'elder')),
  'the owner revokes the elder sibling''s links');
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
select throws_ok(format($$ select public.portal_get(%L) $$, (select v #>> '{}' from t where k = 'elder_link')), null, null,
  'a revoked link no longer opens (safety)');
select is((public.portal_get((select v #>> '{}' from t where k = 'younger_link')) #>> '{customer,name}'), 'Younger Share',
  'the sibling''s own link keeps working (D-118)');
reset role;

-- ===========================================================================
-- transfer_failed has its own push text (riders + safety)
-- ===========================================================================
select is(private.member_alert_text('transfer_failed', '{"amount_paise": 182000, "error": "Linked account is not active"}', 'Konark') ->> 'title',
  'Bank transfer failed', 'a failed Route transfer is named in the owner''s push alert');

select * from finish();
rollback;
