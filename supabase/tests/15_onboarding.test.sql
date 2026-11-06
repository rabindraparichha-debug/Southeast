-- Wave 4: vendor onboarding and founder support (docs/VENDOR_FIRST_AUDIT.md Phase 1 steps 2, 4, 5, 7).
-- Approval gate for new kitchens (approved application, allowed number, open_vendor_signup flag),
-- Odia kitchen names, onboarding_status for invited staff, the admin_actions log, the admin kitchen
-- detail, phone change, ownership transfer, platform admins, dated plan prices charged at lock,
-- phoned-in complaints, "Export my kitchen" and close requests.
-- Roles: owner, staff, rider, another kitchen's owner, admin, anon.
-- Calendar: Mon 9 Nov 2026. Lunch cutoff 21:00 the day before.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ===========================================================================
-- Setup
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, u.confirmed, now(), now()
from (values
  ('f5000000-0000-4000-f000-000000000001'::uuid, '919555000001', now()),   -- applicant (application not approved yet)
  ('f5000000-0000-4000-f000-000000000002'::uuid, '919555000002', now()),   -- allowed number
  ('f5000000-0000-4000-f000-000000000003'::uuid, '919555000003', now()),   -- nobody: refused until the flag is on
  ('f5000000-0000-4000-f000-000000000004'::uuid, '919555000004', null),    -- allowed, but phone never confirmed
  ('f5000000-0000-4000-f000-000000000005'::uuid, '919555000005', now()),   -- invited staff (pending invite)
  ('f5000000-0000-4000-f000-000000000006'::uuid, '919555000006', now()),   -- allowed, but signed up with a password
  ('f5000000-0000-4000-f000-000000000011'::uuid, '919555000011', now()),   -- owner of kitchen K
  ('f5000000-0000-4000-f000-000000000012'::uuid, '919555000012', now()),   -- staff of K
  ('f5000000-0000-4000-f000-000000000013'::uuid, '919555000013', now()),   -- rider of K
  ('f5000000-0000-4000-f000-000000000014'::uuid, '919555000014', now())    -- staff of K, becomes owner
) as u(id, phone, confirmed);
-- What GoTrue stores for a phone + password sign-up (auto-confirmed when phone confirmations are off).
update auth.users set encrypted_password = crypt('hunter2hunter2', gen_salt('bf'))
where id = 'f5000000-0000-4000-f000-000000000006';

insert into public.kitchens (id, name, slug, owner_id, lat, lng, weekly_off) values
  ('85500000-0000-4000-f000-000000000001', 'Support Kitchen', 'support-kitchen', 'f5000000-0000-4000-f000-000000000011', 20.3553, 85.8197, '{}');
insert into public.kitchen_settings (kitchen_id, credit_limit_meals) values ('85500000-0000-4000-f000-000000000001', 100);
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('85500000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000011', 'owner', 'Owner K'),
  ('85500000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000012', 'staff', 'Staff K'),
  ('85500000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000013', 'rider', 'Rider K'),
  ('85500000-0000-4000-f000-000000000001', 'f5000000-0000-4000-f000-000000000014', 'staff', 'Next Owner');
insert into public.member_invites (kitchen_id, phone_e164, role, display_name)
values ('85500000-0000-4000-f000-000000000001', '+919555000005', 'staff', 'Invited Staff');
insert into public.plans (id, kitchen_id, name, slots, days_of_week, price_per_meal_paise) values
  ('85600000-0000-4000-f000-000000000001', '85500000-0000-4000-f000-000000000001', 'Lunch', '{lunch}', '{1,2,3,4,5,6,7}', 7000);

select set_config('app.now', '2026-11-09 08:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
create temp table vals (k text primary key, v jsonb);
grant select, insert, update on ids, vals to authenticated, anon;

do $$
declare
  v_c uuid;
  v_s uuid;
  i integer;
begin
  for i in 1..2 loop
    v_c := private.insert_customer('85500000-0000-4000-f000-000000000001', 'Support Customer ' || i, '+91955510000' || i, 'veg', 'en',
      null, jsonb_build_object('line1', 'House ' || i, 'area', 'Patia', 'lat', 20.3553 + i * 0.001, 'lng', 85.8197), 'vendor', 'vendor');
    insert into ids values ('c' || i, v_c);
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values ('85500000-0000-4000-f000-000000000001', v_c, '85600000-0000-4000-f000-000000000001',
            (select id from public.addresses where customer_id = v_c), '2026-11-09', 'active')
    returning id into v_s;
    insert into ids values ('s' || i, v_s);
  end loop;
end $$;

-- ===========================================================================
-- 1. Approval gate
-- ===========================================================================
-- wave 3 puts the application form behind the 'growth' switch; on in this test (no-op without it).
update public.platform_settings set enabled = true where key = 'growth';
insert into ids select 'app1', public.submit_vendor_application('Applicant One', '9555000001', 'Odia Rasoi', 'Patia', 20, p_consent => true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.create_kitchen('Odia Rasoi') $$, '42501', 'not_approved',
  'a phone whose application is not approved yet cannot create a kitchen');
select is(public.onboarding_status() -> 'application', '{"status":"new","approved":false}'::jsonb,
  'onboarding_status shows the application is waiting');
select is((public.onboarding_status() ->> 'can_create_kitchen')::boolean, false, 'and that a kitchen cannot be created yet');

-- Only admins approve.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_set_vendor_approval((select v from ids where k = 'app1')) $$, '42501', 'forbidden',
  'a kitchen owner cannot approve applications');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select lives_ok($$ select public.admin_set_vendor_approval((select v from ids where k = 'app1'), true, 'Called and checked FSSAI') $$,
  'the admin approves the application');
select is((select action || '/' || reason from public.admin_actions where target = (select v from ids where k = 'app1')::text),
  'vendor_approved/Called and checked FSSAI', 'the approval is in admin_actions with its reason');

