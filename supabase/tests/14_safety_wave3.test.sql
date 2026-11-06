-- Vendor-first wave 3 (safety): phase flags and the gated entry points (item 27), revocable
-- customer-page links (37), refund claims (38), public forms (39), Route transfers (40), verified vs
-- listed (41) and vendor terms (33). Roles: owner, staff, rider, other kitchen, admin, anon.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select set_config('app.now', '2026-11-12 10:00:00+05:30', true);

-- Seed users (supabase/seed.sql)
--   owner A ...001, staff A ...002, rider A ...003, owner B ...011, admin ...099
create temp table t (k text primary key, v jsonb);
grant select, insert, update on t to anon, authenticated, service_role;

-- A kitchen far from the seed kitchens (Puri), live on the platform, with one existing customer.
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'f3000000-0000-4000-f000-000000000001', 'authenticated', 'authenticated', '919777300001', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f3000000-0000-4000-f000-000000000002', 'authenticated', 'authenticated', '919777300002', now(), now(), now());
insert into public.kitchens (id, name, slug, owner_id, lat, lng, service_radius_km, fssai_no, capacity_lunch, status, verified_at,
                             accepts_platform_leads) values
  ('85000000-0000-4000-f000-000000000001', 'Puri Rasoi', 'puri-rasoi', 'f3000000-0000-4000-f000-000000000001', 19.8135, 85.8312, 5,
   '12026001008881', 30, 'active', now(), true),
  ('85000000-0000-4000-f000-000000000002', 'Puri Draft', 'puri-draft', 'f3000000-0000-4000-f000-000000000002', 19.8100, 85.8300, 5,
   '12026001008882', 30, 'draft', null, true);
insert into public.members (kitchen_id, user_id, role) values
  ('85000000-0000-4000-f000-000000000001', 'f3000000-0000-4000-f000-000000000001', 'owner'),
  ('85000000-0000-4000-f000-000000000002', 'f3000000-0000-4000-f000-000000000002', 'owner');
insert into public.kitchen_settings (kitchen_id) values ('85000000-0000-4000-f000-000000000001'), ('85000000-0000-4000-f000-000000000002');
insert into public.kitchen_payout_accounts (kitchen_id) values ('85000000-0000-4000-f000-000000000001'), ('85000000-0000-4000-f000-000000000002');
insert into public.plans (kitchen_id, name, slots, diet, price_per_meal_paise)
values ('85000000-0000-4000-f000-000000000001', 'Veg Lunch', '{lunch}', 'veg', 8000);
insert into public.customers (kitchen_id, name, phone_enc, phone_hash, phone_last4, consent_at, consent_basis)
values ('85000000-0000-4000-f000-000000000001', 'Existing Eater', private.encrypt_phone('+919777300101'),
        private.phone_hash('+919777300101'), '0101', now(), 'vendor_attested');

-- Every phase flag off (as in production), whatever the seed or an earlier run left.
update public.platform_settings set enabled = false where key = any (private.phase_flag_keys());

-- ===========================================================================
-- Item 27: feature_flags() and the gates
-- ===========================================================================
set local role anon;
select is(public.feature_flags(),
  '{"customer_whatsapp": false, "customer_portal": false, "online_payments": false, "marketplace": false, "growth": false, "extras": false, "kitchen_switching": false}'::jsonb,
  'anon reads the phase flags: all off');
reset role;
delete from public.platform_settings where key = 'extras';
select is(public.feature_flags() ->> 'extras', 'false', 'a missing flag counts as off');
insert into public.platform_settings (key, enabled) values ('extras', false);
select ok(not (public.feature_flags() ? 'retention') and not (public.feature_flags() ? 'min_app_version'),
  'only the phase switches are exposed');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select is((public.feature_flags() ->> 'marketplace'), 'false', 'signed-in users read them too');
select throws_ok($$ select public.admin_set_platform_flag('marketplace', true) $$, '42501', 'forbidden', 'an owner cannot switch a flag');
reset role;

