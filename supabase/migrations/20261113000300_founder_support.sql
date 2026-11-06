-- Wave 4 (onboarding), step 3: founder support tools (audit Phase 1 steps 3, 4 and 7; work order 34).
-- Admin only; every action writes an admin_actions row (with a reason where access changes).
--   * admin_kitchen_detail: owner, team, pending invites, setup and usage signals, recent actions
--   * admin_reveal_member_phone: a member's full number (logged)
--   * admin_phone_change_check / admin_phone_change_done: the database half of the
--     'admin-change-phone' Edge Function (which changes auth.users.phone with the service role)
--   * admin_transfer_ownership: hand a kitchen to another member (old owner becomes staff or leaves)
--   * admin_add_platform_admin / admin_remove_platform_admin / admin_platform_admins (never the last admin)

-- Display name for an auth user: their name in this kitchen, else the name on their login.
create or replace function private.user_display_name(p_user uuid, p_kitchen uuid default null)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(trim(m.display_name), '') from public.members m where m.user_id = p_user and m.kitchen_id = p_kitchen),
    (select nullif(trim(u.raw_user_meta_data ->> 'name'), '') from auth.users u where u.id = p_user),
    (select nullif(trim(m.display_name), '') from public.members m where m.user_id = p_user order by m.created_at limit 1));
$$;

-- ---------------------------------------------------------------------------
-- Kitchen detail for support calls
-- ---------------------------------------------------------------------------
create or replace function public.admin_kitchen_detail(p_kitchen uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_k public.kitchens;
  v_today date := private.ist_today();
begin
  perform private.require_admin();
  select * into v_k from public.kitchens where id = p_kitchen;
  if v_k.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'kitchen', jsonb_build_object('id', v_k.id, 'name', v_k.name, 'slug', v_k.slug, 'area', v_k.area, 'address', v_k.address,
                                  'status', v_k.status, 'fssai_no', v_k.fssai_no, 'created_at', v_k.created_at),
    'owner', (select jsonb_build_object('user_id', u.id, 'member_id', m.id, 'name', private.user_display_name(u.id, v_k.id),
                                        'phone', private.mask_phone(right(u.phone, 4)), 'last_sign_in_at', u.last_sign_in_at)
              from auth.users u left join public.members m on m.user_id = u.id and m.kitchen_id = v_k.id
              where u.id = v_k.owner_id),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
                 'member_id', m.id, 'user_id', m.user_id, 'role', m.role, 'name', private.user_display_name(m.user_id, v_k.id),
                 'phone', private.mask_phone(right(u.phone, 4)), 'joined_at', m.created_at, 'last_sign_in_at', u.last_sign_in_at)
                 order by (m.role = 'owner') desc, m.role, m.created_at)
               from public.members m join auth.users u on u.id = m.user_id where m.kitchen_id = v_k.id), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'role', i.role, 'name', i.display_name,
                                                             'phone', private.mask_phone(right(i.phone_e164, 4)), 'created_at', i.created_at)
                                          order by i.created_at desc)
               from public.member_invites i where i.kitchen_id = v_k.id and i.accepted_at is null and i.revoked_at is null), '[]'::jsonb),
    'application', (select jsonb_build_object('id', a.id, 'status', a.status, 'approved_at', a.approved_at, 'source', a.source,
                                              'created_at', a.created_at)
                    from public.vendor_applications a where a.kitchen_id = v_k.id order by a.created_at desc limit 1),
    'signals', jsonb_build_object(
      'plans', (select count(*) from public.plans p where p.kitchen_id = v_k.id and p.active),
      'customers', (select count(*) from public.customers c where c.kitchen_id = v_k.id and c.deleted_at is null),
      'live_subscriptions', (select count(*) from public.subscriptions s where s.kitchen_id = v_k.id
                               and s.status in ('active', 'low_balance', 'paused')),
      'routes', (select count(*) from public.delivery_routes r where r.kitchen_id = v_k.id and r.active),
      'routes_without_rider', (select count(*) from public.delivery_routes r where r.kitchen_id = v_k.id and r.active and r.rider_id is null),
      'staff', (select count(*) from public.members m where m.kitchen_id = v_k.id and m.role = 'staff'),
      'riders', (select count(*) from public.members m where m.kitchen_id = v_k.id and m.role = 'rider'),
      'credit_limit_meals', (select ks.credit_limit_meals from public.kitchen_settings ks where ks.kitchen_id = v_k.id),
      'grace_days', (select ks.grace_days from public.kitchen_settings ks where ks.kitchen_id = v_k.id),
      'meals_7d', (select coalesce(sum(o.qty), 0) from public.meal_orders o where o.kitchen_id = v_k.id
                     and o.service_date between v_today - 7 and v_today - 1 and o.locked_at is not null
                     and (o.status <> 'skipped' or o.charged)),
      'last_lock', (select max(cs.locked_at) from public.count_snapshots cs where cs.kitchen_id = v_k.id),
      'last_activity', (select max(a.created_at) from public.audit_log a where a.kitchen_id = v_k.id),
      'open_complaints', (select count(*) from public.complaints cp where cp.kitchen_id = v_k.id and cp.status in ('open', 'escalated')),
      'open_engine_errors', (select count(*) from public.engine_errors e where e.kitchen_id = v_k.id and e.resolved_at is null)),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.created_at, 'action', a.action, 'target', a.target,
                                                             'reason', a.reason, 'before', a.before, 'after', a.after,
                                                             'admin_phone_last4', right(u.phone, 4)) order by a.created_at desc, a.id desc)
               from (select * from public.admin_actions a0 where a0.kitchen_id = v_k.id order by a0.created_at desc, a0.id desc limit 30) a
               left join auth.users u on u.id = a.admin_id), '[]'::jsonb)
  );
