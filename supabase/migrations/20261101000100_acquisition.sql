-- M7: acquisition (new customers for vendors, and new vendors for the platform).
-- Leads from Google Ads forms, calls, Justdial, the website, Instagram and WhatsApp, each tagged
-- with source + campaign; bot/website qualification (location, meal times, diet, budget, start);
-- matching to active kitchens within their radius that have spare capacity, ranked by verified
-- rating and price fit; the customer picks from 2–3 kitchen profiles; paid trial → plan →
-- month-2 renewal funnel; platform_sourced customers. Vendor applications with onboarding nudges.

create type public.lead_source as enum ('whatsapp', 'website', 'google_ads', 'instagram', 'justdial', 'call', 'referral', 'other');
create type public.lead_status as enum ('new', 'qualifying', 'qualified', 'matched', 'trial', 'converted', 'renewed', 'waitlist', 'lost');
create type public.vendor_app_status as enum ('new', 'contacted', 'onboarding', 'live', 'rejected');

-- ---------------------------------------------------------------------------
-- Kitchen profile (public page) fields, owner-editable.
-- ---------------------------------------------------------------------------
alter table public.kitchens
  add column description text check (length(description) <= 1000),
  add column cuisine_tags text[] not null default '{}' check (cardinality(cuisine_tags) <= 10),
  add column photo_paths text[] not null default '{}' check (cardinality(photo_paths) <= 8),   -- kitchen-photos/<kitchen_id>/...
  add column trial_meals smallint not null default 2 check (trial_meals between 1 and 7),
  add column accepts_platform_leads boolean not null default true;
grant update (description, cuisine_tags, photo_paths, trial_meals, accepts_platform_leads) on public.kitchens to authenticated;

-- ---------------------------------------------------------------------------
-- Areas of Bhubaneswar (approximate centres) so a typed area can be matched without a
-- geocoding API. A shared WhatsApp location is always preferred (D-080).
-- ---------------------------------------------------------------------------
create table public.areas (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  city text not null default 'Bhubaneswar',
  lat double precision not null,
  lng double precision not null,
  aliases text[] not null default '{}'
);
insert into public.areas (name, lat, lng, aliases) values
  ('Patia', 20.3553, 85.8197, '{patia chhak,patia square}'),
  ('KIIT Square', 20.3540, 85.8180, '{kiit,kiit road,campus}'),
  ('Infocity', 20.3480, 85.8100, '{info city,infocity square,tcs,infosys,wipro}'),
  ('Chandrasekharpur', 20.3260, 85.8180, '{csp,chandrasekhar pur,chandrashekharpur}'),
  ('Damana', 20.3330, 85.8150, '{damana square}'),
  ('Raghunathpur', 20.3650, 85.8200, '{}'),
  ('Nandankanan Road', 20.3300, 85.8230, '{nandankanan,kalinga hospital}'),
  ('Sailashree Vihar', 20.3180, 85.8180, '{sailashree}'),
  ('Niladri Vihar', 20.3230, 85.8210, '{niladri}'),
  ('Jaydev Vihar', 20.2970, 85.8180, '{jayadev vihar,jaydev}'),
  ('Nayapalli', 20.2950, 85.8100, '{naya palli,irc village}'),
  ('Acharya Vihar', 20.2960, 85.8300, '{acharya}'),
  ('Vani Vihar', 20.2980, 85.8400, '{utkal university,vanivihar}'),
  ('Saheed Nagar', 20.2900, 85.8450, '{sahid nagar,shaheed nagar,esplanade}'),
  ('Satya Nagar', 20.2830, 85.8410, '{satyanagar}'),
  ('Bapuji Nagar', 20.2560, 85.8330, '{bapujinagar}'),
  ('Unit 4', 20.2810, 85.8300, '{unit-4,unit iv,mla colony}'),
  ('Kharavela Nagar', 20.2720, 85.8380, '{unit 3,unit-3}'),
  ('Master Canteen', 20.2680, 85.8430, '{railway station,station square}'),
  ('Kalpana Square', 20.2510, 85.8420, '{kalpana}'),
  ('Old Town', 20.2380, 85.8350, '{lingaraj,oldtown}'),
  ('Laxmisagar', 20.2560, 85.8550, '{laxmi sagar}'),
  ('Rasulgarh', 20.2900, 85.8600, '{}'),
  ('Bomikhal', 20.2830, 85.8570, '{}'),
  ('Palasuni', 20.2950, 85.8700, '{}'),
  ('Mancheswar', 20.3100, 85.8500, '{}'),
  ('Baramunda', 20.2750, 85.8000, '{baramunda bus stand}'),
  ('Khandagiri', 20.2580, 85.7800, '{khandgiri}'),
  ('Kalinga Nagar', 20.2850, 85.7700, '{sum hospital,ghatikia}'),
  ('Sundarpada', 20.2430, 85.7900, '{}'),
  ('Pokhariput', 20.2400, 85.8100, '{}');

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  phone_enc bytea,
  phone_hash text,
  phone_last4 text,
  name text check (length(name) <= 80),
  source public.lead_source not null,
  campaign text check (length(campaign) <= 60),
  external_id text,                       -- e.g. the Google Ads lead id (dedupe)
  status public.lead_status not null default 'new',
  language public.language_code not null default 'en',
  area text,
  area_id uuid references public.areas (id),
  address_text text,
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  geo_point extensions.geography(Point, 4326) generated always as (
    case when lat is not null and lng is not null
      then extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
    end
  ) stored,
  slots public.meal_slot[] check (slots is null or cardinality(slots) between 1 and 2),
  diet public.diet_type,
  budget_per_meal_paise integer check (budget_per_meal_paise is null or budget_per_meal_paise between 1000 and 100000),
  start_date date,
  consent_at timestamptz,                 -- agreed to be contacted about this enquiry
  whatsapp_opt_in boolean not null default false,
  bot_step text,                          -- WhatsApp qualification step
  token_hash text unique,                 -- website flow: the browser holds the token
  chosen_kitchen_id uuid references public.kitchens (id),
  customer_id uuid references public.customers (id),
  lost_reason text,
  notes text,
  qualified_at timestamptz,
  matched_at timestamptz,
  trial_at timestamptz,
  converted_at timestamptz,
  renewed_at timestamptz,
  followed_up_at timestamptz,
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);
create index leads_phone_idx on public.leads (phone_hash);
-- One open lead per phone (closed leads are kept for the funnel).
create unique index leads_one_open_idx on public.leads (phone_hash)
  where phone_hash is not null and status not in ('converted', 'renewed', 'lost');
create index leads_status_idx on public.leads (status, created_at desc);
create index leads_customer_idx on public.leads (customer_id);
create index leads_geo_idx on public.leads using gist (geo_point);

-- The shortlist shown to the lead (latest matching run).
create table public.lead_matches (
  lead_id uuid not null references public.leads (id) on delete cascade,
  kitchen_id uuid not null references public.kitchens (id),
  rank smallint not null,
  distance_km numeric(5, 2) not null,
  plan_id uuid not null references public.plans (id),
  price_per_meal_paise integer not null,
  rating numeric(3, 2),
  reviews integer not null default 0,
  spare integer not null,
  score numeric(6, 4) not null,
  created_at timestamptz not null default now(),
  primary key (lead_id, kitchen_id)
);

-- Funnel history, append-only.
create table public.lead_events (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads (id) on delete cascade,
  event text not null,
  detail jsonb not null default '{}',
  actor_id uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index lead_events_lead_idx on public.lead_events (lead_id, created_at);

-- Verified ratings: only customers who received meals from the kitchen can review it.
create table public.kitchen_reviews (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  customer_id uuid not null,
  rating smallint not null check (rating between 1 and 5),
  comment text check (length(comment) <= 500),
  verified boolean not null default false,
  hidden boolean not null default false,  -- platform moderation
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kitchen_id, customer_id),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id) on delete cascade
);

