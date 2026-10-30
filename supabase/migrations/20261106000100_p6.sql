-- P6 (built switched off): platform commission via Razorpay Route split, kitchen switching at the
-- same price (admin flag, default OFF), shared riders, office plans, health tags, and the
-- notebook-photo import (preview only; the owner confirms through import_customers).
--
-- Rules
--   * Commission applies only to online payments of platform_sourced customers, at a rate the
--     platform team sets per kitchen (default 0 bps = nothing changes). It is the platform's cut of
--     the Route split; the rest is transferred to the kitchen. We still hold no customer balance.
--   * Kitchen switching: every entry point raises feature_disabled while the flag is off. The old
--     kitchen's subscription ends through the normal cancel path, so unused meals are refunded by
--     private.create_refund (refund_on_cancel); the new customer is created by private.convert_lead.
--   * Health tags are sensitive: stored only with consent, visible to owner and staff (packing list,
--     stickers, counts), never to riders.

-- ===========================================================================
-- 1. Platform commission (Route split)
-- ===========================================================================
alter table public.kitchen_payout_accounts
  add column commission_bps integer not null default 0 check (commission_bps between 0 and 3000);

alter table public.payments
  add column commission_bps integer not null default 0 check (commission_bps between 0 and 3000),
  add column commission_paise integer not null default 0 check (commission_paise >= 0),
  add column transfer_paise integer check (transfer_paise is null or transfer_paise > 0),
  add constraint payments_commission_le_amount check (commission_paise < amount_paise);

-- Append-only: one row per captured online payment that carried a commission.
create table public.platform_commissions (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  payment_id uuid not null unique,
  customer_id uuid not null,
  amount_paise integer not null check (amount_paise > 0),
  commission_bps integer not null check (commission_bps between 1 and 3000),
  commission_paise integer not null check (commission_paise > 0),
  transfer_paise integer not null check (transfer_paise > 0),
  razorpay_payment_id text,
  created_at timestamptz not null default now(),
  check (commission_paise + transfer_paise = amount_paise),
  foreign key (payment_id, kitchen_id) references public.payments (id, kitchen_id),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id)
);
create index platform_commissions_kitchen_idx on public.platform_commissions (kitchen_id, created_at desc);
create trigger platform_commissions_append_only before update or delete on public.platform_commissions
  for each row execute function private.forbid_mutation();
create trigger platform_commissions_no_truncate before truncate on public.platform_commissions
  for each statement execute function private.forbid_mutation();