end;
$$;

-- A member's (or any user's) full number, for a support call. Logged twice: audit_log (ACCESS)
-- and admin_actions.
create or replace function public.admin_reveal_member_phone(p_user uuid, p_kitchen uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
begin
  perform private.require_admin();
  select u.phone into v_phone from auth.users u where u.id = p_user;
  if nullif(v_phone, '') is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.audit_access(p_kitchen, 'auth.users', p_user::text, jsonb_build_object('reason', 'admin_reveal'));
  perform private.log_admin_action(p_kitchen, 'phone_revealed', p_user::text, null, null,
    jsonb_build_object('phone_last4', right(v_phone, 4)));
  return '+' || v_phone;
end;
$$;

-- ---------------------------------------------------------------------------
-- Phone change (lost or changed SIM). The Edge Function 'admin-change-phone' calls _check as the
-- admin, changes auth.users.phone through the Auth admin API (service role), then calls _done as
-- the admin. _done only logs a change that really happened (it reads auth.users), and signs the
-- user out everywhere (refresh tokens are deleted; an access token lives at most an hour).
-- ---------------------------------------------------------------------------
create or replace function public.admin_phone_change_check(p_user uuid, p_new_phone text, p_reason text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_new text := private.normalize_phone(p_new_phone);
  v_old text;
begin
  perform private.require_admin();
  perform private.require_reason(p_reason);
  if v_new is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  select u.phone into v_old from auth.users u where u.id = p_user;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_old = substr(v_new, 2) then
    raise exception 'same_phone' using errcode = '22023';
  end if;
  if exists (select 1 from auth.users u where u.phone = substr(v_new, 2) and u.id <> p_user) then
    raise exception 'phone_in_use' using errcode = '23505';
  end if;
  return jsonb_build_object('user_id', p_user, 'new_phone', v_new, 'old_phone_last4', right(v_old, 4),
    'kitchens', coalesce((select jsonb_agg(jsonb_build_object('kitchen_id', m.kitchen_id, 'role', m.role))
                          from public.members m where m.user_id = p_user), '[]'::jsonb));
end;
$$;

create or replace function public.admin_phone_change_done(p_user uuid, p_new_phone text, p_reason text,
                                                          p_old_last4 text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new text := private.normalize_phone(p_new_phone);
  v_reason text;
  v_revoked boolean := true;
  v_rows integer := 0;
  r record;
begin
  perform private.require_admin();
  v_reason := private.require_reason(p_reason);
  if v_new is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user and u.phone = substr(v_new, 2)) then
    raise exception 'phone_not_changed' using errcode = '22023';
  end if;
  begin
    delete from auth.sessions where user_id = p_user;
  exception when others then
    v_revoked := false;
  end;
  for r in select m.kitchen_id, m.role from public.members m where m.user_id = p_user loop
    perform private.log_admin_action(r.kitchen_id, 'member_phone_changed', p_user::text, v_reason,
      jsonb_build_object('phone_last4', nullif(left(regexp_replace(coalesce(p_old_last4, ''), '\D', '', 'g'), 4), '')),
      jsonb_build_object('phone_last4', right(v_new, 4), 'role', r.role, 'signed_out', v_revoked));
    v_rows := v_rows + 1;
  end loop;
  if v_rows = 0 then
    perform private.log_admin_action(null, 'member_phone_changed', p_user::text, v_reason,
      jsonb_build_object('phone_last4', nullif(left(regexp_replace(coalesce(p_old_last4, ''), '\D', '', 'g'), 4), '')),
      jsonb_build_object('phone_last4', right(v_new, 4), 'signed_out', v_revoked));
  end if;
  return jsonb_build_object('user_id', p_user, 'phone_last4', right(v_new, 4), 'signed_out', v_revoked);
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership transfer
-- ---------------------------------------------------------------------------
create or replace function public.admin_transfer_ownership(p_kitchen uuid, p_member uuid, p_old_owner text default 'staff',
                                                           p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_k public.kitchens;
  v_new public.members;
  v_old public.members;
begin
  perform private.require_admin();
  v_reason := private.require_reason(p_reason);
  if coalesce(p_old_owner, '') not in ('staff', 'remove') then
    raise exception 'invalid_option' using errcode = '22023';
  end if;
  select * into v_k from public.kitchens where id = p_kitchen for update;
  if v_k.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_new from public.members where id = p_member and kitchen_id = p_kitchen for update;
  if v_new.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_new.role = 'owner' then
    raise exception 'already_owner' using errcode = '22023';
  end if;
  select * into v_old from public.members where kitchen_id = p_kitchen and user_id = v_k.owner_id for update;

  update public.members set role = 'owner' where id = v_new.id;
  update public.kitchens set owner_id = v_new.user_id where id = p_kitchen;
  if v_old.id is not null then
    if p_old_owner = 'remove' then
      delete from public.members where id = v_old.id;
      -- A removed owner stops being the default rider of the kitchen's routes.
      update public.delivery_routes set rider_id = null where kitchen_id = p_kitchen and rider_id = v_old.user_id;
    else
      update public.members set role = 'staff' where id = v_old.id;
    end if;
  end if;
  -- Any other row still marked owner (should not exist) becomes staff: one owner per kitchen.
  update public.members set role = 'staff' where kitchen_id = p_kitchen and role = 'owner' and id <> v_new.id;

  perform private.log_admin_action(p_kitchen, 'ownership_transferred', v_new.user_id::text, v_reason,
    jsonb_build_object('owner_user_id', v_k.owner_id, 'new_owner_role', v_new.role),
    jsonb_build_object('owner_user_id', v_new.user_id, 'old_owner', p_old_owner));
  return jsonb_build_object('kitchen_id', p_kitchen, 'owner_user_id', v_new.user_id, 'old_owner', p_old_owner);
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform admins
-- ---------------------------------------------------------------------------
create or replace function public.admin_platform_admins()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', pa.user_id, 'name', private.user_display_name(pa.user_id),
                                        'phone', private.mask_phone(right(u.phone, 4)), 'since', pa.created_at,
                                        'last_sign_in_at', u.last_sign_in_at, 'is_me', pa.user_id = auth.uid())
                     order by pa.created_at)
    from public.platform_admins pa join auth.users u on u.id = pa.user_id), '[]'::jsonb);
