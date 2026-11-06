-- Vendor-first wave 3 (ops), item 31 (part 1): a smaller audit log that can forget a customer.
--
-- * Updates on personal-data tables store only the keys that changed (plus the identity keys that
--   say which row it was). Inserts and deletes still store the whole row. Every other table keeps
--   full before/after copies.
-- * Rider location pings (rider_ping moves delivery_runs.last_lat/last_lng/last_seen_at) and
--   updates that only touch updated_at are not audit events.
-- * Never copied: the delivery OTP and invite phone numbers join phone_enc/phone_hash/token_hash.
-- * audit_log stays append-only. The one exception is erasure: with the session flag
--   tiffin.audit_scrub = 'on' (set only by private.scrub_customer_audit), an update may replace
--   values with "[erased]" and nothing else; every other update or delete still raises.

create or replace function private.audit_redacted_columns()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['phone_enc', 'phone_hash', 'token_hash', 'contact_phone_enc', 'otp', 'phone_e164'];
$$;

-- Keys that identify a row; kept in diff-only audit rows.
create or replace function private.audit_identity_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['id', 'kitchen_id', 'customer_id', 'user_id', 'run_id', 'route_id', 'subscription_id', 'new_customer_id'];
$$;

-- Personal data per table (null: not a personal-data table). Used for diff-only updates and for
-- erasure. Keep in sync with docs/DECISIONS.md (vendor-first wave 3).
create or replace function private.audit_personal_keys(p_table text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_table
    when 'customers' then array['name', 'notes', 'phone_last4']
    when 'addresses' then array['label', 'line1', 'landmark', 'delivery_notes', 'lat', 'lng', 'geo_point']
    when 'customer_health' then array['tags']
    when 'complaints' then array['description', 'photo_url', 'resolution_note']
    when 'delivery_stops' then array['gps_lat', 'gps_lng', 'gps_accuracy_m', 'gps_distance_m', 'failed_note', 'photo_path']
    when 'delivery_runs' then array['last_lat', 'last_lng']
    when 'kitchen_reviews' then array['comment']
    when 'kitchen_switch_requests' then array['reason', 'decision_note']
    when 'leads' then array['name', 'phone_last4', 'address_text', 'lat', 'lng', 'geo_point', 'notes']
    when 'vendor_applications' then array['name', 'phone_last4', 'lat', 'lng', 'notes']
    when 'member_invites' then array['display_name']
    when 'members' then array['display_name']
    when 'offices' then array['contact_name', 'contact_phone_last4']
  end;
$$;

create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_ping text[] := array['last_lat', 'last_lng', 'last_seen_at', 'updated_at'];
  v_keep text[];
  v_before jsonb;
  v_after jsonb;
begin
  if tg_op = 'UPDATE' then
    if (v_old - 'updated_at') = (v_new - 'updated_at') then
      return new;
    end if;
    if tg_table_name = 'delivery_runs' and (v_old - v_ping) = (v_new - v_ping) then
      return new;  -- rider_ping: the live position is not an audit event
    end if;
  end if;

  v_before := v_old - private.audit_redacted_columns();
  v_after := v_new - private.audit_redacted_columns();

  if tg_op = 'UPDATE' and private.audit_personal_keys(tg_table_name) is not null then
    v_keep := private.audit_identity_keys();
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_before
    from jsonb_each(v_old - private.audit_redacted_columns()) e
    where e.key = any (v_keep) or e.value is distinct from (v_new -> e.key);
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_after
    from jsonb_each(v_new - private.audit_redacted_columns()) e
    where e.key = any (v_keep) or e.value is distinct from (v_old -> e.key);
  end if;

  insert into public.audit_log (kitchen_id, actor_id, actor_role, table_name, row_id, action, before, after)
  values (
    case when tg_table_name = 'kitchens' then (v_row ->> 'id')::uuid
         else (v_row ->> 'kitchen_id')::uuid end,
    auth.uid(),
    coalesce(auth.role(), current_user),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'kitchen_id', v_row ->> 'user_id'),
    tg_op,
    v_before,
    v_after
  );
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- Erasure-only scrubbing of audit rows
-- ---------------------------------------------------------------------------
-- Replaces the value of each listed key that is present and not null with "[erased]".
create or replace function private.audit_scrub(p_json jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_json is null or jsonb_typeof(p_json) <> 'object' or p_keys is null then p_json
    else p_json || coalesce((select jsonb_object_agg(e.key, '"[erased]"'::jsonb) from jsonb_each(p_json) e
                             where e.key = any (p_keys) and e.value <> 'null'::jsonb), '{}'::jsonb)
  end;
$$;

-- True when p_new is p_old with zero or more values replaced by "[erased]" (same keys, nothing else changed).
create or replace function private.audit_is_scrub_of(p_old jsonb, p_new jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_old is null or p_new is null then p_old is not distinct from p_new
    when jsonb_typeof(p_old) <> 'object' or jsonb_typeof(p_new) <> 'object' then p_old = p_new
    else (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_old) k)
           = (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_new) k)
         and not exists (select 1 from jsonb_each(p_old) e
                         where (p_new -> e.key) <> e.value and (p_new -> e.key) <> '"[erased]"'::jsonb)
  end;
$$;

create or replace function private.audit_log_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('tiffin.audit_scrub', true), '') = 'on'
     and new.id = old.id
     and new.kitchen_id is not distinct from old.kitchen_id
     and new.actor_id is not distinct from old.actor_id
     and new.actor_role is not distinct from old.actor_role
     and new.table_name = old.table_name
     and new.row_id is not distinct from old.row_id
     and new.action = old.action
     and new.created_at = old.created_at
     and private.audit_is_scrub_of(old.before, new.before)
     and private.audit_is_scrub_of(old.after, new.after) then
    return new;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end;
$$;

-- Deletes (and truncate) stay forbidden by private.forbid_mutation; updates go through the guard.
drop trigger audit_log_append_only on public.audit_log;
create trigger audit_log_append_only before delete on public.audit_log
  for each row execute function private.forbid_mutation();
create trigger audit_log_scrub_only before update on public.audit_log
  for each row execute function private.audit_log_guard();

-- One-time: values of the newly redacted keys already in the log (delivery OTPs, invite phones, office
-- contact ciphertext) are replaced with "[erased]" through the same scrub-only path.
do $$
begin
  perform set_config('tiffin.audit_scrub', 'on', true);
  update public.audit_log
  set before = private.audit_scrub(before, array['otp', 'phone_e164', 'contact_phone_enc']),
      after = private.audit_scrub(after, array['otp', 'phone_e164', 'contact_phone_enc'])
  where table_name in ('delivery_stops', 'member_invites', 'offices')
    and (before ?| array['otp', 'phone_e164', 'contact_phone_enc'] or after ?| array['otp', 'phone_e164', 'contact_phone_enc']);
  perform set_config('tiffin.audit_scrub', '', true);
end $$;

revoke execute on function private.audit_identity_keys, private.audit_personal_keys, private.audit_scrub,
  private.audit_is_scrub_of, private.audit_log_guard from public, anon, authenticated;