create table public.vendor_applications (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 80),
  phone_enc bytea not null,
  phone_hash text not null,
  phone_last4 text not null,
  kitchen_name text check (length(kitchen_name) <= 80),
  area text,
  lat double precision,
  lng double precision,
  subscribers_estimate integer check (subscribers_estimate is null or subscribers_estimate between 0 and 5000),
  fssai_no text check (fssai_no is null or fssai_no ~ '^[0-9]{14}$'),
  source public.lead_source not null default 'website',
  campaign text,
  status public.vendor_app_status not null default 'new',
  kitchen_id uuid references public.kitchens (id),
  consent_at timestamptz not null,
  whatsapp_opt_in boolean not null default false,
  bot_step text,
  notes text,
  nudges smallint not null default 0,
  last_nudged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index vendor_applications_open_phone_idx on public.vendor_applications (phone_hash)
  where status in ('new', 'contacted', 'onboarding');

create trigger leads_updated_at before update on public.leads
  for each row execute function private.set_updated_at();
create trigger kitchen_reviews_updated_at before update on public.kitchen_reviews
  for each row execute function private.set_updated_at();
create trigger vendor_applications_updated_at before update on public.vendor_applications
  for each row execute function private.set_updated_at();
create trigger lead_events_append_only before update or delete on public.lead_events
  for each row execute function private.forbid_mutation();
create trigger leads_audit after insert or update or delete on public.leads
  for each row execute function private.audit_row();
create trigger kitchen_reviews_audit after insert or update or delete on public.kitchen_reviews
  for each row execute function private.audit_row();
create trigger vendor_applications_audit after insert or update or delete on public.vendor_applications
  for each row execute function private.audit_row();

-- Outbox can now address leads and vendor applicants directly.
alter table public.notifications_outbox drop constraint notifications_outbox_recipient_type_check;
alter table public.notifications_outbox add constraint notifications_outbox_recipient_type_check
  check (recipient_type in ('member', 'customer', 'lead', 'vendor_application'));