end;
$$;

-- The person must have logged in once (an account with that phone).
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
  select u.id into v_user from auth.users u where u.phone = substr(v_phone, 2) limit 1;
  if v_user is null then
    raise exception 'no_account' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.platform_admins where user_id = v_user) then
    raise exception 'already_exists' using errcode = '23505';
  end if;
  insert into public.platform_admins (user_id, created_at) values (v_user, private.now());
  perform private.log_admin_action(null, 'platform_admin_added', v_user::text, v_reason, null,
    jsonb_build_object('phone_last4', right(v_phone, 4)));
  return v_user;
end;
$$;

create or replace function public.admin_remove_platform_admin(p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  perform private.require_admin();
  v_reason := private.require_reason(p_reason);
  -- Two removals at once must not leave zero admins.
  perform pg_advisory_xact_lock(hashtextextended('platform_admins', 0));
  if not exists (select 1 from public.platform_admins where user_id = p_user) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if (select count(*) from public.platform_admins) <= 1 then
    raise exception 'last_admin' using errcode = '22023';
  end if;
  delete from public.platform_admins where user_id = p_user;
  perform private.log_admin_action(null, 'platform_admin_removed', p_user::text, v_reason,
    jsonb_build_object('phone_last4', (select right(u.phone, 4) from auth.users u where u.id = p_user)), null);
end;
$$;

revoke execute on function private.user_display_name from public, anon, authenticated;
revoke execute on function public.admin_kitchen_detail, public.admin_reveal_member_phone, public.admin_phone_change_check,
  public.admin_phone_change_done, public.admin_transfer_ownership, public.admin_platform_admins,
  public.admin_add_platform_admin, public.admin_remove_platform_admin from public, anon;
grant execute on function public.admin_kitchen_detail, public.admin_reveal_member_phone, public.admin_phone_change_check,
  public.admin_phone_change_done, public.admin_transfer_ownership, public.admin_platform_admins,
  public.admin_add_platform_admin, public.admin_remove_platform_admin to authenticated;