-- With every flag off, each gated entry point refuses.
set local role anon;
select throws_ok($$ select public.kitchen_directory('Patia') $$, '22023', 'feature_disabled', 'marketplace off: no public directory');
select throws_ok($$ select public.kitchen_profile('puri-rasoi') $$, '22023', 'feature_disabled', 'marketplace off: no public kitchen page');
select throws_ok($$ select public.lead_confirm('x') $$, '22023', 'feature_disabled', 'marketplace off: no lead confirmation');
select throws_ok($$ select public.submit_lead('Asha', '9777300201', 'Patia', p_consent => true) $$, '42501', null,
  'anon cannot call the lead form directly any more (public-forms Edge Function only)');
select throws_ok($$ select public.submit_vendor_application('Gita', '9777300202', p_consent => true) $$, '42501', null,
  'nor the vendor form');
select throws_ok($$ select public.lead_choose('x', '85000000-0000-4000-f000-000000000001') $$, '42501', null, 'nor the kitchen pick');
reset role;
set local role service_role;
select throws_ok($$ select public.submit_lead('Asha', '9777300201', 'Patia', p_consent => true) $$, '22023', 'feature_disabled',
  'marketplace off: the lead form refuses');
select throws_ok($$ select public.lead_choose('x', '85000000-0000-4000-f000-000000000001') $$, '22023', 'feature_disabled',
  'marketplace off: picking a kitchen refuses');
select throws_ok($$ select public.submit_vendor_application('Gita', '9777300202', p_consent => true) $$, '22023', 'feature_disabled',
  'growth off: the vendor form refuses');