select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is(public.onboarding_status() ->> 'basis', 'approved', 'the approved applicant may now create a kitchen');
insert into vals select 'k1', to_jsonb(public.create_kitchen('Odia Rasoi', p_area => 'Patia'));
select is((select v ->> 'slug' from vals where k = 'k1'), 'odia-rasoi', 'the approved number creates its kitchen');
reset role;
select is((select status::text || '/' || (approved_at is not null)::text from public.vendor_applications
           where id = (select v from ids where k = 'app1')), 'onboarding/true', 'the application follows the kitchen and stays approved');

-- Allowed numbers.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000002","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.create_kitchen('Allowed Kitchen') $$, '42501', 'not_approved', 'a number nobody approved is refused');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_allow_vendor_phone('9555000002', '  ') $$, '22023', 'reason_required',
  'allowing a number needs a note');
insert into ids select 'allow2', public.admin_allow_vendor_phone('95550 00002', 'Pilot vendor, met in Patia');
insert into ids select 'allow4', public.admin_allow_vendor_phone('9555000004', 'Pilot vendor two');
insert into ids select 'allow6', public.admin_allow_vendor_phone('9555000006', 'Pilot vendor three');
select throws_ok($$ select public.admin_allow_vendor_phone('+919555000002', 'Again') $$, '23505', 'already_exists',
  'a number is allowed once');
select ok((select bool_or(x ->> 'phone' = '+91 ••••••0002' and x ->> 'note' = 'Pilot vendor, met in Patia')
           from jsonb_array_elements(public.admin_vendor_phones()) x), 'the allowed list shows the masked number and the note');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_vendor_phones() $$, '42501', 'forbidden', 'owners cannot read the allowed numbers');
select throws_ok($$ select public.admin_allow_vendor_phone('9555000003', 'me') $$, '42501', 'forbidden', 'or add one');
select throws_ok($$ select count(*) from public.vendor_allowed_phones $$, '42501', null, 'the allowed numbers table is closed to vendors');
-- A proven phone only: a password login on the allowed number (amr 'password') is refused.
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000002","role":"authenticated","amr":[{"method":"password","timestamp":0}]}', true);
select throws_ok($$ select public.create_kitchen('Allowed Kitchen') $$, '42501', 'not_approved',
  'a session not signed in with a one-time code does not count, even on an allowed number');
select is(public.onboarding_status() ->> 'login_with_code', 'true', 'onboarding_status asks for a login with a code');
select is(public.onboarding_status() ->> 'can_create_kitchen', 'false', 'and offers no kitchen');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select public.create_kitchen('Allowed Kitchen') $$, '42501', 'not_approved', 'nor does a session without amr');
-- Someone registered the allowed number with a password; the real vendor logs in with a code and
-- creates the kitchen. The password is replaced and every other session ends.
reset role;
insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('f5000000-0000-4000-5000-000000000061', 'f5000000-0000-4000-f000-000000000006', now(), now()),  -- the stranger
  ('f5000000-0000-4000-5000-000000000062', 'f5000000-0000-4000-f000-000000000006', now(), now());  -- the vendor
insert into vals select 'pw6', to_jsonb(encrypted_password) from auth.users where id = 'f5000000-0000-4000-f000-000000000006';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000006","role":"authenticated","amr":[{"method":"password","timestamp":0}]}', true);
select throws_ok($$ select public.create_kitchen('Password Kitchen') $$, '42501', 'not_approved',
  'the stranger''s password login cannot create the kitchen');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000006","session_id":"f5000000-0000-4000-5000-000000000062","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select lives_ok($$ select public.create_kitchen('Password Kitchen') $$, 'the vendor''s code login creates it');
reset role;
select isnt((select to_jsonb(encrypted_password) from auth.users where id = 'f5000000-0000-4000-f000-000000000006'),
  (select v from vals where k = 'pw6'), 'the password someone set before is replaced by a random one');
select is((select array_agg(id::text) from auth.sessions where user_id = 'f5000000-0000-4000-f000-000000000006'),
  array['f5000000-0000-4000-5000-000000000062'], 'every other session ended; the vendor stays signed in');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000002","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is(public.onboarding_status() ->> 'login_with_code', 'false', 'an OTP login on an allowed number is fine');
select lives_ok($$ select public.create_kitchen('Allowed Kitchen') $$, 'an allowed number creates a kitchen');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000004","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.create_kitchen('Unconfirmed Kitchen') $$, '42501', 'not_approved',
  'an allowed number counts only once the phone is confirmed');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select lives_ok($$ select public.admin_remove_vendor_phone((select v from ids where k = 'allow4'), 'Changed their mind') $$,
  'the admin removes an allowed number');
select is((select count(*) from public.admin_actions where action in ('vendor_phone_allowed', 'vendor_phone_removed')), 4::bigint,
  'adding and removing numbers is logged');

-- The open-signup flag.
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.create_kitchen('Open Kitchen') $$, '42501', 'not_approved', 'refused while open_vendor_signup is off');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_set_platform_flag('open_vendor_signup', true) $$, '22023', 'use_vendor_signup',
  'the generic flag switch refuses open_vendor_signup (it needs a reason)');
select throws_ok($$ select public.admin_set_vendor_signup(true, ' ') $$, '22023', 'reason_required', 'opening signup needs a reason');
select lives_ok($$ select public.admin_set_vendor_signup(true, 'Pilot week in Patia') $$, 'the admin opens vendor signup');
select is((select action || '/' || reason from public.admin_actions where action like 'vendor_signup_%'),
  'vendor_signup_opened/Pilot week in Patia', 'opening signup is in admin_actions with its reason');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is(public.onboarding_status() ->> 'basis', 'open', 'onboarding_status says signup is open');