-- Commission in paise for an amount (rounded down: the kitchen never gets less than its share).
create or replace function private.commission_paise(p_amount integer, p_bps integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select (coalesce(p_amount, 0)::bigint * greatest(coalesce(p_bps, 0), 0) / 10000)::integer;
$$;

-- Payment link record (P5) + commission: platform customers pay the kitchen's rate.
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

-- Captured online payment with a commission: one ledger row, idempotent on the payment.
create or replace function private.post_commission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.platform_commissions (kitchen_id, payment_id, customer_id, amount_paise, commission_bps, commission_paise,
                                           transfer_paise, razorpay_payment_id, created_at)
  values (new.kitchen_id, new.id, new.customer_id, new.amount_paise, new.commission_bps, new.commission_paise,
          new.amount_paise - new.commission_paise, new.razorpay_payment_id, coalesce(new.paid_at, private.now()))
  on conflict (payment_id) do nothing;
  return null;
end;
$$;

create trigger payments_post_commission after update of status on public.payments
  for each row when (new.status = 'paid' and old.status is distinct from 'paid' and new.method = 'razorpay_link'
                     and new.commission_paise > 0)
  execute function private.post_commission();

create or replace function public.admin_set_commission(p_kitchen uuid, p_bps integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_bps is null or p_bps not between 0 and 3000 then
    raise exception 'invalid_commission' using errcode = '22023';
  end if;
  update public.kitchen_payout_accounts set commission_bps = p_bps where kitchen_id = p_kitchen;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Admin: commission per kitchen for captured payments in [p_from, p_to] (IST dates).
create or replace function public.admin_commission_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'total_commission_paise', coalesce((select sum(c.commission_paise) from public.platform_commissions c
       where (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to), 0),
    'kitchens', coalesce((select jsonb_agg(x order by x ->> 'kitchen_name') from (
       select jsonb_build_object('kitchen_id', k.id, 'kitchen_name', k.name, 'commission_bps', pa.commission_bps,
         'payments', count(c.id), 'gross_paise', coalesce(sum(c.amount_paise), 0),
         'commission_paise', coalesce(sum(c.commission_paise), 0), 'transferred_paise', coalesce(sum(c.transfer_paise), 0)) x
       from public.kitchens k
       join public.kitchen_payout_accounts pa on pa.kitchen_id = k.id
       left join public.platform_commissions c on c.kitchen_id = k.id
         and (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
       where pa.commission_bps > 0 or c.id is not null
       group by k.id, k.name, pa.commission_bps) y), '[]'::jsonb));
end;
$$;

-- Owner: what the platform kept from their payments (transparency).
create or replace function public.commission_statement(p_kitchen uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  return jsonb_build_object(
    'commission_bps', (select commission_bps from public.kitchen_payout_accounts where kitchen_id = p_kitchen),
    'commission_paise', coalesce((select sum(commission_paise) from public.platform_commissions
       where kitchen_id = p_kitchen and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to), 0),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('payment_id', c.payment_id, 'customer_name', cu.name,
         'amount_paise', c.amount_paise, 'commission_paise', c.commission_paise, 'transfer_paise', c.transfer_paise,
         'created_at', c.created_at) order by c.created_at desc)
       from public.platform_commissions c join public.customers cu on cu.id = c.customer_id
       where c.kitchen_id = p_kitchen and (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 2. Kitchen switching at the same price (admin flag, OFF by default)
-- ===========================================================================
create table public.platform_settings (
  key text primary key check (key ~ '^[a-z_]{3,40}$'),
  enabled boolean not null default false,
  value jsonb not null default '{}',
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);
create trigger platform_settings_updated_at before update on public.platform_settings
  for each row execute function private.set_updated_at();
create trigger platform_settings_audit after insert or update or delete on public.platform_settings
  for each row execute function private.audit_row();
insert into public.platform_settings (key, enabled) values ('kitchen_switching', false);

create or replace function private.feature_enabled(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select enabled from public.platform_settings where key = p_key), false);
$$;

create or replace function private.require_feature(p_key text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.feature_enabled(p_key) then
    raise exception 'feature_disabled' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.admin_set_platform_flag(p_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  update public.platform_settings set enabled = coalesce(p_enabled, false), updated_by = auth.uid() where key = p_key;
  if not found then
    raise exception 'invalid_flag' using errcode = '22023';
  end if;
end;
$$;

create table public.kitchen_switch_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  from_kitchen_id uuid not null,
  to_kitchen_id uuid not null references public.kitchens (id),
  to_plan_id uuid not null,
  price_per_meal_paise integer not null,
  reason text check (length(reason) <= 300),
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  effective_date date,
  new_customer_id uuid references public.customers (id),
  decision_note text,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (to_kitchen_id <> from_kitchen_id),
  foreign key (customer_id, from_kitchen_id) references public.customers (id, kitchen_id),
  foreign key (to_plan_id, to_kitchen_id) references public.plans (id, kitchen_id)
);
create unique index kitchen_switch_requests_open_idx on public.kitchen_switch_requests (customer_id) where status = 'requested';
create trigger kitchen_switch_requests_updated_at before update on public.kitchen_switch_requests
  for each row execute function private.set_updated_at();
create trigger kitchen_switch_requests_audit after insert or update or delete on public.kitchen_switch_requests
  for each row execute function private.audit_row();

-- The customer's current plan (latest live subscription).
create or replace function private.current_plan(p_customer uuid)
returns public.plans
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.subscriptions s join public.plans p on p.id = s.plan_id
  where s.customer_id = p_customer and s.status <> 'cancelled'
  order by s.created_at desc limit 1;
$$;

-- Kitchens a customer may switch to: the matching rules of private.match_kitchens (active, taking
-- platform leads, within the kitchen's radius, a plan with the same meals and diet, a free place)
-- plus the exact same price per meal. Ranked by verified rating, then distance (D-107).
create or replace function private.switch_options(p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_plan public.plans;
  v_a public.addresses;
  v_from date := private.ist_today() + 1;
begin
  select * into v_c from public.customers where id = p_customer;
  v_plan := private.current_plan(p_customer);
  if v_plan.id is null then
    raise exception 'no_plan' using errcode = '22023';
  end if;
  select * into v_a from public.addresses where customer_id = p_customer and is_default;
  if v_a.geo_point is null then
    raise exception 'location_required' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('kitchen_id', x.id, 'name', x.name, 'slug', x.slug, 'area', x.area,
                                        'distance_km', x.km, 'plan_id', x.pid, 'plan_name', x.pname,
                                        'price_per_meal_paise', x.price, 'rating', x.avg_rating, 'reviews', x.nrev,
                                        'profile_url', private.public_web_url() || '/k/' || x.slug)
                     order by x.rscore desc, x.km)
    from (
      select k.id, k.name, k.slug, k.area,
             round((extensions.st_distance(k.geo_point, v_a.geo_point) / 1000)::numeric, 2) as km,
             p.id as pid, p.name as pname, p.price_per_meal_paise as price, r.avg_rating, r.reviews as nrev, r.score as rscore,
             row_number() over (partition by k.id order by p.created_at) as rn
      from public.kitchens k
      join public.plans p on p.kitchen_id = k.id and p.active and p.slots = v_plan.slots and p.diet = v_plan.diet
        and p.price_per_meal_paise = v_plan.price_per_meal_paise
      cross join lateral private.kitchen_rating(k.id) r
      where k.id <> v_c.kitchen_id and k.status = 'active' and k.accepts_platform_leads and k.geo_point is not null
        and extensions.st_dwithin(k.geo_point, v_a.geo_point, k.service_radius_km * 1000)
        and (select min(private.spare_capacity(k.id, sl, v_from)) from unnest(v_plan.slots) sl) >= 1
        and not exists (select 1 from public.customers o where o.kitchen_id = k.id and o.phone_hash = v_c.phone_hash
                        and o.deleted_at is null)
    ) x where x.rn = 1), '[]'::jsonb);
end;
$$;

-- First date from today whose meals are all still open at the kitchen (nothing frozen yet).
create or replace function private.first_open_date(p_kitchen uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select min(d.d)::date
  from public.kitchens k, generate_series(private.ist_today(), private.ist_today() + 7, interval '1 day') d(d)
  where k.id = p_kitchen
    and not exists (select 1 from unnest(enum_range(null::public.meal_slot)) sl
                    where private.now() >= private.cutoff_at(k, d.d::date, sl)
                       or exists (select 1 from public.count_snapshots cs
                                  where cs.kitchen_id = p_kitchen and cs.service_date = d.d::date and cs.slot = sl));
$$;

-- Customer page: same-price kitchens and any open request.
create or replace function public.portal_switch_options(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
  v_plan public.plans;
begin
  perform private.require_feature('kitchen_switching');
  if not v_cust.platform_sourced then
    raise exception 'switch_not_allowed' using errcode = '22023';
  end if;
  v_plan := private.current_plan(v_cust.id);
  return jsonb_build_object(
    'current', jsonb_build_object('plan_name', v_plan.name, 'price_per_meal_paise', v_plan.price_per_meal_paise,
                                  'slots', v_plan.slots, 'diet', v_plan.diet),
    'options', private.switch_options(v_cust.id),
    'open_request', (select jsonb_build_object('id', r.id, 'kitchen_name', k.name, 'created_at', r.created_at, 'status', r.status)
                     from public.kitchen_switch_requests r join public.kitchens k on k.id = r.to_kitchen_id
                     where r.customer_id = v_cust.id and r.status = 'requested'));
end;
$$;

create or replace function public.portal_request_switch(p_token text, p_kitchen uuid, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
  v_opt jsonb;
  v_id uuid;
begin
  perform private.require_feature('kitchen_switching');
  if not v_cust.platform_sourced then
    raise exception 'switch_not_allowed' using errcode = '22023';
  end if;
  select o into v_opt from jsonb_array_elements(private.switch_options(v_cust.id)) o where o ->> 'kitchen_id' = p_kitchen::text;
  if v_opt is null then
    raise exception 'kitchen_not_available' using errcode = '22023';
  end if;
  if exists (select 1 from public.kitchen_switch_requests where customer_id = v_cust.id and status = 'requested') then
    raise exception 'already_requested' using errcode = '23505';
  end if;
  insert into public.kitchen_switch_requests (customer_id, from_kitchen_id, to_kitchen_id, to_plan_id, price_per_meal_paise,
                                              reason, created_at)
  values (v_cust.id, v_cust.kitchen_id, p_kitchen, (v_opt ->> 'plan_id')::uuid, (v_opt ->> 'price_per_meal_paise')::integer,
          nullif(trim(p_reason), ''), private.now())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.portal_cancel_switch(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
begin
  perform private.require_feature('kitchen_switching');
  update public.kitchen_switch_requests set status = 'cancelled' where customer_id = v_cust.id and status = 'requested';
end;
$$;

create or replace function public.admin_switch_requests(p_status text default 'requested')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  perform private.require_feature('kitchen_switching');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'status', r.status, 'customer_id', r.customer_id, 'customer_name', c.name,
      'phone_masked', private.mask_phone(c.phone_last4), 'from_kitchen', fk.name, 'to_kitchen', tk.name,
      'to_plan', p.name, 'price_per_meal_paise', r.price_per_meal_paise, 'reason', r.reason,
      'balance_meals', coalesce((select sum(b.meals) from public.balance_entries b where b.customer_id = c.id), 0),
      'effective_date', r.effective_date, 'decision_note', r.decision_note, 'created_at', r.created_at,
      'decided_at', r.decided_at) order by r.created_at desc)
    from public.kitchen_switch_requests r
    join public.customers c on c.id = r.customer_id
    join public.kitchens fk on fk.id = r.from_kitchen_id
    join public.kitchens tk on tk.id = r.to_kitchen_id
    join public.plans p on p.id = r.to_plan_id
    where p_status is null or r.status = p_status), '[]'::jsonb);
end;
$$;

-- Admin approves (old subscriptions end at the first open date, unused meals refunded through the
-- cancel path; the customer joins the new kitchen through convert_lead) or rejects.
create or replace function public.admin_decide_switch(p_request uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.kitchen_switch_requests;
  v_c public.customers;
  v_a public.addresses;
  v_plan public.plans;
  v_eff date;
  v_lead uuid;
  v_conv jsonb;
  s record;
begin
  perform private.require_admin();
  perform private.require_feature('kitchen_switching');
  select * into v_r from public.kitchen_switch_requests where id = p_request for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_r.status <> 'requested' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  if not coalesce(p_approve, false) then
    update public.kitchen_switch_requests
    set status = 'rejected', decision_note = nullif(trim(p_note), ''), decided_by = auth.uid(), decided_at = private.now()
    where id = p_request;
    return jsonb_build_object('status', 'rejected');
  end if;

  select * into v_c from public.customers where id = v_r.customer_id and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from jsonb_array_elements(private.switch_options(v_c.id)) o
                 where o ->> 'kitchen_id' = v_r.to_kitchen_id::text and o ->> 'plan_id' = v_r.to_plan_id::text) then
    raise exception 'kitchen_not_available' using errcode = '22023';
  end if;
  v_plan := private.current_plan(v_c.id);
  select * into v_a from public.addresses where customer_id = v_c.id and is_default;
  v_eff := coalesce(private.first_open_date(v_c.kitchen_id), private.ist_today() + 1);

  -- Old kitchen: every live subscription ends before v_eff (the refund follows from the cancel path).
  for s in select id from public.subscriptions where customer_id = v_c.id and status <> 'cancelled' loop
    perform private.apply_change(s.id, 'cancel', v_eff, null, null, null, 'web', false, 'Switched kitchen via Tiffin platform',
                                 false, auth.uid());
  end loop;

  -- New kitchen: through the normal lead → customer path (platform_sourced, trial subscription).
  update public.leads set status = 'lost', lost_reason = 'Switched kitchen'
  where customer_id = v_c.id and status not in ('converted', 'renewed', 'lost');
  v_lead := private.upsert_lead(private.decrypt_phone(v_c.phone_enc), 'other', 'kitchen_switch', null,
    jsonb_strip_nulls(jsonb_build_object('name', v_c.name, 'address_text', v_a.line1, 'area', v_a.area, 'lat', v_a.lat, 'lng', v_a.lng,
      'slots', to_jsonb(v_plan.slots), 'diet', v_plan.diet, 'budget_per_meal_paise', v_r.price_per_meal_paise,
      'start_date', v_eff, 'language', v_c.preferred_language)),
    true, v_c.whatsapp_opt_in, true);
  v_conv := private.convert_lead(v_lead, v_r.to_kitchen_id, v_r.to_plan_id, 'web');

  update public.kitchen_switch_requests
  set status = 'approved', effective_date = v_eff, new_customer_id = (v_conv ->> 'customer_id')::uuid,
      decision_note = nullif(trim(p_note), ''), decided_by = auth.uid(), decided_at = private.now()
  where id = p_request;

  perform private.notify_customer(v_r.to_kitchen_id, (v_conv ->> 'customer_id')::uuid, 'kitchen_switch_approved',
    jsonb_build_object('from_kitchen', (select name from public.kitchens where id = v_c.kitchen_id),
                       'effective_date', v_eff, 'url', v_conv ->> 'portal_url'),
    'kitchen_switch_approved:' || p_request);
  perform private.notify_owners(v_c.kitchen_id, 'customer_switched_out',
    jsonb_build_object('customer_name', v_c.name, 'effective_date', v_eff), 'customer_switched_out:' || p_request);

  return jsonb_build_object('status', 'approved', 'effective_date', v_eff, 'new_customer_id', v_conv ->> 'customer_id',
                            'trial_amount_paise', v_conv -> 'trial_amount_paise');
end;
$$;

-- ===========================================================================
-- 4. Office plans
-- ===========================================================================
create table public.offices (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  name text not null check (length(trim(name)) between 2 and 80),
  line1 text,
  area text,
  landmark text,
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  contact_name text check (length(contact_name) <= 80),
  contact_phone_enc bytea,
  contact_phone_last4 text check (contact_phone_last4 ~ '^[0-9]{4}$'),
  billing_customer_id uuid not null,
  address_id uuid,                            -- the delivery point (an address row of the billing customer)
  active boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id),
  unique (kitchen_id, name),
  foreign key (billing_customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (address_id, kitchen_id) references public.addresses (id, kitchen_id)
);
create trigger offices_updated_at before update on public.offices
  for each row execute function private.set_updated_at();
create trigger offices_audit after insert or update or delete on public.offices
  for each row execute function private.audit_row();

alter table public.customers add column office_id uuid,
  add constraint customers_office_fk foreign key (office_id, kitchen_id) references public.offices (id, kitchen_id);
create index customers_office_idx on public.customers (office_id) where office_id is not null;
grant select (office_id) on public.customers to authenticated;

alter table public.delivery_stops add column office_id uuid,
  add constraint delivery_stops_office_fk foreign key (office_id, kitchen_id) references public.offices (id, kitchen_id);
grant select (office_id) on public.delivery_stops to authenticated;

-- Owner creates or updates an office. The billing customer pays for every member (P5 payer).
create or replace function public.upsert_office(
  p_kitchen uuid,
  p_name text,
  p_billing_customer uuid,
  p_line1 text default null,
  p_area text default null,
  p_landmark text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_contact_name text default null,
  p_contact_phone text default null,
  p_office uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.offices;
  v_bill public.customers;
  v_phone text;
  v_addr uuid;
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner}');
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;
  select * into v_bill from public.customers where id = p_billing_customer and kitchen_id = p_kitchen and deleted_at is null;
  if v_bill.id is null then
    raise exception 'invalid_payer' using errcode = '22023';
  end if;
  if v_bill.payer_customer_id is not null then
    raise exception 'payer_chain' using errcode = '22023';
  end if;
  if nullif(trim(p_contact_phone), '') is not null then
    v_phone := private.normalize_phone(p_contact_phone);
    if v_phone is null then
      raise exception 'invalid_phone' using errcode = '22023';
    end if;
  end if;
  if p_office is not null then
    select * into v_o from public.offices where id = p_office and kitchen_id = p_kitchen;
    if v_o.id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;

  -- The delivery point is an address row owned by the billing customer (composite FKs hold).
  if v_o.address_id is not null and v_o.billing_customer_id = p_billing_customer then
    update public.addresses set label = 'Office: ' || trim(p_name), line1 = nullif(trim(p_line1), ''), area = nullif(trim(p_area), ''),
      landmark = nullif(trim(p_landmark), ''), lat = p_lat, lng = p_lng
    where id = v_o.address_id;
    v_addr := v_o.address_id;
  else
    insert into public.addresses (kitchen_id, customer_id, label, line1, area, landmark, lat, lng, is_default)
    values (p_kitchen, p_billing_customer, 'Office: ' || trim(p_name), nullif(trim(p_line1), ''), nullif(trim(p_area), ''),
            nullif(trim(p_landmark), ''), p_lat, p_lng, false)
    returning id into v_addr;
  end if;

  if v_o.id is null then
    insert into public.offices (kitchen_id, name, line1, area, landmark, lat, lng, contact_name, contact_phone_enc,
                                contact_phone_last4, billing_customer_id, address_id, created_by)
    values (p_kitchen, trim(p_name), nullif(trim(p_line1), ''), nullif(trim(p_area), ''), nullif(trim(p_landmark), ''), p_lat, p_lng,
            nullif(trim(p_contact_name), ''), case when v_phone is not null then private.encrypt_phone(v_phone) end,
            right(v_phone, 4), p_billing_customer, v_addr, auth.uid())
    returning id into v_id;
  else
    update public.offices set name = trim(p_name), line1 = nullif(trim(p_line1), ''), area = nullif(trim(p_area), ''),
      landmark = nullif(trim(p_landmark), ''), lat = p_lat, lng = p_lng, contact_name = nullif(trim(p_contact_name), ''),
      contact_phone_enc = case when v_phone is not null then private.encrypt_phone(v_phone)
                               when p_contact_phone is not null then null else contact_phone_enc end,
      contact_phone_last4 = case when v_phone is not null then right(v_phone, 4)
                                 when p_contact_phone is not null then null else contact_phone_last4 end,
      billing_customer_id = p_billing_customer, address_id = v_addr
    where id = v_o.id
    returning id into v_id;
    -- A new billing customer becomes everyone's payer.
    if v_o.billing_customer_id <> p_billing_customer then
      update public.customers set payer_customer_id = null where office_id = v_id and payer_customer_id = v_o.billing_customer_id;
      update public.customers set payer_customer_id = p_billing_customer
      where office_id = v_id and id <> p_billing_customer;
    end if;
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'already_exists' using errcode = '23505';
end;
$$;

-- Owner adds a customer to an office (null removes): the office's billing customer pays for them.
create or replace function public.set_customer_office(p_customer uuid, p_office uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_o public.offices;
  v_old public.offices;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  select * into v_old from public.offices where id = v_c.office_id;
  if p_office is not null then
    select * into v_o from public.offices where id = p_office and kitchen_id = v_c.kitchen_id and active;
    if v_o.id is null then
      raise exception 'invalid_office' using errcode = '22023';
    end if;
  end if;
  update public.customers
  set office_id = p_office,
      payer_customer_id = case
        when v_o.id is not null and v_o.billing_customer_id <> p_customer then v_o.billing_customer_id
        when v_old.id is not null and payer_customer_id = v_old.billing_customer_id then null
        else payer_customer_id end
  where id = p_customer;
end;
$$;

create or replace function public.offices_list(p_kitchen uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner boolean;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  v_owner := private.has_role(p_kitchen, '{owner}');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'line1', o.line1, 'area', o.area, 'landmark', o.landmark, 'lat', o.lat, 'lng', o.lng,
      'contact_name', o.contact_name,
      'contact_phone', case when v_owner then private.decrypt_phone(o.contact_phone_enc) else private.mask_phone(o.contact_phone_last4) end,
      'billing_customer_id', case when v_owner then o.billing_customer_id end,
      'billing_customer_name', case when v_owner then (select name from public.customers where id = o.billing_customer_id) end,
      'active', o.active,
      'members', (select count(*) from public.customers c where c.office_id = o.id and c.deleted_at is null)) order by o.name)
    from public.offices o where o.kitchen_id = p_kitchen), '[]'::jsonb);
end;
$$;

-- Monthly statement for the office's billing contact (owner): meals charged per member.
create or replace function public.office_statement(p_office uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_o public.offices;
  v_from timestamptz;
  v_to timestamptz;
begin
  select * into v_o from public.offices where id = p_office;
  if v_o.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_o.kitchen_id, '{owner}');
  v_from := date_trunc('month', p_month)::date::timestamp at time zone 'Asia/Kolkata';
  v_to := (date_trunc('month', p_month) + interval '1 month')::date::timestamp at time zone 'Asia/Kolkata';
  return (
    with m as (
      select c.id, c.name,
             coalesce(-sum(b.meals) filter (where b.type = 'meal'), 0)::integer as meals,
             coalesce(-sum(b.amount_paise) filter (where b.type = 'meal'), 0)::integer as amount_paise,
             coalesce(sum(b.meals) filter (where b.type = 'credit'), 0)::integer as credit_meals,
             (select coalesce(sum(p.amount_paise), 0) from public.payments p where p.customer_id = c.id and p.status = 'paid'
                and p.paid_at >= v_from and p.paid_at < v_to)::integer as paid_paise,
             (select coalesce(sum(x.meals), 0) from public.balance_entries x where x.customer_id = c.id)::integer as balance_meals
      from public.customers c
      left join public.balance_entries b on b.customer_id = c.id and b.created_at >= v_from and b.created_at < v_to
      where c.office_id = v_o.id
      group by c.id, c.name
    )
    select jsonb_build_object(
      'office', jsonb_build_object('id', v_o.id, 'name', v_o.name, 'billing_customer_id', v_o.billing_customer_id,
                                   'billing_customer_name', (select name from public.customers where id = v_o.billing_customer_id)),
      'month', to_char(date_trunc('month', p_month), 'YYYY-MM'),
      'members', coalesce((select jsonb_agg(jsonb_build_object('customer_id', id, 'name', name, 'meals', meals,
                            'amount_paise', amount_paise, 'credit_meals', credit_meals, 'paid_paise', paid_paise,
                            'balance_meals', balance_meals) order by name) from m), '[]'::jsonb),
      'totals', jsonb_build_object('meals', coalesce((select sum(meals) from m), 0),
                                   'amount_paise', coalesce((select sum(amount_paise) from m), 0),
                                   'paid_paise', coalesce((select sum(paid_paise) from m), 0),
                                   'balance_meals', coalesce((select sum(balance_meals) from m), 0))));
end;
$$;

-- ===========================================================================
-- 5. Health tags (sensitive; consent required)
-- ===========================================================================
create or replace function private.health_tag_list()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['diabetic', 'low_salt', 'low_oil', 'low_spice', 'no_onion_garlic', 'soft_food'];
$$;

create table public.customer_health (
  customer_id uuid primary key,
  kitchen_id uuid not null,
  tags text[] not null check (cardinality(tags) between 1 and 6),
  consent_at timestamptz not null,
  consent_basis text not null check (consent_basis in ('customer', 'vendor_attested')),
  recorded_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  check (tags <@ array['diabetic', 'low_salt', 'low_oil', 'low_spice', 'no_onion_garlic', 'soft_food']),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id) on delete cascade
);
create index customer_health_kitchen_idx on public.customer_health (kitchen_id);
create trigger customer_health_updated_at before update on public.customer_health
  for each row execute function private.set_updated_at();
create trigger customer_health_audit after insert or update or delete on public.customer_health
  for each row execute function private.audit_row();

alter table public.consents drop constraint consents_purpose_check;
alter table public.consents add constraint consents_purpose_check
  check (purpose in ('service_contact', 'whatsapp', 'marketing', 'health_data'));

create or replace function private.set_health_tags(p_customer uuid, p_tags text[], p_consent boolean, p_basis text, p_channel text)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_tags text[];
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  select coalesce(array_agg(distinct lower(trim(t)) order by lower(trim(t))), '{}') into v_tags
  from unnest(coalesce(p_tags, '{}')) t where nullif(trim(t), '') is not null;
  if cardinality(v_tags) = 0 then
    -- Withdrawn: the data goes, the consent record is marked withdrawn.
    delete from public.customer_health where customer_id = p_customer;
    update public.consents set withdrawn_at = private.now()
    where customer_id = p_customer and purpose = 'health_data' and withdrawn_at is null;
    return '{}';
  end if;
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if not (v_tags <@ private.health_tag_list()) then
    raise exception 'invalid_tags' using errcode = '22023';
  end if;
  insert into public.customer_health (customer_id, kitchen_id, tags, consent_at, consent_basis, recorded_by)
  values (p_customer, v_c.kitchen_id, v_tags, private.now(), p_basis, auth.uid())
  on conflict (customer_id) do update
    set tags = excluded.tags, consent_at = excluded.consent_at, consent_basis = excluded.consent_basis,
        recorded_by = excluded.recorded_by;
  if not exists (select 1 from public.consents where customer_id = p_customer and purpose = 'health_data' and withdrawn_at is null) then
    insert into public.consents (kitchen_id, customer_id, purpose, basis, channel, recorded_by)
    values (v_c.kitchen_id, p_customer, 'health_data', p_basis, p_channel, auth.uid());
  end if;
  return v_tags;
end;
$$;

-- Owner records tags the customer agreed to share (empty array withdraws and deletes them).
create or replace function public.set_health_tags(p_customer uuid, p_tags text[], p_consent boolean default false)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer and deleted_at is null;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  return private.set_health_tags(p_customer, p_tags, p_consent, 'vendor_attested', 'vendor');
end;
$$;

create or replace function public.portal_set_health_tags(p_token text, p_tags text[], p_consent boolean default false)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
begin
  return private.set_health_tags(v_cust.id, p_tags, p_consent, 'customer', 'web');
end;
$$;

-- Erasure (P5 trigger) now also deletes health data.
create or replace function private.customer_erased_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.customers set payer_customer_id = null where payer_customer_id = new.id;
    delete from public.customer_health where customer_id = new.id;
    update public.customers set office_id = null where id = new.id and office_id is not null;
  end if;
  return null;
end;
$$;

-- Counts (P5) + health tags (meals per tag).
create or replace function private.slot_totals(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with o as (
    select mo.*, (mo.status <> 'skipped' or mo.charged) as counted, p.name as plan_name, a.area
    from public.meal_orders mo
    join public.plans p on p.id = mo.plan_id
    left join public.addresses a on a.id = mo.address_id
    where mo.kitchen_id = p_kitchen and mo.service_date = p_date and mo.slot = p_slot
  )
  select jsonb_build_object(
    'total_meals', coalesce((select sum(qty) from o where counted), 0),
    'orders', (select count(*) from o where counted),
    'to_deliver', coalesce((select sum(qty) from o where status <> 'skipped'), 0),
    'skipped', (select count(*) from o where status = 'skipped' and not charged),
    'late_skips', (select count(*) from o where status = 'skipped' and charged),
    'by_diet', jsonb_build_object(
      'veg', coalesce((select sum(qty) from o where counted and diet = 'veg'), 0),
      'nonveg', coalesce((select sum(qty) from o where counted and diet = 'nonveg'), 0),
      'jain', coalesce((select sum(qty) from o where counted and diet = 'jain'), 0)),
    'veg_switched', coalesce((select sum(qty) from o where counted and veg_override), 0),
    'by_health', coalesce((select jsonb_object_agg(tag, m) from (
                             select t.tag, sum(o.qty) as m from o join public.customer_health h on h.customer_id = o.customer_id,
                                    unnest(h.tags) t(tag)
                             where o.counted group by t.tag) x), '{}'::jsonb),
    'by_plan', coalesce((select jsonb_agg(jsonb_build_object('plan', plan_name, 'meals', m) order by plan_name)
                         from (select plan_name, sum(qty) m from o where counted group by plan_name) x), '[]'::jsonb),
    'by_area', coalesce((select jsonb_agg(jsonb_build_object('area', area, 'meals', m) order by m desc, area)
                         from (select coalesce(area, 'No area') area, sum(qty) m from o where counted group by 1) x), '[]'::jsonb)
  );
$$;

-- Packing list (M5) + veg-day switch, health tags and office. Staff use it: no phones, no money.
drop function public.packing_list(uuid, date, public.meal_slot);
create function public.packing_list(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns table (
  order_id uuid,
  customer_name text,
  line1 text,
  landmark text,
  area text,
  delivery_notes text,
  customer_notes text,
  qty smallint,
  diet public.diet_type,
  plan_name text,
  status public.order_status,
  charged boolean,
  stop_seq integer,
  veg_override boolean,
  health_tags text[],
  office_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  return query
  select o.id, cu.name, coalesce(oa.line1, a.line1), coalesce(oa.landmark, a.landmark), coalesce(oa.area, a.area),
         a.delivery_notes, cu.notes, o.qty, o.diet, p.name, o.status, o.charged, o.stop_seq, o.veg_override,
         h.tags, ofc.name
  from public.meal_orders o
  join public.customers cu on cu.id = o.customer_id
  join public.plans p on p.id = o.plan_id
  left join public.addresses a on a.id = o.address_id
  left join public.delivery_stops ds on ds.id = o.stop_id
  left join public.offices ofc on ofc.id = ds.office_id
  left join public.addresses oa on oa.id = ofc.address_id
  left join public.customer_health h on h.customer_id = o.customer_id
  left join public.delivery_runs dr on dr.id = o.run_id
  left join public.delivery_routes rt on rt.id = dr.route_id
  where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
    and (o.status <> 'skipped' or o.charged)
  order by rt.name nulls last, o.stop_seq nulls last, a.area nulls last, a.landmark nulls last, cu.name;
end;
$$;

-- Sticker sheet (P5) + office stops, eaters at the stop and their health tags.
create or replace function public.sticker_sheet(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'stop_id', s.id, 'run_id', dr.id, 'route_name', rt.name, 'seq', s.seq, 'name', coalesce(ofc.name, cu.name),
      'office', ofc.name is not null,
      'line1', a.line1, 'landmark', a.landmark, 'area', a.area, 'meal_count', s.meal_count,
      'diets', (select jsonb_object_agg(x.diet, x.n) from (
                  select o.diet, sum(o.qty)::integer as n from public.meal_orders o
                  where o.stop_id = s.id and o.status <> 'skipped' group by o.diet) x),
      'veg_day', exists (select 1 from public.meal_orders o where o.stop_id = s.id and o.veg_override),
      'health_tags', coalesce((select jsonb_agg(distinct t) from public.meal_orders o
                               join public.customer_health h on h.customer_id = o.customer_id, unnest(h.tags) t
                               where o.stop_id = s.id and o.status <> 'skipped'), '[]'::jsonb),
      'eaters', (select jsonb_agg(jsonb_build_object('name', e.name, 'qty', e.qty, 'diet', e.diet, 'veg_day', e.veg_override,
                                                     'health_tags', coalesce(to_jsonb(e.tags), '[]'::jsonb)) order by e.name)
                 from (select c2.name, o.qty, o.diet, o.veg_override, h.tags
                       from public.meal_orders o join public.customers c2 on c2.id = o.customer_id
                       left join public.customer_health h on h.customer_id = o.customer_id
                       where o.stop_id = s.id and o.status <> 'skipped') e),
      'notes', nullif(concat_ws(' · ', a.delivery_notes, case when ofc.id is null then cu.notes end), ''),
      'qr_token', s.qr_token, 'status', s.status) order by rt.name, s.seq)
    from public.delivery_stops s
    join public.delivery_runs dr on dr.id = s.run_id
    join public.delivery_routes rt on rt.id = dr.route_id
    join public.customers cu on cu.id = s.customer_id
    left join public.offices ofc on ofc.id = s.office_id
    left join public.addresses a on a.id = s.address_id
    where dr.kitchen_id = p_kitchen and dr.service_date = p_date and dr.slot = p_slot), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 6. Notebook-photo import (preview only)
-- ===========================================================================
-- What the notebook-import Edge Function needs: the caller must own the kitchen and the photo
-- must sit in that kitchen's folder of the private 'imports' bucket.
create or replace function public.notebook_import_context(p_kitchen uuid, p_path text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  if nullif(trim(p_path), '') is null or split_part(p_path, '/', 1) <> p_kitchen::text or p_path ~ '\.\.' then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'kitchen_name', (select name from public.kitchens where id = p_kitchen),
    'plans', coalesce((select jsonb_agg(p.name order by p.name) from public.plans p where p.kitchen_id = p_kitchen and p.active), '[]'::jsonb));
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imports', 'imports', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy imports_read on storage.objects for select to authenticated
  using (bucket_id = 'imports' and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}'))::text[]));
create policy imports_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'imports' and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}'))::text[]));

-- ===========================================================================
-- Customer page extras (P5) + health tags, office, switching flag.
-- ===========================================================================
create or replace function private.portal_extras(p_cust public.customers)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ks public.kitchen_settings;
begin
  select * into v_ks from public.kitchen_settings where kitchen_id = p_cust.kitchen_id;
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
    'referral', jsonb_build_object(
      'code', p_cust.referral_code,
      'url', private.public_web_url() || '/find?ref=' || p_cust.referral_code,
      'reward_meals', v_ks.referral_reward_meals,
      'referred', exists (select 1 from public.referrals r where r.referee_customer_id = p_cust.id),
      'can_apply', not exists (select 1 from public.referrals r where r.referee_customer_id = p_cust.id)
                   and not exists (select 1 from public.balance_entries b where b.customer_id = p_cust.id and b.type = 'recharge')),
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

-- Route building (M5 speed version) + office grouping.
create or replace function private.build_runs(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_k public.kitchens;
  v_stops integer := 0;
  r record;
  v_run uuid;
  v_lat double precision[];
  v_lng double precision[];
  v_route uuid;
  v_default_route uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('runs:' || p_kitchen || ':' || p_date || ':' || p_slot, 0));
  select * into v_k from public.kitchens where id = p_kitchen;

  -- The slot's deliverable orders with their stop key: an office member's meal goes to the office
  -- (billing customer + office address), everyone else to their own address (P6 offices).
  if to_regclass('pg_temp.build_orders') is null then
    create temporary table build_orders (
      order_id uuid, customer_id uuid, address_id uuid, office_id uuid, qty integer, sort_name text
    ) on commit drop;
  end if;
  truncate pg_temp.build_orders;
  insert into pg_temp.build_orders
  select o.id,
         case when ofc.id is not null then ofc.billing_customer_id else o.customer_id end,
         case when ofc.id is not null then ofc.address_id else o.address_id end,
         ofc.id, o.qty, coalesce(ofc.name, cu.name)
  from public.meal_orders o
  join public.customers cu on cu.id = o.customer_id
  left join public.offices ofc on ofc.id = cu.office_id and ofc.active
  where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot and o.status <> 'skipped';

  -- 1. Every deliverable address needs a place in an active route.
  for r in
    select distinct b.address_id
    from pg_temp.build_orders b
    left join public.route_stops rs on rs.kitchen_id = p_kitchen and rs.slot = p_slot and rs.address_id = b.address_id
    left join public.delivery_routes dr on dr.id = rs.route_id
    where b.address_id is not null
      and (rs.id is null or not dr.active)
  loop
    v_route := private.route_for_address(p_kitchen, p_slot, r.address_id);
    if exists (select 1 from public.delivery_runs x where x.route_id = v_route)
       or exists (select 1 from public.route_stops rs where rs.route_id = v_route and rs.pinned) then
      perform private.insert_route_stop(v_route, r.address_id);
    else
      -- First build of this route: it is optimised as a whole just below, so append.
      insert into public.route_stops (kitchen_id, route_id, slot, address_id, seq)
      values (p_kitchen, v_route, p_slot, r.address_id,
              (select coalesce(max(seq), 0) + 1 from public.route_stops where route_id = v_route))
      on conflict (kitchen_id, slot, address_id) do update
        set route_id = excluded.route_id, seq = excluded.seq, pinned = false, updated_at = now();
    end if;
  end loop;

  -- Orders without an address go to the first active route (at the end).
  if exists (select 1 from pg_temp.build_orders b where b.address_id is null) then
    perform private.route_for_address(p_kitchen, p_slot, null);
  end if;

  -- A route's first build gets a full optimisation (insertion one by one is only for additions).
  for r in
    select dr.id from public.delivery_routes dr
    where dr.kitchen_id = p_kitchen and dr.slot = p_slot and dr.active
      and not exists (select 1 from public.delivery_runs x where x.route_id = dr.id)
      and not exists (select 1 from public.route_stops rs where rs.route_id = dr.id and rs.pinned)
  loop
    perform private.optimize_route_order(r.id);
  end loop;

  -- 2. One run per route that has deliveries (planned runs only are (re)synced).
  v_default_route := (select id from public.delivery_routes
                      where kitchen_id = p_kitchen and slot = p_slot and active
                      order by created_at, name limit 1);
  for r in
    select coalesce(rs.route_id, v_default_route) as route_id
    from pg_temp.build_orders b
    left join public.route_stops rs on rs.kitchen_id = p_kitchen and rs.slot = p_slot and rs.address_id = b.address_id
    group by 1
  loop
    insert into public.delivery_runs (kitchen_id, route_id, service_date, slot, rider_id)
    select p_kitchen, r.route_id, p_date, p_slot, dr.rider_id from public.delivery_routes dr where dr.id = r.route_id
    on conflict (route_id, service_date) do nothing;
  end loop;

  for v_run in
    select id from public.delivery_runs
    where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot and status = 'planned'
  loop
    -- Desired stops for this run.
    if to_regclass('pg_temp.run_stops_wanted') is null then
      create temporary table run_stops_wanted (
        customer_id uuid, address_id uuid, office_id uuid, meal_count integer, route_seq integer, sort_name text, order_ids uuid[]
      ) on commit drop;
    end if;
    truncate pg_temp.run_stops_wanted;
    insert into pg_temp.run_stops_wanted
    select b.customer_id, b.address_id, b.office_id, sum(b.qty), min(coalesce(rs.seq, 1000000)), min(b.sort_name), array_agg(b.order_id)
    from pg_temp.build_orders b
    join public.delivery_runs dr on dr.id = v_run
    left join public.route_stops rs on rs.kitchen_id = p_kitchen and rs.slot = p_slot and rs.address_id = b.address_id
    where coalesce(rs.route_id, v_default_route) = dr.route_id
    group by b.customer_id, b.address_id, b.office_id;

    -- Orders in this run that are no longer wanted leave it.
    update public.meal_orders o set run_id = null, stop_id = null, stop_seq = null
    where o.run_id = v_run
      and not exists (select 1 from pg_temp.run_stops_wanted w where o.id = any (w.order_ids));
    delete from public.delivery_stops s
    where s.run_id = v_run and s.status = 'pending'
      and not exists (select 1 from pg_temp.run_stops_wanted w
                      where w.customer_id = s.customer_id and w.address_id is not distinct from s.address_id);

    insert into public.delivery_stops (kitchen_id, run_id, customer_id, address_id, office_id, seq, meal_count)
    select p_kitchen, v_run, w.customer_id, w.address_id, w.office_id,
           row_number() over (order by w.route_seq, w.sort_name), w.meal_count
    from pg_temp.run_stops_wanted w
    on conflict (run_id, customer_id, address_id) do update
      set meal_count = excluded.meal_count, office_id = excluded.office_id;

    -- Renumber 1..n in saved order.
    update public.delivery_stops s set seq = x.rn
    from (
      select s2.id, row_number() over (order by w.route_seq, w.sort_name) as rn
      from public.delivery_stops s2
      join pg_temp.run_stops_wanted w on w.customer_id = s2.customer_id and w.address_id is not distinct from s2.address_id
      where s2.run_id = v_run
    ) x
    where s.id = x.id and s.seq is distinct from x.rn;

    update public.meal_orders o set run_id = v_run, stop_id = s.id, stop_seq = s.seq
    from pg_temp.run_stops_wanted w
    join public.delivery_stops s on s.run_id = v_run and s.customer_id = w.customer_id
                                 and s.address_id is not distinct from w.address_id
    where o.id = any (w.order_ids)
      and (o.run_id is distinct from v_run or o.stop_id is distinct from s.id or o.stop_seq is distinct from s.seq);

    select array_agg(a.lat order by s.seq), array_agg(a.lng order by s.seq) into v_lat, v_lng
    from public.delivery_stops s left join public.addresses a on a.id = s.address_id
    where s.run_id = v_run;
    update public.delivery_runs set planned_km = private.path_km(v_lat, v_lng, v_k.lat, v_k.lng) where id = v_run;

    -- A planned run with no stops left is removed.
    if not exists (select 1 from public.delivery_stops where run_id = v_run) then
      delete from public.delivery_runs where id = v_run;
    end if;
  end loop;

  select count(*) into v_stops
  from public.delivery_stops s join public.delivery_runs dr on dr.id = s.run_id
  where dr.kitchen_id = p_kitchen and dr.service_date = p_date and dr.slot = p_slot;
  return v_stops;
end;
$$;

create or replace function public.rider_today()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', dr.id, 'kitchen_id', dr.kitchen_id, 'kitchen_name', k.name, 'kitchen_lat', k.lat, 'kitchen_lng', k.lng,
      'route_name', rt.name, 'service_date', dr.service_date, 'slot', dr.slot, 'status', dr.status,
      'started_at', dr.started_at, 'finished_at', dr.finished_at, 'planned_km', dr.planned_km,
      'stops', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'seq', s.seq, 'customer_id', s.customer_id, 'name', coalesce(ofc.name, cu.name), 'office', ofc.id is not null,
          'phone_masked', 'XXXXXX' || coalesce(cu.phone_last4, '????'),
          'line1', a.line1, 'area', a.area, 'landmark', a.landmark, 'delivery_notes', a.delivery_notes,
          'lat', a.lat, 'lng', a.lng, 'meal_count', s.meal_count,
          'diets', (select jsonb_object_agg(x.diet, x.n) from (
                      select o.diet, sum(o.qty)::integer as n from public.meal_orders o
                      where o.stop_id = s.id group by o.diet) x),
          'status', s.status, 'proof_type', s.proof_type, 'otp_ok', s.otp_ok, 'done_at', s.done_at,
          'failed_reason', s.failed_reason, 'tiffins_out', s.tiffins_out, 'tiffins_returned', s.tiffins_returned,
          'tiffins_with_customer', coalesce((select sum(t.tiffins_out - t.tiffins_returned)::integer
                                             from public.tiffin_ledger t
                                             where t.kitchen_id = s.kitchen_id and t.customer_id = s.customer_id), 0),
          'otp_sent', exists (select 1 from public.notifications_outbox n
                              where n.dedupe_key like 'on_the_way:' || s.id || '%' and n.status in ('pending', 'sent', 'sending')),
          'qr_token', s.qr_token
        ) order by s.seq)
        from public.delivery_stops s
        join public.customers cu on cu.id = s.customer_id
        left join public.offices ofc on ofc.id = s.office_id
        left join public.addresses a on a.id = s.address_id
        where s.run_id = dr.id), '[]'::jsonb)
    ) order by dr.slot, k.name, rt.name)
    from public.delivery_runs dr
    join public.kitchens k on k.id = dr.kitchen_id
    join public.delivery_routes rt on rt.id = dr.route_id
    where dr.rider_id = auth.uid() and dr.service_date = private.ist_today()
      and exists (select 1 from public.members m where m.kitchen_id = dr.kitchen_id and m.user_id = auth.uid())
  ), '[]'::jsonb);
