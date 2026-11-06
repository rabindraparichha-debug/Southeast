-- Wave 4 (onboarding) review fixes.
--
--  1. A proven phone (D-134). phone_confirmed_at alone is not proof: with phone confirmations off,
--     a phone + password sign-up is stamped confirmed without any code. A phone counts for the
--     approval gate only when this session was signed in with a one-time code (JWT amr 'otp', the
--     same rule as wave 2's claim_invites). A password set by whoever registered the number first
--     would keep working after the real vendor logs in, so the moment the account gains trust
--     (create_kitchen on an approved/allowed number, admin_add_platform_admin) its password is
--     replaced by a random one and its other sessions end (private.secure_account). GoTrue gives
--     OTP-created accounts a random password too, so a password cannot be told apart in SQL.
--  2. The 'owner' basis counts only owners of a kitchen that is not suspended and not closed
--     (D-135): a suspended vendor cannot start a fresh kitchen to get around the suspension.
--  3. onboarding_status: proven phone, 'apply_open' (the public application form is switched on)
--     and 'login_with_code' (the number is confirmed but this login is not a one-time code).
--  4. Phone change (D-136): admin_phone_change_check records a pending change (old last 4 read on
--     the server); admin_phone_change_done(change) consumes it, so nothing the caller sends ends up
--     in admin_actions and nothing is logged for a phone that did not change through this flow.
--     admin_sign_out_user signs a person out everywhere on its own (retry, or a stolen phone).
--  5. Owner-only areas check the exact owner role (D-137): export_kitchen, close requests and the
--     admin_actions / kitchen_close_requests policies. Wave 2 makes '{owner}' include managers.
--  6. 'open_vendor_signup' is switched with admin_set_vendor_signup (reason, admin_actions).
--  7. Vendor applicants are nudged to log in only once they may create a kitchen (D-138), and
--     applications already in 'onboarding' or 'live' are approved by this migration.
--  8. set_plan_price reports the meals of the start date that are already counted at the old price.

-- ---------------------------------------------------------------------------
-- 1. Proven phone
-- ---------------------------------------------------------------------------
-- The caller's phone (+E.164) when it is confirmed AND this session was signed in with a one-time
-- code; otherwise null.
create or replace function private.session_phone()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select '+' || u.phone
  from auth.users u
  where u.id = auth.uid() and u.phone is not null and u.phone <> '' and u.phone_confirmed_at is not null
    and exists (select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
                where a ->> 'method' = 'otp');
$$;

-- Ends every session of p_user except p_keep. False if Auth refused.
create or replace function private.revoke_sessions(p_user uuid, p_keep uuid default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.sessions where user_id = p_user and (p_keep is null or id <> p_keep);
  return true;
exception when others then
  return false;
end;
$$;

-- The account is about to gain trust (a kitchen, platform admin rights): replace any password with
-- a random one nobody knows (what GoTrue gives OTP-created accounts) and end every other session,
-- so whoever registered the number with a password first is locked out. Logins with a one-time
-- code keep working. Never raises.
create or replace function private.secure_account(p_user uuid, p_keep_current boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep uuid := case when p_keep_current and p_user = auth.uid()
                      then nullif(auth.jwt() ->> 'session_id', '')::uuid end;
begin
  update auth.users
  set encrypted_password = extensions.crypt(encode(extensions.gen_random_bytes(32), 'hex'), extensions.gen_salt('bf'))
  where id = p_user;
  perform private.revoke_sessions(p_user, v_keep);
exception when others then
  null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The gate (redefined from 20261113000200_vendor_approval.sql)
-- ---------------------------------------------------------------------------
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
  -- Owner of a kitchen in good standing: not suspended and not closed by the platform team.
  if exists (select 1 from public.members m join public.kitchens k on k.id = m.kitchen_id
             where m.user_id = p_uid and m.role = 'owner' and k.status <> 'suspended'
               and not exists (select 1 from public.kitchen_close_requests r
                               where r.kitchen_id = k.id and r.status = 'closed')) then
    return 'owner';
  end if;
  -- Approved or allowed numbers: only the caller's own, proven phone.
  if p_uid is distinct from auth.uid() then
    return null;
  end if;
  v_phone := private.session_phone();
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

-- Redefined from 20261113000200_vendor_approval.sql: on an approved or allowed number the account
-- is secured once the kitchen exists (private.secure_account). Otherwise unchanged.
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
  v_basis text;
  v_slug text;
  v_kitchen public.kitchens;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_basis := private.vendor_signup_basis(v_uid);
  if v_basis is null then
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
  -- First kitchen on an approved or allowed number: lock out anyone who registered it with a password.
  if v_basis in ('approved', 'allowed') then
    perform private.secure_account(v_uid, true);
  end if;

  return v_kitchen;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. onboarding_status (redefined from 20261113000200_vendor_approval.sql)
-- ---------------------------------------------------------------------------
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
  v_confirmed boolean;
  v_basis text;
  v_app_status public.vendor_app_status;
  v_app_approved boolean;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_phone := private.session_phone();
  v_confirmed := exists (select 1 from auth.users u where u.id = v_uid and u.phone is not null and u.phone <> ''
                         and u.phone_confirmed_at is not null);
  v_basis := private.vendor_signup_basis(v_uid);
  if v_phone is not null then
    select a.status, a.approved_at is not null into v_app_status, v_app_approved
    from public.vendor_applications a
    where a.phone_hash = private.phone_hash(v_phone)
    order by (a.status <> 'rejected') desc, a.created_at desc limit 1;
  end if;
  return jsonb_build_object(
    'phone_confirmed', v_phone is not null,
    -- The number is confirmed but this login did not use a one-time code: log out and log in again
    -- with a code.
    'login_with_code', v_confirmed and v_phone is null,
    'memberships', (select count(*) from public.members where user_id = v_uid),
    'pending_invites', case when v_phone is null then 0 else
      (select count(*) from public.member_invites i
       where i.phone_e164 = v_phone and i.accepted_at is null and i.revoked_at is null
         and not exists (select 1 from public.members m where m.kitchen_id = i.kitchen_id and m.user_id = v_uid)) end,
    'can_create_kitchen', v_basis is not null,
    'basis', v_basis,
    -- The public vendor application form is on (the 'growth' switch, when a branch adds it).
    'apply_open', coalesce((select s.enabled from public.platform_settings s where s.key = 'growth'), true),
    'application', case when v_app_status is null then null
                        else jsonb_build_object('status', v_app_status, 'approved', v_app_approved) end);
end;
$$;

-- Redefined from 20261113000300_founder_support.sql: the account must have a confirmed phone, and
-- it is secured (random password, all sessions ended) so a number someone pre-registered with a
-- password does not hand them admin rights; the new admin logs in again with a code.
create or replace function public.admin_add_platform_admin(p_phone text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
  v_reason text;
  v_user uuid;
begin
  perform private.require_admin();
  v_reason := private.require_reason(p_reason);
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  select u.id into v_user from auth.users u
  where u.phone = substr(v_phone, 2) and u.phone_confirmed_at is not null limit 1;
  if v_user is null then
    raise exception 'no_account' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.platform_admins where user_id = v_user) then
    raise exception 'already_exists' using errcode = '23505';
  end if;
  perform private.secure_account(v_user, false);
  insert into public.platform_admins (user_id, created_at) values (v_user, private.now());
  perform private.log_admin_action(null, 'platform_admin_added', v_user::text, v_reason, null,
    jsonb_build_object('phone_last4', right(v_phone, 4)));
  return v_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Phone change with a pending record
-- ---------------------------------------------------------------------------
-- Not exposed through PostgREST (schema private); only the admin RPCs below touch it.
create table private.phone_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  old_phone_last4 text,
  new_phone_hash text not null,
  new_phone_last4 text not null,
  reason text not null check (length(reason) between 1 and 500),
  admin_id uuid not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  done_at timestamptz,
  signed_out boolean
);
create index phone_changes_user_idx on private.phone_changes (user_id, created_at desc);
revoke all on private.phone_changes from public, anon, authenticated;

-- Redefined from 20261113000300_founder_support.sql: now records a pending change and returns its
-- id. When the Auth half of an earlier attempt already went through (the login already has the
-- new number), the open change is returned with already_changed = true so the Edge Function can
-- finish it instead of failing with same_phone.
create or replace function public.admin_phone_change_check(p_user uuid, p_new_phone text, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_new text := private.normalize_phone(p_new_phone);
  v_reason text;
  v_old text;
  v_change private.phone_changes;
  v_kitchens jsonb;
begin
  perform private.require_admin();
  v_reason := private.require_reason(p_reason);
  if v_new is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  select u.phone into v_old from auth.users u where u.id = p_user;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_kitchens := coalesce((select jsonb_agg(jsonb_build_object('kitchen_id', m.kitchen_id, 'role', m.role))
                          from public.members m where m.user_id = p_user), '[]'::jsonb);
  if v_old = substr(v_new, 2) then
    select * into v_change from private.phone_changes c
    where c.user_id = p_user and c.new_phone_hash = private.phone_hash(v_new) and c.done_at is null
      and c.expires_at > private.now()
    order by c.created_at desc limit 1;
    if v_change.id is null then
      raise exception 'same_phone' using errcode = '22023';
    end if;
    return jsonb_build_object('change_id', v_change.id, 'user_id', p_user, 'new_phone', v_new,
      'old_phone_last4', v_change.old_phone_last4, 'already_changed', true, 'kitchens', v_kitchens);
  end if;
  if exists (select 1 from auth.users u where u.phone = substr(v_new, 2) and u.id <> p_user) then
    raise exception 'phone_in_use' using errcode = '23505';
  end if;
  insert into private.phone_changes (user_id, old_phone_last4, new_phone_hash, new_phone_last4, reason, admin_id,
                                     created_at, expires_at)
  values (p_user, nullif(right(coalesce(v_old, ''), 4), ''), private.phone_hash(v_new), right(v_new, 4), v_reason,
          auth.uid(), private.now(), private.now() + interval '1 hour')
  returning * into v_change;
  return jsonb_build_object('change_id', v_change.id, 'user_id', p_user, 'new_phone', v_new,
    'old_phone_last4', v_change.old_phone_last4, 'already_changed', false, 'kitchens', v_kitchens);
end;
$$;

-- The old signature trusted the caller's old last 4 and could log a change that never happened.
drop function public.admin_phone_change_done(uuid, text, text, text);

-- Finishes a pending change once the login really has the new number: signs the user out
-- everywhere and writes admin_actions from the pending record. Calling it again for a finished
-- change only retries the sign-out.
create or replace function public.admin_phone_change_done(p_change uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change private.phone_changes;
  v_revoked boolean;
  v_rows integer := 0;
  r record;
begin
  perform private.require_admin();
  select * into v_change from private.phone_changes where id = p_change for update;
  if v_change.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_change.done_at is not null then
    v_revoked := private.revoke_sessions(v_change.user_id);
    update private.phone_changes set signed_out = v_revoked or coalesce(signed_out, false) where id = p_change;
    return jsonb_build_object('user_id', v_change.user_id, 'phone_last4', v_change.new_phone_last4, 'signed_out', v_revoked,
                              'already_done', true);
  end if;
  if not exists (select 1 from auth.users u where u.id = v_change.user_id and u.phone is not null and u.phone <> ''
                 and private.phone_hash('+' || u.phone) = v_change.new_phone_hash) then
    raise exception 'phone_not_changed' using errcode = '22023';
  end if;
  v_revoked := private.revoke_sessions(v_change.user_id);
  update private.phone_changes set done_at = private.now(), signed_out = v_revoked where id = p_change;
  for r in select m.kitchen_id, m.role from public.members m where m.user_id = v_change.user_id loop
    perform private.log_admin_action(r.kitchen_id, 'member_phone_changed', v_change.user_id::text, v_change.reason,
      jsonb_build_object('phone_last4', v_change.old_phone_last4),
      jsonb_build_object('phone_last4', v_change.new_phone_last4, 'role', r.role, 'signed_out', v_revoked));
    v_rows := v_rows + 1;
  end loop;
  if v_rows = 0 then
    perform private.log_admin_action(null, 'member_phone_changed', v_change.user_id::text, v_change.reason,
      jsonb_build_object('phone_last4', v_change.old_phone_last4),
      jsonb_build_object('phone_last4', v_change.new_phone_last4, 'signed_out', v_revoked));
  end if;
  return jsonb_build_object('user_id', v_change.user_id, 'phone_last4', v_change.new_phone_last4, 'signed_out', v_revoked,
                            'already_done', false);
end;
$$;

-- Sign a person out on every device (a lost phone, or a phone change whose sign-out failed).
create or replace function public.admin_sign_out_user(p_user uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_revoked boolean;
  v_rows integer := 0;
  r record;
begin
  perform private.require_admin();
  v_reason := private.require_reason(p_reason);
  if not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_revoked := private.revoke_sessions(p_user);
  for r in select m.kitchen_id, m.role from public.members m where m.user_id = p_user loop
    perform private.log_admin_action(r.kitchen_id, 'member_signed_out', p_user::text, v_reason, null,
      jsonb_build_object('role', r.role, 'signed_out', v_revoked));
    v_rows := v_rows + 1;
  end loop;
  if v_rows = 0 then
    perform private.log_admin_action(null, 'member_signed_out', p_user::text, v_reason, null,
      jsonb_build_object('signed_out', v_revoked));
  end if;
  return jsonb_build_object('user_id', p_user, 'signed_out', v_revoked);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Exact owner checks
-- ---------------------------------------------------------------------------
-- Kitchens where the caller is exactly 'owner' (wave 2's private.kitchen_ids('{owner}') also
-- includes managers).
create or replace function private.owner_kitchen_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.kitchen_id), '{}') from public.members m
  where m.user_id = auth.uid() and m.role = 'owner';
$$;

create or replace function private.require_owner(p_kitchen uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  if not exists (select 1 from public.members m where m.kitchen_id = p_kitchen and m.user_id = auth.uid()
                 and m.role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

drop policy admin_actions_select on public.admin_actions;
create policy admin_actions_select on public.admin_actions for select to authenticated
  using (kitchen_id = any ((select private.owner_kitchen_ids())::uuid[]) or (select private.is_platform_admin()));
drop policy kitchen_close_requests_select on public.kitchen_close_requests;
create policy kitchen_close_requests_select on public.kitchen_close_requests for select to authenticated
  using (kitchen_id = any ((select private.owner_kitchen_ids())::uuid[]) or (select private.is_platform_admin()));

-- Redefined from 20261113000600_kitchen_export.sql: exact owner (full customer phones).
create or replace function public.export_kitchen(p_kitchen uuid, p_part text, p_offset integer default 0,
                                                 p_limit integer default 2000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 5000);
  v_from date := (private.ist_today() - interval '12 months')::date;
  v_rows jsonb;
  v_n integer;
begin
  perform private.require_role(p_kitchen, '{owner}');
  perform private.require_owner(p_kitchen);
  if p_part = 'customers' then
    select coalesce(jsonb_agg(x.j order by x.created_at, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select c.id, c.created_at, jsonb_build_object(
        'id', c.id, 'name', c.name,
        'phone', case when c.deleted_at is null and c.phone_enc is not null then private.decrypt_phone(c.phone_enc) end,
        'whatsapp_opt_in', c.whatsapp_opt_in, 'language', c.preferred_language, 'diet', c.diet, 'source', c.source,
        'notes', c.notes, 'address', a.line1, 'area', a.area, 'landmark', a.landmark, 'delivery_notes', a.delivery_notes,
        'lat', a.lat, 'lng', a.lng, 'consent_at', c.consent_at, 'created_at', c.created_at, 'erased_at', c.deleted_at) as j
      from public.customers c
      left join lateral (select ad.* from public.addresses ad where ad.customer_id = c.id
                         order by ad.is_default desc, ad.created_at desc limit 1) a on true
      where c.kitchen_id = p_kitchen
      order by c.created_at, c.id offset v_offset limit v_limit) x;
    perform private.audit_access(p_kitchen, 'customers', 'export',
      jsonb_build_object('reason', 'kitchen_export', 'offset', v_offset, 'rows', v_n));
  elsif p_part = 'subscriptions' then
    select coalesce(jsonb_agg(x.j order by x.created_at, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select s.id, s.created_at, to_jsonb(s) || jsonb_build_object('customer_name', c.name, 'plan_name', p.name) as j
      from public.subscriptions s join public.customers c on c.id = s.customer_id join public.plans p on p.id = s.plan_id
      where s.kitchen_id = p_kitchen
      order by s.created_at, s.id offset v_offset limit v_limit) x;
  elsif p_part = 'payments' then
    select coalesce(jsonb_agg(x.j order by x.created_at, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select py.id, py.created_at, to_jsonb(py) || jsonb_build_object('customer_name', c.name) as j
      from public.payments py join public.customers c on c.id = py.customer_id
      where py.kitchen_id = p_kitchen
      order by py.created_at, py.id offset v_offset limit v_limit) x;
  elsif p_part = 'balance_entries' then
    select coalesce(jsonb_agg(x.j order by x.created_at, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select b.id, b.created_at, to_jsonb(b) || jsonb_build_object('customer_name', c.name) as j
      from public.balance_entries b join public.customers c on c.id = b.customer_id
      where b.kitchen_id = p_kitchen
      order by b.created_at, b.id offset v_offset limit v_limit) x;
  elsif p_part = 'meal_orders' then
    select coalesce(jsonb_agg(x.j order by x.service_date, x.slot, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select o.id, o.service_date, o.slot, jsonb_build_object(
        'id', o.id, 'service_date', o.service_date, 'slot', o.slot, 'customer_id', o.customer_id, 'customer_name', c.name,
        'subscription_id', o.subscription_id, 'plan_name', p.name, 'qty', o.qty, 'diet', o.diet, 'status', o.status,
        'skip_reason', o.skip_reason, 'charged', o.charged, 'charge_waived', o.charge_waived,
        'price_per_meal_paise', o.price_per_meal_paise,
        'amount_paise', case when o.locked_at is not null and (o.status <> 'skipped' or o.charged)
                             then o.qty * coalesce(o.price_per_meal_paise, 0) end,
        'locked_at', o.locked_at) as j
      from public.meal_orders o join public.customers c on c.id = o.customer_id join public.plans p on p.id = o.plan_id
      where o.kitchen_id = p_kitchen and o.service_date >= v_from
      order by o.service_date, o.slot, o.id offset v_offset limit v_limit) x;
  else
    raise exception 'invalid_part' using errcode = '22023';
  end if;
  return jsonb_build_object('part', p_part, 'rows', v_rows,
                            'next_offset', case when v_n = v_limit then v_offset + v_limit end);
end;
$$;

-- Redefined from 20261113000600_kitchen_export.sql: exact owner.
create or replace function public.request_kitchen_close(p_kitchen uuid, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner}');
  perform private.require_owner(p_kitchen);
  if length(coalesce(p_reason, '')) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  select id into v_id from public.kitchen_close_requests where kitchen_id = p_kitchen and status = 'open';
  if v_id is not null then
    return v_id;   -- already filed: one open request per kitchen
  end if;
  insert into public.kitchen_close_requests (kitchen_id, requested_by, reason, created_at)
  values (p_kitchen, auth.uid(), nullif(trim(p_reason), ''), private.now())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.withdraw_kitchen_close(p_kitchen uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  perform private.require_owner(p_kitchen);
  update public.kitchen_close_requests set status = 'withdrawn', resolved_at = private.now(), resolved_by = auth.uid()
  where kitchen_id = p_kitchen and status = 'open';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Open vendor signup, with a reason and an admin_actions row
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_vendor_signup(p_open boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_was boolean;
begin
  perform private.require_admin();
  v_reason := private.require_reason(p_reason);
  select enabled into v_was from public.platform_settings where key = 'open_vendor_signup' for update;
  if coalesce(p_open, false) = coalesce(v_was, false) then
    return;
  end if;
  update public.platform_settings set enabled = coalesce(p_open, false), updated_by = auth.uid()
  where key = 'open_vendor_signup';
  perform private.log_admin_action(null, case when coalesce(p_open, false) then 'vendor_signup_opened' else 'vendor_signup_closed' end,
    'open_vendor_signup', v_reason, jsonb_build_object('enabled', coalesce(v_was, false)),
    jsonb_build_object('enabled', coalesce(p_open, false)));
end;
$$;

-- Redefined from 20261106000100_p6.sql: 'open_vendor_signup' only through admin_set_vendor_signup.
create or replace function public.admin_set_platform_flag(p_key text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_key = 'open_vendor_signup' then
    raise exception 'use_vendor_signup' using errcode = '22023';
  end if;
  update public.platform_settings set enabled = coalesce(p_enabled, false), updated_by = auth.uid() where key = p_key;
  if not found then
    raise exception 'invalid_flag' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Vendor nudges wait for approval; backfill
-- ---------------------------------------------------------------------------
-- Applications the team already moved to onboarding (or live) were effectively approved.
update public.vendor_applications set approved_at = coalesce(updated_at, created_at)
where status in ('onboarding', 'live') and approved_at is null;

-- Redefined from 20261101000100_acquisition.sql: an applicant with no kitchen yet is nudged to
-- log in only once their number is approved (or vendor signup is open); until then, no nudge.
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
  v_open boolean := private.feature_enabled('open_vendor_signup');
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

  -- Vendor applicants: nudge on day 1, 3 and 7 until their kitchen is live. Without a kitchen,
  -- only once they may create one (approved, or signup open); the count starts again then.
  for r in
    select a.*, k.id as kid from public.vendor_applications a left join public.kitchens k on k.id = a.kitchen_id
    where a.status in ('new', 'contacted', 'onboarding') and a.nudges < 3
      and (a.kitchen_id is not null or a.approved_at is not null or v_open)
      and coalesce(case when a.kitchen_id is null and not v_open then a.approved_at end, a.created_at)
          <= v_now - (case a.nudges when 0 then interval '1 day' when 1 then interval '3 days' else interval '7 days' end)
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

-- ---------------------------------------------------------------------------
-- 8. set_plan_price reports meals already counted on the start date
-- ---------------------------------------------------------------------------
-- Redefined from 20261113000400_plan_prices.sql: adds 'charged_slots', the plan's slots on the
-- start date that are already counted (and charged) at the old price.
create or replace function public.set_plan_price(p_plan uuid, p_price_paise integer, p_from date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.plans;
  v_today date := private.ist_today();
  v_id uuid;
  v_from date;
  v_charged jsonb;
begin
  select * into v_plan from public.plans where id = p_plan;
  if v_plan.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_plan.kitchen_id, '{owner}');
  if p_price_paise is null or p_price_paise <= 0 or p_price_paise > 100000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_from is not null and p_from < v_today then
    raise exception 'date_in_past' using errcode = '22023';
  end if;
  if p_from is not null and p_from > v_today + 366 then
    raise exception 'date_too_far' using errcode = '22023';
  end if;
  v_from := coalesce(p_from, v_today);
  v_charged := coalesce((select jsonb_agg(cs.slot order by cs.slot) from public.count_snapshots cs
                         where cs.kitchen_id = v_plan.kitchen_id and cs.service_date = v_from
                           and cs.slot = any (v_plan.slots)), '[]'::jsonb);

  if v_from = v_today then
    update public.plans set price_per_meal_paise = p_price_paise where id = p_plan;
    return jsonb_build_object('plan_id', p_plan, 'price_per_meal_paise', p_price_paise, 'effective_from', v_today,
                              'scheduled', false, 'charged_slots', v_charged);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('plan_price:' || p_plan, 0));
  perform private.plan_price_baseline(p_plan, v_plan.kitchen_id, v_plan.price_per_meal_paise);
  -- A new price for the same start date replaces the one scheduled before.
  update public.plan_prices set cancelled_at = private.now(), cancelled_by = auth.uid()
  where plan_id = p_plan and effective_from = p_from and cancelled_at is null;
  insert into public.plan_prices (kitchen_id, plan_id, price_per_meal_paise, effective_from, created_by, created_at)
  values (v_plan.kitchen_id, p_plan, p_price_paise, p_from, auth.uid(), private.now())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'plan_id', p_plan, 'price_per_meal_paise', p_price_paise, 'effective_from', p_from,
                            'scheduled', true, 'charged_slots', v_charged);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (fail closed)
-- ---------------------------------------------------------------------------
revoke execute on function private.session_phone(), private.secure_account(uuid, boolean), private.revoke_sessions(uuid, uuid),
  private.owner_kitchen_ids(), private.require_owner(uuid) from public, anon, authenticated;
-- The RLS policies call owner_kitchen_ids() as the signed-in user.
grant execute on function private.owner_kitchen_ids() to authenticated;
revoke execute on function public.admin_phone_change_done(uuid), public.admin_sign_out_user(uuid, text),
  public.admin_set_vendor_signup(boolean, text) from public, anon;
grant execute on function public.admin_phone_change_done(uuid), public.admin_sign_out_user(uuid, text),
  public.admin_set_vendor_signup(boolean, text) to authenticated;
