-- Phase 2 hardening, step 2: referral links that stay with the kitchen (docs/VENDOR_FIRST_AUDIT.md,
-- Phase 2 step 1 "Referral links do not work"; D-127).
--
--   * The customer page shares <web>/k/<kitchen slug>/join?ref=<CODE> (it shared /find?ref=, which
--     ignored the code and matched the friend across every kitchen).
--   * referral_invite(slug, code): what the join page shows. Only that kitchen, never others. A code
--     from another kitchen says so (code_status 'other_kitchen'); a draft kitchen is shown only with
--     one of its own codes.
--   * referral_join(...): the friend joins THAT kitchen as its own customer (source 'web', not
--     platform-sourced, so no commission) with a 'trial' subscription (meals start once the trial is
--     paid, D-033), the referral recorded (source 'link') and the owners told ('referral_customer').
--     The answer is the same whether or not the number was already a customer, and it carries no
--     customer-page link, so nobody can test which numbers a kitchen serves. At most 5 joins per code
--     and 30 per kitchen in 24 hours.
--   * A code from another kitchen gives its own error (referral_other_kitchen) everywhere codes are
--     typed (owner, customer page, join page).
--   * The customer page omits the referral card while the kitchen's reward is 0 meals.
--   * Both public functions are behind the platform flag customer_portal (off): the link lives on the
--     customer page, which is a Phase 2 feature.

insert into public.platform_settings (key, enabled) values ('customer_portal', false)
on conflict (key) do nothing;

alter table public.referrals drop constraint referrals_source_check;
alter table public.referrals add constraint referrals_source_check check (source in ('vendor', 'lead', 'portal', 'link'));
create index referrals_link_day_idx on public.referrals (kitchen_id, created_at) where source = 'link';

-- A code from another kitchen is not "invalid": say where the problem is.
create or replace function private.link_referral(p_referee uuid, p_code text, p_source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref public.customers;
  v_code text := private.scan_token(p_code);
  v_referrer uuid;
  v_id uuid;
begin
  select * into v_ref from public.customers where id = p_referee and deleted_at is null;
  if v_ref.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select id into v_referrer from public.customers
  where kitchen_id = v_ref.kitchen_id and referral_code = v_code and deleted_at is null;
  if v_referrer is null then
    if exists (select 1 from public.customers where referral_code = v_code and kitchen_id <> v_ref.kitchen_id and deleted_at is null) then
      raise exception 'referral_other_kitchen' using errcode = '22023';
    end if;
    raise exception 'invalid_referral_code' using errcode = '22023';
  end if;
  if v_referrer = p_referee then
    raise exception 'self_referral' using errcode = '22023';
  end if;
  if exists (select 1 from public.referrals where referee_customer_id = p_referee) then
    raise exception 'already_referred' using errcode = '23505';
  end if;
  -- Only new customers: the reward follows the first paid recharge.
  if exists (select 1 from public.balance_entries where customer_id = p_referee and type = 'recharge') then
    raise exception 'referral_too_late' using errcode = '22023';
  end if;
  insert into public.referrals (kitchen_id, referrer_customer_id, referee_customer_id, code, source, created_by, created_at)
  values (v_ref.kitchen_id, v_referrer, p_referee, v_code, p_source, auth.uid(), private.now())
  returning id into v_id;
  return v_id;
end;
$$;

-- The kitchen behind a join link: any kitchen that is not suspended. Returns the referrer (null when
-- the code is not this kitchen's) and why.
create or replace function private.referral_target(p_slug text, p_code text,
  out kitchen public.kitchens, out referrer public.customers, out code_status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := private.scan_token(p_code);
begin
  select * into kitchen from public.kitchens k where k.slug = lower(trim(coalesce(p_slug, ''))) and k.status <> 'suspended';
  if kitchen.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_code is not null then
    select * into referrer from public.customers c
    where c.kitchen_id = kitchen.id and c.referral_code = v_code and c.deleted_at is null;
  end if;
  code_status := case
    when referrer.id is not null then 'ok'
    when v_code is not null and exists (select 1 from public.customers c where c.referral_code = v_code
                                          and c.kitchen_id <> kitchen.id and c.deleted_at is null) then 'other_kitchen'
    else 'invalid' end;
  -- A kitchen that is not listed is only visible through one of its own invites.
  if code_status <> 'ok' and kitchen.status <> 'active' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Public: the join page for one kitchen. Only that kitchen's name, plans and invite status.
create or replace function public.referral_invite(p_slug text, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_reward integer;
begin
  perform private.require_feature('customer_portal');
  if length(coalesce(p_slug, '')) > 80 or length(coalesce(p_code, '')) > 40 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_t from private.referral_target(p_slug, p_code);
  select coalesce(referral_reward_meals, 0) into v_reward from public.kitchen_settings where kitchen_id = (v_t.kitchen).id;
  return jsonb_build_object(
    'code_status', v_t.code_status,
    'code', case when v_t.code_status = 'ok' then (v_t.referrer).referral_code end,
    'kitchen', jsonb_build_object('name', (v_t.kitchen).name, 'slug', (v_t.kitchen).slug, 'area', (v_t.kitchen).area,
      'fssai_no', (v_t.kitchen).fssai_no, 'trial_meals', (v_t.kitchen).trial_meals, 'weekly_off', (v_t.kitchen).weekly_off),
    'reward_meals', case when v_t.code_status = 'ok' then coalesce(v_reward, 0) else 0 end,
    'plans', case when v_t.code_status = 'ok' then coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slots', p.slots, 'diet', p.diet,
                                            'days_of_week', p.days_of_week, 'price_per_meal_paise', p.price_per_meal_paise,
                                            'description', p.description) order by p.price_per_meal_paise)
        from public.plans p where p.kitchen_id = (v_t.kitchen).id and p.active), '[]'::jsonb)
      else '[]'::jsonb end);