end;
$$;

create or replace function public.live_board(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner boolean;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  v_owner := private.has_role(p_kitchen, '{owner}');
  return jsonb_build_object(
    'service_date', p_date, 'slot', p_slot,
    'locked', exists (select 1 from public.count_snapshots where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot),
    'kitchen', (select jsonb_build_object('lat', lat, 'lng', lng, 'name', name) from public.kitchens where id = p_kitchen),
    'unassigned', (select count(*) from public.meal_orders o
                   where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
                     and o.status <> 'skipped' and o.stop_id is null),
    'riders', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', m.display_name, 'role', m.role)
                                         order by m.role desc, m.display_name)
                        from public.members m where m.kitchen_id = p_kitchen and m.role in ('owner', 'rider')), '[]'::jsonb),
    'routes', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'rider_id', r.rider_id,
                                                            'active', r.active,
                                                            'stops', (select count(*) from public.route_stops where route_id = r.id))
                                         order by r.name)
                        from public.delivery_routes r where r.kitchen_id = p_kitchen and r.slot = p_slot), '[]'::jsonb),
    'runs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', dr.id, 'route_id', dr.route_id, 'route_name', rt.name, 'rider_id', dr.rider_id,
        'rider_name', (select display_name from public.members where kitchen_id = p_kitchen and user_id = dr.rider_id),
        'status', dr.status, 'started_at', dr.started_at, 'finished_at', dr.finished_at, 'planned_km', dr.planned_km,
        'last_lat', dr.last_lat, 'last_lng', dr.last_lng, 'last_seen_at', dr.last_seen_at,
        'counts', (select jsonb_build_object(
                     'stops', count(*), 'meals', coalesce(sum(meal_count), 0),
                     'delivered', count(*) filter (where status = 'delivered'),
                     'failed', count(*) filter (where status = 'failed'),
                     'pending', count(*) filter (where status = 'pending'),
                     'proved', count(*) filter (where status = 'delivered' and (otp_ok or photo_path is not null)))
                   from public.delivery_stops where run_id = dr.id),
        'stops', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', s.id, 'seq', s.seq, 'customer_id', s.customer_id, 'customer_name', coalesce(ofc.name, cu.name),
            'office_id', s.office_id,
            'line1', a.line1, 'area', a.area, 'landmark', a.landmark, 'lat', a.lat, 'lng', a.lng,
            'meal_count', s.meal_count, 'status', s.status, 'proof_type', s.proof_type, 'otp_ok', s.otp_ok,
            'photo_path', s.photo_path, 'done_at', s.done_at, 'offline', s.offline, 'synced_at', s.synced_at,
            'failed_reason', s.failed_reason, 'failed_note', s.failed_note, 'kitchen_fault', s.kitchen_fault,
            'gps_distance_m', s.gps_distance_m, 'tiffins_out', s.tiffins_out, 'tiffins_returned', s.tiffins_returned,
            'cash_paise', case when v_owner then (select amount_paise from public.payments where id = s.cash_payment_id) end
          ) order by s.seq)
          from public.delivery_stops s
          join public.customers cu on cu.id = s.customer_id
          left join public.offices ofc on ofc.id = s.office_id
          left join public.addresses a on a.id = s.address_id
          where s.run_id = dr.id), '[]'::jsonb)
      ) order by rt.name)
      from public.delivery_runs dr join public.delivery_routes rt on rt.id = dr.route_id
      where dr.kitchen_id = p_kitchen and dr.service_date = p_date and dr.slot = p_slot), '[]'::jsonb)
  );