select lives_ok($$ select public.create_kitchen('Open Kitchen') $$, 'with the flag on anyone signed in can create a kitchen');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select lives_ok($$ select public.admin_set_vendor_signup(false, 'Pilot week over') $$, 'and closes it again');
select is((select count(*) from public.admin_actions where action in ('vendor_signup_opened', 'vendor_signup_closed')), 2::bigint,
  'both switches are logged');
reset role;
select is((select enabled from public.platform_settings where key = 'open_vendor_signup'), false, 'open_vendor_signup is off');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_set_vendor_signup(true, 'me') $$, '42501', 'forbidden', 'owners cannot open vendor signup');
-- An owner may add another kitchen only while one of theirs is in good standing.
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is(public.onboarding_status() ->> 'basis', 'owner', 'the owner of an active kitchen may add another');
reset role;
update public.kitchens set status = 'suspended' where name = 'Open Kitchen';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.create_kitchen('Fresh Start Kitchen') $$, '42501', 'not_approved',
  'an owner whose only kitchen is suspended cannot start a new one');
reset role;
update public.kitchens set status = 'draft' where name = 'Open Kitchen';
insert into public.kitchen_close_requests (kitchen_id, requested_by, status, created_at, resolved_at)
select id, owner_id, 'closed', now(), now() from public.kitchens where name = 'Open Kitchen';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000003","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.create_kitchen('Fresh Start Kitchen') $$, '42501', 'not_approved',
  'nor one whose only kitchen the platform team closed');
reset role;

-- Invited staff: onboarding_status reports the waiting invite until it is claimed.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000005","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is(public.onboarding_status() ->> 'pending_invites', '1', 'an invited person sees one waiting invite');
select is(public.onboarding_status() ->> 'memberships', '0', 'and no kitchen yet');
select is(public.claim_invites(), 1, 'claiming joins the kitchen');
select is(public.onboarding_status() - 'application' - 'basis' - 'phone_confirmed' - 'apply_open',
  '{"memberships": 1, "pending_invites": 0, "can_create_kitchen": false, "login_with_code": false}'::jsonb,
  'afterwards: one kitchen, nothing waiting');
select is(public.onboarding_status() ->> 'apply_open', 'true', 'the application form is reported open');
-- A password session sees no waiting invite (wave 2's claim_invites would not claim it either).
reset role;
insert into public.member_invites (kitchen_id, phone_e164, role, display_name)
values ('85500000-0000-4000-f000-000000000001', '+919555000006', 'rider', 'Password Rider');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000006","role":"authenticated","amr":[{"method":"password","timestamp":0}]}', true);
select is(public.onboarding_status() ->> 'pending_invites', '0',
  'a password session is not offered a waiting invite (no endless "still joining")');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000006","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is(public.onboarding_status() ->> 'pending_invites', '1', 'a code session is');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.onboarding_status() $$, '42501', null, 'anon cannot call onboarding_status');
reset role;

-- ===========================================================================
-- 2. Odia kitchen names
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000001","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into vals select 'odia', to_jsonb(public.create_kitchen('ମା ତାରିଣୀ ଟିଫିନ'));
select matches((select v ->> 'slug' from vals where k = 'odia'), '^kitchen-[0-9a-f]{6}$', 'an Odia-only name gets kitchen-<random>');
select is((select v ->> 'name' from vals where k = 'odia'), 'ମା ତାରିଣୀ ଟିଫିନ', 'and keeps its Odia name');
insert into vals select 'odia2', to_jsonb(public.create_kitchen('ମା'));
select matches((select v ->> 'slug' from vals where k = 'odia2'), '^kitchen-[0-9a-f]{6}$', 'a two-letter Odia name works too');
insert into vals select 'mixed', to_jsonb(public.create_kitchen('Maa ତାରିଣୀ'));
select is((select v ->> 'slug' from vals where k = 'mixed'), 'maa', 'mixed names keep their Latin part');
insert into vals select 'dup', to_jsonb(public.create_kitchen('Odia Rasoi'));
select matches((select v ->> 'slug' from vals where k = 'dup'), '^odia-rasoi-[0-9a-f]{4}$', 'a taken address gets a short suffix');
select throws_ok($$ select public.create_kitchen('A') $$, '22023', 'invalid_name', 'a one-letter name is a short error, not a constraint error');
select throws_ok($$ select public.create_kitchen('Good Name', p_fssai_no => '123') $$, '22023', 'invalid_fssai', 'a bad FSSAI number too');
select throws_ok($$ select public.create_kitchen('Good Name', 'ମା') $$, '22023', 'invalid_slug', 'an explicit address must have Latin letters');
reset role;