end;
$$;

-- Public: a friend joins the referrer's kitchen with a trial. Validates everything itself.
create or replace function public.referral_join(
  p_slug text,
  p_code text,
  p_name text,
  p_phone text,
  p_plan uuid,
  p_address text,
  p_area text default null,
  p_landmark text default null,
  p_start_date date default null,
  p_consent boolean default false,
  p_whatsapp_opt_in boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_phone text := private.normalize_phone(p_phone);
  v_p public.plans;
  v_start date;
  v_customer uuid;
  v_address uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_answer jsonb;
begin
  perform private.require_feature('customer_portal');
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if length(v_name) not between 1 and 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_address, ''))) not between 3 and 200 or length(coalesce(p_area, '')) > 80
     or length(coalesce(p_landmark, '')) > 120 then
    raise exception 'invalid_address' using errcode = '22023';
  end if;
  if length(coalesce(p_slug, '')) > 80 or length(coalesce(p_code, '')) > 40 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select * into v_t from private.referral_target(p_slug, p_code);
  if v_t.code_status = 'other_kitchen' then
    raise exception 'referral_other_kitchen' using errcode = '22023';
  elsif v_t.code_status <> 'ok' then
    raise exception 'invalid_referral_code' using errcode = '22023';
  end if;
  select * into v_p from public.plans where id = p_plan and kitchen_id = (v_t.kitchen).id and active;
  if v_p.id is null then
    raise exception 'no_plan' using errcode = '22023';
  end if;
  v_start := coalesce(p_start_date, private.ist_today() + 1);
  if v_start < private.ist_today() + 1 or v_start > private.ist_today() + 30 then
    raise exception 'invalid_date' using errcode = '22023';
  end if;

  v_answer := jsonb_build_object('ok', true, 'kitchen_name', (v_t.kitchen).name, 'trial_meals', (v_t.kitchen).trial_meals);

  -- Already this kitchen's customer (the referrer included): nothing changes, same answer.
  if exists (select 1 from public.customers where kitchen_id = (v_t.kitchen).id and phone_hash = private.phone_hash(v_phone)
             and deleted_at is null) then
    return v_answer;
  end if;
  -- A shared link cannot fill a kitchen's books: 5 joins per code, 30 per kitchen, per 24 hours.
  if (select count(*) from public.referrals r where r.referrer_customer_id = (v_t.referrer).id and r.source = 'link'
        and r.created_at > private.now() - interval '24 hours') >= 5
     or (select count(*) from public.referrals r where r.kitchen_id = (v_t.kitchen).id and r.source = 'link'
           and r.created_at > private.now() - interval '24 hours') >= 30 then
    raise exception 'too_many_requests' using errcode = '22023';
  end if;

  insert into public.customers (kitchen_id, name, phone_enc, phone_hash, phone_last4, source, platform_sourced,
    whatsapp_opt_in, preferred_language, diet, notes, consent_at, consent_basis)
  values ((v_t.kitchen).id, v_name, private.encrypt_phone(v_phone), private.phone_hash(v_phone), right(v_phone, 4), 'web', false,
    coalesce(p_whatsapp_opt_in, false), 'en', v_p.diet,
    'Joined with ' || split_part((v_t.referrer).name, ' ', 1) || '''s invite (' || (v_t.referrer).referral_code || ')',
    private.now(), 'customer')
  returning id into v_customer;
  insert into public.consents (kitchen_id, customer_id, purpose, basis, channel)
  values ((v_t.kitchen).id, v_customer, 'service_contact', 'customer', 'web');
  if coalesce(p_whatsapp_opt_in, false) then
    insert into public.consents (kitchen_id, customer_id, purpose, basis, channel)
    values ((v_t.kitchen).id, v_customer, 'whatsapp', 'customer', 'web');
  end if;
  insert into public.addresses (kitchen_id, customer_id, label, line1, area, landmark)
  values ((v_t.kitchen).id, v_customer, 'Home', trim(p_address), nullif(trim(p_area), ''), nullif(trim(p_landmark), ''))
  returning id into v_address;
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
  values ((v_t.kitchen).id, v_customer, v_p.id, v_address, v_start, 'trial');
  perform private.link_referral(v_customer, (v_t.referrer).referral_code, 'link');

  perform private.notify_owners((v_t.kitchen).id, 'referral_customer',
    jsonb_build_object('customer_name', v_name, 'area', nullif(trim(p_area), ''), 'referrer_name', (v_t.referrer).name,
                       'plan_name', v_p.name, 'trial_meals', (v_t.kitchen).trial_meals, 'start_date', v_start),
    'referral_customer:' || v_customer);
  return v_answer;
end;
$$;

-- Customer page extras: the referral card links to the kitchen's own join page, and is left out
-- while the kitchen gives no reward. Everything else as in P6.
create or replace function private.portal_extras(p_cust public.customers)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ks public.kitchen_settings;
  v_slug text;
begin
  select * into v_ks from public.kitchen_settings where kitchen_id = p_cust.kitchen_id;
  select slug into v_slug from public.kitchens where id = p_cust.kitchen_id;
  return jsonb_build_object(
    'payer', (select jsonb_build_object('name', p.name) from public.customers p
              where p.id = p_cust.payer_customer_id and p.deleted_at is null),
    'dependents', coalesce((select jsonb_agg(jsonb_build_object(
        'customer_id', d.id, 'name', d.name,
        'balance_meals', coalesce((select sum(b.meals) from public.balance_entries b where b.customer_id = d.id), 0),
        'low_threshold', v_ks.low_balance_meals,
        'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'plan', pl.name,
                                     'price_paise', pl.price_per_meal_paise, 'slots', pl.slots) order by s.created_at)
                                   from public.subscriptions s join public.plans pl on pl.id = s.plan_id
                                   where s.customer_id = d.id and s.status <> 'cancelled'), '[]'::jsonb)) order by d.name)
      from public.customers d where d.payer_customer_id = p_cust.id and d.deleted_at is null), '[]'::jsonb),
    'food_prefs', jsonb_build_object(
      'observes_veg_days', p_cust.observes_veg_days, 'observes_kartika', p_cust.observes_kartika,
      'kitchen_veg_days', case when v_ks.veg_days_enabled then to_jsonb(v_ks.veg_days) else '[]'::jsonb end,
      'kitchen_kartika_mode', v_ks.kartika_veg_mode,
      'kartika_now', exists (select 1 from public.food_calendar f where f.kind = 'kartika'
                             and private.ist_today() between f.starts_on and f.ends_on)),
    'referral', case when coalesce(v_ks.referral_reward_meals, 0) > 0 and p_cust.referral_code is not null then jsonb_build_object(
      'code', p_cust.referral_code,
      'url', private.public_web_url() || '/k/' || v_slug || '/join?ref=' || p_cust.referral_code,
      'reward_meals', v_ks.referral_reward_meals,
      'referred', exists (select 1 from public.referrals r where r.referee_customer_id = p_cust.id),
      'can_apply', not exists (select 1 from public.referrals r where r.referee_customer_id = p_cust.id)
                   and not exists (select 1 from public.balance_entries b where b.customer_id = p_cust.id and b.type = 'recharge'))
      end,
    'specials', coalesce((select jsonb_agg(jsonb_build_object('service_date', s.service_date, 'slot', s.slot, 'name', s.name,
                                             'description', s.description, 'addon_price_paise', s.addon_price_paise)
                                           order by s.service_date, s.slot)
                          from public.festival_specials s
                          where s.kitchen_id = p_cust.kitchen_id and s.service_date between private.ist_today() and private.ist_today() + 14),
                         '[]'::jsonb),
    'festivals', coalesce((select jsonb_agg(jsonb_build_object('name', f.name, 'starts_on', f.starts_on, 'ends_on', f.ends_on,
                                              'kind', f.kind, 'veg_only', f.veg_only) order by f.starts_on)
                           from public.food_calendar f
                           where f.ends_on >= private.ist_today() and f.starts_on <= private.ist_today() + 30), '[]'::jsonb),
    'health_tags', coalesce((select to_jsonb(h.tags) from public.customer_health h where h.customer_id = p_cust.id), '[]'::jsonb),
    'health_tag_options', to_jsonb(private.health_tag_list()),
    'office', (select jsonb_build_object('name', o.name) from public.offices o where o.id = p_cust.office_id),
    'kitchen_switching', private.feature_enabled('kitchen_switching') and p_cust.platform_sourced);
end;
$$;

revoke execute on function private.referral_target(text, text) from public, anon, authenticated;
revoke execute on function public.referral_invite(text, text),
  public.referral_join(text, text, text, text, uuid, text, text, text, date, boolean, boolean) from public;
grant execute on function public.referral_invite(text, text),
  public.referral_join(text, text, text, text, uuid, text, text, text, date, boolean, boolean) to anon, authenticated;
