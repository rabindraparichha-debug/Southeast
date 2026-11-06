-- Vendor-first wave 3 (safety), audit item 27: phase flags reach the screens and the public entry points.
--
--   * public.feature_flags() (anon + signed-in): the platform's phase switches as booleans, so the web
--     app and the mobile app can hide what is switched off. A missing key counts as off.
--   * The keys themselves (all off) are also added here, in case this runs before wave 2's
--     outbox migration (both use ON CONFLICT DO NOTHING).
--   * Gates (private.require_feature, error 'feature_disabled'):
--       customer_portal  every portal_* RPC (through private.portal_customer, which they all start with)
--       online_payments  every payment link (owner, customer page, payer, WhatsApp bot) through
--                        private.payment_link_record, the single place that creates one
--       marketplace      kitchen_profile, kitchen_directory (public kitchen pages and directory);
--                        submit_lead / lead_choose / lead_confirm (20261112000400_public_forms.sql)
--       growth           submit_vendor_application (20261112000400_public_forms.sql)

insert into public.platform_settings (key, enabled) values
  ('customer_whatsapp', false), ('customer_portal', false), ('online_payments', false),
  ('marketplace', false), ('growth', false), ('extras', false)
on conflict (key) do nothing;

-- The phase switches the apps read. Only these keys are exposed (other platform_settings rows,
-- such as operational settings, stay private).
create or replace function private.phase_flag_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['customer_whatsapp', 'customer_portal', 'online_payments', 'marketplace', 'growth', 'extras', 'kitchen_switching'];
$$;

create or replace function public.feature_flags()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_object_agg(k, coalesce(s.enabled, false) order by k)
  from unnest(private.phase_flag_keys()) k
  left join public.platform_settings s on s.key = k;
$$;

-- ---------------------------------------------------------------------------
-- customer_portal: every portal_* RPC starts with private.portal_customer(p_token).
-- ---------------------------------------------------------------------------
create or replace function private.portal_customer(p_token text)
returns public.customers
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cust public.customers;
begin
  perform private.require_feature('customer_portal');
  select c.* into v_cust
  from public.customer_magic_links l join public.customers c on c.id = l.customer_id
  where l.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and l.revoked_at is null and l.expires_at > private.now() and c.deleted_at is null;
  if v_cust.id is null then
    raise exception 'invalid_link' using errcode = '28000';
  end if;
  return v_cust;
end;
$$;