-- ===========================================================================
-- 3. Founder support
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into vals select 'detail', public.admin_kitchen_detail('85500000-0000-4000-f000-000000000001');
select is((select v #>> '{owner,phone}' from vals where k = 'detail'), '+91 ••••••0011', 'the detail shows the owner''s masked phone');
select is((select v #>> '{owner,name}' from vals where k = 'detail'), 'Owner K', 'and their name');
select is((select jsonb_array_length(v -> 'members') from vals where k = 'detail'), 5, 'the whole team (incl. the staff who just joined)');
select is((select v #>> '{signals,customers}' from vals where k = 'detail'), '2', 'and usage signals');
select is((select v #>> '{signals,live_subscriptions}' from vals where k = 'detail'), '2', 'live subscriptions');
select is(public.admin_reveal_member_phone('f5000000-0000-4000-f000-000000000011', '85500000-0000-4000-f000-000000000001'),
  '+919555000011', 'the admin reveals the owner''s number');
reset role;
select is((select count(*) from public.audit_log where action = 'ACCESS' and table_name = 'auth.users'
           and row_id = 'f5000000-0000-4000-f000-000000000011'), 1::bigint, 'the reveal is in the audit log');
select is((select count(*) from public.admin_actions where action = 'phone_revealed'
           and kitchen_id = '85500000-0000-4000-f000-000000000001'), 1::bigint, 'and in admin_actions');

-- Nobody else sees the detail.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_kitchen_detail('85500000-0000-4000-f000-000000000001') $$, '42501', 'forbidden', 'not even the owner');
select throws_ok($$ select public.admin_reveal_member_phone('f5000000-0000-4000-f000-000000000012') $$, '42501', 'forbidden', 'owner cannot reveal via admin');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000012","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_kitchen_detail('85500000-0000-4000-f000-000000000001') $$, '42501', 'forbidden', 'nor staff');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000013","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_kitchen_detail('85500000-0000-4000-f000-000000000001') $$, '42501', 'forbidden', 'nor riders');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_kitchen_detail('85500000-0000-4000-f000-000000000001') $$, '42501', 'forbidden', 'nor another kitchen');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.admin_kitchen_detail('85500000-0000-4000-f000-000000000001') $$, '42501', null, 'nor anon');
reset role;

-- Phone change (the Edge Function's database half).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_phone_change_check('f5000000-0000-4000-f000-000000000012', '9555000099', '') $$,
  '22023', 'reason_required', 'a phone change needs a reason');
select throws_ok($$ select public.admin_phone_change_check('f5000000-0000-4000-f000-000000000012', '9555000012', 'Lost SIM') $$,
  '22023', 'same_phone', 'the new number must differ');
select throws_ok($$ select public.admin_phone_change_check('f5000000-0000-4000-f000-000000000012', '9000000001', 'Lost SIM') $$,
  '23505', 'phone_in_use', 'and must not belong to someone else');
insert into vals select 'chg', public.admin_phone_change_check('f5000000-0000-4000-f000-000000000012', '95550 00099', 'Lost SIM');
select is((select v ->> 'new_phone' || '/' || (v ->> 'old_phone_last4') || '/' || (v ->> 'already_changed') from vals where k = 'chg'),
  '+919555000099/0012/false', 'a valid change is accepted and recorded as pending, old digits read on the server');
select throws_ok($$ select public.admin_phone_change_done((select (v ->> 'change_id')::uuid from vals where k = 'chg')) $$,
  '22023', 'phone_not_changed', 'nothing is logged unless the login''s phone really changed');
select throws_ok($$ select public.admin_phone_change_done(gen_random_uuid()) $$, 'P0002', 'not_found',
  'done only finishes a change that check recorded (no caller-chosen user, number or digits)');
reset role;
select is((select count(*) from public.admin_actions where action = 'member_phone_changed'), 0::bigint, 'nothing logged yet');
insert into auth.sessions (id, user_id, created_at, updated_at)
values (gen_random_uuid(), 'f5000000-0000-4000-f000-000000000012', now(), now());
update auth.users set phone = '919555000099' where id = 'f5000000-0000-4000-f000-000000000012';  -- what the Auth admin API does
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
-- The Auth half went through but the last step was lost: checking again resumes the same change.
select is(public.admin_phone_change_check('f5000000-0000-4000-f000-000000000012', '9555000099', 'Lost SIM, retry'),
  (select v || '{"already_changed": true}'::jsonb from vals where k = 'chg'),
  'a retry after the Auth change resumes the pending change instead of failing with same_phone');
select is(public.admin_phone_change_done((select (v ->> 'change_id')::uuid from vals where k = 'chg')) - 'user_id',
  '{"phone_last4": "0099", "signed_out": true, "already_done": false}'::jsonb,
  'after the change it is logged and the user is signed out everywhere');
select is(public.admin_phone_change_done((select (v ->> 'change_id')::uuid from vals where k = 'chg')) ->> 'already_done',
  'true', 'finishing it again only retries the sign-out');
select throws_ok($$ select public.admin_phone_change_check('f5000000-0000-4000-f000-000000000012', '9555000099', 'Lost SIM') $$,
  '22023', 'same_phone', 'once finished, the same number is simply the current one');
reset role;
select is((select count(*) from auth.sessions where user_id = 'f5000000-0000-4000-f000-000000000012'), 0::bigint, 'their sessions are gone');
select is((select string_agg(before ->> 'phone_last4' || '>' || (after ->> 'phone_last4') || '/' || reason, ',') from public.admin_actions
           where action = 'member_phone_changed' and kitchen_id = '85500000-0000-4000-f000-000000000001'),
  '0012>0099/Lost SIM', 'admin_actions records old and new last digits and the reason, once');

-- Sign out everywhere, on its own.
insert into auth.sessions (id, user_id, created_at, updated_at)
values (gen_random_uuid(), 'f5000000-0000-4000-f000-000000000013', now(), now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_sign_out_user('f5000000-0000-4000-f000-000000000013', '') $$, '22023', 'reason_required',
  'signing someone out needs a reason');
select is(public.admin_sign_out_user('f5000000-0000-4000-f000-000000000013', 'Phone stolen') ->> 'signed_out', 'true',
  'the admin signs the rider out everywhere');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_sign_out_user('f5000000-0000-4000-f000-000000000013', 'x') $$, '42501', 'forbidden',
  'owners cannot use it');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000012","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_sign_out_user('f5000000-0000-4000-f000-000000000013', 'x') $$, '42501', 'forbidden',
  'nor staff');
reset role;
select is((select count(*) from auth.sessions where user_id = 'f5000000-0000-4000-f000-000000000013'), 0::bigint, 'the rider''s sessions are gone');
select is((select reason from public.admin_actions where action = 'member_signed_out'), 'Phone stolen', 'and it is in admin_actions');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select count(*) from private.phone_changes $$, '42501', null, 'pending changes are not readable directly, not even by admins');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_phone_change_check('f5000000-0000-4000-f000-000000000012', '9555000098', 'x') $$,
  '42501', 'forbidden', 'owners cannot change phones');
