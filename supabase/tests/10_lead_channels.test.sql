-- M9 lead channels: Google Ads click ids and offline conversions (trial, plan, renewal, with the
-- payment value), Sulekha / directory CSV import, website gclid capture, permissions.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select set_config('app.now', '2026-11-02 10:00:00+05:30', true);
update public.kitchens set accepts_platform_leads = false where id <> '10000000-0000-4000-a000-00000000000a';

-- A Google Ads lead with a click id comes in, picks kitchen A and pays.
create temp table t (k text primary key, v jsonb);
grant select, insert on t to anon, authenticated;
insert into t values ('lead', public.lead_ingest('google_ads', 'gads-L1', 'Ads Person', '+919861555001', 'Patia', 'gads-777', false,
  '{"slots":["lunch"],"diet":"veg"}', 'EAIaIQclickid'));
select is((select gclid from public.leads where id = (select (v ->> 'lead_id')::uuid from t where k = 'lead')), 'EAIaIQclickid',
  'the Google click id is kept on the lead');
insert into t select 'chose', private.convert_lead((select (v ->> 'lead_id')::uuid from t where k = 'lead'), '10000000-0000-4000-a000-00000000000a', null, 'web');
do $$
declare v_pay uuid;
begin
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, paid_at, created_at)
  values ('10000000-0000-4000-a000-00000000000a', (select (v ->> 'customer_id')::uuid from t where k = 'chose'), 'cash', 'paid', 14000, 2,
          private.now(), private.now()) returning id into v_pay;
  perform private.post_recharge(v_pay);
end $$;
select is((select stage || ':' || value_paise from public.ad_conversions), 'trial:14000', 'the paid trial is queued for Google Ads with its value');

select set_config('app.now', '2026-11-04 10:00:00+05:30', true);
do $$
declare v_pay uuid;
begin
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, paid_at, created_at)
  values ('10000000-0000-4000-a000-00000000000a', (select (v ->> 'customer_id')::uuid from t where k = 'chose'), 'cash', 'paid', 168000, 24,
          private.now(), private.now()) returning id into v_pay;
  perform private.post_recharge(v_pay);
end $$;
select is((select value_paise from public.ad_conversions where stage = 'plan'), 168000, 'buying the plan queues a plan conversion');

-- The uploader claims and completes them (service role).
set local role service_role;
create temp table claimed as select * from public.ads_claim_conversions(10);
select is((select count(*) from claimed), 2::bigint, 'both are claimed for upload');
select is((select count(*) from public.ads_claim_conversions(10)), 0::bigint, 'and not claimed twice');
select lives_ok($$ select public.ads_complete_conversion(id, true) from claimed $$, 'the uploader marks them sent');
reset role;
select is((select string_agg(status, ',' order by stage) from public.ad_conversions), 'sent,sent', 'both sent');
select is((select count(*) from public.leads where source = 'google_ads' and gclid is null and external_id = 'gads-L1'), 0::bigint, 'leads without a click id queue nothing');

-- A lead without a click id never queues a conversion.
insert into t values ('noclick', public.lead_ingest('justdial', 'jd-L2', 'JD Person', '+919861555002', 'Patia', null, false, '{"slots":["lunch"]}'));
select is((select count(*) from public.ad_conversions where lead_id = (select (v ->> 'lead_id')::uuid from t where k = 'noclick')), 0::bigint,
  'no click id, no conversion');

-- Sulekha: CSV import from the dashboard, idempotent.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.admin_import_leads('sulekha', '[]') $$, '42501', 'forbidden', 'only the platform team imports leads');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
insert into t select 'imp', public.admin_import_leads('sulekha', '[
  {"external_id":"SK-1","name":"Sulekha One","phone":"9861555011","area":"Patia","slots":["lunch"],"diet":"veg"},
  {"name":"Sulekha Two","phone":"9861555012","area":"Khandagiri","notes":"needs dinner"},
  {"name":"Bad Phone","phone":"12345"}]');
select is((select (v ->> 'created')::int from t where k = 'imp'), 2, 'two Sulekha leads imported');
select is((select jsonb_array_length(v -> 'errors') from t where k = 'imp'), 1, 'the bad row is reported');
select is((public.admin_import_leads('sulekha', '[{"external_id":"SK-1","name":"Sulekha One","phone":"9861555011"}]') ->> 'duplicates')::int, 1,
  'importing the same file again creates nothing');
select ok(jsonb_array_length(public.admin_ad_conversions()) = 2, 'admins can see the conversions sent to Google Ads');
reset role;
select is((select status::text from public.leads where external_id = 'SK-1' and source = 'sulekha'), 'matched',
  'an imported Sulekha lead in Patia is matched straight away');

-- Website: the click id from the landing URL is attached with the lead token.
set local role anon;
insert into t select 'web', public.submit_lead('Web Click', '9861555021', 'Patia', p_consent => true);
select lives_ok(format($$ select public.lead_attach_gclid(%L, 'EAIaIQweb') $$, (select v ->> 'token' from t where k = 'web')), 'anon attaches the click id');
select lives_ok($$ select public.lead_attach_gclid('wrong-token', 'EAIaIQevil') $$, 'a wrong token changes nothing');
reset role;
select is((select gclid from public.leads where phone_last4 = '5021' and source = 'website'), 'EAIaIQweb', 'the website lead keeps its click id');
select is((select count(*) from public.leads where gclid = 'EAIaIQevil'), 0::bigint, 'no lead got the forged click id');

select * from finish();
rollback;
