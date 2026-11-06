-- Wave 4 (onboarding), step 2: new kitchens need the founder's approval (audit Phase 1 step 2),
-- and kitchen names in Odia (or any non-Latin script) get a valid web address (step 4).
--
-- A signed-in phone may create a kitchen when one of these holds (private.vendor_signup_basis):
--   * the platform setting 'open_vendor_signup' is on (default off);
--   * the phone has a vendor application the platform team approved (vendor_applications.approved_at);
--   * the platform team added the phone to vendor_allowed_phones;
--   * the user already owns a kitchen (approved before), or is a platform admin.
-- Otherwise create_kitchen raises 'not_approved'. Only a confirmed phone counts.

-- ---------------------------------------------------------------------------
-- Approval flag on applications (the statuses new/contacted/onboarding/live/rejected keep working)
-- ---------------------------------------------------------------------------
alter table public.vendor_applications
  add column approved_at timestamptz,
  add column approved_by uuid references auth.users (id);
grant select (approved_at) on public.vendor_applications to authenticated;  -- RLS: admins only

-- ---------------------------------------------------------------------------
-- Numbers the platform team allowed to create a kitchen without an application
-- ---------------------------------------------------------------------------
create table public.vendor_allowed_phones (
  id uuid primary key default gen_random_uuid(),
  phone_enc bytea not null,
  phone_hash text not null unique,
  phone_last4 text not null check (phone_last4 ~ '^[0-9]{4}$'),
  note text not null check (length(trim(note)) between 1 and 200),
  added_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create trigger vendor_allowed_phones_audit after insert or update or delete on public.vendor_allowed_phones
  for each row execute function private.audit_row();
alter table public.vendor_allowed_phones enable row level security;
create policy vendor_allowed_phones_select on public.vendor_allowed_phones for select to authenticated
  using ((select private.is_platform_admin()));
-- No table grants: admins use the admin_* RPCs below.
revoke all on public.vendor_allowed_phones from anon, authenticated;

insert into public.platform_settings (key, enabled) values ('open_vendor_signup', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The gate
-- ---------------------------------------------------------------------------
-- Why this user may create a kitchen: 'open', 'admin', 'owner', 'approved' or 'allowed'; null = not yet.
create or replace function private.vendor_signup_basis(p_uid uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_phone text;
  v_hash text;
begin
  if p_uid is null then
    return null;
  end if;
  if private.feature_enabled('open_vendor_signup') then
    return 'open';
  end if;
  if exists (select 1 from public.platform_admins where user_id = p_uid) then
    return 'admin';
  end if;
  if exists (select 1 from public.members where user_id = p_uid and role = 'owner') then
    return 'owner';
  end if;
  select '+' || u.phone into v_phone from auth.users u
  where u.id = p_uid and u.phone is not null and u.phone <> '' and u.phone_confirmed_at is not null;
  if v_phone is null then
    return null;
  end if;
  v_hash := private.phone_hash(v_phone);
  if exists (select 1 from public.vendor_applications
             where phone_hash = v_hash and approved_at is not null and status <> 'rejected') then
    return 'approved';
  end if;
  if exists (select 1 from public.vendor_allowed_phones where phone_hash = v_hash) then
    return 'allowed';
  end if;
  return null;
end;
$$;

-- A web address from any kitchen name. Names with no Latin letters or digits (Odia, Hindi…) get
-- 'kitchen-<6 random characters>'; a taken address gets a short random suffix.
create or replace function private.kitchen_slug(p_name text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_base text := trim(both '-' from left(private.slugify(p_name), 50));
  v_slug text;
begin
  if length(v_base) < 3 then
    v_base := 'kitchen-' || substr(md5(gen_random_uuid()::text), 1, 6);
  end if;
  v_slug := v_base;
  while exists (select 1 from public.kitchens where slug = v_slug) loop
    v_slug := v_base || '-' || substr(md5(gen_random_uuid()::text), 1, 4);
  end loop;
  return v_slug;
end;
$$;

-- Create a kitchen; the caller becomes its owner. One transaction.
-- Redefined from 20261027000200_tenancy.sql: the approval gate, name/slug/FSSAI checks with short
-- error codes (never a raw constraint error), and the non-Latin slug fallback.
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
  if private.vendor_signup_basis(v_uid) is null then
    raise exception 'not_approved' using errcode = '42501';
  end if;
  if length(coalesce(trim(p_name), '')) not between 2 and 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if nullif(trim(p_fssai_no), '') is not null and trim(p_fssai_no) !~ '^[0-9]{14}$' then
    raise exception 'invalid_fssai' using errcode = '22023';
  end if;
  if (p_lat is not null and p_lat not between -90 and 90) or (p_lng is not null and p_lng not between -180 and 180) then
    raise exception 'invalid_location' using errcode = '22023';
  end if;

  if nullif(trim(p_slug), '') is not null then
    v_slug := private.slugify(p_slug);
    if length(v_slug) not between 3 and 60 then
      raise exception 'invalid_slug' using errcode = '22023';
    end if;
    if exists (select 1 from public.kitchens where slug = v_slug) then
      raise exception 'slug_taken' using errcode = '23505';
    end if;
  else
    v_slug := private.kitchen_slug(p_name);
  end if;

  insert into public.kitchens (name, slug, owner_id, area, address, lat, lng, fssai_no)
  values (trim(p_name), v_slug, v_uid, nullif(trim(p_area), ''), nullif(trim(p_address), ''), p_lat, p_lng,
          nullif(trim(p_fssai_no), ''))
  returning * into v_kitchen;

  insert into public.members (kitchen_id, user_id, role, display_name)
  values (v_kitchen.id, v_uid, 'owner', nullif(trim(p_owner_name), ''));
  insert into public.kitchen_settings (kitchen_id) values (v_kitchen.id);
  insert into public.kitchen_payout_accounts (kitchen_id) values (v_kitchen.id);

  return v_kitchen;
end;
$$;

-- What the "Set up your kitchen" screens need to decide what to show: kitchens the user already
-- belongs to, invites still waiting for this phone (claim them, or retry), and whether a new
-- kitchen is allowed. Self-service: describes only the caller.
create or replace function public.onboarding_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_phone text;
  v_basis text;
  v_app_status public.vendor_app_status;
  v_app_approved boolean;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select '+' || u.phone into v_phone from auth.users u
  where u.id = v_uid and u.phone is not null and u.phone <> '' and u.phone_confirmed_at is not null;
  v_basis := private.vendor_signup_basis(v_uid);
  if v_phone is not null then
    select a.status, a.approved_at is not null into v_app_status, v_app_approved
    from public.vendor_applications a
    where a.phone_hash = private.phone_hash(v_phone)
    order by (a.status <> 'rejected') desc, a.created_at desc limit 1;
  end if;
  return jsonb_build_object(
    'phone_confirmed', v_phone is not null,
    'memberships', (select count(*) from public.members where user_id = v_uid),
    'pending_invites', case when v_phone is null then 0 else
      (select count(*) from public.member_invites i
       where i.phone_e164 = v_phone and i.accepted_at is null and i.revoked_at is null
         and not exists (select 1 from public.members m where m.kitchen_id = i.kitchen_id and m.user_id = v_uid)) end,
    'can_create_kitchen', v_basis is not null,
    'basis', v_basis,
    'application', case when v_app_status is null then null
                        else jsonb_build_object('status', v_app_status, 'approved', v_app_approved) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: approve applications, allow numbers
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_vendor_approval(p_id uuid, p_approved boolean default true,
                                                            p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.vendor_applications;
begin
  perform private.require_admin();
  select * into v_app from public.vendor_applications where id = p_id for update;
  if v_app.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if coalesce(p_approved, true) and v_app.status = 'rejected' then
    raise exception 'application_rejected' using errcode = '22023';
  end if;
  if coalesce(p_approved, true) = (v_app.approved_at is not null) then
    return; -- nothing changes
  end if;
  update public.vendor_applications
  set approved_at = case when coalesce(p_approved, true) then private.now() end,
      approved_by = case when coalesce(p_approved, true) then auth.uid() end
  where id = p_id;
  perform private.log_admin_action(v_app.kitchen_id,
    case when coalesce(p_approved, true) then 'vendor_approved' else 'vendor_unapproved' end,
    p_id::text, p_reason,
    jsonb_build_object('approved', v_app.approved_at is not null, 'status', v_app.status, 'phone_last4', v_app.phone_last4),
    jsonb_build_object('approved', coalesce(p_approved, true), 'kitchen_name', v_app.kitchen_name));
end;
$$;

create or replace function public.admin_allow_vendor_phone(p_phone text, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
  v_note text;
  v_id uuid;
begin
  perform private.require_admin();
  v_note := private.require_reason(p_note);
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if length(v_note) > 200 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  select id into v_id from public.vendor_allowed_phones where phone_hash = private.phone_hash(v_phone);
  if v_id is not null then
    raise exception 'already_exists' using errcode = '23505';
  end if;
  insert into public.vendor_allowed_phones (phone_enc, phone_hash, phone_last4, note, added_by, created_at)
  values (private.encrypt_phone(v_phone), private.phone_hash(v_phone), right(v_phone, 4), v_note, auth.uid(), private.now())
  returning id into v_id;
  perform private.log_admin_action(null, 'vendor_phone_allowed', v_id::text, v_note, null,
    jsonb_build_object('phone_last4', right(v_phone, 4)));
  return v_id;
end;
$$;

create or replace function public.admin_remove_vendor_phone(p_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.vendor_allowed_phones;
begin
  perform private.require_admin();
  delete from public.vendor_allowed_phones where id = p_id returning * into v_row;
  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.log_admin_action(null, 'vendor_phone_removed', p_id::text, p_reason,
    jsonb_build_object('phone_last4', v_row.phone_last4, 'note', v_row.note), null);
end;
$$;

create or replace function public.admin_vendor_phones()
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
      'id', p.id, 'phone', private.mask_phone(p.phone_last4), 'note', p.note, 'created_at', p.created_at,
      'added_by_last4', right(u.phone, 4),
      -- Did this number already sign up and create a kitchen?
      'kitchen', (select jsonb_build_object('id', k.id, 'name', k.name) from public.kitchens k join auth.users o on o.id = k.owner_id
                  where o.phone is not null and o.phone <> '' and private.phone_hash('+' || o.phone) = p.phone_hash
                  order by k.created_at limit 1)
    ) order by p.created_at desc)
    from public.vendor_allowed_phones p left join auth.users u on u.id = p.added_by), '[]'::jsonb);
end;
$$;

revoke execute on function private.vendor_signup_basis, private.kitchen_slug from public, anon, authenticated;
revoke execute on function public.onboarding_status, public.admin_set_vendor_approval, public.admin_allow_vendor_phone,
  public.admin_remove_vendor_phone, public.admin_vendor_phones from public, anon;
grant execute on function public.onboarding_status, public.admin_set_vendor_approval, public.admin_allow_vendor_phone,
  public.admin_remove_vendor_phone, public.admin_vendor_phones to authenticated;