reset role;

-- Ownership transfer.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_transfer_ownership('85500000-0000-4000-f000-000000000001',
  (select id from public.members where user_id = 'f5000000-0000-4000-f000-000000000014'), 'staff', null) $$,
  '22023', 'reason_required', 'a transfer needs a reason');
select throws_ok($$ select public.admin_transfer_ownership('85500000-0000-4000-f000-000000000001',
  (select id from public.members where user_id = 'f5000000-0000-4000-f000-000000000011'), 'staff', 'x') $$,
  '22023', 'already_owner', 'the owner cannot be made owner again');
select throws_ok($$ select public.admin_transfer_ownership('85500000-0000-4000-f000-000000000001',
  (select id from public.members where user_id = 'f5000000-0000-4000-f000-000000000014'), 'boss', 'x') $$,
  '22023', 'invalid_option', 'the old owner becomes staff or leaves');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_transfer_ownership('85500000-0000-4000-f000-000000000001',
  (select id from public.members where user_id = 'f5000000-0000-4000-f000-000000000014'), 'staff', 'x') $$,
  '42501', 'forbidden', 'an owner cannot hand over the kitchen through the admin tool');
reset role;

-- ===========================================================================
-- 4. Plan prices with a start date (before the ownership transfer: the owner sets them)
-- ===========================================================================
-- Tue 10 and Wed 11 lunch are locked at ₹70 first; they owe those meals.
select private.lock_slot('85500000-0000-4000-f000-000000000001', d::date, 'lunch')
from generate_series('2026-11-10'::date, '2026-11-11'::date, interval '1 day') d;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into vals select 'dues_before', to_jsonb(coalesce((select sum(amount_owed_paise) from public.dues_list('85500000-0000-4000-f000-000000000001')), 0));
select throws_ok($$ select public.set_plan_price('85600000-0000-4000-f000-000000000001', 8000, '2026-11-01') $$, '22023', 'date_in_past',
  'a price cannot start in the past');
select throws_ok($$ select public.set_plan_price('85600000-0000-4000-f000-000000000001', 0, '2026-11-12') $$, '22023', 'invalid_amount',
  'a price must be positive');
insert into vals select 'p12', public.set_plan_price('85600000-0000-4000-f000-000000000001', 8000, '2026-11-12');
select is((select (v ->> 'scheduled')::boolean from vals where k = 'p12'), true, '₹80 from Thursday 12 Nov is scheduled');
select is((select v -> 'charged_slots' from vals where k = 'p12'), '[]'::jsonb, 'no meal of Thursday is counted yet');
select is((select price_per_meal_paise from public.plans where id = '85600000-0000-4000-f000-000000000001'), 7000,
  'today''s price stays ₹70');
select is((select count(*) from public.plan_prices where plan_id = '85600000-0000-4000-f000-000000000001' and cancelled_at is null), 2::bigint,
  'the old price is kept as the baseline next to the scheduled one');
select is(to_jsonb(coalesce((select sum(amount_owed_paise) from public.dues_list('85500000-0000-4000-f000-000000000001')), 0)),
  (select v from vals where k = 'dues_before'), 'scheduling a price (before it starts) changes nobody''s dues');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000012","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.set_plan_price('85600000-0000-4000-f000-000000000001', 9000, '2026-11-20') $$, '42501', 'forbidden',
  'staff cannot change prices');
select is((select count(*) from public.plan_prices), 0::bigint, 'nor see them');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000013","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.set_plan_price('85600000-0000-4000-f000-000000000001', 9000, '2026-11-20') $$, '42501', 'forbidden',
  'riders cannot change prices');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.set_plan_price('85600000-0000-4000-f000-000000000001', 9000, '2026-11-20') $$, '42501', 'forbidden',
  'another kitchen''s owner cannot change prices');
select is((select count(*) from public.plan_prices where plan_id = '85600000-0000-4000-f000-000000000001'), 0::bigint,
  'nor see them');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.set_plan_price('85600000-0000-4000-f000-000000000001', 9000, '2026-11-20') $$, '42501', null,
  'anon cannot change prices');
reset role;

-- Lock Thu 12 lunch (the daily job has not moved the plan price yet).
select private.lock_slot('85500000-0000-4000-f000-000000000001', '2026-11-12', 'lunch');
select is((select array_agg(distinct o.price_per_meal_paise order by o.price_per_meal_paise) from public.meal_orders o
           where o.kitchen_id = '85500000-0000-4000-f000-000000000001' and o.service_date in ('2026-11-10', '2026-11-11')),
  array[7000], 'meals before the start date are charged the old price');
select is((select array_agg(distinct o.price_per_meal_paise) from public.meal_orders o
           where o.kitchen_id = '85500000-0000-4000-f000-000000000001' and o.service_date = '2026-11-12'),
  array[8000], 'meals from the start date are charged the new price, without waiting for the daily job');
select is((select sum(-b.amount_paise) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where b.type = 'meal' and o.kitchen_id = '85500000-0000-4000-f000-000000000001'),
  (2 * 7000 * 2 + 2 * 8000)::bigint, 'the meal entries carry those prices');

-- Thursday 00:10: the daily job makes ₹80 the plan price; past meals keep theirs.
select set_config('app.now', '2026-11-12 00:10:00+05:30', true);
select is(private.apply_plan_prices(), 1, 'the daily job moves one plan to its new price');
select is((select price_per_meal_paise from public.plans where id = '85600000-0000-4000-f000-000000000001'), 8000, 'the plan now shows ₹80');
select is(private.apply_plan_prices(), 0, 'running it again changes nothing');
-- Dues for meals already eaten should keep their own prices once the new price starts: 2 customers
-- owe Tue + Wed at ₹70 and Thu at ₹80. On this base private.dues values every owed meal at today's
-- plan price; wave 2's ledger-valued private.dues fixes it (merge prerequisite, D-144).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select todo('dues use today''s plan price until wave 2''s private.dues lands (D-144)', 1);
select is((select sum(amount_owed_paise) from public.dues_list('85500000-0000-4000-f000-000000000001')),
  (2 * 2 * 7000 + 2 * 8000)::bigint, 'after the new price starts, dues for meals already eaten keep their prices');
