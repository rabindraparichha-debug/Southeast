-- M1 / 1.1–1.2 Tenancy: kitchens, settings, members, invites, payout accounts,
-- platform admins, role helpers, RLS and the RPCs that manage them.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.kitchens (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 80),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 60),
  owner_id uuid not null references auth.users (id),
  address text,
  area text,
  city text not null default 'Bhubaneswar',
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  geo_point extensions.geography(Point, 4326) generated always as (
    case when lat is not null and lng is not null
      then extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
    end
  ) stored,
  service_radius_km numeric(4, 1) not null default 3
    check (service_radius_km > 0 and service_radius_km <= 25),
  fssai_no text check (fssai_no ~ '^[0-9]{14}$'),
  -- Cutoffs are IST wall-clock times. *_prev_day = the cutoff is on the day before service.
  cutoff_lunch time not null default '21:00',
  cutoff_lunch_prev_day boolean not null default true,
  cutoff_dinner time not null default '12:00',
  cutoff_dinner_prev_day boolean not null default false,
  capacity_lunch integer not null default 50 check (capacity_lunch >= 0),
  capacity_dinner integer not null default 50 check (capacity_dinner >= 0),
  -- ISO day of week: 1 = Monday … 7 = Sunday.
  weekly_off smallint[] not null default '{}'
    check (weekly_off <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  status public.kitchen_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kitchens_live_needs_fssai check (status <> 'active' or fssai_no is not null)
);
create index kitchens_owner_idx on public.kitchens (owner_id);
create index kitchens_geo_idx on public.kitchens using gist (geo_point);

create table public.kitchen_settings (
  kitchen_id uuid primary key references public.kitchens (id) on delete cascade,
  low_balance_meals integer not null default 3 check (low_balance_meals >= 0),
  credit_limit_meals integer not null default 0 check (credit_limit_meals >= 0),
  grace_days integer not null default 7 check (grace_days >= 0),
  notice_days integer not null default 1 check (notice_days >= 0),
  -- Pauses/skips requested by phone (via the vendor) close at this IST time; WhatsApp stays open until cutoff.
  phone_pause_close_time time not null default '19:00',
  updated_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kitchen_id, user_id)
);
create index members_user_idx on public.members (user_id);

create table public.member_invites (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+91[6-9][0-9]{9}$'),
  role public.member_role not null check (role <> 'owner'),
  display_name text,
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_user_id uuid references auth.users (id),
  revoked_at timestamptz
);
create unique index member_invites_open_idx on public.member_invites (kitchen_id, phone_e164)
  where accepted_at is null and revoked_at is null;
create index member_invites_phone_idx on public.member_invites (phone_e164)
  where accepted_at is null and revoked_at is null;