end;
$$;

-- Failed office stops credit every member (P5 version otherwise unchanged).
create or replace function private.do_fail_stop(
  p_stop uuid, p_reason public.fail_reason, p_note text, p_lat double precision, p_lng double precision,
  p_at timestamptz, p_tiffins_returned integer, p_client_op uuid, p_offline boolean, p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op_stop uuid;
  v_s public.delivery_stops;
  v_run public.delivery_runs;
  v_at timestamptz;
  v_fault boolean;
  v_meals integer;
  v_amount integer;
  v_entry uuid;
  v_one uuid;
  r_o record;
begin
  -- Idempotency is per stop: a retried op returns its own stop's result; an op id that already
  -- belongs to another stop is refused (it would otherwise answer with someone else's result).
  if p_client_op is not null then
    select id into v_op_stop from public.delivery_stops where client_op_id = p_client_op;
    if v_op_stop is not null then
      if v_op_stop <> p_stop then
        raise exception 'invalid_client_op' using errcode = '22023';
      end if;
      return private.stop_result(v_op_stop);
    end if;
  end if;
  select * into v_s from public.delivery_stops where id = p_stop for update;
  select * into v_run from public.delivery_runs where id = v_s.run_id for update;
  if v_s.status <> 'pending' then
    return private.stop_result(p_stop, true);
  end if;
  if p_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_reason = 'other' and nullif(trim(p_note), '') is null then
    raise exception 'note_required' using errcode = '22023';
  end if;
  v_at := private.client_time(p_at, v_run.service_date);
  v_fault := private.is_kitchen_fault(p_reason);

  if v_run.status = 'planned' then
    perform private.do_start_run(v_run.id, v_at, p_actor);
  end if;

  -- Kitchen fault: the meals were charged at lock; give them back at the price they were charged.
  -- Balances are per eater, so an office stop credits each member's own meals (P6).
  if v_fault and v_s.office_id is null then
    select coalesce(sum(o.qty), 0), coalesce(sum(o.qty * coalesce(o.price_per_meal_paise, 0)), 0)
    into v_meals, v_amount
    from public.meal_orders o where o.stop_id = p_stop and (o.status <> 'skipped' or o.charged)
      and exists (select 1 from public.balance_entries b where b.type = 'meal' and b.ref_type = 'meal_order' and b.ref_id = o.id);
    if v_meals > 0 then
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
      values (v_s.kitchen_id, v_s.customer_id, 'credit', v_meals, v_amount, 'delivery_stop', p_stop,
              'Missed delivery: ' || p_reason, p_actor, v_at)
      on conflict (type, ref_type, ref_id) where ref_id is not null do nothing
      returning id into v_entry;
      if v_entry is not null then
        perform private.sync_balance_status(v_s.kitchen_id, v_s.customer_id);
        perform private.notify_customer(v_s.kitchen_id, v_s.customer_id, 'delivery_credit',
          jsonb_build_object('meals', v_meals, 'service_date', v_run.service_date, 'slot', v_run.slot),
          'delivery_credit:' || p_stop);
      end if;
    end if;
  elsif v_fault then
    for r_o in
      select o.id, o.customer_id, o.qty, o.qty * coalesce(o.price_per_meal_paise, 0) as amount
      from public.meal_orders o where o.stop_id = p_stop and (o.status <> 'skipped' or o.charged)
        and exists (select 1 from public.balance_entries b where b.type = 'meal' and b.ref_type = 'meal_order' and b.ref_id = o.id)
    loop
      v_one := null;
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
      values (v_s.kitchen_id, r_o.customer_id, 'credit', r_o.qty, r_o.amount, 'delivery_stop_order', r_o.id,
              'Missed delivery: ' || p_reason, p_actor, v_at)
      on conflict (type, ref_type, ref_id) where ref_id is not null do nothing
      returning id into v_one;
      if v_one is not null then
        v_entry := coalesce(v_entry, v_one);
        perform private.sync_balance_status(v_s.kitchen_id, r_o.customer_id);
        perform private.notify_customer(v_s.kitchen_id, r_o.customer_id, 'delivery_credit',
          jsonb_build_object('meals', r_o.qty, 'service_date', v_run.service_date, 'slot', v_run.slot),
          'delivery_credit:' || p_stop || ':' || r_o.customer_id);
      end if;
    end loop;
  end if;

  update public.delivery_stops
  set status = 'failed', failed_reason = p_reason, failed_note = nullif(trim(p_note), ''), kitchen_fault = v_fault,
      credit_entry_id = v_entry, gps_lat = p_lat, gps_lng = p_lng, done_at = v_at,
      device_at = case when p_at is distinct from v_at then p_at end, synced_at = private.now(),
      offline = coalesce(p_offline, false), tiffins_returned = coalesce(p_tiffins_returned, 0),
      client_op_id = p_client_op, done_by = p_actor
  where id = p_stop;

  update public.meal_orders set status = 'failed' where stop_id = p_stop and status <> 'skipped';

  if coalesce(p_tiffins_returned, 0) > 0 then
    insert into public.tiffin_ledger (kitchen_id, customer_id, stop_id, tiffins_returned, created_by, created_at)
    values (v_s.kitchen_id, v_s.customer_id, p_stop, p_tiffins_returned, p_actor, v_at)
    on conflict (stop_id) where stop_id is not null do nothing;
  end if;

  return private.stop_result(p_stop);
end;
$$;

-- ===========================================================================
-- RLS and grants
-- ===========================================================================
alter table public.platform_commissions enable row level security;
alter table public.platform_settings enable row level security;
alter table public.kitchen_switch_requests enable row level security;
alter table public.offices enable row level security;
alter table public.customer_health enable row level security;

create policy platform_commissions_select on public.platform_commissions for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
-- Feature flags are not secret: every signed-in user may read them.
create policy platform_settings_select on public.platform_settings for select to authenticated using (true);
create policy kitchen_switch_requests_select on public.kitchen_switch_requests for select to authenticated
  using ((select private.is_platform_admin()));
create policy offices_select on public.offices for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
-- Health data: owner and staff (packing), admins. Riders never.
create policy customer_health_select on public.customer_health for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));