reset role;
select is((select count(*) from public.plan_prices where plan_id = '85600000-0000-4000-f000-000000000001'), 2::bigint,
  'and adds no history row');
select is((select sum(-b.amount_paise) from public.balance_entries b join public.meal_orders o on o.id = b.ref_id
           where b.type = 'meal' and o.kitchen_id = '85500000-0000-4000-f000-000000000001' and o.service_date < '2026-11-12'),
  (2 * 7000 * 2)::bigint, 'past meals stay charged at ₹70');

-- Scheduled changes can be cancelled before they start; a started one cannot.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.cancel_plan_price((select id from public.plan_prices where effective_from = '2026-11-12')) $$,
  '22023', 'already_started', 'a price that already started cannot be cancelled');
insert into ids select 'p20', (public.set_plan_price('85600000-0000-4000-f000-000000000001', 9000, '2026-11-14') ->> 'id')::uuid;
select lives_ok($$ select public.cancel_plan_price((select v from ids where k = 'p20')) $$, 'a scheduled price is cancelled');
insert into ids select 'p21', (public.set_plan_price('85600000-0000-4000-f000-000000000001', 9500, '2026-11-15') ->> 'id')::uuid;
-- A price edited now (no date) applies from today.
insert into vals select 'p_now', public.set_plan_price('85600000-0000-4000-f000-000000000001', 8500);
select is((select (v ->> 'scheduled')::boolean from vals where k = 'p_now'), false, 'a price change now');
select is((select v -> 'charged_slots' from vals where k = 'p_now'), '["lunch"]'::jsonb,
  'and it says today''s lunch is already counted at the old price');
reset role;
select is((select price_per_meal_paise from public.plans where id = '85600000-0000-4000-f000-000000000001'), 8500, 'changes the plan at once');
select private.lock_slot('85500000-0000-4000-f000-000000000001', d::date, 'lunch')
from generate_series('2026-11-13'::date, '2026-11-14'::date, interval '1 day') d;
select is((select array_agg(distinct o.price_per_meal_paise) from public.meal_orders o
           where o.kitchen_id = '85500000-0000-4000-f000-000000000001' and o.service_date in ('2026-11-13', '2026-11-14')),
  array[8500], 'meals after an immediate change use it; the cancelled ₹90 never applies');
-- "Don't charge" on a meal not frozen yet credits the price of its own date (₹95 from the 15th).
update public.meal_orders set status = 'skipped', skip_reason = 'skip', charged = true
where kitchen_id = '85500000-0000-4000-f000-000000000001' and service_date = '2026-11-15'
  and customer_id = (select v from ids where k = 'c1');
insert into ids select 'waiver', private.waive_meal_charge((select id from public.meal_orders where service_date = '2026-11-15'
                                                             and customer_id = (select v from ids where k = 'c1')), null);
select is((select b.amount_paise from public.balance_entries b where b.id = (select v from ids where k = 'waiver')),
  9500, 'a "don''t charge" credit before the lock uses the price of that date');
select private.lock_slot('85500000-0000-4000-f000-000000000001', '2026-11-15', 'lunch');
select is((select o.price_per_meal_paise from public.meal_orders o
           where o.service_date = '2026-11-15' and o.customer_id = (select v from ids where k = 'c2')), 9500,
  'and the lock charges the same price');
-- A direct table edit of the price is recorded as a change from today.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
update public.plans set price_per_meal_paise = 8800 where id = '85600000-0000-4000-f000-000000000001';
reset role;
select is((select price_per_meal_paise || '@' || effective_from from public.plan_prices
           where plan_id = '85600000-0000-4000-f000-000000000001' and cancelled_at is null order by seq desc limit 1),
  '8800@2026-11-12', 'a direct edit is kept in the price history from today');
select is(private.plan_price_on('85600000-0000-4000-f000-000000000001', '2026-11-16'), 9500,
  'the ₹95 scheduled for the 15th still applies after it');
select set_config('app.now', '2026-11-09 08:00:00+05:30', true);

-- ===========================================================================
-- 5. Phoned-in complaints
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into ids select 'cp1', public.log_complaint((select v from ids where k = 'c1'), 'quality', 'Dal was cold', (select v from ids where k = 's1'));
select is((select channel || '/' || status || '/' || (subscription_id = (select v from ids where k = 's1'))::text from public.complaints
           where id = (select v from ids where k = 'cp1')), 'vendor/responded/true', 'the owner logs a phoned-in complaint');
select throws_ok($$ select public.log_complaint((select v from ids where k = 'c1'), 'smell', null) $$, '22023', 'invalid_category',
  'only known categories');
select throws_ok($$ select public.log_complaint((select v from ids where k = 'c1'), 'late', null, (select v from ids where k = 's2')) $$,
  '22023', 'invalid_subscription', 'the subscription must be this customer''s');
select is((select count(*) from public.balance_entries where ref_type = 'complaint_auto'
           and customer_id = (select v from ids where k = 'c1')), 0::bigint, 'no free meal: the kitchen setting is off by default');
select is((public.customer_complaint_score((select v from ids where k = 'c1')) ->> 'complaints')::integer, 1, 'it counts in the complaint score');
select lives_ok($$ select public.resolve_complaint((select v from ids where k = 'cp1'), null) $$, 'and is resolved as usual');
update public.kitchen_settings set auto_credit_first_complaint = true where kitchen_id = '85500000-0000-4000-f000-000000000001';
insert into ids select 'cp2', public.log_complaint((select v from ids where k = 'c2'), 'late', 'Came at 2 pm');
reset role;
select is((select meals from public.balance_entries where ref_type = 'complaint_auto' and ref_id = (select v from ids where k = 'cp2')), 1,
  'with the setting on, the first complaint gets its free meal');
