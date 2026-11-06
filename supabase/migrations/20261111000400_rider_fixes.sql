-- Vendor-first wave 3 (riders track): fixes from review.
--
-- 1. A kitchen's first rider takes over the routes and planned runs the owner held only because
--    there was no rider (private.member_joined_routes, trigger on members).
-- 2. assign_routes_by_area rebuilds locked slots through private.rebuild_locked_runs, which uses
--    wave 1's private.resync_runs (engine_errors recorded and resolved) when it exists.
-- 3. do_fail_stop: the owner check goes through private.has_role (managers once wave 2 lands);
--    a credit request alerts once per attempt; its payload carries customer_id (erasure).
-- 4. correct_stop: "try again" (back to pending) is for today's runs only (retry_today_only).
-- 5. Member alerts are owner alerts: my_notifications and push_claim_outbox stop serving them to a
--    member who is no longer an owner (or, after wave 2, a manager) of that kitchen.
-- 6. release_device(): a phone signed in by a member who gets no alerts (staff, rider) drops the
--    previous user's push token, so their alerts stop arriving on it.
-- 7. Erasure: the stop notes and member alerts this track added are scrubbed when a customer is
--    erased (trigger on customers.deleted_at; erase_customer itself is unchanged).

-- ===========================================================================
-- Roles that receive member alerts (WhatsApp, push, in-app list)
-- ===========================================================================
-- Text, not the enum: 'manager' is a role only after wave 2, and the check must not fail before.
create or replace function private.is_alert_role(p_role text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_role in ('owner', 'manager');
$$;

-- ===========================================================================
-- 1. First rider takes over
-- ===========================================================================
-- A kitchen's first rider (a new member, or a member made a rider) takes over what the owner held
-- only because there was no rider: routes whose rider is an owner or nobody, and planned runs from
-- today on. Runs already out stay with whoever is delivering. With a second rider nothing moves
-- (the owner assigns). Never fails the membership change.
create or replace function private.member_joined_routes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role <> 'rider' or (tg_op = 'UPDATE' and old.role = 'rider') then
    return null;
  end if;
  begin
    if (select count(*) from public.members m where m.kitchen_id = new.kitchen_id and m.role = 'rider') <> 1 then
      return null;
    end if;
    update public.delivery_routes r set rider_id = new.user_id
    where r.kitchen_id = new.kitchen_id
      and (r.rider_id is null
           or exists (select 1 from public.members m where m.kitchen_id = new.kitchen_id and m.user_id = r.rider_id
                      and m.role = 'owner'));
    update public.delivery_runs dr set rider_id = new.user_id
    where dr.kitchen_id = new.kitchen_id and dr.status = 'planned' and dr.service_date >= private.ist_today()
      and (dr.rider_id is null
           or exists (select 1 from public.members m where m.kitchen_id = new.kitchen_id and m.user_id = dr.rider_id
                      and m.role = 'owner'));
  exception when others then
    raise warning 'first rider % of kitchen %: routes not moved: %', new.user_id, new.kitchen_id, sqlerrm;
  end;
  return null;
end;
$$;

create trigger members_joined_routes after insert or update of role on public.members
  for each row execute function private.member_joined_routes();

-- ===========================================================================
-- 2. Rebuilding locked slots after routes change
-- ===========================================================================
-- Returns false when the rebuild failed. Where wave 1's private.resync_runs exists (it records and
-- resolves engine_errors, so the slot's engine health stays true) it is used; otherwise build_runs
-- directly. Looked up at run time, so this file needs no edit when the branches merge.
create or replace function private.rebuild_locked_runs(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean := true;
begin
  if to_regprocedure('private.resync_runs(uuid, date, public.meal_slot)') is not null then
    execute 'select private.resync_runs($1, $2, $3)' using p_kitchen, p_date, p_slot;
    if to_regclass('public.engine_errors') is not null then
      execute 'select not exists (select 1 from public.engine_errors e where e.kitchen_id = $1 and e.job = ''build_runs''
                                  and e.service_date = $2 and e.slot = $3 and e.resolved_at is null)'
        into v_ok using p_kitchen, p_date, p_slot;
    end if;
    return coalesce(v_ok, true);
  end if;
  perform private.build_runs(p_kitchen, p_date, p_slot);
  return true;
exception when others then
  raise warning 'rebuild runs % % % failed: %', p_kitchen, p_date, p_slot, sqlerrm;
  return false;
end;
$$;

-- Unchanged from 20261111000200_rider_tools.sql except the rebuild (private.rebuild_locked_runs).
create or replace function public.assign_routes_by_area(p_kitchen uuid, p_slot public.meal_slot, p_rules jsonb,
                                                        p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slots public.meal_slot[];
  v_slot public.meal_slot;
  v_rule jsonb;
  v_area text;
  v_route uuid;
  v_route_name text;
  v_rider uuid;
  v_created boolean;
  v_matched integer;
  v_moved integer;
  v_report jsonb := '[]'::jsonb;
  v_touched uuid[] := '{}';
  v_rebuilt integer := 0;
  v_failed integer := 0;
  v_date date;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) = 0 then
    raise exception 'invalid_rules' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rules) > 200 then
    raise exception 'too_many_rules' using errcode = '22023';
  end if;
  v_slots := case when p_slot is null then enum_range(null::public.meal_slot) else array[p_slot] end;

  -- Validate every rule before writing anything.
  for v_rule in select * from jsonb_array_elements(p_rules) loop
    if jsonb_typeof(v_rule) <> 'object' or nullif(trim(v_rule ->> 'area'), '') is null then
      raise exception 'invalid_rules' using errcode = '22023';
    end if;
    if nullif(trim(v_rule ->> 'route'), '') is null and nullif(v_rule ->> 'route_id', '') is null then
      raise exception 'invalid_rules' using errcode = '22023';
    end if;
    if nullif(v_rule ->> 'route_id', '') is not null and (
         (v_rule ->> 'route_id') !~ '^[0-9a-f-]{36}$'
         or not exists (select 1 from public.delivery_routes where id = (v_rule ->> 'route_id')::uuid
                        and kitchen_id = p_kitchen and slot = any (v_slots))) then
      raise exception 'invalid_route' using errcode = '22023';
    end if;
    if nullif(v_rule ->> 'rider_id', '') is not null and (
         (v_rule ->> 'rider_id') !~ '^[0-9a-f-]{36}$'
         or not exists (select 1 from public.members where kitchen_id = p_kitchen and user_id = (v_rule ->> 'rider_id')::uuid
                        and role in ('owner', 'rider'))) then
      raise exception 'invalid_rider' using errcode = '22023';
    end if;
    if length(trim(coalesce(v_rule ->> 'route', ''))) > 60 then
      raise exception 'invalid_rules' using errcode = '22023';
    end if;
  end loop;

  foreach v_slot in array v_slots loop
    for v_rule in select * from jsonb_array_elements(p_rules) loop
      v_area := lower(regexp_replace(trim(v_rule ->> 'area'), '\s+', ' ', 'g'));
      v_rider := nullif(v_rule ->> 'rider_id', '')::uuid;
      v_created := false;
      v_route := null;
      if nullif(v_rule ->> 'route_id', '') is not null then
        select id, name into v_route, v_route_name from public.delivery_routes
        where id = (v_rule ->> 'route_id')::uuid and slot = v_slot;
        continue when v_route is null;   -- a route id belongs to one slot only
      else
        v_route_name := left(regexp_replace(trim(v_rule ->> 'route'), '\s+', ' ', 'g'), 60);
        select id into v_route from public.delivery_routes
        where kitchen_id = p_kitchen and slot = v_slot and lower(name) = lower(v_route_name)
        order by active desc, created_at limit 1;
        if v_route is null then
          v_created := true;
          if not coalesce(p_dry_run, false) then
            v_route := private.ensure_route(p_kitchen, v_slot, v_route_name, v_rider);
          end if;
        end if;
      end if;

      select count(*), count(*) filter (where rs.route_id is distinct from v_route)
      into v_matched, v_moved
      from private.slot_addresses(p_kitchen, v_slot) sa
      left join public.route_stops rs on rs.kitchen_id = p_kitchen and rs.slot = v_slot and rs.address_id = sa.address_id
      where sa.area_key = v_area;

      if not coalesce(p_dry_run, false) then
        if v_rider is not null then
          update public.delivery_routes set rider_id = v_rider where id = v_route;
          update public.delivery_runs set rider_id = v_rider
          where route_id = v_route and status = 'planned' and service_date >= private.ist_today();
        end if;
        update public.delivery_routes set active = true where id = v_route and not active;
        insert into public.route_stops (kitchen_id, route_id, slot, address_id, seq)
        select p_kitchen, v_route, v_slot, sa.address_id, 1000000 + row_number() over (order by sa.address_id)
        from private.slot_addresses(p_kitchen, v_slot) sa
        where sa.area_key = v_area
        on conflict (kitchen_id, slot, address_id) do update
          set route_id = excluded.route_id, seq = excluded.seq, pinned = false, updated_at = now()
          where public.route_stops.route_id is distinct from excluded.route_id;
        v_touched := v_touched || v_route;
      end if;

      v_report := v_report || jsonb_build_object('slot', v_slot, 'area', trim(v_rule ->> 'area'), 'route_id', v_route,
        'route', v_route_name, 'created', v_created, 'addresses', v_matched, 'moved', v_moved);
    end loop;
  end loop;

  if not coalesce(p_dry_run, false) then
    -- Every route that received addresses gets a fresh order (an explicit bulk action: hand-placed
    -- pins on those routes are cleared). Routes that only lost addresses keep their order.
    perform private.optimize_route_order(r.id)
    from public.delivery_routes r
    where r.id = any (v_touched);
    -- Slots that are already locked: planned runs follow the new routes now. A failed rebuild
    -- keeps the new routes; the board's "Plan / refresh" (or the next lock) rebuilds.
    foreach v_slot in array v_slots loop
      for v_date in
        select cs.service_date from public.count_snapshots cs
        where cs.kitchen_id = p_kitchen and cs.slot = v_slot and cs.service_date >= private.ist_today()
      loop
        if private.rebuild_locked_runs(p_kitchen, v_date, v_slot) then
          v_rebuilt := v_rebuilt + 1;
        else
          v_failed := v_failed + 1;
        end if;
      end loop;
    end loop;
  end if;

  return jsonb_build_object('dry_run', coalesce(p_dry_run, false), 'rules', v_report, 'rebuilt_slots', v_rebuilt,
                            'rebuild_failed', v_failed);
