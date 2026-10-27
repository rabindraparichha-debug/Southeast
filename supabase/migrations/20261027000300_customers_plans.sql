-- M1 / 1.3 Customers, addresses, consents, plans, subscriptions.
--
-- Privacy model:
--   * Phone numbers are never readable from tables by API roles. Owners see the
--     full number through customers_v.phone; staff see a masked number; riders
--     see nothing in M1 (their stop list arrives in M5).
--   * Customers are written only through RPCs (phone must be encrypted server-side).
--   * Every child row carries kitchen_id and a composite FK to its parent, so a
--     row can never point at another kitchen's data.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  name text not null check (length(trim(name)) between 1 and 100),
  phone_enc bytea,
  phone_hash text,
  phone_last4 text check (phone_last4 ~ '^[0-9]{4}$'),
  source public.customer_source not null default 'vendor',
  -- Permanent once true; only the platform can set it (see guard trigger).
  platform_sourced boolean not null default false,
  payer_customer_id uuid,
  whatsapp_opt_in boolean not null default false,
  preferred_language public.language_code not null default 'en',
  diet public.diet_type not null default 'veg',
  notes text,
  consent_at timestamptz,
  consent_basis text check (consent_basis in ('customer', 'vendor_attested')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, kitchen_id),
  foreign key (payer_customer_id, kitchen_id) references public.customers (id, kitchen_id),
  constraint customers_phone_required check (
    deleted_at is not null
    or (phone_enc is not null and phone_hash is not null and phone_last4 is not null)
  )
);
create unique index customers_kitchen_phone_idx on public.customers (kitchen_id, phone_hash)
  where deleted_at is null;
create index customers_kitchen_idx on public.customers (kitchen_id) where deleted_at is null;
create index customers_last4_idx on public.customers (kitchen_id, phone_last4);
create index customers_name_trgm_idx on public.customers using gin (name extensions.gin_trgm_ops);