select set_config('app.now', '2026-11-09 12:00:00+05:30', true);
select private.escalate_complaints();
select is((select status from public.complaints where id = (select v from ids where k = 'cp2')), 'responded',
  'a logged complaint never escalates to the platform team');
select set_config('app.now', '2026-11-09 08:00:00+05:30', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000012","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.log_complaint((select v from ids where k = 'c1'), 'late', null) $$, '42501', 'forbidden', 'staff cannot log complaints');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000013","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.log_complaint((select v from ids where k = 'c1'), 'late', null) $$, '42501', 'forbidden', 'nor riders');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.log_complaint((select v from ids where k = 'c1'), 'late', null) $$, '42501', 'forbidden', 'nor another kitchen');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.log_complaint((select v from ids where k = 'c1'), 'late', null) $$, '42501', 'forbidden', 'nor admins');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.log_complaint((select v from ids where k = 'c1'), 'late', null) $$, '42501', null, 'nor anon');
reset role;

-- ===========================================================================
-- 6. Export my kitchen, close requests
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into vals select 'cust', public.export_kitchen('85500000-0000-4000-f000-000000000001', 'customers');
select is((select jsonb_array_length(v -> 'rows') from vals where k = 'cust'), 2, 'the owner exports every customer');
select is((select x ->> 'phone' from vals, jsonb_array_elements(v -> 'rows') x where k = 'cust' and x ->> 'name' = 'Support Customer 1'),
  '+919555100001', 'with the full phone number');
select is((select x ->> 'address' from vals, jsonb_array_elements(v -> 'rows') x where k = 'cust' and x ->> 'name' = 'Support Customer 1'),
  'House 1', 'and the address');
select is((select v -> 'next_offset' from vals where k = 'cust'), 'null'::jsonb, 'all in one page');
select is(public.export_kitchen('85500000-0000-4000-f000-000000000001', 'customers', 0, 1) -> 'next_offset', '1'::jsonb, 'pages continue');
select ok(jsonb_array_length(public.export_kitchen('85500000-0000-4000-f000-000000000001', 'meal_orders') -> 'rows') >= 12,
  'meal orders of the last 12 months');
select is((select count(*) from jsonb_array_elements(public.export_kitchen('85500000-0000-4000-f000-000000000001', 'balance_entries') -> 'rows') x
           where x ->> 'type' = 'meal'), 12::bigint, 'balance entries');
select is(jsonb_array_length(public.export_kitchen('85500000-0000-4000-f000-000000000001', 'subscriptions') -> 'rows'), 2, 'subscriptions');
select is(jsonb_array_length(public.export_kitchen('85500000-0000-4000-f000-000000000001', 'payments') -> 'rows'), 0, 'payments');
select throws_ok($$ select public.export_kitchen('85500000-0000-4000-f000-000000000001', 'audit') $$, '22023', 'invalid_part', 'only the known parts');
reset role;
select ok((select count(*) from public.audit_log where action = 'ACCESS' and table_name = 'customers' and row_id = 'export'
           and kitchen_id = '85500000-0000-4000-f000-000000000001' and after ->> 'reason' = 'kitchen_export') >= 2,
  'every customers page read is logged');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000012","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.export_kitchen('85500000-0000-4000-f000-000000000001', 'customers') $$, '42501', 'forbidden', 'staff cannot export');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000013","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.export_kitchen('85500000-0000-4000-f000-000000000001', 'customers') $$, '42501', 'forbidden', 'nor riders');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.export_kitchen('85500000-0000-4000-f000-000000000001', 'customers') $$, '42501', 'forbidden', 'nor another kitchen');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.export_kitchen('85500000-0000-4000-f000-000000000001', 'customers') $$, '42501', 'forbidden', 'nor admins');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.export_kitchen('85500000-0000-4000-f000-000000000001', 'customers') $$, '42501', null, 'nor anon');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
insert into ids select 'close', public.request_kitchen_close('85500000-0000-4000-f000-000000000001', 'Moving to Cuttack');
select is(public.request_kitchen_close('85500000-0000-4000-f000-000000000001', 'again'), (select v from ids where k = 'close'),
  'one open close request per kitchen');
select is((select status from public.kitchen_close_requests where kitchen_id = '85500000-0000-4000-f000-000000000001'), 'open',
  'the owner sees their request');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000012","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.request_kitchen_close('85500000-0000-4000-f000-000000000001') $$, '42501', 'forbidden', 'staff cannot file one');
select is((select count(*) from public.kitchen_close_requests), 0::bigint, 'nor see it');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select count(*) from public.kitchen_close_requests), 0::bigint, 'nor another kitchen');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select ok((select bool_or(x ->> 'reason' = 'Moving to Cuttack') from jsonb_array_elements(public.admin_close_requests()) x),
  'the platform team sees the request');
select throws_ok($$ select public.admin_resolve_close_request((select v from ids where k = 'close'), 'closed', null) $$,
  '22023', 'reason_required', 'closing it needs a note');
select lives_ok($$ select public.admin_resolve_close_request((select v from ids where k = 'close'), 'closed', 'Export sent, kitchen suspended') $$,
  'the admin records the outcome');
select throws_ok($$ select public.admin_resolve_close_request((select v from ids where k = 'close'), 'declined', 'x') $$,
  '22023', 'not_pending', 'only once');
reset role;
select is((select count(*) from public.kitchens where id = '85500000-0000-4000-f000-000000000001'), 1::bigint, 'nothing was deleted');