-- Base URL of the web app for links in messages (Vault secret public_web_url; local default).
create or replace function private.public_web_url()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'public_web_url' limit 1),
                  'http://localhost:3000');
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function private.lead_event(p_lead uuid, p_event text, p_detail jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.lead_events (lead_id, event, detail, actor_id, created_at)
  values (p_lead, p_event, coalesce(p_detail, '{}'), auth.uid(), private.now());
$$;

-- Best area for free text ("near kiit campus 6" → KIIT Square).
create or replace function private.find_area(p_text text)
returns public.areas
language sql
stable
set search_path = ''
as $$
  select a.* from public.areas a
  where p_text is not null and length(trim(p_text)) >= 3
    and (lower(p_text) like '%' || lower(a.name) || '%'
         or exists (select 1 from unnest(a.aliases) al where lower(p_text) like '%' || al || '%')
         or lower(a.name) like lower(trim(p_text)) || '%')
  order by (lower(trim(p_text)) = lower(a.name)) desc, length(a.name) desc
  limit 1;
$$;

-- Verified rating with a prior of 4.0 worth 3 reviews (so one 5★ review doesn't top the list).
create or replace function private.kitchen_rating(p_kitchen uuid)
returns table (avg_rating numeric, reviews integer, score numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select round(avg(r.rating)::numeric, 2), count(r.*)::integer,
         round(((coalesce(sum(r.rating), 0) + 4.0 * 3) / (count(r.*) + 3))::numeric, 3)
  from public.kitchen_reviews r
  where r.kitchen_id = p_kitchen and r.verified and not r.hidden;
$$;

-- Free places for a slot: capacity minus the busiest day's counted meals over 7 days from p_from.
create or replace function private.spare_capacity(p_kitchen uuid, p_slot public.meal_slot, p_from date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (case when p_slot = 'lunch' then k.capacity_lunch else k.capacity_dinner end)
         - coalesce((select max(n) from (
             select sum(o.qty) as n from public.meal_orders o
             where o.kitchen_id = p_kitchen and o.slot = p_slot
               and o.service_date between p_from and p_from + 6
               and (o.status <> 'skipped' or o.charged)
             group by o.service_date) d), 0)
         -- Trials waiting for payment hold a place too.
         - (select count(*) from public.subscriptions s join public.plans p on p.id = s.plan_id
            where s.kitchen_id = p_kitchen and s.status = 'trial' and p_slot = any (p.slots))::integer
  from public.kitchens k where k.id = p_kitchen;
$$;

create or replace function private.lead_is_qualified(p public.leads)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p.lat is not null and p.lng is not null and p.slots is not null and cardinality(p.slots) > 0;
$$;

-- Kitchens a lead can be offered: active (FSSAI), taking platform leads, the lead within the
-- kitchen's service radius, a plan covering the meal times and diet, spare capacity for every
-- requested slot. Ranked by verified rating (60%) and price fit (40%), then distance.
create or replace function private.match_kitchens(p_lead uuid, p_limit integer default 3)
returns table (kitchen_id uuid, kitchen_name text, slug text, distance_km numeric, plan_id uuid, plan_name text,
               price_per_meal_paise integer, rating numeric, reviews integer, spare integer, score numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_l public.leads;
  v_from date;
begin
  select * into v_l from public.leads where id = p_lead;
  if v_l.id is null or not private.lead_is_qualified(v_l) then
    return;
  end if;
  v_from := greatest(coalesce(v_l.start_date, private.ist_today() + 1), private.ist_today() + 1);
  return query
  with cand as (
    select k.id, k.name, k.slug,
           round((extensions.st_distance(k.geo_point, v_l.geo_point) / 1000)::numeric, 2) as km,
           (select least(min(private.spare_capacity(k.id, sl, v_from)), 9999)
            from unnest(v_l.slots) sl) as free
    from public.kitchens k
    where k.status = 'active' and k.accepts_platform_leads and k.geo_point is not null
      and extensions.st_dwithin(k.geo_point, v_l.geo_point, k.service_radius_km * 1000)
  ), planned as (
    select c.*, p.id as pid, p.name as pname, p.price_per_meal_paise as price,
           row_number() over (partition by c.id order by
             p.slots = v_l.slots desc,   -- a lunch-only lead gets a lunch plan, not a lunch + dinner one
             case when v_l.budget_per_meal_paise is null then p.price_per_meal_paise
                  else abs(p.price_per_meal_paise - v_l.budget_per_meal_paise) end, p.price_per_meal_paise) as rn
    from cand c
    join public.plans p on p.kitchen_id = c.id and p.active
      and p.slots @> v_l.slots
      and (v_l.diet is null or p.diet = v_l.diet)
    where c.free >= 1
  ), scored as (
    select p.*, r.avg_rating, r.reviews as nrev, r.score as rscore,
           (0.6 * (r.score / 5.0)
            + 0.4 * case when v_l.budget_per_meal_paise is null then 1
                         else greatest(0, 1 - abs(p.price - v_l.budget_per_meal_paise)::numeric / v_l.budget_per_meal_paise) end
           )::numeric(6, 4) as total
    from planned p, lateral private.kitchen_rating(p.id) r
    where p.rn = 1
  )
  select s.id, s.name, s.slug, s.km, s.pid, s.pname, s.price, s.avg_rating, s.nrev, s.free, s.total
  from scored s
  order by s.total desc, s.km, s.name
  limit greatest(1, coalesce(p_limit, 3));
end;
$$;

-- Store the shortlist and move the lead to matched (or waitlist when nothing fits).
create or replace function private.refresh_lead_matches(p_lead uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.leads;
  v_n integer;
begin
  select * into v_l from public.leads where id = p_lead for update;
  if v_l.status in ('trial', 'converted', 'renewed', 'lost') or v_l.chosen_kitchen_id is not null then
    -- Already decided: show the kitchen they picked (if any), not a new shortlist.
    return coalesce((select jsonb_agg(x) from jsonb_array_elements(private.lead_shortlist(p_lead)) x
                     where x ->> 'kitchen_id' = v_l.chosen_kitchen_id::text), '[]'::jsonb);
  end if;
  if not private.lead_is_qualified(v_l) then
    return '[]'::jsonb;
  end if;
  delete from public.lead_matches where lead_id = p_lead;
  insert into public.lead_matches (lead_id, kitchen_id, rank, distance_km, plan_id, price_per_meal_paise, rating, reviews, spare, score)
  select p_lead, m.kitchen_id, row_number() over (order by m.score desc, m.distance_km), m.distance_km, m.plan_id,
         m.price_per_meal_paise, m.rating, m.reviews, m.spare, m.score
  from private.match_kitchens(p_lead, 3) m;
  get diagnostics v_n = row_count;
  update public.leads
  set status = case when v_n > 0 then 'matched'::public.lead_status else 'waitlist'::public.lead_status end,
      matched_at = case when v_n > 0 then private.now() else matched_at end
  where id = p_lead;
  perform private.lead_event(p_lead, case when v_n > 0 then 'matched' else 'waitlist' end, jsonb_build_object('kitchens', v_n));
  return private.lead_shortlist(p_lead);
end;
$$;

-- What the lead is shown: kitchen cards with profile links.
create or replace function private.lead_shortlist(p_lead uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'kitchen_id', k.id, 'name', k.name, 'slug', k.slug, 'area', k.area, 'distance_km', m.distance_km,
    'plan_id', p.id, 'plan_name', p.name, 'price_per_meal_paise', m.price_per_meal_paise, 'rating', m.rating,
    'reviews', m.reviews, 'trial_meals', k.trial_meals, 'fssai_no', k.fssai_no,
    'profile_url', private.public_web_url() || '/k/' || k.slug
  ) order by m.rank), '[]'::jsonb)
  from public.lead_matches m
  join public.kitchens k on k.id = m.kitchen_id
  join public.plans p on p.id = m.plan_id
  where m.lead_id = p_lead;
$$;

-- Create or update the open lead for a phone (one open lead per phone; a new enquiry merges in).
-- p_fields: name, area, address_text, lat, lng, slots, diet, budget_per_meal_paise, start_date, language, notes.
create or replace function private.upsert_lead(
  p_phone text, p_source public.lead_source, p_campaign text, p_external_id text, p_fields jsonb,
  p_consent boolean, p_whatsapp_opt_in boolean, p_log boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
  v_id uuid;
  v_area public.areas;
  v_f jsonb := coalesce(p_fields, '{}');
  v_new boolean := false;
  v_before public.lead_status;
begin
  if p_phone is not null and v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if p_external_id is not null then
    select id into v_id from public.leads where source = p_source and external_id = p_external_id;
  end if;
  if v_id is null and v_phone is not null then
    select id into v_id from public.leads
    where phone_hash = private.phone_hash(v_phone) and status not in ('converted', 'renewed', 'lost')
    order by created_at desc limit 1;
  end if;
  if v_id is null then
    begin
      insert into public.leads (phone_enc, phone_hash, phone_last4, source, campaign, external_id, created_at)
      values (case when v_phone is not null then private.encrypt_phone(v_phone) end,
              case when v_phone is not null then private.phone_hash(v_phone) end, right(v_phone, 4),
              p_source, nullif(trim(p_campaign), ''), p_external_id, private.now())
      returning id into v_id;
      v_new := true;
    exception when unique_violation then
      -- A simultaneous enquiry from the same phone created it first: merge into that one.
      select id into v_id from public.leads
      where (p_external_id is not null and source = p_source and external_id = p_external_id)
         or (phone_hash = private.phone_hash(v_phone) and status not in ('converted', 'renewed', 'lost'))
      limit 1;
    end;
  end if;

  if v_f ? 'area' and not (v_f ? 'lat') then
    v_area := private.find_area(v_f ->> 'area');
  end if;
  select status into v_before from public.leads where id = v_id;

  update public.leads l set
    name = coalesce(nullif(trim(v_f ->> 'name'), ''), l.name),
    campaign = coalesce(l.campaign, nullif(trim(p_campaign), '')),
    language = coalesce((v_f ->> 'language')::public.language_code, l.language),
    area = coalesce(v_area.name, nullif(trim(v_f ->> 'area'), ''), l.area),
    area_id = coalesce(v_area.id, l.area_id),
    address_text = coalesce(nullif(trim(v_f ->> 'address_text'), ''), l.address_text),
    -- A shared location beats an area centre; a typed area only fills in when nothing better exists.
    lat = coalesce((v_f ->> 'lat')::double precision, case when l.lat is null then v_area.lat end, l.lat),
    lng = coalesce((v_f ->> 'lng')::double precision, case when l.lng is null then v_area.lng end, l.lng),
    slots = coalesce((select array_agg(x::public.meal_slot) from jsonb_array_elements_text(v_f -> 'slots') x), l.slots),
    diet = coalesce((v_f ->> 'diet')::public.diet_type, l.diet),
    budget_per_meal_paise = coalesce((v_f ->> 'budget_per_meal_paise')::integer, l.budget_per_meal_paise),
    start_date = coalesce((v_f ->> 'start_date')::date, l.start_date),
    notes = coalesce(nullif(trim(v_f ->> 'notes'), ''), l.notes),
    consent_at = case when coalesce(p_consent, false) then coalesce(l.consent_at, private.now()) else l.consent_at end,
    whatsapp_opt_in = l.whatsapp_opt_in or coalesce(p_whatsapp_opt_in, false)
  where l.id = v_id;

  update public.leads l
  set status = case when private.lead_is_qualified(l) and l.status in ('new', 'qualifying') then 'qualified'::public.lead_status
                    when l.status = 'new' and (l.slots is not null or l.lat is not null) then 'qualifying'::public.lead_status
                    else l.status end,
      qualified_at = case when private.lead_is_qualified(l) and l.qualified_at is null then private.now() else l.qualified_at end
  where l.id = v_id;

  -- Funnel log: new leads and new enquiries (a bot answer is not an event), and qualification.
  if v_new or p_log then
    perform private.lead_event(v_id, case when v_new then 'created' else 'enquiry' end,
                               jsonb_build_object('source', p_source, 'campaign', p_campaign));
  end if;
  if v_before is distinct from 'qualified' and (select status from public.leads where id = v_id) = 'qualified' then
    perform private.lead_event(v_id, 'qualified', '{}');
  end if;
  return v_id;
end;
$$;

-- The customer picked a kitchen: they become that kitchen's customer (platform_sourced, permanent)
-- with a trial subscription. Meals start once the trial is paid (D-033). Returns what the
-- customer needs to pay and a link to their customer page.
create or replace function private.convert_lead(p_lead uuid, p_kitchen uuid, p_plan uuid, p_channel text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.leads;
  v_k public.kitchens;
  v_p public.plans;
  v_phone text;
  v_customer uuid;
  v_address uuid;
  v_token text;
begin
  select * into v_l from public.leads where id = p_lead for update;
  if v_l.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_l.customer_id is not null then
    raise exception 'already_converted' using errcode = '22023';
  end if;
  select * into v_k from public.kitchens where id = p_kitchen;
  if v_k.id is null or v_k.status <> 'active' then
    raise exception 'kitchen_not_available' using errcode = '22023';
  end if;
  select * into v_p from public.plans where id = coalesce(p_plan, (select plan_id from public.lead_matches where lead_id = p_lead and kitchen_id = p_kitchen))
    and kitchen_id = p_kitchen and active;
  if v_p.id is null then
    raise exception 'no_plan' using errcode = '22023';
  end if;
  if v_l.phone_enc is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  v_phone := private.decrypt_phone(v_l.phone_enc);
  -- Already this kitchen's customer: the platform did not bring them.
  if exists (select 1 from public.customers where kitchen_id = p_kitchen and phone_hash = v_l.phone_hash and deleted_at is null) then
    raise exception 'already_customer' using errcode = '23505';
  end if;

  insert into public.customers (kitchen_id, name, phone_enc, phone_hash, phone_last4, source, platform_sourced,
    whatsapp_opt_in, preferred_language, diet, notes, consent_at, consent_basis)
  values (p_kitchen, coalesce(nullif(trim(v_l.name), ''), 'Customer ' || v_l.phone_last4), v_l.phone_enc, v_l.phone_hash,
    v_l.phone_last4, 'platform', true, v_l.whatsapp_opt_in, v_l.language, coalesce(v_l.diet, v_p.diet),
    'Via Tiffin platform' || coalesce(' (' || v_l.source || coalesce('/' || v_l.campaign, '') || ')', ''),
    coalesce(v_l.consent_at, private.now()), 'customer')
  returning id into v_customer;
  insert into public.consents (kitchen_id, customer_id, purpose, basis, channel)
  values (p_kitchen, v_customer, 'service_contact', 'customer', p_channel);
  if v_l.whatsapp_opt_in then
    insert into public.consents (kitchen_id, customer_id, purpose, basis, channel)
    values (p_kitchen, v_customer, 'whatsapp', 'customer', p_channel);
  end if;
  insert into public.addresses (kitchen_id, customer_id, line1, area, lat, lng, label)
  values (p_kitchen, v_customer, v_l.address_text, v_l.area, v_l.lat, v_l.lng, 'Home')
  returning id into v_address;
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
  values (p_kitchen, v_customer, v_p.id, v_address,
          greatest(coalesce(v_l.start_date, private.ist_today() + 1), private.ist_today() + 1), 'trial');

  update public.leads set chosen_kitchen_id = p_kitchen, customer_id = v_customer, status = 'matched',
                          matched_at = coalesce(matched_at, private.now())
  where id = p_lead;
  perform private.lead_event(p_lead, 'chose_kitchen', jsonb_build_object('kitchen_id', p_kitchen, 'plan_id', v_p.id, 'channel', p_channel));

  -- Tell the owners: a new customer from the platform.
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select p_kitchen, 'whatsapp', 'member', m.user_id, 'new_platform_customer',
         jsonb_build_object('customer_name', coalesce(v_l.name, 'A customer'), 'area', v_l.area, 'plan_name', v_p.name,
                            'trial_meals', v_k.trial_meals),
         'new_platform_customer:' || v_customer || ':' || m.user_id
  from public.members m where m.kitchen_id = p_kitchen and m.role = 'owner'
  on conflict (dedupe_key) do nothing;

  v_token := private.issue_magic_link(v_customer, 14);
  return jsonb_build_object('customer_id', v_customer, 'kitchen_name', v_k.name, 'plan_name', v_p.name,
    'trial_meals', v_k.trial_meals, 'price_per_meal_paise', v_p.price_per_meal_paise,
    'trial_amount_paise', v_k.trial_meals * v_p.price_per_meal_paise, 'portal_token', v_token,
    'portal_url', private.public_web_url() || '/c/' || v_token);
end;
$$;

-- Funnel: the first payment of a platform customer starts the trial (or converts directly when
-- it buys more than the trial), the next converts, and a payment 25+ days after conversion is
-- the month-2 renewal.
create or replace function private.lead_funnel_on_recharge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.leads;
  v_trial integer;
begin
  select l.* into v_l from public.leads l where l.customer_id = new.customer_id for update;
  if v_l.id is null then
    return null;
  end if;
  select trial_meals into v_trial from public.kitchens where id = new.kitchen_id;
  if v_l.status in ('new', 'qualifying', 'qualified', 'matched', 'waitlist') then
    if new.meals > v_trial then
      update public.leads set status = 'converted', trial_at = coalesce(trial_at, new.created_at), converted_at = new.created_at where id = v_l.id;
      perform private.lead_event(v_l.id, 'converted', jsonb_build_object('meals', new.meals, 'direct', true));
    else
      update public.leads set status = 'trial', trial_at = new.created_at where id = v_l.id;
      perform private.lead_event(v_l.id, 'trial_paid', jsonb_build_object('meals', new.meals));
    end if;
  elsif v_l.status = 'trial' then
    update public.leads set status = 'converted', converted_at = new.created_at where id = v_l.id;
    perform private.lead_event(v_l.id, 'converted', jsonb_build_object('meals', new.meals));
  elsif v_l.status = 'converted' and new.created_at >= v_l.converted_at + interval '25 days' then
    update public.leads set status = 'renewed', renewed_at = new.created_at where id = v_l.id;
    perform private.lead_event(v_l.id, 'renewed', jsonb_build_object('meals', new.meals));
  end if;
  return null;
end;
$$;

create trigger balance_entries_lead_funnel after insert on public.balance_entries
  for each row when (new.type = 'recharge') execute function private.lead_funnel_on_recharge();

-- Vendor applications follow the applicant's kitchen: created → onboarding, made active → live.
create or replace function private.vendor_app_follow_kitchen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  select private.phone_hash('+' || u.phone) into v_hash from auth.users u where u.id = new.owner_id;
  if v_hash is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    update public.vendor_applications set kitchen_id = new.id, status = 'onboarding'
    where phone_hash = v_hash and status in ('new', 'contacted');
  elsif new.status = 'active' and old.status is distinct from 'active' then
    update public.vendor_applications set status = 'live'
    where (kitchen_id = new.id or phone_hash = v_hash) and status in ('new', 'contacted', 'onboarding');
  end if;
  return null;
end;
$$;

create trigger kitchens_vendor_app after insert or update of status on public.kitchens
  for each row execute function private.vendor_app_follow_kitchen();

-- What a new kitchen still has to do before it can take platform customers.
create or replace function private.kitchen_checklist(p_kitchen uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_array(
    jsonb_build_object('key', 'profile', 'done', coalesce(length(k.description), 0) >= 20 and cardinality(k.photo_paths) > 0),
    jsonb_build_object('key', 'location', 'done', k.lat is not null),
    jsonb_build_object('key', 'fssai', 'done', k.fssai_no is not null),
    jsonb_build_object('key', 'plans', 'done', exists (select 1 from public.plans p where p.kitchen_id = k.id and p.active)),
    jsonb_build_object('key', 'menu', 'done', exists (select 1 from public.menus m where m.kitchen_id = k.id and m.published
                                                       and m.service_date >= private.ist_today())),
    jsonb_build_object('key', 'payout', 'done', exists (select 1 from public.kitchen_payout_accounts a where a.kitchen_id = k.id
                                                         and a.kyc_status = 'verified')),
    jsonb_build_object('key', 'customers', 'done', (select count(*) from public.customers c where c.kitchen_id = k.id
                                                      and c.deleted_at is null) >= 5),
    jsonb_build_object('key', 'rider', 'done', exists (select 1 from public.members m where m.kitchen_id = k.id and m.role = 'rider')),
    jsonb_build_object('key', 'live', 'done', k.status = 'active')
  )
  from public.kitchens k where k.id = p_kitchen;
$$;

-- Hourly growth automation: trial day-2 follow-up with the plan offer, a reminder to leads who
-- were shown kitchens but didn't pick, and onboarding nudges to vendor applicants (day 1, 3, 7).
create or replace function private.growth_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.now();
  v_follow integer := 0;
  v_remind integer := 0;
  v_nudge integer := 0;
  r record;
  v_token text;
  v_next text;
begin
  -- Day 2 of a paid trial: offer the plan (a month of the plan's days).
  for r in
    select l.id, l.customer_id, l.chosen_kitchen_id, p.name as plan_name, p.price_per_meal_paise,
           (p.days_per_week * 4 * cardinality(p.slots)) as month_meals
    from public.leads l
    join public.subscriptions s on s.customer_id = l.customer_id and s.status <> 'cancelled'
    join public.plans p on p.id = s.plan_id
    where l.status = 'trial' and l.followed_up_at is null and l.trial_at <= v_now - interval '20 hours'
  loop
    v_token := private.issue_magic_link(r.customer_id, 14);
    perform private.notify_customer(r.chosen_kitchen_id, r.customer_id, 'trial_followup',
      jsonb_build_object('plan_name', r.plan_name, 'price_per_meal_paise', r.price_per_meal_paise, 'meals', r.month_meals,
                         'amount_paise', r.month_meals * r.price_per_meal_paise, 'url', private.public_web_url() || '/c/' || v_token),
      'trial_followup:' || r.id);
    update public.leads set followed_up_at = v_now where id = r.id;
    perform private.lead_event(r.id, 'trial_followup', '{}');
    v_follow := v_follow + 1;
  end loop;

  -- Shown kitchens 24 h ago and didn't pick: one reminder.
  for r in
    select l.id from public.leads l
    where l.status = 'matched' and l.chosen_kitchen_id is null and l.reminded_at is null
      and l.matched_at <= v_now - interval '24 hours' and l.phone_enc is not null
  loop
    insert into public.notifications_outbox (channel, recipient_type, recipient_id, template, payload, dedupe_key)
    values ('whatsapp', 'lead', r.id, 'lead_reminder', jsonb_build_object('kitchens', private.lead_shortlist(r.id)),
            'lead_reminder:' || r.id)
    on conflict (dedupe_key) do nothing;
    update public.leads set reminded_at = v_now where id = r.id;
    perform private.lead_event(r.id, 'reminded', '{}');
    v_remind := v_remind + 1;
  end loop;

  -- Vendor applicants: nudge on day 1, 3 and 7 until their kitchen is live.
  for r in
    select a.*, k.id as kid from public.vendor_applications a left join public.kitchens k on k.id = a.kitchen_id
    where a.status in ('new', 'contacted', 'onboarding') and a.nudges < 3
      and a.created_at <= v_now - (case a.nudges when 0 then interval '1 day' when 1 then interval '3 days' else interval '7 days' end)
  loop
    if r.kid is null then
      v_next := 'signup';
    else
      select c ->> 'key' into v_next from jsonb_array_elements(private.kitchen_checklist(r.kid)) c
      where not (c ->> 'done')::boolean limit 1;
    end if;
    insert into public.notifications_outbox (channel, recipient_type, recipient_id, template, payload, dedupe_key)
    values ('whatsapp', 'vendor_application', r.id, 'vendor_nudge',
            jsonb_build_object('name', split_part(r.name, ' ', 1), 'next_step', coalesce(v_next, 'live'),
                               'url', private.public_web_url() || '/login'),
            'vendor_nudge:' || r.id || ':' || r.nudges)
    on conflict (dedupe_key) do nothing;
    update public.vendor_applications set nudges = nudges + 1, last_nudged_at = v_now where id = r.id;
    v_nudge := v_nudge + 1;
  end loop;

  return jsonb_build_object('followups', v_follow, 'reminders', v_remind, 'vendor_nudges', v_nudge);
end;
$$;

select cron.schedule('tiffin-growth', '7 * * * *', $$select private.growth_tick()$$);

-- ---------------------------------------------------------------------------
-- Outbox: leads and vendor applicants as recipients.
-- ---------------------------------------------------------------------------
create or replace function public.wa_claim_outbox(p_limit integer default 25)
returns table (
  id uuid, kitchen_id uuid, template text, payload jsonb, recipient_type text, recipient_id uuid,
  phone_e164 text, language public.language_code, kitchen_name text, conversation_id uuid,
  in_window boolean, opted_in boolean, attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select o.id from public.notifications_outbox o
    where o.channel = 'whatsapp' and o.status = 'pending' and o.send_after <= private.now()
    order by o.send_after
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update skip locked
  ),
  claimed as (
    update public.notifications_outbox o set status = 'sending', attempts = o.attempts + 1
    from due where o.id = due.id
    returning o.*
  )
  select c.id, c.kitchen_id, c.template, c.payload, c.recipient_type, c.recipient_id,
         case c.recipient_type
           when 'customer' then private.decrypt_phone(cu.phone_enc)
           when 'lead' then private.decrypt_phone(l.phone_enc)
           when 'vendor_application' then private.decrypt_phone(va.phone_enc)
           else '+' || u.phone end,
         coalesce(cu.preferred_language, l.language, 'en'::public.language_code),
         k.name, coalesce(conv.id, pconv.id),
         coalesce(conv.last_inbound_at > private.now() - interval '24 hours',
                  pconv.last_inbound_at > private.now() - interval '24 hours', false),
         case c.recipient_type
           when 'customer' then coalesce(cu.whatsapp_opt_in, false)
           when 'lead' then coalesce(l.whatsapp_opt_in, false)
           when 'vendor_application' then coalesce(va.whatsapp_opt_in, false)
           else true end,
         c.attempts
  from claimed c
  left join public.kitchens k on k.id = c.kitchen_id
  left join public.customers cu on c.recipient_type = 'customer' and cu.id = c.recipient_id
  left join public.leads l on c.recipient_type = 'lead' and l.id = c.recipient_id
  left join public.vendor_applications va on c.recipient_type = 'vendor_application' and va.id = c.recipient_id
  left join auth.users u on c.recipient_type = 'member' and u.id = c.recipient_id
  left join public.conversations conv on c.recipient_type = 'customer' and conv.customer_id = c.recipient_id and conv.kitchen_id = c.kitchen_id
  -- Leads and applicants chat with the platform number (conversation without a kitchen).
  left join public.conversations pconv on c.recipient_type in ('lead', 'vendor_application') and pconv.kitchen_id is null
    and pconv.wa_phone_hash = coalesce(l.phone_hash, va.phone_hash);
end;
$$;

-- ---------------------------------------------------------------------------
-- Public (anon) RPCs: website lead form, kitchen profile, vendor sign-up, reviews
-- ---------------------------------------------------------------------------

-- Website "find a tiffin" form. Returns a token (the browser keeps it to pick a kitchen) and the
-- shortlist. Consent to be contacted is required.
create or replace function public.submit_lead(
  p_name text, p_phone text, p_area text default null, p_slots public.meal_slot[] default '{lunch}',
  p_diet public.diet_type default 'veg', p_budget_paise integer default null, p_start date default null,
  p_lat double precision default null, p_lng double precision default null, p_address text default null,
  p_source public.lead_source default 'website', p_campaign text default null, p_consent boolean default false,
  p_whatsapp_opt_in boolean default false, p_language public.language_code default 'en'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_token text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  v_phone text := private.normalize_phone(p_phone);
  v_kitchens jsonb;
begin
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if p_source not in ('website', 'instagram', 'google_ads', 'referral', 'other') then
    raise exception 'invalid_source' using errcode = '22023';
  end if;
  -- Abuse guard: at most 5 website submissions per phone per day.
  if (select count(*) from public.lead_events e join public.leads l on l.id = e.lead_id
      where l.phone_hash = private.phone_hash(v_phone) and e.event in ('created', 'enquiry')
        and e.created_at > private.now() - interval '1 day') >= 5 then
    raise exception 'too_many_requests' using errcode = '22023';
  end if;
  v_id := private.upsert_lead(v_phone, p_source, p_campaign, null,
    jsonb_strip_nulls(jsonb_build_object('name', p_name, 'area', p_area, 'address_text', p_address, 'lat', p_lat, 'lng', p_lng,
      'slots', to_jsonb(p_slots), 'diet', p_diet, 'budget_per_meal_paise', p_budget_paise, 'start_date', p_start,
      'language', p_language)),
    true, p_whatsapp_opt_in);
  update public.leads set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex') where id = v_id;
  v_kitchens := private.refresh_lead_matches(v_id);
  return jsonb_build_object('token', v_token, 'status', (select status from public.leads where id = v_id),
    'area', (select area from public.leads where id = v_id), 'kitchens', v_kitchens);
end;
$$;

-- The website visitor picks one of their matched kitchens.
create or replace function public.lead_choose(p_token text, p_kitchen uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.leads where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if v_id is null then
    raise exception 'invalid_link' using errcode = '22023';
  end if;
  if not exists (select 1 from public.lead_matches where lead_id = v_id and kitchen_id = p_kitchen) then
    raise exception 'kitchen_not_available' using errcode = '22023';
  end if;
  return private.convert_lead(v_id, p_kitchen, null, 'web');
end;
$$;

-- Public kitchen page (active kitchens only): profile, plans, this week's menu, verified ratings.
create or replace function public.kitchen_profile(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', k.id, 'name', k.name, 'slug', k.slug, 'area', k.area, 'city', k.city, 'description', k.description,
    'cuisine_tags', k.cuisine_tags, 'photo_paths', k.photo_paths, 'fssai_no', k.fssai_no,
    'service_radius_km', k.service_radius_km, 'weekly_off', k.weekly_off, 'trial_meals', k.trial_meals,
    'lat', round(k.lat::numeric, 3), 'lng', round(k.lng::numeric, 3),
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
  where k.slug = lower(p_slug) and k.status = 'active';
$$;

-- Active kitchens for the public directory, optionally near an area.
create or replace function public.kitchen_directory(p_area text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
  ) s;
$$;

create or replace function public.list_areas()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from public.areas;
$$;

-- "Run a tiffin service? Join free" form.
create or replace function public.submit_vendor_application(
  p_name text, p_phone text, p_kitchen_name text default null, p_area text default null,
  p_subscribers integer default null, p_fssai text default null, p_source public.lead_source default 'website',
  p_campaign text default null, p_consent boolean default false, p_whatsapp_opt_in boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
  v_area public.areas := private.find_area(p_area);
  v_id uuid;
begin
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if nullif(trim(p_fssai), '') is not null and trim(p_fssai) !~ '^[0-9]{14}$' then
    raise exception 'invalid_fssai' using errcode = '22023';
  end if;
  select id into v_id from public.vendor_applications
  where phone_hash = private.phone_hash(v_phone) and status in ('new', 'contacted', 'onboarding');
  if v_id is not null then
    update public.vendor_applications
    set kitchen_name = coalesce(nullif(trim(p_kitchen_name), ''), kitchen_name), area = coalesce(v_area.name, nullif(trim(p_area), ''), area),
        subscribers_estimate = coalesce(p_subscribers, subscribers_estimate), fssai_no = coalesce(nullif(trim(p_fssai), ''), fssai_no),
        whatsapp_opt_in = whatsapp_opt_in or coalesce(p_whatsapp_opt_in, false)
    where id = v_id;
    return v_id;
  end if;
  insert into public.vendor_applications (name, phone_enc, phone_hash, phone_last4, kitchen_name, area, lat, lng,
    subscribers_estimate, fssai_no, source, campaign, consent_at, whatsapp_opt_in, created_at)
  values (trim(p_name), private.encrypt_phone(v_phone), private.phone_hash(v_phone), right(v_phone, 4),
    nullif(trim(p_kitchen_name), ''), coalesce(v_area.name, nullif(trim(p_area), '')), v_area.lat, v_area.lng,
    p_subscribers, nullif(trim(p_fssai), ''), p_source, nullif(trim(p_campaign), ''), private.now(),
    coalesce(p_whatsapp_opt_in, false), private.now())
  returning id into v_id;
  -- Already signed up in the app with this number? Link straight away.
  update public.vendor_applications va set kitchen_id = k.id,
         status = case when k.status = 'active' then 'live'::public.vendor_app_status else 'onboarding'::public.vendor_app_status end
  from public.kitchens k join auth.users u on u.id = k.owner_id
  where va.id = v_id and private.phone_hash('+' || u.phone) = va.phone_hash;
  insert into public.notifications_outbox (channel, recipient_type, recipient_id, template, payload, dedupe_key)
  values ('whatsapp', 'vendor_application', v_id, 'vendor_welcome',
          jsonb_build_object('name', split_part(trim(p_name), ' ', 1), 'url', private.public_web_url() || '/login'),
          'vendor_welcome:' || v_id)
  on conflict (dedupe_key) do nothing;
  return v_id;
end;
$$;

-- A customer rates their kitchen from the customer page. Verified when they have received meals.
create or replace function public.portal_review(p_token text, p_rating integer, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
  v_verified boolean;
begin
  if p_rating is null or p_rating not between 1 and 5 then
    raise exception 'invalid_rating' using errcode = '22023';
  end if;
  v_verified := exists (select 1 from public.meal_orders o where o.customer_id = v_cust.id
                        and o.status in ('delivered', 'locked', 'prepared', 'out') and o.service_date <= private.ist_today());
  insert into public.kitchen_reviews (kitchen_id, customer_id, rating, comment, verified, created_at)
  values (v_cust.kitchen_id, v_cust.id, p_rating, nullif(trim(left(p_comment, 500)), ''), v_verified, private.now())
  on conflict (kitchen_id, customer_id) do update
    set rating = excluded.rating, comment = excluded.comment, verified = excluded.verified;
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role RPCs for the WhatsApp lead bot and the lead-intake Edge Function
-- ---------------------------------------------------------------------------

-- The bot's view of a lead (by conversation phone): steps and collected answers.
create or replace function public.wa_lead_get(p_phone text, p_campaign text default null, p_source public.lead_source default 'whatsapp',
                                              p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := private.upsert_lead(p_phone, p_source, p_campaign, null, jsonb_strip_nulls(jsonb_build_object('name', p_name)), true, true, false);
  return (select to_jsonb(l) - 'phone_enc' - 'phone_hash' - 'token_hash' || jsonb_build_object('kitchens', private.lead_shortlist(l.id))
          from public.leads l where l.id = v_id);
end;
$$;

-- Save answers (same keys as upsert_lead's p_fields) and the next step; matches when qualified.
create or replace function public.wa_lead_update(p_lead uuid, p_fields jsonb, p_step text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
  v_l public.leads;
begin
  select * into v_l from public.leads where id = p_lead;
  if v_l.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_phone := private.decrypt_phone(v_l.phone_enc);
  perform private.upsert_lead(v_phone, v_l.source, null, null, p_fields, true, true, false);
  update public.leads set bot_step = p_step where id = p_lead;
  if p_step = 'matched' then
    perform private.refresh_lead_matches(p_lead);
  end if;
  return (select to_jsonb(l) - 'phone_enc' - 'phone_hash' - 'token_hash' || jsonb_build_object('kitchens', private.lead_shortlist(l.id))
          from public.leads l where l.id = p_lead);
end;
$$;

create or replace function public.wa_lead_choose(p_lead uuid, p_kitchen uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.lead_matches where lead_id = p_lead and kitchen_id = p_kitchen) then
    raise exception 'kitchen_not_available' using errcode = '22023';
  end if;
  return private.convert_lead(p_lead, p_kitchen, null, 'whatsapp');
end;
$$;

-- Bot state of a conversation with the platform number (no kitchen yet).
create or replace function public.wa_platform_conversation(p_conversation uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('state', c.state, 'language', c.language, 'contact_name', c.contact_name)
  from public.conversations c where c.id = p_conversation and c.kitchen_id is null;
$$;

-- Vendor sign-up through WhatsApp ("Hi VENDOR").
create or replace function public.wa_vendor_apply(p_phone text, p_name text, p_kitchen_name text, p_area text,
                                                  p_subscribers integer, p_campaign text default null)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public.submit_vendor_application(coalesce(nullif(trim(p_name), ''), 'Kitchen owner'), p_phone, p_kitchen_name, p_area,
                                          p_subscribers, null, 'whatsapp', p_campaign, true, true);
$$;

-- Leads from ad forms and directories (Google Ads lead forms, Justdial, Instagram/Meta forms),
-- idempotent on (source, external_id). Sends a WhatsApp welcome when the person opted in.
create or replace function public.lead_ingest(p_source public.lead_source, p_external_id text, p_name text, p_phone text,
                                              p_area text default null, p_campaign text default null,
                                              p_whatsapp_opt_in boolean default false, p_extra jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_id uuid;
begin
  select id into v_existing from public.leads where source = p_source and external_id = p_external_id;
  if v_existing is not null then
    return jsonb_build_object('lead_id', v_existing, 'duplicate', true);
  end if;
  v_id := private.upsert_lead(p_phone, p_source, p_campaign, p_external_id,
    jsonb_strip_nulls(jsonb_build_object('name', p_name, 'area', p_area, 'notes', nullif(p_extra ->> 'notes', ''))) ||
      coalesce(p_extra - 'notes', '{}'),
    true, p_whatsapp_opt_in);
  perform private.refresh_lead_matches(v_id);
  if p_whatsapp_opt_in then
    insert into public.notifications_outbox (channel, recipient_type, recipient_id, template, payload, dedupe_key)
    values ('whatsapp', 'lead', v_id, 'lead_welcome',
            jsonb_build_object('name', split_part(coalesce(nullif(trim(p_name), ''), 'there'), ' ', 1), 'source', p_source),
            'lead_welcome:' || v_id)
    on conflict (dedupe_key) do nothing;
  end if;
  return jsonb_build_object('lead_id', v_id, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner RPCs
-- ---------------------------------------------------------------------------
create or replace function public.kitchen_checklist(p_kitchen uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  return private.kitchen_checklist(p_kitchen);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs (platform team). Phone numbers are masked; reveals are logged.
-- ---------------------------------------------------------------------------
create or replace function private.require_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.admin_leads(p_status public.lead_status default null, p_source public.lead_source default null,
                                              p_search text default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'phone', 'XXXXXX' || coalesce(l.phone_last4, '????'), 'source', l.source, 'campaign', l.campaign,
      'status', l.status, 'area', l.area, 'slots', l.slots, 'diet', l.diet, 'budget_per_meal_paise', l.budget_per_meal_paise,
      'start_date', l.start_date, 'whatsapp_opt_in', l.whatsapp_opt_in, 'chosen_kitchen', k.name,
      'matches', (select count(*) from public.lead_matches m where m.lead_id = l.id),
      'created_at', l.created_at, 'updated_at', l.updated_at, 'notes', l.notes, 'lost_reason', l.lost_reason
    ) order by l.created_at desc)
    from (select * from public.leads l0
          where (p_status is null or l0.status = p_status) and (p_source is null or l0.source = p_source)
            and (p_search is null or l0.name ilike '%' || p_search || '%' or l0.area ilike '%' || p_search || '%'
                 or l0.phone_last4 = right(p_search, 4) or l0.campaign ilike '%' || p_search || '%')
          order by l0.created_at desc limit least(coalesce(p_limit, 100), 500)) l
    left join public.kitchens k on k.id = l.chosen_kitchen_id), '[]'::jsonb);
end;
$$;

create or replace function public.admin_lead_detail(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return (select to_jsonb(l) - 'phone_enc' - 'phone_hash' - 'token_hash' || jsonb_build_object(
      'phone', 'XXXXXX' || coalesce(l.phone_last4, '????'),
      'kitchens', private.lead_shortlist(l.id),
      'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'detail', e.detail, 'at', e.created_at) order by e.created_at)
                          from public.lead_events e where e.lead_id = l.id), '[]'::jsonb),
      'nearby', coalesce((select jsonb_agg(jsonb_build_object('kitchen_id', k.id, 'name', k.name, 'status', k.status,
                                   'distance_km', round(private.km_between(k.lat, k.lng, l.lat, l.lng)::numeric, 1),
                                   'radius_km', k.service_radius_km) order by private.km_between(k.lat, k.lng, l.lat, l.lng))
                          from public.kitchens k
                          where l.lat is not null and k.lat is not null and private.km_between(k.lat, k.lng, l.lat, l.lng) <= 8), '[]'::jsonb))
    from public.leads l where l.id = p_lead);
end;
$$;

create or replace function public.admin_reveal_lead_phone(p_lead uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enc bytea;
begin
  perform private.require_admin();
  select phone_enc into v_enc from public.leads where id = p_lead;
  if v_enc is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.audit_access(null, 'leads', p_lead::text, jsonb_build_object('reason', 'admin_reveal'));
  perform private.lead_event(p_lead, 'phone_revealed', '{}');
  return private.decrypt_phone(v_enc);
end;
$$;

-- Calls and walk-ins entered by the platform team.
create or replace function public.admin_create_lead(
  p_name text, p_phone text, p_source public.lead_source default 'call', p_campaign text default null,
  p_area text default null, p_slots public.meal_slot[] default '{lunch}', p_diet public.diet_type default 'veg',
  p_budget_paise integer default null, p_start date default null, p_whatsapp_opt_in boolean default false,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_admin();
  v_id := private.upsert_lead(p_phone, p_source, p_campaign, null,
    jsonb_strip_nulls(jsonb_build_object('name', p_name, 'area', p_area, 'slots', to_jsonb(p_slots), 'diet', p_diet,
      'budget_per_meal_paise', p_budget_paise, 'start_date', p_start, 'notes', p_notes)), true, p_whatsapp_opt_in);
  return jsonb_build_object('lead_id', v_id, 'kitchens', private.refresh_lead_matches(v_id));
end;
$$;

create or replace function public.admin_match_lead(p_lead uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return private.refresh_lead_matches(p_lead);
end;
$$;

-- Manual routing: the team places a lead with a kitchen (e.g. after a call). Any active kitchen.
create or replace function public.admin_assign_lead(p_lead uuid, p_kitchen uuid, p_plan uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan uuid := p_plan;
begin
  perform private.require_admin();
  if v_plan is null then
    select p.id into v_plan from public.plans p, public.leads l
    where l.id = p_lead and p.kitchen_id = p_kitchen and p.active and (l.slots is null or p.slots @> l.slots)
    order by (l.diet is null or p.diet = l.diet) desc, (p.slots = l.slots) desc, p.price_per_meal_paise limit 1;
  end if;
  return private.convert_lead(p_lead, p_kitchen, v_plan, 'vendor');
end;
$$;

create or replace function public.admin_set_lead_status(p_lead uuid, p_status public.lead_status, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_status not in ('new', 'qualifying', 'waitlist', 'lost') then
    raise exception 'invalid_status' using errcode = '22023';  -- funnel stages after matching come from real events
  end if;
  update public.leads set status = p_status, lost_reason = case when p_status = 'lost' then nullif(trim(p_reason), '') else lost_reason end
  where id = p_lead;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.lead_event(p_lead, 'status_' || p_status, jsonb_build_object('reason', p_reason));
end;
$$;

-- Funnel per source and campaign: lead → qualified → trial → plan → month-2 renewal.
create or replace function public.lead_funnel(p_from date default null, p_to date default null)
returns table (source public.lead_source, campaign text, leads integer, qualified integer, matched integer, chose integer,
               trial integer, converted integer, renewed integer, waitlist integer, lost integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_admin();
  return query
  select l.source, coalesce(l.campaign, '—'), count(*)::integer,
         count(*) filter (where l.qualified_at is not null)::integer,
         count(*) filter (where l.matched_at is not null)::integer,
         count(*) filter (where l.chosen_kitchen_id is not null)::integer,
         count(*) filter (where l.trial_at is not null)::integer,
         count(*) filter (where l.converted_at is not null)::integer,
         count(*) filter (where l.renewed_at is not null)::integer,
         count(*) filter (where l.status = 'waitlist')::integer,
         count(*) filter (where l.status = 'lost')::integer
  from public.leads l
  where (p_from is null or l.created_at >= (p_from::timestamp at time zone 'Asia/Kolkata'))
    and (p_to is null or l.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata'))
  group by l.source, coalesce(l.campaign, '—')
  order by 3 desc;
end;
$$;

-- Where demand has no kitchen: waitlisted leads by area, with the nearest active kitchen. This is
-- where vendor recruitment should focus.
create or replace function public.demand_gaps()
returns table (area text, waiting integer, lunch integer, dinner integer, nearest_kitchen text, nearest_km numeric,
               open_applications integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_admin();
  return query
  select coalesce(l.area, 'Unknown'), count(*)::integer,
         count(*) filter (where 'lunch' = any (l.slots))::integer, count(*) filter (where 'dinner' = any (l.slots))::integer,
         (select k.name from public.kitchens k where k.status = 'active' and k.lat is not null and min(l.lat) is not null
          order by private.km_between(k.lat, k.lng, avg(l.lat), avg(l.lng)) limit 1),
         (select round(private.km_between(k.lat, k.lng, avg(l.lat), avg(l.lng))::numeric, 1) from public.kitchens k
          where k.status = 'active' and k.lat is not null and min(l.lat) is not null
          order by private.km_between(k.lat, k.lng, avg(l.lat), avg(l.lng)) limit 1),
         (select count(*) from public.vendor_applications va where va.status in ('new', 'contacted', 'onboarding')
            and va.area is not distinct from l.area)::integer
  from public.leads l
  where l.status = 'waitlist'
  group by coalesce(l.area, 'Unknown'), l.area
  order by 2 desc;
end;
$$;

create or replace function public.admin_vendor_applications(p_status public.vendor_app_status default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', a.name, 'phone', 'XXXXXX' || a.phone_last4, 'kitchen_name', a.kitchen_name, 'area', a.area,
      'subscribers_estimate', a.subscribers_estimate, 'fssai_no', coalesce(k.fssai_no, a.fssai_no), 'source', a.source, 'campaign', a.campaign,
      'status', a.status, 'kitchen_id', a.kitchen_id, 'kitchen_slug', k.slug, 'notes', a.notes, 'nudges', a.nudges,
      'created_at', a.created_at,
      'demand_nearby', (select count(*) from public.leads l where l.status = 'waitlist' and l.lat is not null and a.lat is not null
                          and private.km_between(l.lat, l.lng, a.lat, a.lng) <= 3),
      'checklist', case when a.kitchen_id is not null then private.kitchen_checklist(a.kitchen_id) end
    ) order by (a.status = 'new') desc, a.created_at desc)
    from public.vendor_applications a left join public.kitchens k on k.id = a.kitchen_id
    where p_status is null or a.status = p_status), '[]'::jsonb);
end;
$$;

create or replace function public.admin_update_vendor_application(p_id uuid, p_status public.vendor_app_status default null,
                                                                  p_notes text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  update public.vendor_applications
  set status = coalesce(p_status, status), notes = coalesce(nullif(trim(p_notes), ''), notes)
  where id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.admin_reveal_vendor_phone(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enc bytea;
begin
  perform private.require_admin();
  select phone_enc into v_enc from public.vendor_applications where id = p_id;
  if v_enc is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.audit_access(null, 'vendor_applications', p_id::text, jsonb_build_object('reason', 'admin_reveal'));
  return private.decrypt_phone(v_enc);
end;
$$;

create or replace function public.admin_hide_review(p_review uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  update public.kitchen_reviews set hidden = coalesce(p_hidden, true) where id = p_review;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Reviews for moderation (latest first), optionally for one kitchen.
create or replace function public.admin_reviews(p_kitchen uuid default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'kitchen', k.name, 'kitchen_slug', k.slug, 'rating', r.rating,
                                        'comment', r.comment, 'customer', split_part(c.name, ' ', 1), 'verified', r.verified,
                                        'hidden', r.hidden, 'created_at', r.created_at) order by r.created_at desc)
    from (select * from public.kitchen_reviews r0 where p_kitchen is null or r0.kitchen_id = p_kitchen
          order by r0.created_at desc limit least(coalesce(p_limit, 100), 500)) r
    join public.kitchens k on k.id = r.kitchen_id join public.customers c on c.id = r.customer_id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage: public kitchen photos (kitchen-photos/<kitchen_id>/...), written by owners.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kitchen-photos', 'kitchen-photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy kitchen_photos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'kitchen-photos'
              and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}'))::text[]));
create policy kitchen_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'kitchen-photos'
         and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}'))::text[]));
create policy kitchen_photos_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'kitchen-photos'
         and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}'))::text[]));

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.areas enable row level security;
alter table public.leads enable row level security;
alter table public.lead_matches enable row level security;
alter table public.lead_events enable row level security;
alter table public.kitchen_reviews enable row level security;
alter table public.vendor_applications enable row level security;

create policy areas_select on public.areas for select to anon, authenticated using (true);
-- Leads and applications are the platform's: admins only (vendors see the customer once chosen).
create policy leads_select on public.leads for select to authenticated using ((select private.is_platform_admin()));
create policy lead_matches_select on public.lead_matches for select to authenticated using ((select private.is_platform_admin()));
create policy lead_events_select on public.lead_events for select to authenticated using ((select private.is_platform_admin()));
create policy vendor_applications_select on public.vendor_applications for select to authenticated
  using ((select private.is_platform_admin()));
create policy kitchen_reviews_select on public.kitchen_reviews for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

revoke all on public.areas, public.leads, public.lead_matches, public.lead_events, public.kitchen_reviews,
  public.vendor_applications from anon, authenticated;
grant select on public.areas to anon, authenticated;
grant select (id, name, source, campaign, status, area, slots, diet, budget_per_meal_paise, start_date, chosen_kitchen_id,
  customer_id, created_at, qualified_at, matched_at, trial_at, converted_at, renewed_at) on public.leads to authenticated;
grant select on public.lead_matches, public.lead_events to authenticated;
grant select (id, kitchen_id, customer_id, rating, comment, verified, hidden, created_at) on public.kitchen_reviews to authenticated;
grant select (id, name, kitchen_name, area, subscribers_estimate, source, campaign, status, kitchen_id, created_at)
  on public.vendor_applications to authenticated;

revoke execute on function public.submit_lead, public.lead_choose, public.kitchen_profile, public.kitchen_directory,
  public.list_areas, public.submit_vendor_application, public.portal_review, public.wa_lead_get, public.wa_lead_update,
  public.wa_lead_choose, public.wa_vendor_apply, public.lead_ingest, public.wa_platform_conversation, public.kitchen_checklist, public.admin_leads,
  public.admin_lead_detail, public.admin_reveal_lead_phone, public.admin_create_lead, public.admin_match_lead,
  public.admin_assign_lead, public.admin_set_lead_status, public.lead_funnel, public.demand_gaps,
  public.admin_vendor_applications, public.admin_update_vendor_application, public.admin_reveal_vendor_phone,
  public.admin_hide_review, public.admin_reviews
  from public, anon, authenticated;
-- Public website: no login.
grant execute on function public.submit_lead, public.lead_choose, public.kitchen_profile, public.kitchen_directory,
  public.list_areas, public.submit_vendor_application, public.portal_review to anon, authenticated;
-- WhatsApp webhook and lead-intake Edge Functions only.
grant execute on function public.wa_lead_get, public.wa_lead_update, public.wa_lead_choose, public.wa_vendor_apply,
  public.lead_ingest, public.wa_platform_conversation to service_role;
grant execute on function public.kitchen_checklist, public.admin_leads, public.admin_lead_detail,
  public.admin_reveal_lead_phone, public.admin_create_lead, public.admin_match_lead, public.admin_assign_lead,
  public.admin_set_lead_status, public.lead_funnel, public.demand_gaps, public.admin_vendor_applications,
  public.admin_update_vendor_application, public.admin_reveal_vendor_phone, public.admin_hide_review, public.admin_reviews
  to authenticated;