create table public.addresses (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  customer_id uuid not null,
  label text,
  line1 text,
  area text,
  landmark text,
  delivery_notes text,
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  geo_point extensions.geography(Point, 4326) generated always as (
    case when lat is not null and lng is not null
      then extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
    end
  ) stored,
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id) on delete cascade
);
create unique index addresses_one_default_idx on public.addresses (customer_id) where is_default;
create index addresses_kitchen_idx on public.addresses (kitchen_id);
create index addresses_geo_idx on public.addresses using gist (geo_point);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  customer_id uuid not null,
  purpose text not null check (purpose in ('service_contact', 'whatsapp', 'marketing')),
  basis text not null check (basis in ('customer', 'vendor_attested')),
  channel text not null check (channel in ('vendor', 'import', 'whatsapp', 'web')),
  notice_version text not null default 'v1',
  recorded_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id) on delete cascade
);
create index consents_customer_idx on public.consents (customer_id);

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 60),
  slots public.meal_slot[] not null check (cardinality(slots) between 1 and 2),
  diet public.diet_type not null default 'veg',
  -- ISO days the plan serves (1 = Mon … 7 = Sun). days_per_week is derived.
  days_of_week smallint[] not null default '{1,2,3,4,5,6}'
    check (cardinality(days_of_week) between 1 and 7
           and days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  days_per_week smallint generated always as (cardinality(days_of_week)) stored,
  price_per_meal_paise integer not null check (price_per_meal_paise > 0 and price_per_meal_paise <= 100000),
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id),
  unique (kitchen_id, name)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  customer_id uuid not null,
  plan_id uuid not null,
  address_id uuid,
  qty smallint not null default 1 check (qty between 1 and 20),
  start_date date not null,
  end_date date,
  -- Transitions are owned by the daily engine (M2); M1 only creates trial/active rows.
  status public.subscription_status not null default 'trial',
  autopay_mandate_id text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (plan_id, kitchen_id) references public.plans (id, kitchen_id),
  foreign key (address_id, kitchen_id) references public.addresses (id, kitchen_id)
);
create index subscriptions_kitchen_status_idx on public.subscriptions (kitchen_id, status);
create index subscriptions_customer_idx on public.subscriptions (customer_id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function private.guard_platform_sourced()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_privileged boolean := auth.uid() is null            -- migrations, seed, cron, service code
                          or auth.role() = 'service_role'
                          or private.is_platform_admin();
begin
  if tg_op = 'INSERT' then
    if new.platform_sourced and not v_privileged then
      raise exception 'platform_sourced_protected' using errcode = '42501';
    end if;
  elsif new.platform_sourced is distinct from old.platform_sourced then
    if old.platform_sourced then
      raise exception 'platform_sourced_is_permanent' using errcode = '42501';
    end if;
    if not v_privileged then
      raise exception 'platform_sourced_protected' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger customers_platform_sourced_guard before insert or update on public.customers
  for each row execute function private.guard_platform_sourced();

-- Setting a new default address clears the previous default.
create or replace function private.single_default_address()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_default then
    update public.addresses set is_default = false
    where customer_id = new.customer_id and id <> new.id and is_default;
  end if;
  return new;
end;
$$;

create trigger addresses_single_default before insert or update of is_default on public.addresses
  for each row when (new.is_default) execute function private.single_default_address();

-- M1 only creates trial or active subscriptions; other states come from the engine.
create or replace function private.subscription_insert_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status not in ('trial', 'active') and auth.uid() is not null then
    raise exception 'invalid_initial_status' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger subscriptions_insert_status before insert on public.subscriptions
  for each row execute function private.subscription_insert_status();

create trigger customers_updated_at before update on public.customers
  for each row execute function private.set_updated_at();
create trigger addresses_updated_at before update on public.addresses
  for each row execute function private.set_updated_at();
create trigger plans_updated_at before update on public.plans
  for each row execute function private.set_updated_at();
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function private.set_updated_at();

create trigger customers_audit after insert or update or delete on public.customers
  for each row execute function private.audit_row();
create trigger addresses_audit after insert or update or delete on public.addresses
  for each row execute function private.audit_row();
create trigger consents_audit after insert or update or delete on public.consents
  for each row execute function private.audit_row();
create trigger plans_audit after insert or update or delete on public.plans
  for each row execute function private.audit_row();
create trigger subscriptions_audit after insert or update or delete on public.subscriptions
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.customers enable row level security;
alter table public.addresses enable row level security;
alter table public.consents enable row level security;
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;

-- Customers: owners and staff read (column grants hide phone ciphertext); writes via RPC only.
create policy customers_select on public.customers for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[])
         or (select private.is_platform_admin()));

create policy addresses_select on public.addresses for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[])
         or (select private.is_platform_admin()));
create policy addresses_insert on public.addresses for insert to authenticated
  with check (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]));
create policy addresses_update on public.addresses for update to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]))
  with check (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]));
create policy addresses_delete on public.addresses for delete to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]));

create policy consents_select on public.consents for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

-- Plans and subscriptions carry prices/money context: owner only (staff have no money access).
create policy plans_select on public.plans for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy plans_insert on public.plans for insert to authenticated
  with check (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]));
create policy plans_update on public.plans for update to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]))
  with check (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]));

create policy subscriptions_select on public.subscriptions for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy subscriptions_insert on public.subscriptions for insert to authenticated
  with check (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]));
create policy subscriptions_update on public.subscriptions for update to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]))
  with check (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]));

-- ---------------------------------------------------------------------------
-- Phone display + customer view
-- ---------------------------------------------------------------------------