-- ===========================================================================
-- 7. Ownership transfer and platform admins
-- ===========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select lives_ok($$ select public.admin_transfer_ownership('85500000-0000-4000-f000-000000000001',
  (select id from public.members where user_id = 'f5000000-0000-4000-f000-000000000014'), 'staff', 'Owner moved to Delhi, handed over to her son') $$,
  'the admin hands the kitchen to another member');
reset role;
select is((select owner_id from public.kitchens where id = '85500000-0000-4000-f000-000000000001'),
  'f5000000-0000-4000-f000-000000000014'::uuid, 'the kitchen has its new owner');
select is((select string_agg(role::text, ',' order by user_id) from public.members
           where kitchen_id = '85500000-0000-4000-f000-000000000001' and user_id in ('f5000000-0000-4000-f000-000000000011', 'f5000000-0000-4000-f000-000000000014')),
  'staff,owner', 'the old owner is staff now');
select is((select count(*) from public.members where kitchen_id = '85500000-0000-4000-f000-000000000001' and role = 'owner'), 1::bigint,
  'one owner');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.export_kitchen('85500000-0000-4000-f000-000000000001', 'customers') $$, '42501', 'forbidden',
  'the old owner lost the owner''s rights');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000014","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select lives_ok($$ select public.export_kitchen('85500000-0000-4000-f000-000000000001', 'subscriptions') $$, 'the new owner has them');
select ok((select count(*) from public.admin_actions where kitchen_id = '85500000-0000-4000-f000-000000000001') >= 4,
  'the new owner can see what the platform team did to the kitchen');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000012","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select count(*) from public.admin_actions), 0::bigint, 'staff see no admin actions');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is((select count(*) from public.admin_actions where kitchen_id = '85500000-0000-4000-f000-000000000001'), 0::bigint,
  'another kitchen sees none of them');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select count(*) from public.admin_actions $$, '42501', null, 'anon cannot read admin actions');
reset role;
select throws_ok($$ update public.admin_actions set reason = 'edited' $$, 'P0001', null, 'admin_actions is append-only');
select throws_ok($$ delete from public.admin_actions $$, 'P0001', null, 'even for deletes');
select is((select action from public.admin_actions where kitchen_id = '85500000-0000-4000-f000-000000000001'
           order by id desc limit 1), 'ownership_transferred', 'the transfer is logged');

-- Platform admins.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_add_platform_admin('9555000077', 'Second founder') $$, 'P0002', 'no_account',
  'an admin must have logged in once');
reset role;
insert into auth.sessions (id, user_id, created_at, updated_at) values (gen_random_uuid(), 'f5000000-0000-4000-f000-000000000003', now(), now());
update auth.users set encrypted_password = 'known-hash' where id = 'f5000000-0000-4000-f000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select lives_ok($$ select public.admin_add_platform_admin('9555000003', 'Second admin so one lost SIM cannot lock us out') $$,
  'the admin adds a second admin');
select throws_ok($$ select public.admin_add_platform_admin('9555000003', 'again') $$, '23505', 'already_exists', 'only once');
reset role;
select ok((select encrypted_password <> 'known-hash' and count(s.id) = 0 from auth.users u left join auth.sessions s on s.user_id = u.id
           where u.id = 'f5000000-0000-4000-f000-000000000003' group by u.encrypted_password),
  'a new admin''s account is secured: any password replaced, all sessions ended (they log in again with a code)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select is(jsonb_array_length(public.admin_platform_admins()), 2, 'two admins');
select lives_ok($$ select public.admin_remove_platform_admin('f5000000-0000-4000-f000-000000000003', 'Test over') $$, 'and removes them');
select throws_ok($$ select public.admin_remove_platform_admin('00000000-0000-4000-a000-000000000099', 'Leaving') $$, '22023', 'last_admin',
  'the last admin can never be removed');
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-f000-000000000011","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select throws_ok($$ select public.admin_add_platform_admin('9555000011', 'me') $$, '42501', 'forbidden', 'non-admins cannot add admins');
select throws_ok($$ select public.admin_platform_admins() $$, '42501', 'forbidden', 'or list them');
reset role;
select is((select count(*) from public.admin_actions where action in ('platform_admin_added', 'platform_admin_removed')), 2::bigint,
  'both are logged');

-- ===========================================================================
-- 8. Vendor nudges wait for approval
-- ===========================================================================
insert into ids select 'app9', public.submit_vendor_application('Applicant Nine', '9555000009', 'Nine Kitchen', 'Patia', 20, p_consent => true);
update public.vendor_applications set created_at = private.now() - interval '2 days' where id = (select v from ids where k = 'app9');
do $$ begin perform private.growth_tick(); end $$;
select is((select count(*) from public.notifications_outbox where template = 'vendor_nudge'
           and recipient_id = (select v from ids where k = 'app9')), 0::bigint,
  'an applicant who is not approved yet is not told to log in and set up a kitchen');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated","amr":[{"method":"otp","timestamp":0}]}', true);
select lives_ok($$ select public.admin_set_vendor_approval((select v from ids where k = 'app9'), true, 'Called, FSSAI ok') $$,
  'the admin approves them');
reset role;
do $$ begin perform private.growth_tick(); end $$;
select is((select count(*) from public.notifications_outbox where template = 'vendor_nudge'
           and recipient_id = (select v from ids where k = 'app9')), 0::bigint, 'the first nudge comes a day after approval');
select set_config('app.now', '2026-11-10 09:00:00+05:30', true);
do $$ begin perform private.growth_tick(); end $$;
select is((select payload ->> 'next_step' from public.notifications_outbox where template = 'vendor_nudge'
           and recipient_id = (select v from ids where k = 'app9')), 'signup', 'then: log in and create your kitchen');
select set_config('app.now', '2026-11-09 08:00:00+05:30', true);

select * from finish();
rollback;