-- One Razorpay Route linked account per kitchen. Written only by platform/service code (M3).
create table public.kitchen_payout_accounts (
  kitchen_id uuid primary key references public.kitchens (id) on delete cascade,
  razorpay_linked_account_id text unique,
  kyc_status text not null default 'not_started'
    check (kyc_status in ('not_started', 'pending', 'verified', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Role helpers (used by RLS). SECURITY DEFINER so they can read `members`
-- without recursing through its own policies. They only describe the caller.
-- ---------------------------------------------------------------------------
create or replace function private.kitchen_ids(p_roles public.member_role[] default null)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.kitchen_id), '{}')
  from public.members m
  where m.user_id = auth.uid()
    and (p_roles is null or m.role = any (p_roles));
$$;

create or replace function private.has_role(p_kitchen uuid, p_roles public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.kitchen_id = p_kitchen and m.user_id = auth.uid() and m.role = any (p_roles)
  );
$$;

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function private.require_role(p_kitchen uuid, p_roles public.member_role[])
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
  if not private.has_role(p_kitchen, p_roles) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create trigger kitchens_updated_at before update on public.kitchens
  for each row execute function private.set_updated_at();
create trigger kitchen_settings_updated_at before update on public.kitchen_settings
  for each row execute function private.set_updated_at();
create trigger members_updated_at before update on public.members
  for each row execute function private.set_updated_at();
create trigger kitchen_payout_accounts_updated_at before update on public.kitchen_payout_accounts
  for each row execute function private.set_updated_at();

create trigger kitchens_audit after insert or update or delete on public.kitchens
  for each row execute function private.audit_row();
create trigger kitchen_settings_audit after insert or update or delete on public.kitchen_settings
  for each row execute function private.audit_row();
create trigger members_audit after insert or update or delete on public.members
  for each row execute function private.audit_row();
create trigger member_invites_audit after insert or update or delete on public.member_invites
  for each row execute function private.audit_row();
create trigger kitchen_payout_accounts_audit after insert or update or delete on public.kitchen_payout_accounts
  for each row execute function private.audit_row();
create trigger platform_admins_audit after insert or update or delete on public.platform_admins
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.kitchens enable row level security;
alter table public.kitchen_settings enable row level security;
alter table public.members enable row level security;
alter table public.member_invites enable row level security;
alter table public.kitchen_payout_accounts enable row level security;
alter table public.platform_admins enable row level security;
alter table public.audit_log enable row level security;

create policy kitchens_select on public.kitchens for select to authenticated
  using (id = any ((select private.kitchen_ids())::uuid[]) or (select private.is_platform_admin()));
create policy kitchens_update on public.kitchens for update to authenticated
  using (id = any ((select private.kitchen_ids('{owner}'))::uuid[]))
  with check (id = any ((select private.kitchen_ids('{owner}'))::uuid[]));

create policy kitchen_settings_select on public.kitchen_settings for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids())::uuid[]) or (select private.is_platform_admin()));
create policy kitchen_settings_update on public.kitchen_settings for update to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]))
  with check (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]));

create policy members_select on public.members for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids())::uuid[]) or (select private.is_platform_admin()));

create policy member_invites_select on public.member_invites for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

create policy kitchen_payout_accounts_select on public.kitchen_payout_accounts for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

create policy platform_admins_select on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

create policy audit_log_select on public.audit_log for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create a kitchen; the caller becomes its owner. One transaction.
create or replace function public.create_kitchen(
  p_name text,
  p_slug text default null,
  p_area text default null,
  p_address text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_fssai_no text default null,
  p_owner_name text default null
)
returns public.kitchens
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_slug text;
  v_kitchen public.kitchens;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if nullif(trim(p_slug), '') is not null then
    v_slug := private.slugify(p_slug);
    if exists (select 1 from public.kitchens where slug = v_slug) then
      raise exception 'slug_taken' using errcode = '23505';
    end if;
  else
    v_slug := private.slugify(p_name);
    if length(v_slug) < 3 then
      v_slug := v_slug || '-kitchen';
    end if;
    v_slug := left(v_slug, 50);
    while exists (select 1 from public.kitchens where slug = v_slug) loop
      v_slug := left(private.slugify(p_name), 50) || '-' || substr(md5(random()::text), 1, 4);
    end loop;
  end if;

  insert into public.kitchens (name, slug, owner_id, area, address, lat, lng, fssai_no)
  values (trim(p_name), v_slug, v_uid, p_area, p_address, p_lat, p_lng, nullif(trim(p_fssai_no), ''))
  returning * into v_kitchen;

  insert into public.members (kitchen_id, user_id, role, display_name)
  values (v_kitchen.id, v_uid, 'owner', p_owner_name);
  insert into public.kitchen_settings (kitchen_id) values (v_kitchen.id);
  insert into public.kitchen_payout_accounts (kitchen_id) values (v_kitchen.id);

  return v_kitchen;
end;
$$;