revoke all on public.platform_commissions, public.platform_settings, public.kitchen_switch_requests, public.offices,
  public.customer_health from anon, authenticated;
grant select on public.platform_commissions, public.platform_settings, public.kitchen_switch_requests,
  public.customer_health to authenticated;
-- The office contact's phone is encrypted: owners read it through offices_list.
grant select (id, kitchen_id, name, line1, area, landmark, lat, lng, contact_name, contact_phone_last4, billing_customer_id,
  address_id, active, created_by, created_at, updated_at) on public.offices to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.kitchen_ids(public.member_role[]) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;
grant execute on function private.my_run_ids() to authenticated;

revoke execute on function public.admin_set_commission, public.admin_commission_report, public.commission_statement,
  public.admin_set_platform_flag, public.portal_switch_options, public.portal_request_switch, public.portal_cancel_switch,
  public.admin_switch_requests, public.admin_decide_switch, public.upsert_office, public.set_customer_office,
  public.offices_list, public.office_statement, public.set_health_tags, public.portal_set_health_tags, public.packing_list,
  public.sticker_sheet, public.notebook_import_context, public.rider_today, public.live_board
  from public, anon, authenticated;
grant execute on function public.admin_set_commission, public.admin_commission_report, public.commission_statement,
  public.admin_set_platform_flag, public.admin_switch_requests, public.admin_decide_switch, public.upsert_office,
  public.set_customer_office, public.offices_list, public.office_statement, public.set_health_tags, public.packing_list,
  public.sticker_sheet, public.notebook_import_context, public.rider_today, public.live_board
  to authenticated;
-- Customer page (token checked inside every function).
grant execute on function public.portal_switch_options, public.portal_request_switch, public.portal_cancel_switch,
  public.portal_set_health_tags to anon, authenticated;