end;
$$;

-- ===========================================================================
-- 3. Failing a stop
-- ===========================================================================
-- As in 20261111000200_rider_tools.sql, with three changes: the owner check uses private.has_role
-- for the caller; the alert's dedupe key is per attempt; the alert payload carries customer_id.
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
  v_owner boolean;
  v_entry uuid;
  v_credit_status text;
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
  -- fail_stop always passes auth.uid(); any other actor counts as a rider (the credit waits).
  -- private.has_role also accepts a manager once wave 2's role expansion lands.
  v_owner := p_actor is not distinct from auth.uid() and private.has_role(v_s.kitchen_id, '{owner}');

  if v_run.status = 'planned' then
    perform private.do_start_run(v_run.id, v_at, p_actor);
  end if;

  update public.delivery_stops
  set status = 'failed', failed_reason = p_reason, failed_note = nullif(trim(p_note), ''), kitchen_fault = v_fault,
      gps_lat = p_lat, gps_lng = p_lng, done_at = v_at,
      device_at = case when p_at is distinct from v_at then p_at end, synced_at = private.now(),
      offline = coalesce(p_offline, false), tiffins_returned = coalesce(p_tiffins_returned, 0),
      client_op_id = p_client_op, done_by = p_actor
  where id = p_stop;

  update public.meal_orders set status = 'failed' where stop_id = p_stop and status <> 'skipped';

  if v_fault and v_owner then
    v_entry := private.post_stop_credit(p_stop, p_actor, v_at);
    v_credit_status := 'approved';
  elsif v_fault then
    v_credit_status := 'pending';
  end if;
  update public.delivery_stops
  set credit_entry_id = v_entry, credit_status = v_credit_status,
      credit_decided_by = case when v_credit_status = 'approved' then p_actor end,
      credit_decided_at = case when v_credit_status = 'approved' then private.now() end
  where id = p_stop;

  if v_credit_status = 'pending' then
    perform private.notify_owners_push(v_s.kitchen_id, 'stop_credit_request',
      jsonb_build_object('stop_id', p_stop, 'customer_id', v_s.customer_id, 'reason', p_reason,
        'service_date', v_run.service_date, 'slot', v_run.slot,
        'meals', (select coalesce(sum(o.qty), 0) from public.meal_orders o where o.stop_id = p_stop and o.status <> 'skipped'),
        'customer_name', (select coalesce(ofc.name, cu.name) from public.customers cu
                          left join public.offices ofc on ofc.id = v_s.office_id where cu.id = v_s.customer_id),
        'rider_name', (select m.display_name from public.members m where m.kitchen_id = v_s.kitchen_id and m.user_id = p_actor)),
      -- One alert per attempt: after a "try again" correction the next request alerts again.
      'stop_credit_request:' || p_stop || ':' || coalesce(p_client_op::text, (extract(epoch from v_at) * 1000)::bigint::text));
  end if;

  if coalesce(p_tiffins_returned, 0) > 0 then
    insert into public.tiffin_ledger (kitchen_id, customer_id, stop_id, tiffins_returned, created_by, created_at)
    values (v_s.kitchen_id, v_s.customer_id, p_stop, p_tiffins_returned, p_actor, v_at)
    on conflict (stop_id) where stop_id is not null do nothing;
  end if;

  return private.stop_result(p_stop);