-- ---------------------------------------------------------------------------
-- online_payments: the single function that creates a payment link record (P6 body, plus the gate).
-- ---------------------------------------------------------------------------
create or replace function private.payment_link_record(p_customer uuid, p_meals integer, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_payer public.customers;
  v_price integer;
  v_account public.kitchen_payout_accounts;
  v_amount integer;
  v_bps integer;
  v_commission integer;
  v_id uuid;
begin
  perform private.require_feature('online_payments');
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if coalesce(p_meals, 0) not between 1 and 200 then
    raise exception 'invalid_meals' using errcode = '22023';
  end if;
  select * into v_account from public.kitchen_payout_accounts where kitchen_id = v_c.kitchen_id;
  if v_account.razorpay_linked_account_id is null or v_account.kyc_status <> 'verified' then
    raise exception 'payout_account_not_verified' using errcode = '22023';
  end if;
  v_price := private.customer_unit_price(p_customer);
  if v_price is null then
    raise exception 'no_plan' using errcode = '22023';
  end if;
  v_amount := p_meals * v_price;
  v_bps := case when v_c.platform_sourced then coalesce(v_account.commission_bps, 0) else 0 end;
  v_commission := private.commission_paise(v_amount, v_bps);
  select * into v_payer from public.customers where id = v_c.payer_customer_id and deleted_at is null;
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, description, created_by, created_at,
                               commission_bps, commission_paise, transfer_paise)
  values (v_c.kitchen_id, p_customer, 'razorpay_link', 'created', v_amount, p_meals,
          p_meals || ' meals' || case when v_payer.id is not null then ' for ' || v_c.name else '' end, p_actor, private.now(),
          case when v_commission > 0 then v_bps else 0 end, v_commission, v_amount - v_commission)
  returning id into v_id;
  return jsonb_build_object(
    'payment_id', v_id, 'amount_paise', v_amount, 'meals', p_meals,
    'linked_account_id', v_account.razorpay_linked_account_id,
    'commission_paise', v_commission, 'transfer_paise', v_amount - v_commission,
    'customer_name', coalesce(v_payer.name, v_c.name), 'eater_name', v_c.name,
    'customer_phone', private.decrypt_phone(coalesce(v_payer.phone_enc, v_c.phone_enc)),
    'paid_by_payer', v_payer.id is not null,
    'kitchen_name', (select name from public.kitchens where id = v_c.kitchen_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- marketplace: the public kitchen page and directory (M7 bodies, plus the gate). The page no
-- longer returns the kitchen's location (it was rounded to about 110 m: roughly a home cook's home)
-- and says "accepting" only when the kitchen takes platform customers.
-- ---------------------------------------------------------------------------
create or replace function public.kitchen_profile(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_feature('marketplace');
  return (
  select jsonb_build_object(
    'id', k.id, 'name', k.name, 'slug', k.slug, 'area', k.area, 'city', k.city, 'description', k.description,
    'cuisine_tags', k.cuisine_tags, 'photo_paths', k.photo_paths, 'fssai_no', k.fssai_no,
    'service_radius_km', k.service_radius_km, 'weekly_off', k.weekly_off, 'trial_meals', k.trial_meals,
    'accepting', k.accepts_platform_leads and (private.spare_capacity(k.id, 'lunch', private.ist_today() + 1) > 0
                                               or private.spare_capacity(k.id, 'dinner', private.ist_today() + 1) > 0),
    'rating', (select jsonb_build_object('avg', avg_rating, 'reviews', reviews) from private.kitchen_rating(k.id)),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slots', p.slots, 'diet', p.diet,
                                                           'days_of_week', p.days_of_week, 'price_per_meal_paise', p.price_per_meal_paise,
                                                           'description', p.description) order by p.price_per_meal_paise)
                       from public.plans p where p.kitchen_id = k.id and p.active), '[]'::jsonb),
    'menu', coalesce((select jsonb_agg(jsonb_build_object('date', m.service_date, 'slot', m.slot, 'dishes', m.dishes)
                                       order by m.service_date, m.slot)
                      from public.menus m where m.kitchen_id = k.id and m.published
                        and m.service_date between private.ist_today() and private.ist_today() + 6), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object('rating', r.rating, 'comment', r.comment,
                                                             'name', split_part(c.name, ' ', 1), 'date', r.created_at::date)
                                          order by r.created_at desc)
                         from (select * from public.kitchen_reviews r0 where r0.kitchen_id = k.id and r0.verified and not r0.hidden
                               order by r0.created_at desc limit 10) r
                         join public.customers c on c.id = r.customer_id), '[]'::jsonb)
  )
  from public.kitchens k
  where k.slug = lower(p_slug) and k.status = 'active');
end;
$$;

create or replace function public.kitchen_directory(p_area text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_feature('marketplace');
  return (
  with a as (select * from private.find_area(p_area))
  select coalesce(jsonb_agg(x order by x ->> 'sort'), '[]'::jsonb) from (
    select jsonb_build_object('name', k.name, 'slug', k.slug, 'area', k.area, 'cuisine_tags', k.cuisine_tags,
             'photo', k.photo_paths[1],
             'from_price_paise', (select min(price_per_meal_paise) from public.plans p where p.kitchen_id = k.id and p.active),
             'rating', (select avg_rating from private.kitchen_rating(k.id)),
             'reviews', (select reviews from private.kitchen_rating(k.id)),
             'distance_km', case when (select lat from a) is not null
                                 then round(private.km_between(k.lat, k.lng, (select lat from a), (select lng from a))::numeric, 1) end,
             'sort', lpad(coalesce(round(private.km_between(k.lat, k.lng, (select lat from a), (select lng from a)) * 100)::text, '0'), 8, '0') || k.name
           ) as x
    from public.kitchens k
    where k.status = 'active' and k.lat is not null
      and ((select lat from a) is null
           or private.km_between(k.lat, k.lng, (select lat from a), (select lng from a)) <= k.service_radius_km)
  ) s);
end;
$$;

revoke execute on function public.feature_flags from public;
grant execute on function public.feature_flags to anon, authenticated;
revoke execute on function private.phase_flag_keys from public, anon, authenticated;