reset role;
insert into t select 'eater', to_jsonb((select id from public.customers where name = 'Existing Eater'));
insert into t select 'page', to_jsonb(private.issue_magic_link((select id from public.customers where name = 'Existing Eater')));
set local role anon;
select throws_ok(format($$ select public.portal_get(%L) $$, (select v #>> '{}' from t where k = 'page')), '22023', 'feature_disabled',
  'customer_portal off: the customer page refuses even a valid link');
select throws_ok(format($$ select public.portal_review(%L, 5) $$, (select v #>> '{}' from t where k = 'page')), '22023', 'feature_disabled',
  'and so does every other portal function');
reset role;
update public.kitchen_payout_accounts set razorpay_linked_account_id = 'acc_Puri0001', kyc_status = 'verified'
where kitchen_id = '85000000-0000-4000-f000-000000000001';
insert into public.subscriptions (kitchen_id, customer_id, plan_id, start_date, status)
select '85000000-0000-4000-f000-000000000001', c.id, p.id, '2026-11-13', 'active'
from public.customers c, public.plans p where c.name = 'Existing Eater' and p.kitchen_id = '85000000-0000-4000-f000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.create_payment_link_record((select id from public.customers where name = 'Existing Eater'), 5) $$,
  '22023', 'feature_disabled', 'online_payments off: an owner cannot create a payment link');
reset role;
select throws_ok($$ select private.payment_link_record((select id from public.customers where name = 'Existing Eater'), 5, null) $$,
  '22023', 'feature_disabled', 'nor can the WhatsApp bot or the customer page (one shared function)');

-- The platform team switches them on.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select lives_ok($$ select public.admin_set_platform_flag(k, true) from unnest(array['marketplace', 'growth', 'customer_portal', 'online_payments']) k $$,
  'an admin switches the Phase 2 flags on');
reset role;
set local role anon;
select is((public.feature_flags() ->> 'marketplace'), 'true', 'the apps see it at once');
select ok(jsonb_typeof(public.kitchen_directory(null)) = 'array', 'marketplace on: the directory answers');
select is((public.kitchen_profile('puri-rasoi') ->> 'name'), 'Puri Rasoi', 'and the kitchen page');
select ok(not (public.kitchen_profile('puri-rasoi') ? 'lat'), 'which no longer returns the kitchen''s location');
select lives_ok(format($$ select public.portal_get(%L) $$, (select v #>> '{}' from t where k = 'page')), 'customer_portal on: the page opens');
reset role;
select is((private.payment_link_record((select id from public.customers where name = 'Existing Eater'), 5, null) ->> 'amount_paise')::int, 40000,
  'online_payments on: payment links work again');

-- ===========================================================================
-- Item 37: revocable customer-page links
-- ===========================================================================
-- Two more links (bot "my page", a payer message), then the owner shares one: 4 issued.
select ok(private.issue_magic_link((select id from public.customers where name = 'Existing Eater')) <> private.issue_magic_link((select id from public.customers where name = 'Existing Eater')),
  'every link is a new random token');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
insert into t select 'link1', to_jsonb(public.customer_page_link((select (v #>> '{}')::uuid from t where k = 'eater')));
select is((public.customer_page_links((select (v #>> '{}')::uuid from t where k = 'eater')) ->> 'live')::int, 3,
  'the owner sees how many links are live (at most 3)');
reset role;
select is((select count(*) from public.customer_magic_links l join public.customers c on c.id = l.customer_id
           where c.name = 'Existing Eater' and l.revoked_at is null), 3::bigint, 'issuing more than 3 links revokes the oldest');
-- Each role is refused.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.revoke_customer_page_links((select (v #>> '{}')::uuid from t where k = 'eater')) $$,
  '42501', 'forbidden', 'another kitchen''s owner cannot revoke the links');
select throws_ok($$ select public.rotate_customer_page_link((select (v #>> '{}')::uuid from t where k = 'eater')) $$,
  '42501', 'forbidden', 'nor rotate them');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$ select public.revoke_customer_page_links((select (v #>> '{}')::uuid from t where k = 'eater')) $$,
  '42501', 'forbidden', 'admins read, they do not revoke a kitchen''s links');
reset role;
-- Staff and rider of kitchen A on a kitchen-A customer.
insert into t select 'custA', to_jsonb((select id from public.customers where kitchen_id = '10000000-0000-4000-a000-00000000000a'
                                        and deleted_at is null order by created_at limit 1));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.revoke_customer_page_links((select (v #>> '{}')::uuid from t where k = 'custA')) $$,
  '42501', 'forbidden', 'staff cannot revoke links');
select throws_ok($$ select public.customer_page_links((select (v #>> '{}')::uuid from t where k = 'custA')) $$,
  '42501', 'forbidden', 'or list them');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.rotate_customer_page_link((select (v #>> '{}')::uuid from t where k = 'custA')) $$,
  '42501', 'forbidden', 'riders cannot rotate links');
reset role;
set local role anon;
select throws_ok($$ select public.revoke_customer_page_links((select (v #>> '{}')::uuid from t where k = 'custA')) $$,
  '42501', null, 'anon cannot call it');
reset role;
-- The owner revokes: the old link stops working at once.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is(public.revoke_customer_page_links((select (v #>> '{}')::uuid from t where k = 'eater')), 3, 'the owner revokes every live link');
reset role;
set local role anon;
select throws_ok(format($$ select public.portal_get(%L) $$, (select v #>> '{}' from t where k = 'link1')), '28000', 'invalid_link',
  'after a revoke the old link is refused');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
insert into t select 'link2', to_jsonb(public.rotate_customer_page_link((select (v #>> '{}')::uuid from t where k = 'eater')));
reset role;
set local role anon;
select lives_ok(format($$ select public.portal_get(%L) $$, (select v #>> '{}' from t where k = 'link2')), 'rotate hands out one new working link');
reset role;
select is((select count(*) from public.customer_magic_links l join public.customers c on c.id = l.customer_id
           where c.name = 'Existing Eater' and l.revoked_at is null), 1::bigint, 'and only that one is live');

-- ===========================================================================
-- Item 38: a refund is claimed before Razorpay is called
-- ===========================================================================
do $$
declare v_c uuid := (select id from public.customers where name = 'Existing Eater');
        v_p uuid;
begin
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, razorpay_payment_id, paid_at, created_at)
  values ('85000000-0000-4000-f000-000000000001', v_c, 'razorpay_link', 'paid', 40000, 5, 'pay_refund_test', private.now(), private.now())
  returning id into v_p;
  insert into public.refunds (id, kitchen_id, customer_id, meals, amount_paise, payment_id, reason) values
    ('86000000-0000-4000-f000-000000000001', '85000000-0000-4000-f000-000000000001', v_c, 1, 8000, v_p, 'test one'),
    ('86000000-0000-4000-f000-000000000002', '85000000-0000-4000-f000-000000000001', v_c, 1, 8000, v_p, 'test two');
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.claim_refund_for_gateway('86000000-0000-4000-f000-000000000001') $$, '42501', 'forbidden',
  'another kitchen''s owner cannot claim the refund');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$ select public.claim_refund_for_gateway('86000000-0000-4000-f000-000000000001') $$, '42501', 'forbidden',
  'nor can an admin');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((public.claim_refund_for_gateway('86000000-0000-4000-f000-000000000001') ->> 'razorpay_payment_id'), 'pay_refund_test',
  'the owner claims the refund for the gateway');
select throws_ok($$ select public.claim_refund_for_gateway('86000000-0000-4000-f000-000000000001') $$, '55P03', 'refund_in_progress',
  'a second click (or a second tab) is refused: one gateway refund');
select throws_ok($$ select public.release_refund_claim('86000000-0000-4000-f000-000000000001', 'x') $$, '42501', null,
  'users cannot release a claim (service role only)');
select throws_ok($$ select public.mark_refund_submitted('86000000-0000-4000-f000-000000000001', 'rfnd_x') $$, '42501', null,
  'or mark it submitted');
reset role;
select is((select status::text || '/' || method::text from public.refunds where id = '86000000-0000-4000-f000-000000000001'),
  'processing/razorpay', 'the claimed refund is processing');
select ok(public.mark_refund_submitted('86000000-0000-4000-f000-000000000001', 'rfnd_test_1'), 'the function records Razorpay''s refund id');
select is((select razorpay_refund_id from public.refunds where id = '86000000-0000-4000-f000-000000000001'), 'rfnd_test_1', 'kept on the row');
select ok(not public.mark_refund_submitted('86000000-0000-4000-f000-000000000001', 'rfnd_other'), 'a different refund id is not accepted');
-- A definite gateway refusal releases the claim; a stale claim can be taken again.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.claim_refund_for_gateway('86000000-0000-4000-f000-000000000002') $$, 'the second refund is claimed');
reset role;
select ok(public.release_refund_claim('86000000-0000-4000-f000-000000000002', 'BAD_REQUEST_ERROR'), 'Razorpay refused it: the claim is released');
select is((select status::text || '/' || gateway_error from public.refunds where id = '86000000-0000-4000-f000-000000000002'),
  'failed/BAD_REQUEST_ERROR', 'and the refund is failed with the reason');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.claim_refund_for_gateway('86000000-0000-4000-f000-000000000002') $$, 'a failed refund can be claimed again');
reset role;
update public.refunds set gateway_claimed_at = private.now() - interval '20 minutes' where id = '86000000-0000-4000-f000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select public.claim_refund_for_gateway('86000000-0000-4000-f000-000000000002') $$,
  'a claim left without a Razorpay id for 15 minutes is stale and can be taken again');
reset role;

-- ===========================================================================
-- Item 39: public forms (rate limits, token expiry, no phone oracle)
-- ===========================================================================
set local role service_role;
select set_config('request.headers', '{"x-tiffin-client-ip":"203.0.113.9"}', true);
select throws_ok($$ select public.submit_lead('Nowhere', '9777300301', 'Atlantis', p_consent => true) $$, '22023', 'location_required',
  'the lead form needs a known area or a shared location');
do $$ begin
  for i in 1..5 loop
    perform public.submit_vendor_application('Vendor ' || i, '97773004' || lpad(i::text, 2, '0'), p_consent => true);
  end loop;
end $$;
select throws_ok($$ select public.submit_vendor_application('Vendor 6', '9777300406', p_consent => true) $$, '22023', 'rate_limited',
  'a sixth vendor application from one IP within the hour is refused');
select set_config('request.headers', '{"x-tiffin-client-ip":"198.51.100.7"}', true);
select lives_ok($$ select public.submit_vendor_application('Vendor 6', '9777300406', p_consent => true) $$, 'another IP is not affected');
select lives_ok($$ select public.submit_vendor_application('Vendor 6', '9777300406', p_consent => true) $$, 'the same phone again (2)');
select set_config('request.headers', '{"x-tiffin-client-ip":"198.51.100.8"}', true);
select lives_ok($$ select public.submit_vendor_application('Vendor 6', '9777300406', p_consent => true) $$, 'the same phone again (3)');
select throws_ok($$ select public.submit_vendor_application('Vendor 6', '9777300406', p_consent => true) $$, '22023', 'too_many_requests',
  'a fourth application from one phone in a day is refused, whatever the IP');
reset role;
select ok((select count(*) from public.rate_limit_hits where subject_hash like '%203.0.113.9%') = 0, 'IPs are stored only as keyed hashes');
select is((select count(*) from public.rate_limit_hits h where h.bucket = 'vendor_app_ip_hour'), 3::bigint, 'one counter per IP and window');

set local role service_role;
select set_config('request.headers', '{"x-tiffin-client-ip":"192.0.2.10"}', true);
do $$ begin
  for i in 1..10 loop
    perform public.submit_lead('Lead ' || i, '97773005' || lpad(i::text, 2, '0'), p_lat => 19.8140, p_lng => 85.8320, p_consent => true);
  end loop;
end $$;
select throws_ok($$ select public.submit_lead('Lead 11', '9777300511', p_lat => 19.8140, p_lng => 85.8320, p_consent => true) $$,
  '22023', 'rate_limited', 'an eleventh lead from one IP within the hour is refused');
-- No oracle: a stranger types the number of the kitchen's existing customer, and a fresh number.
select set_config('request.headers', '{"x-tiffin-client-ip":"192.0.2.11"}', true);
insert into t select 'known', public.submit_lead('Someone', '9777300101', p_lat => 19.8140, p_lng => 85.8320, p_consent => true);
insert into t select 'fresh', public.submit_lead('Someone', '9777300601', p_lat => 19.8140, p_lng => 85.8320, p_consent => true);
select is((select v -> 'kitchens' -> 0 ->> 'name' from t where k = 'known'), 'Puri Rasoi', 'the shortlist shows the kitchen');
insert into t select 'known_pick', public.lead_choose((select v ->> 'token' from t where k = 'known'), '85000000-0000-4000-f000-000000000001');
insert into t select 'fresh_pick', public.lead_choose((select v ->> 'token' from t where k = 'fresh'), '85000000-0000-4000-f000-000000000001');
select is((select v - 'phone_last4' from t where k = 'known_pick'), (select v - 'phone_last4' from t where k = 'fresh_pick'),
  'picking answers exactly the same for an existing customer''s number and a new one');
reset role;
select is((select count(*) from public.notifications_outbox where template = 'lead_confirm' and recipient_type = 'lead'
           and recipient_id in (select id from public.leads where phone_last4 in ('0101', '0601'))), 2::bigint,
  'both phones get the confirmation link on WhatsApp');
insert into t select 'known_confirm', jsonb_build_object('token', substring(o.payload ->> 'url' from '/find/confirm/(.+)$'))
from public.notifications_outbox o join public.leads l on l.id = o.recipient_id
where o.template = 'lead_confirm' and l.phone_last4 = '0101';
set local role anon;
select throws_ok(format($$ select public.lead_confirm(%L) $$, (select v ->> 'token' from t where k = 'known_confirm')), '23505', 'already_customer',
  'only whoever holds the phone learns it is already the kitchen''s customer');
reset role;
-- The website token expires after a day.
select set_config('app.now', '2026-11-13 10:30:00+05:30', true);
set local role service_role;
select set_config('request.headers', '{"x-tiffin-client-ip":"192.0.2.12"}', true);
select throws_ok(format($$ select public.lead_choose(%L, '85000000-0000-4000-f000-000000000001') $$, (select v ->> 'token' from t where k = 'fresh')),
  '22023', 'invalid_link', 'a lead token older than 24 hours is refused');
reset role;
select set_config('app.now', '2026-11-12 10:00:00+05:30', true);
-- A kitchen that stops taking platform customers is not converted into, even from an earlier pick.
update public.kitchens set accepts_platform_leads = false where id = '85000000-0000-4000-f000-000000000001';
insert into t select 'fresh_confirm', jsonb_build_object('token', substring(o.payload ->> 'url' from '/find/confirm/(.+)$'))
from public.notifications_outbox o join public.leads l on l.id = o.recipient_id
where o.template = 'lead_confirm' and l.phone_last4 = '0601';
set local role anon;
select throws_ok(format($$ select public.lead_confirm(%L) $$, (select v ->> 'token' from t where k = 'fresh_confirm')), '22023', 'kitchen_not_available',
  'a kitchen that opted out after the pick is not converted into');
reset role;
update public.kitchens set accepts_platform_leads = true where id = '85000000-0000-4000-f000-000000000001';

-- ===========================================================================
-- Item 33: vendor terms and the data processing agreement
-- ===========================================================================
insert into t select 'versions', private.vendor_terms_versions();
select is((select count(*) from public.consents where kitchen_id = '10000000-0000-4000-a000-00000000000a' and customer_id is null), 2::bigint,
  'the seed kitchens accepted the current drafts');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((public.vendor_terms_status('85000000-0000-4000-f000-000000000001') ->> 'accepted'), 'false', 'a new kitchen has not accepted yet');
select throws_ok($$ select public.accept_vendor_terms('85000000-0000-4000-f000-000000000001', 'old', 'old') $$, '22023', 'terms_outdated',
  'accepting a version that is not the current one is refused');
select throws_ok(format($$ select public.accept_vendor_terms('85000000-0000-4000-f000-000000000001', %L, %L, 'fax') $$,
  (select v ->> 'vendor_terms' from t where k = 'versions'), (select v ->> 'data_processing' from t where k = 'versions')), '22023', 'invalid_channel',
  'channel is web or app');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((public.accept_vendor_terms('85000000-0000-4000-f000-000000000001', (select v ->> 'vendor_terms' from t where k = 'versions'),
  (select v ->> 'data_processing' from t where k = 'versions'), 'app') ->> 'accepted'), 'true', 'the owner accepts both documents');
select lives_ok(format($$ select public.accept_vendor_terms('85000000-0000-4000-f000-000000000001', %L, %L) $$,
  (select v ->> 'vendor_terms' from t where k = 'versions'), (select v ->> 'data_processing' from t where k = 'versions')),
  'accepting again changes nothing');
reset role;
select is((select string_agg(purpose || ':' || basis || ':' || channel || ':' || (recorded_by = 'f3000000-0000-4000-f000-000000000001')::text, ',' order by purpose)
           from public.consents where kitchen_id = '85000000-0000-4000-f000-000000000001' and customer_id is null),
  'data_processing:kitchen_owner:app:true,vendor_terms:kitchen_owner:app:true',
  'recorded once each in consents: by the owner, with the channel and version');
select ok((select count(*) from public.audit_log where table_name = 'consents' and kitchen_id = '85000000-0000-4000-f000-000000000001') >= 2,
  'and audited');
select throws_ok($$ insert into public.consents (kitchen_id, customer_id, purpose, basis, channel)
                    select '85000000-0000-4000-f000-000000000001', id, 'vendor_terms', 'kitchen_owner', 'web'
                    from public.customers where name = 'Existing Eater' $$, '23514', null,
  'a kitchen agreement cannot be attached to a customer');
-- Roles.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated"}', true);
select throws_ok(format($$ select public.accept_vendor_terms('10000000-0000-4000-a000-00000000000a', %L, %L) $$,
  (select v ->> 'vendor_terms' from t where k = 'versions'), (select v ->> 'data_processing' from t where k = 'versions')), '42501', 'forbidden',
  'staff cannot accept the kitchen''s contract');
select throws_ok($$ select public.vendor_terms_status('10000000-0000-4000-a000-00000000000a') $$, '42501', 'forbidden', 'or read its status');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.vendor_terms_status('10000000-0000-4000-a000-00000000000a') $$, '42501', 'forbidden', 'riders neither');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select throws_ok(format($$ select public.accept_vendor_terms('85000000-0000-4000-f000-000000000002', %L, %L) $$,
  (select v ->> 'vendor_terms' from t where k = 'versions'), (select v ->> 'data_processing' from t where k = 'versions')), '42501', 'forbidden',
  'another kitchen''s owner cannot accept for it');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok(format($$ select public.accept_vendor_terms('85000000-0000-4000-f000-000000000002', %L, %L) $$,
  (select v ->> 'vendor_terms' from t where k = 'versions'), (select v ->> 'data_processing' from t where k = 'versions')), '42501', 'forbidden',
  'nor can an admin');
select ok((select count(*) from public.consents where kitchen_id = '85000000-0000-4000-f000-000000000001' and customer_id is null) = 2,
  'admins read the kitchen''s agreements (consents select policy)');
reset role;
set local role anon;
select throws_ok($$ select public.vendor_terms_status('10000000-0000-4000-a000-00000000000a') $$, '42501', null, 'anon cannot call it');
reset role;

-- ===========================================================================
-- Item 41: verified is separate from listed
-- ===========================================================================
select is((select count(*) from public.kitchens where status = 'active' and verified_at is null), 0::bigint, 'every listed kitchen is verified');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select throws_ok($$ select public.set_kitchen_status('85000000-0000-4000-f000-000000000002', 'active') $$, '22023', 'not_verified',
  'an unverified kitchen cannot be listed, even with an FSSAI number');
select throws_ok($$ select public.admin_verify_kitchen('10000000-0000-4000-a000-00000000000b', true) $$, '22023', 'fssai_required',
  'verification needs an FSSAI number');
select ok((public.admin_verify_kitchen('85000000-0000-4000-f000-000000000002', true, 'Certificate seen on call') ->> 'verified_at') is not null,
  'the platform team verifies a kitchen');
select is((select status::text from public.kitchens where id = '85000000-0000-4000-f000-000000000002'), 'draft', 'and it stays private');
select throws_ok($$ select public.admin_verify_kitchen('85000000-0000-4000-f000-000000000001', false) $$, '22023', 'kitchen_listed',
  'a listed kitchen cannot be un-verified (make it private first)');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ update public.kitchens set fssai_no = '12026001008899' where id = '85000000-0000-4000-f000-000000000002' $$,
  '42501', 'fssai_locked', 'once verified, the owner cannot change the FSSAI number (even while private)');
select throws_ok($$ update public.kitchens set verified_at = now() where id = '85000000-0000-4000-f000-000000000002' $$,
  '42501', null, 'owners cannot set verification themselves');
select throws_ok($$ select public.admin_verify_kitchen('85000000-0000-4000-f000-000000000002', true) $$, '42501', 'forbidden',
  'owners cannot verify');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.admin_verify_kitchen('10000000-0000-4000-a000-00000000000a', true) $$, '42501', 'forbidden', 'staff neither');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000003","role":"authenticated"}', true);
select throws_ok($$ select public.admin_verify_kitchen('10000000-0000-4000-a000-00000000000a', true) $$, '42501', 'forbidden', 'riders neither');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select lives_ok($$ select public.set_kitchen_status('85000000-0000-4000-f000-000000000002', 'active') $$, 'a verified kitchen can be listed');
reset role;
set local role anon;
select throws_ok($$ select public.admin_verify_kitchen('10000000-0000-4000-a000-00000000000a', true) $$, '42501', null, 'anon cannot call it');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select is((select verified_at is not null from public.kitchens where id = '85000000-0000-4000-f000-000000000001'), true,
  'the owner sees their kitchen is verified');
reset role;

-- ===========================================================================
-- Item 40: Route transfers are confirmed
-- ===========================================================================
create temp table tp (n integer primary key, id uuid);
grant select on tp to authenticated;
do $$
declare v_c uuid := (select id from public.customers where name = 'Existing Eater');
        i integer;
        v_rec jsonb;
begin
  for i in 1..3 loop
    v_rec := private.payment_link_record(v_c, 2, null);
    insert into tp values (i, (v_rec ->> 'payment_id')::uuid);
    perform public.razorpay_process_event('evt_w3_paid_' || i, jsonb_build_object('event', 'payment_link.paid', 'payload', jsonb_build_object(
      'payment_link', jsonb_build_object('entity', jsonb_build_object('id', 'plink_w3_' || i, 'reference_id', v_rec ->> 'payment_id')),
      'payment', jsonb_build_object('entity', jsonb_build_object('id', 'pay_w3_' || i, 'amount', 16000, 'currency', 'INR')))));
  end loop;
end $$;
select is((select string_agg(transfer_status, ',' order by tp.n) from tp join public.payments p on p.id = tp.id), 'pending,pending,pending',
  'a captured online payment waits for its Route transfer');
select is(public.razorpay_process_event('evt_w3_tr_1', jsonb_build_object('event', 'transfer.processed', 'payload', jsonb_build_object(
  'transfer', jsonb_build_object('entity', jsonb_build_object('id', 'trf_w3_1', 'source', 'order_x', 'recipient', 'acc_Puri0001',
    'amount', 16000, 'notes', jsonb_build_object('payment_id', (select id from tp where n = 1))))))), 'transfer_processed',
  'transfer.processed is matched through the payment id in its notes');
select is((select transfer_status || '/' || razorpay_transfer_id || '/' || transfer_account from public.payments where id = (select id from tp where n = 1)),
  'processed/trf_w3_1/acc_Puri0001', 'and records the transfer and the account it went to');
select is(public.razorpay_process_event('evt_w3_tr_1', '{"event":"transfer.processed"}'), 'duplicate', 'a repeated event is ignored');
select is(public.razorpay_process_event('evt_w3_tr_1s', jsonb_build_object('event', 'transfer.settled', 'payload', jsonb_build_object(
  'transfer', jsonb_build_object('entity', jsonb_build_object('id', 'trf_w3_1', 'source', 'pay_w3_1', 'recipient', 'acc_Puri0001'))))),
  'transfer_settled', 'settled');
select is(public.razorpay_process_event('evt_w3_tr_1p', jsonb_build_object('event', 'transfer.processed', 'payload', jsonb_build_object(
  'transfer', jsonb_build_object('entity', jsonb_build_object('id', 'trf_w3_1', 'source', 'pay_w3_1', 'recipient', 'acc_Puri0001'))))),
  'transfer_settled', 'a late processed event never steps back from settled');
select is(public.razorpay_process_event('evt_w3_tr_2', jsonb_build_object('event', 'transfer.failed', 'payload', jsonb_build_object(
  'transfer', jsonb_build_object('entity', jsonb_build_object('id', 'trf_w3_2', 'source', 'pay_w3_2', 'recipient', 'acc_Puri0001',
    'error', jsonb_build_object('description', 'Linked account not activated')))))), 'transfer_failed',
  'transfer.failed is matched on the Razorpay payment id');
select is((select count(*) from public.notifications_outbox where template = 'transfer_failed' and recipient_type = 'member'
           and recipient_id = 'f3000000-0000-4000-f000-000000000001'), 1::bigint, 'the owner is alerted');
select is(public.razorpay_process_event('evt_w3_tr_3', jsonb_build_object('event', 'transfer.processed', 'payload', jsonb_build_object(
  'transfer', jsonb_build_object('entity', jsonb_build_object('id', 'trf_w3_3', 'source', 'pay_w3_3', 'recipient', 'acc_SomeoneElse'))))),
  'transfer_account_mismatch', 'a transfer to another account than the kitchen''s is flagged');
select is(public.razorpay_process_event('evt_w3_tr_4', jsonb_build_object('event', 'transfer.processed', 'payload', jsonb_build_object(
  'transfer', jsonb_build_object('entity', jsonb_build_object('id', 'trf_w3_4', 'source', 'pay_unknown'))))), 'unmatched',
  'an unknown transfer is recorded as unmatched');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select is((select string_agg(x ->> 'reason', ',' order by x ->> 'reason') from jsonb_array_elements(public.admin_route_transfers()) x
           where (x ->> 'kitchen_id')::uuid = '85000000-0000-4000-f000-000000000001'), 'account_mismatch,failed',
  'the platform team sees the failed and mismatched transfers');
select set_config('request.jwt.claims', '{"sub":"f3000000-0000-4000-f000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_route_transfers() $$, '42501', 'forbidden', 'owners do not see the platform list');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.admin_route_transfers() $$, '42501', 'forbidden', 'staff neither');
reset role;
select set_config('app.now', '2026-11-14 10:00:00+05:30', true);
update public.payments set transfer_status = 'pending', transfer_account = null where id = (select id from tp where n = 3);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select ok(exists (select 1 from jsonb_array_elements(public.admin_route_transfers()) x
                  where (x ->> 'payment_id')::uuid = (select id from tp where n = 3) and x ->> 'reason' = 'overdue'),
  'a transfer still pending a day after capture shows as overdue');
reset role;

select * from finish();
rollback;