-- Full number for the kitchen's owner, masked for everyone else who can see the row.
create or replace function public.customer_phone(p_customer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when private.has_role(c.kitchen_id, '{owner}') then private.decrypt_phone(c.phone_enc)
           else private.mask_phone(c.phone_last4)
         end
  from public.customers c
  where c.id = p_customer
    and (private.has_role(c.kitchen_id, '{owner,staff}') or private.is_platform_admin());
$$;

-- What the apps read. security_invoker: the caller's RLS and column grants apply.
create view public.customers_v
with (security_invoker = on) as
select
  c.id,
  c.kitchen_id,
  c.name,
  public.customer_phone(c.id) as phone,
  c.phone_last4,
  c.diet,
  c.preferred_language,
  c.whatsapp_opt_in,
  c.source,
  c.platform_sourced,
  c.notes,
  c.consent_at,
  c.created_at,
  c.updated_at,
  a.id as address_id,
  a.line1,
  a.area,
  a.landmark,
  a.delivery_notes,
  a.lat,
  a.lng
from public.customers c
left join public.addresses a on a.customer_id = c.id and a.is_default
where c.deleted_at is null;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Internal insert shared by create_customer and import_customers. Caller has
-- already checked the role. Returns the new customer id.
create or replace function private.insert_customer(
  p_kitchen uuid,
  p_name text,
  p_phone_e164 text,
  p_diet public.diet_type,
  p_language public.language_code,
  p_notes text,
  p_address jsonb,
  p_source public.customer_source,
  p_channel text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.customers (kitchen_id, name, phone_enc, phone_hash, phone_last4, source,
    preferred_language, diet, notes, consent_at, consent_basis, created_by)
  values (p_kitchen, trim(p_name), private.encrypt_phone(p_phone_e164), private.phone_hash(p_phone_e164),
    right(p_phone_e164, 4), p_source, coalesce(p_language, 'en'), coalesce(p_diet, 'veg'),
    nullif(trim(p_notes), ''), now(), 'vendor_attested', auth.uid())
  returning id into v_id;

  if p_address is not null and p_address <> '{}'::jsonb then
    insert into public.addresses (kitchen_id, customer_id, line1, area, landmark, delivery_notes, lat, lng)
    values (p_kitchen, v_id, nullif(trim(p_address ->> 'line1'), ''), nullif(trim(p_address ->> 'area'), ''),
      nullif(trim(p_address ->> 'landmark'), ''), nullif(trim(p_address ->> 'delivery_notes'), ''),
      (p_address ->> 'lat')::double precision, (p_address ->> 'lng')::double precision);
  end if;

  insert into public.consents (kitchen_id, customer_id, purpose, basis, channel, recorded_by)
  values (p_kitchen, v_id, 'service_contact', 'vendor_attested', p_channel, auth.uid());

  return v_id;
end;
$$;

-- Owner adds a customer. p_consent: the vendor confirms the customer agreed to be
-- contacted about their tiffin service (required).
create or replace function public.create_customer(
  p_kitchen uuid,
  p_name text,
  p_phone text,
  p_consent boolean,
  p_diet public.diet_type default 'veg',
  p_language public.language_code default 'en',
  p_notes text default null,
  p_address jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
begin
  perform private.require_role(p_kitchen, '{owner}');
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if exists (select 1 from public.customers
             where kitchen_id = p_kitchen and phone_hash = private.phone_hash(v_phone) and deleted_at is null) then
    raise exception 'already_exists' using errcode = '23505';
  end if;
  return private.insert_customer(p_kitchen, p_name, v_phone, p_diet, p_language, p_notes, p_address,
    'vendor', 'vendor');
end;
$$;

-- Owner edits a customer. Only keys present in p_patch change.
create or replace function public.update_customer(p_customer uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_phone text;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');

  if p_patch ? 'phone' then
    v_phone := private.normalize_phone(p_patch ->> 'phone');
    if v_phone is null then
      raise exception 'invalid_phone' using errcode = '22023';
    end if;
    if exists (select 1 from public.customers
               where kitchen_id = v_c.kitchen_id and phone_hash = private.phone_hash(v_phone)
                 and deleted_at is null and id <> v_c.id) then
      raise exception 'already_exists' using errcode = '23505';
    end if;
  end if;
  if p_patch ? 'name' and nullif(trim(p_patch ->> 'name'), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;

  update public.customers set
    name = case when p_patch ? 'name' then trim(p_patch ->> 'name') else name end,
    phone_enc = case when v_phone is not null then private.encrypt_phone(v_phone) else phone_enc end,
    phone_hash = case when v_phone is not null then private.phone_hash(v_phone) else phone_hash end,
    phone_last4 = case when v_phone is not null then right(v_phone, 4) else phone_last4 end,
    diet = case when p_patch ? 'diet' then (p_patch ->> 'diet')::public.diet_type else diet end,
    preferred_language = case when p_patch ? 'preferred_language'
      then (p_patch ->> 'preferred_language')::public.language_code else preferred_language end,
    notes = case when p_patch ? 'notes' then nullif(trim(p_patch ->> 'notes'), '') else notes end
  where id = p_customer;
end;
$$;

-- DPDP erasure on request: scrubs personal data, keeps the row so financial
-- records (M3) stay consistent. Refuses while a live subscription exists.
create or replace function public.erase_customer(p_customer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  if exists (select 1 from public.subscriptions where customer_id = p_customer and status <> 'cancelled') then
    raise exception 'has_live_subscription' using errcode = '22023';
  end if;

  update public.addresses set line1 = null, landmark = null, delivery_notes = null, lat = null, lng = null,
    label = null
  where customer_id = p_customer;
  update public.customers set name = 'Deleted customer', phone_enc = null, phone_hash = null,
    phone_last4 = null, notes = null, whatsapp_opt_in = false, deleted_at = now()
  where id = p_customer;
end;
$$;

-- Search box at the top of every screen: full phone (owner only), last 4 digits, or name/area/landmark.
create or replace function public.search_customers(p_kitchen uuid, p_q text, p_limit integer default 50)
returns setof public.customers_v
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := trim(coalesce(p_q, ''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
  v_phone text;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  if v_q = '' then
    return query select * from public.customers_v v where v.kitchen_id = p_kitchen
      order by v.name limit p_limit;
  elsif length(v_digits) >= 10 and v_digits = regexp_replace(v_q, '[\s+\-]', '', 'g') then
    v_phone := private.normalize_phone(v_q);
    if v_phone is null or not private.has_role(p_kitchen, '{owner}') then
      return;
    end if;
    return query select v.* from public.customers_v v
      join public.customers c on c.id = v.id
      where c.kitchen_id = p_kitchen and c.phone_hash = private.phone_hash(v_phone);
  elsif v_q ~ '^[0-9]{4}$' then
    return query select * from public.customers_v v
      where v.kitchen_id = p_kitchen and v.phone_last4 = v_q order by v.name limit p_limit;
  else
    return query select * from public.customers_v v
      where v.kitchen_id = p_kitchen
        and (v.name ilike '%' || v_q || '%' or v.area ilike '%' || v_q || '%' or v.landmark ilike '%' || v_q || '%')
      order by v.name limit p_limit;
  end if;
end;
$$;

-- Platform admin (or owner) reveals a phone number; always logged.
create or replace function public.reveal_customer_phone(p_customer uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (private.has_role(v_c.kitchen_id, '{owner}') or private.is_platform_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.audit_access(v_c.kitchen_id, 'customers', v_c.id::text,
    jsonb_build_object('field', 'phone'));
  return private.decrypt_phone(v_c.phone_enc);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on public.customers, public.addresses, public.consents, public.plans, public.subscriptions,
  public.customers_v from anon, authenticated;

-- Column-level: phone_enc / phone_hash are never selectable by API roles.
grant select (id, kitchen_id, name, phone_last4, source, platform_sourced, payer_customer_id,
  whatsapp_opt_in, preferred_language, diet, notes, consent_at, consent_basis, created_by,
  created_at, updated_at, deleted_at) on public.customers to authenticated;
grant select on public.customers_v to authenticated;

grant select, delete on public.addresses to authenticated;
grant insert (kitchen_id, customer_id, label, line1, area, landmark, delivery_notes, lat, lng, is_default)
  on public.addresses to authenticated;
grant update (label, line1, area, landmark, delivery_notes, lat, lng, is_default)
  on public.addresses to authenticated;

grant select on public.consents to authenticated;

grant select on public.plans to authenticated;
grant insert (kitchen_id, name, slots, diet, days_of_week, price_per_meal_paise, description, active)
  on public.plans to authenticated;
grant update (name, slots, diet, days_of_week, price_per_meal_paise, description, active)
  on public.plans to authenticated;

grant select on public.subscriptions to authenticated;
grant insert (kitchen_id, customer_id, plan_id, address_id, qty, start_date, end_date, status)
  on public.subscriptions to authenticated;
grant update (plan_id, address_id, qty, start_date, end_date) on public.subscriptions to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.kitchen_ids(public.member_role[]) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;

revoke execute on function public.customer_phone, public.create_customer, public.update_customer,
  public.erase_customer, public.search_customers, public.reveal_customer_phone from public, anon;
grant execute on function public.customer_phone, public.create_customer, public.update_customer,
  public.erase_customer, public.search_customers, public.reveal_customer_phone to authenticated;