end;
$$;

-- ===========================================================================
-- 4. Correcting a stop: "try again" today only
-- ===========================================================================
create or replace function public.correct_stop(p_stop uuid, p_status public.stop_status, p_reason public.fail_reason default null,
                                               p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.delivery_stops;
  v_run public.delivery_runs;
  v_pay public.payments;
  v_old_fault boolean;
  v_new_fault boolean;
  v_entry uuid;
  v_credit_status text;
  v_note text := left(nullif(trim(p_note), ''), 300);
begin
  select * into v_s from public.delivery_stops where id = p_stop for update;
  if v_s.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_s.kitchen_id, '{owner}');
  select * into v_run from public.delivery_runs where id = v_s.run_id for update;
  if p_status is null then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if v_note is null then
    raise exception 'note_required' using errcode = '22023';
  end if;
  if v_s.status = 'pending' then
    raise exception 'not_recorded' using errcode = '22023';  -- use complete_stop / fail_stop
  end if;
  if v_run.service_date < private.ist_today() - 7 then
    raise exception 'too_old' using errcode = '22023';
  end if;
  if p_status = 'failed' and p_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  -- Riders see only today's runs, so a past stop sent back to pending could never be finished.
  if p_status = 'pending' and v_run.service_date <> private.ist_today() then
    raise exception 'retry_today_only' using errcode = '22023';
  end if;
  if p_status = v_s.status and (p_status <> 'failed' or p_reason = v_s.failed_reason) then
    return private.stop_result(p_stop) || jsonb_build_object('credit_status', v_s.credit_status, 'changed', false);
  end if;

  -- Cash collected at the door belongs to a delivery.
  if p_status <> 'delivered' and v_s.cash_payment_id is not null then
    select * into v_pay from public.payments where id = v_s.cash_payment_id for update;
    if v_pay.status = 'paid' then
      raise exception 'cash_confirmed' using errcode = '22023';
    elsif v_pay.status in ('pending', 'created', 'review') then
      update public.payments set status = 'cancelled', note = concat_ws(' · ', note, 'Delivery corrected: ' || v_note)
      where id = v_pay.id;
    end if;
  end if;

  v_old_fault := v_s.status = 'failed' and coalesce(v_s.kitchen_fault, false);
  v_new_fault := p_status = 'failed' and private.is_kitchen_fault(p_reason);
  if v_old_fault and not v_new_fault then
    perform private.reverse_stop_credit(p_stop, auth.uid(), v_note);
  end if;

  if p_status = 'pending' then
    update public.delivery_stops
    set status = 'pending', proof_type = null, otp_ok = null, done_at = null, device_at = null, failed_reason = null,
        failed_note = null, kitchen_fault = null, credit_entry_id = null, credit_status = null, credit_decided_by = null,
        credit_decided_at = null, credit_note = null, cash_payment_id = null, done_by = null
    where id = p_stop;
    update public.meal_orders set status = case when v_run.status = 'planned' then 'locked'::public.order_status else 'out' end
    where stop_id = p_stop and status in ('delivered', 'failed');
    if v_run.status = 'done' then
      update public.delivery_runs set status = 'out', finished_at = null where id = v_run.id;
    end if;
  elsif p_status = 'delivered' then
    update public.delivery_stops
    set status = 'delivered', proof_type = coalesce(proof_type, 'none'), done_at = coalesce(done_at, private.now()),
        failed_reason = null, failed_note = null, kitchen_fault = null, credit_entry_id = null, credit_status = null,
        credit_decided_by = null, credit_decided_at = null, credit_note = null, done_by = coalesce(done_by, auth.uid())
    where id = p_stop;
    update public.meal_orders set status = 'delivered' where stop_id = p_stop and status <> 'skipped';
  else
    update public.delivery_stops
    set status = 'failed', failed_reason = p_reason, failed_note = coalesce(nullif(trim(p_note), ''), failed_note),
        kitchen_fault = v_new_fault, cash_payment_id = null, done_at = coalesce(done_at, private.now()),
        done_by = coalesce(done_by, auth.uid())
    where id = p_stop;
    update public.meal_orders set status = 'failed' where stop_id = p_stop and status <> 'skipped';
    if v_new_fault then
      v_entry := private.post_stop_credit(p_stop, auth.uid(), private.now());
      v_credit_status := 'approved';
    end if;
    update public.delivery_stops
    set credit_entry_id = v_entry, credit_status = v_credit_status,
        credit_decided_by = case when v_new_fault then auth.uid() end,
        credit_decided_at = case when v_new_fault then private.now() end,
        credit_note = case when v_new_fault then v_note end
    where id = p_stop;
  end if;

  update public.delivery_stops set corrected_by = auth.uid(), corrected_at = private.now(), correction_note = v_note
  where id = p_stop;
  select * into v_s from public.delivery_stops where id = p_stop;
  return private.stop_result(p_stop) || jsonb_build_object('credit_status', v_s.credit_status, 'changed', true);