-- Owner adds a staff member or rider by phone. If the person already has an
-- account they are added immediately; otherwise an invite waits for their first login.
create or replace function public.invite_member(
  p_kitchen uuid,
  p_phone text,
  p_role public.member_role,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
  v_user uuid;
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner}');
  if p_role = 'owner' then
    raise exception 'cannot_invite_owner' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  select id into v_user from auth.users where phone = substr(v_phone, 2) limit 1;

  if v_user is not null then
    if exists (select 1 from public.members where kitchen_id = p_kitchen and user_id = v_user) then
      raise exception 'already_member' using errcode = '23505';
    end if;
    insert into public.members (kitchen_id, user_id, role, display_name)
    values (p_kitchen, v_user, p_role, p_display_name)
    returning id into v_id;
    return jsonb_build_object('status', 'added', 'member_id', v_id);
  end if;

  insert into public.member_invites (kitchen_id, phone_e164, role, display_name, invited_by)
  values (p_kitchen, v_phone, p_role, p_display_name, auth.uid())
  on conflict (kitchen_id, phone_e164) where accepted_at is null and revoked_at is null
  do update set role = excluded.role, display_name = excluded.display_name
  returning id into v_id;
  return jsonb_build_object('status', 'invited', 'invite_id', v_id);
end;
$$;

-- Called by the apps after every login: turns pending invites for the caller's
-- verified phone into memberships. Returns how many were claimed.
create or replace function public.claim_invites()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_phone text;
  v_count integer := 0;
  r record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select '+' || phone into v_phone
  from auth.users where id = v_uid and phone_confirmed_at is not null;
  if v_phone is null then
    return 0;
  end if;

  for r in
    select * from public.member_invites
    where phone_e164 = v_phone and accepted_at is null and revoked_at is null
    for update
  loop
    insert into public.members (kitchen_id, user_id, role, display_name)
    values (r.kitchen_id, v_uid, r.role, r.display_name)
    on conflict (kitchen_id, user_id) do nothing;
    update public.member_invites set accepted_at = now(), accepted_user_id = v_uid where id = r.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.revoke_invite(p_invite uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.member_invites where id = p_invite;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  update public.member_invites set revoked_at = now()
  where id = p_invite and accepted_at is null and revoked_at is null;
end;
$$;

create or replace function public.set_member_role(p_member uuid, p_role public.member_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members;
begin
  select * into v_member from public.members where id = p_member;
  if v_member.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_member.kitchen_id, '{owner}');
  if v_member.role = 'owner' or p_role = 'owner' then
    raise exception 'owner_role_locked' using errcode = '22023';
  end if;
  update public.members set role = p_role where id = p_member;
end;
$$;

create or replace function public.remove_member(p_member uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members;
begin
  select * into v_member from public.members where id = p_member;
  if v_member.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_member.kitchen_id, '{owner}');
  if v_member.role = 'owner' then
    raise exception 'owner_role_locked' using errcode = '22023';
  end if;
  delete from public.members where id = p_member;
end;
$$;

-- Platform admins only. The FSSAI check constraint blocks 'active' without a number.
create or replace function public.set_kitchen_status(p_kitchen uuid, p_status public.kitchen_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.kitchens set status = p_status where id = p_kitchen;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on public.kitchens, public.kitchen_settings, public.members, public.member_invites,
  public.kitchen_payout_accounts, public.platform_admins from anon, authenticated;

grant select on public.kitchens to authenticated;
grant update (name, address, area, city, lat, lng, service_radius_km, fssai_no,
  cutoff_lunch, cutoff_lunch_prev_day, cutoff_dinner, cutoff_dinner_prev_day,
  capacity_lunch, capacity_dinner, weekly_off) on public.kitchens to authenticated;

grant select on public.kitchen_settings to authenticated;
grant update (low_balance_meals, credit_limit_meals, grace_days, notice_days, phone_pause_close_time)
  on public.kitchen_settings to authenticated;

grant select on public.members, public.member_invites, public.kitchen_payout_accounts,
  public.platform_admins, public.audit_log to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
-- RLS policies evaluate these as the calling user.
grant execute on function private.kitchen_ids(public.member_role[]) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;

revoke execute on function public.create_kitchen, public.invite_member, public.claim_invites,
  public.revoke_invite, public.set_member_role, public.remove_member, public.set_kitchen_status
  from public, anon;
grant execute on function public.create_kitchen, public.invite_member, public.claim_invites,
  public.revoke_invite, public.set_member_role, public.remove_member, public.set_kitchen_status
  to authenticated;