end;
$$;

-- ===========================================================================
-- 5. Member alerts reach owners only
-- ===========================================================================
create or replace function private.notify_owners_push(p_kitchen uuid, p_template text, p_payload jsonb, p_dedupe text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, send_after)
  select p_kitchen, 'push', 'member', m.user_id, p_template, coalesce(p_payload, '{}'::jsonb), p_dedupe || ':' || m.user_id, private.now()
  from public.members m where m.kitchen_id = p_kitchen and private.is_alert_role(m.role::text)
  on conflict (dedupe_key) do nothing;
$$;

create or replace function public.my_notifications(p_limit integer default 50, p_before timestamptz default null)
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
    select jsonb_agg(x.j order by x.created_at desc)
    from (
      select o.created_at,
             jsonb_build_object('id', o.id, 'kitchen_id', o.kitchen_id, 'template', o.template, 'created_at', o.created_at,
                                'channel', o.channel, 'status', o.status)
             || private.member_alert_text(o.template, o.payload, k.name) as j
      from public.notifications_outbox o
      left join public.kitchens k on k.id = o.kitchen_id
      where o.recipient_type = 'member' and o.recipient_id = auth.uid()
        and coalesce(o.dedupe_key, '') not like 'push:%'
        and o.created_at > now() - interval '30 days'
        and (p_before is null or o.created_at < p_before)
        -- Member alerts are owner alerts (money, customer names): a member who is no longer an
        -- owner of that kitchen stops seeing them.
        and (o.kitchen_id is null or exists (select 1 from public.members m where m.user_id = auth.uid()
                                             and m.kitchen_id = o.kitchen_id and private.is_alert_role(m.role::text)))
      order by o.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) x), '[]'::jsonb);
end;
$$;

create or replace function public.push_claim_outbox(p_limit integer default 50)
returns table (id uuid, kitchen_id uuid, recipient_id uuid, template text, title text, body text, data jsonb,
               tokens text[], attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.notifications_outbox o set status = 'cancelled', last_error = 'expired'
  where o.channel = 'push' and o.status = 'pending' and o.created_at < now() - interval '12 hours';

  return query
  with due as (
    select o.id from public.notifications_outbox o
    where o.channel = 'push'
      and ((o.status = 'pending' and o.send_after <= private.now())
           or (o.status = 'sending' and o.send_after < private.now() - interval '10 minutes'))
    order by o.send_after
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    for update skip locked
  ),
  claimed as (
    update public.notifications_outbox o set status = 'sending', attempts = o.attempts + 1, send_after = private.now()
    from due where o.id = due.id
    returning o.*
  )
  select c.id, c.kitchen_id, c.recipient_id, c.template, t.txt ->> 'title', t.txt ->> 'body',
         jsonb_build_object('outbox_id', c.id, 'template', c.template, 'kitchen_id', c.kitchen_id, 'path', t.txt ->> 'path'),
         case when c.kitchen_id is null
                   or exists (select 1 from public.members m where m.user_id = c.recipient_id and m.kitchen_id = c.kitchen_id
                              and private.is_alert_role(m.role::text))
              then coalesce((select array_agg(d.token order by d.last_seen_at desc) from public.member_devices d
                             where d.user_id = c.recipient_id and d.active), '{}')
              else '{}'::text[] end,
         c.attempts
  from claimed c
  left join public.kitchens k on k.id = c.kitchen_id
  cross join lateral (select private.member_alert_text(c.template, c.payload, k.name) as txt) t;
end;
$$;

-- ===========================================================================
-- 6. A phone changes hands
-- ===========================================================================
-- Called by the app when the member who signed in gets no alerts (staff, rider) and the phone still
-- holds a push token from an earlier sign-in: the token stops receiving anyone's alerts. Owners
-- call register_device instead, which moves the token to them.
create or replace function public.release_device(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$' then
    raise exception 'invalid_token' using errcode = '22023';
  end if;
  delete from public.member_devices where token = p_token;
end;
$$;

-- ===========================================================================
-- 7. Erasure: stop notes and member alerts that name the customer
-- ===========================================================================
-- Member alerts carry the customer's name for the owner (credit requests, inbox, new platform
-- customer, switch-out) and push twins copy them. They are found by customer, stop, conversation,
-- complaint or switch request, and the name is replaced.
create or replace function private.customer_erased_alerts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null or old.deleted_at is not null then
    return null;
  end if;
  update public.delivery_stops set correction_note = null, credit_note = null
  where customer_id = new.id and (correction_note is not null or credit_note is not null);
  update public.notifications_outbox o
  set payload = jsonb_set(o.payload, '{customer_name}', to_jsonb('Deleted customer'::text))
  where o.recipient_type = 'member' and o.kitchen_id = new.kitchen_id and o.payload ? 'customer_name'
    and (o.payload ->> 'customer_id' = new.id::text
         or o.payload ->> 'stop_id' in (select s.id::text from public.delivery_stops s where s.customer_id = new.id)
         or o.payload ->> 'conversation_id' in (select c.id::text from public.conversations c where c.customer_id = new.id)
         or o.payload ->> 'complaint_id' in (select c.id::text from public.complaints c where c.customer_id = new.id)
         or o.dedupe_key like 'new_platform_customer:' || new.id || ':%'
         or o.dedupe_key like 'push:new_platform_customer:' || new.id || ':%'
         or exists (select 1 from public.kitchen_switch_requests r where r.customer_id = new.id
                    and (o.dedupe_key like 'customer_switched_out:' || r.id || ':%'
                         or o.dedupe_key like 'push:customer_switched_out:' || r.id || ':%')));
  return null;
end;
$$;

create trigger customers_erased_alerts after update of deleted_at on public.customers
  for each row execute function private.customer_erased_alerts();

-- ===========================================================================
-- Grants (fail-closed)
-- ===========================================================================
revoke execute on function private.is_alert_role(text), private.member_joined_routes(),
  private.rebuild_locked_runs(uuid, date, public.meal_slot), private.customer_erased_alerts()
  from public, anon, authenticated;
revoke execute on function public.release_device(text) from public, anon, authenticated;
grant execute on function public.release_device(text) to authenticated;
