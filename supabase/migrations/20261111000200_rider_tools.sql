-- Vendor-first wave 3 (riders track), audit item 25: default rider, routes by area, owner tools on
-- the live board.
--
-- 1. Default rider (private.default_rider): a kitchen's only rider; with no rider, the owner (small
--    kitchens where the owner delivers); with two or more riders, nobody (the owner assigns).
--    route_for_address uses it for new routes; a rider who leaves (or stops being a rider) is
--    taken off routes and planned runs, which fall back to the same rule.
-- 2. unassigned_runs(): today's runs without a rider, for owners ("Take this run" uses assign_run).
-- 3. Routes by area: area_routes() shows areas with their customers and routes;
--    assign_routes_by_area() moves every address of an area onto a route in one step (creating
--    the route if needed) and resyncs planned runs of locked slots.
-- 4. Import: a 'route' column places the customer's address on that route (trigger on
--    import_rows, so import_customers itself is unchanged).
-- 5. Kitchen-fault credits recorded by a rider wait for the owner (credit_status 'pending');
--    decide_stop_credit approves (posts the credit) or rejects. Owners' own failures credit at once.
-- 6. correct_stop(): the owner fixes a recorded outcome (mis-tap, second attempt, wrong reason);
--    credits follow (reversed with an 'adjust' row, never edited).
-- 7. Cash handover: cash_handover() per rider for the owner, confirm_rider_cash() in one step,
--    my_cash_handover() for the person holding the cash.

-- ===========================================================================
-- 1. Default rider
-- ===========================================================================
create or replace function private.default_rider(p_kitchen uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when count(*) filter (where m.role = 'rider') = 1 then (array_agg(m.user_id) filter (where m.role = 'rider'))[1]
    when count(*) filter (where m.role = 'rider') = 0 then (array_agg(m.user_id order by m.created_at) filter (where m.role = 'owner'))[1]
  end
  from public.members m where m.kitchen_id = p_kitchen;
$$;

-- Unchanged from M5 (delivery.sql) except the default rider of a new route.
create or replace function private.route_for_address(p_kitchen uuid, p_slot public.meal_slot, p_address uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.addresses;
  v_route uuid;
begin
  select * into v_a from public.addresses where id = p_address;
  if v_a.lat is not null then
    select rs.route_id into v_route
    from public.route_stops rs
    join public.delivery_routes r on r.id = rs.route_id and r.active
    join public.addresses a on a.id = rs.address_id
    where rs.kitchen_id = p_kitchen and rs.slot = p_slot and a.lat is not null and rs.address_id <> p_address
    order by private.km_between(a.lat, a.lng, v_a.lat, v_a.lng)
    limit 1;
  end if;
  if v_route is null then
    select id into v_route from public.delivery_routes
    where kitchen_id = p_kitchen and slot = p_slot and active
    order by created_at, name limit 1;
  end if;
  if v_route is null then
    -- "Route N" with the first free N (a paused "Route 1" may exist).
    insert into public.delivery_routes (kitchen_id, slot, name, rider_id)
    select p_kitchen, p_slot, 'Route ' || n, private.default_rider(p_kitchen)
    from generate_series(1, 1000) n
    where not exists (select 1 from public.delivery_routes
                      where kitchen_id = p_kitchen and slot = p_slot and name = 'Route ' || n)
    order by n limit 1
    returning id into v_route;
  end if;
  return v_route;
end;
$$;

-- A rider who leaves the kitchen (or becomes staff) no longer holds routes or planned runs.
create or replace function private.member_left_routes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_default uuid;
begin
  if tg_op = 'UPDATE' and (new.role in ('owner', 'rider') or old.role not in ('owner', 'rider')) then
    return null;
  end if;
  v_default := private.default_rider(old.kitchen_id);
  if v_default = old.user_id then
    v_default := null;
  end if;
  update public.delivery_routes set rider_id = v_default
  where kitchen_id = old.kitchen_id and rider_id = old.user_id;
  update public.delivery_runs set rider_id = v_default
  where kitchen_id = old.kitchen_id and rider_id = old.user_id and status = 'planned'
    and service_date >= private.ist_today();
  return null;
end;
$$;

create trigger members_left_routes after delete or update of role on public.members
  for each row execute function private.member_left_routes();

-- Kitchens that have no rider today: their routes without a rider go to the owner (new rule).
update public.delivery_routes r set rider_id = private.default_rider(r.kitchen_id)
where r.rider_id is null
  and not exists (select 1 from public.members m where m.kitchen_id = r.kitchen_id and m.role = 'rider');

-- ===========================================================================
-- 2. Unassigned runs (owners)
-- ===========================================================================
create or replace function public.unassigned_runs()
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
      'id', dr.id, 'kitchen_id', dr.kitchen_id, 'kitchen_name', k.name, 'route_id', dr.route_id, 'route_name', rt.name,
      'service_date', dr.service_date, 'slot', dr.slot, 'status', dr.status,
      'stops', (select count(*) from public.delivery_stops s where s.run_id = dr.id),
      'meals', (select coalesce(sum(s.meal_count), 0) from public.delivery_stops s where s.run_id = dr.id),
      'kitchen_has_riders', exists (select 1 from public.members m where m.kitchen_id = dr.kitchen_id and m.role = 'rider')
    ) order by dr.slot, k.name, rt.name)
    from public.delivery_runs dr
    join public.kitchens k on k.id = dr.kitchen_id
    join public.delivery_routes rt on rt.id = dr.route_id
    where dr.rider_id is null and dr.status <> 'done' and dr.service_date = private.ist_today()
      and private.has_role(dr.kitchen_id, '{owner}')
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 3. Routes by area
-- ===========================================================================

-- Addresses a slot delivers to: live subscriptions of that slot, upcoming orders (dated address
-- moves) and addresses already placed on a route of that slot.
create or replace function private.slot_addresses(p_kitchen uuid, p_slot public.meal_slot)
returns table (address_id uuid, area_key text, area text)
language sql
stable
security definer
set search_path = ''
as $$
  with ids as (
    select coalesce(s.address_id, (select a.id from public.addresses a where a.customer_id = s.customer_id and a.is_default)) as id
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
    join public.customers c on c.id = s.customer_id and c.deleted_at is null
    where s.kitchen_id = p_kitchen and s.status <> 'cancelled' and p_slot = any (p.slots)
    union
    select o.address_id from public.meal_orders o
    where o.kitchen_id = p_kitchen and o.slot = p_slot and o.service_date >= private.ist_today() and o.address_id is not null
    union
    select rs.address_id from public.route_stops rs where rs.kitchen_id = p_kitchen and rs.slot = p_slot
  )
  select a.id, lower(regexp_replace(trim(a.area), '\s+', ' ', 'g')), trim(a.area)
  from ids join public.addresses a on a.id = ids.id
  where ids.id is not null;
$$;

-- Areas of a slot with how many addresses each route holds; the routes and who can ride them.
create or replace function public.area_routes(p_kitchen uuid, p_slot public.meal_slot)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  return jsonb_build_object(
    'slot', p_slot,
    'areas', coalesce((
      select jsonb_agg(jsonb_build_object('area', x.area, 'key', x.area_key, 'addresses', x.n, 'routes', x.routes)
                       order by x.n desc, x.area)
      from (
        select sa.area_key, coalesce(min(sa.area), '') as area, count(distinct sa.address_id) as n,
               coalesce(jsonb_agg(distinct jsonb_build_object('route_id', r.id, 'name', r.name)) filter (where r.id is not null),
                        '[]'::jsonb) as routes
        from private.slot_addresses(p_kitchen, p_slot) sa
        left join public.route_stops rs on rs.kitchen_id = p_kitchen and rs.slot = p_slot and rs.address_id = sa.address_id
        left join public.delivery_routes r on r.id = rs.route_id
        group by sa.area_key
      ) x), '[]'::jsonb),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'rider_id', r.rider_id, 'active', r.active,
                                          'rider_name', (select m.display_name from public.members m
                                                         where m.kitchen_id = p_kitchen and m.user_id = r.rider_id),
                                          'stops', (select count(*) from public.route_stops rs where rs.route_id = r.id))
                       order by r.name)
      from public.delivery_routes r where r.kitchen_id = p_kitchen and r.slot = p_slot), '[]'::jsonb),
    'riders', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', m.display_name, 'role', m.role)
                       order by m.role desc, m.display_name)
      from public.members m where m.kitchen_id = p_kitchen and m.role in ('owner', 'rider')), '[]'::jsonb));
end;
$$;

-- An active route of the slot by name (case-insensitive), created when missing.
create or replace function private.ensure_route(p_kitchen uuid, p_slot public.meal_slot, p_name text, p_rider uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := left(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), 60);
  v_id uuid;
begin
  if v_name = '' then
    return null;
  end if;
  select id into v_id from public.delivery_routes
  where kitchen_id = p_kitchen and slot = p_slot and lower(name) = lower(v_name)
  order by active desc, created_at limit 1;
  if v_id is null then
    insert into public.delivery_routes (kitchen_id, slot, name, rider_id)
    values (p_kitchen, p_slot, v_name, coalesce(p_rider, private.default_rider(p_kitchen)))
    on conflict (kitchen_id, slot, name) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.delivery_routes where kitchen_id = p_kitchen and slot = p_slot and name = v_name;
    end if;
  else
    update public.delivery_routes set active = true where id = v_id and not active;
  end if;
  return v_id;
end;
$$;

-- p_rules: [{"area": "Patia", "route": "Patia" | "route_id": uuid, "rider_id": uuid (optional)}].
-- p_slot null = both slots. Dry run returns the same report without writing.
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
        begin
          perform private.build_runs(p_kitchen, v_date, v_slot);
          v_rebuilt := v_rebuilt + 1;
        exception when others then
          v_failed := v_failed + 1;
          raise warning 'assign_routes_by_area: build_runs % % % failed: %', p_kitchen, v_date, v_slot, sqlerrm;
        end;
      end loop;
    end loop;
  end if;

  return jsonb_build_object('dry_run', coalesce(p_dry_run, false), 'rules', v_report, 'rebuilt_slots', v_rebuilt,
                            'rebuild_failed', v_failed);
end;
$$;

-- ===========================================================================
-- 4. Import: Route column (import_rows.raw keeps every column except the phone)
-- ===========================================================================
create or replace function private.import_row_route()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := left(regexp_replace(trim(coalesce(new.raw ->> 'route', '')), '\s+', ' ', 'g'), 60);
  v_addr uuid;
  v_slot public.meal_slot;
  v_route uuid;
begin
  if new.status <> 'imported' or new.customer_id is null or v_name = '' then
    return null;
  end if;
  begin
    select id into v_addr from public.addresses where customer_id = new.customer_id and is_default;
    if v_addr is null then
      return null;
    end if;
    -- The slots of the customer's plan; without a plan, both (unused slots are harmless).
    for v_slot in
      select distinct sl from public.subscriptions s join public.plans p on p.id = s.plan_id, unnest(p.slots) sl
      where s.customer_id = new.customer_id
      union
      select sl from unnest(enum_range(null::public.meal_slot)) sl
      where not exists (select 1 from public.subscriptions s where s.customer_id = new.customer_id)
    loop
      v_route := private.ensure_route(new.kitchen_id, v_slot, v_name);
      insert into public.route_stops (kitchen_id, route_id, slot, address_id, seq)
      values (new.kitchen_id, v_route, v_slot, v_addr,
              (select coalesce(max(seq), 0) + 1 from public.route_stops where route_id = v_route))
      on conflict (kitchen_id, slot, address_id) do update
        set route_id = excluded.route_id, seq = excluded.seq, pinned = false, updated_at = now();
    end loop;
  exception when others then
    -- Never fail the import for a route: the address joins a route at the next lock instead.
    raise warning 'import route for row % failed: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

create trigger import_rows_route after insert on public.import_rows
  for each row when (new.status = 'imported' and nullif(trim(new.raw ->> 'route'), '') is not null)
  execute function private.import_row_route();

-- ===========================================================================
-- 5. Kitchen-fault credits: owner approval for riders' failures
-- ===========================================================================
alter table public.delivery_stops
  add column credit_status text check (credit_status in ('pending', 'approved', 'rejected')),
  add column credit_decided_by uuid references auth.users (id),
  add column credit_decided_at timestamptz,
  add column credit_note text check (length(credit_note) <= 300),
  add column corrected_by uuid references auth.users (id),
  add column corrected_at timestamptz,
  add column correction_note text check (length(correction_note) <= 300);
create index delivery_stops_credit_pending_idx on public.delivery_stops (kitchen_id) where credit_status = 'pending';

-- The credit chain of one reference: (credit, base_type, base_id); after a reversal
-- (adjust, 'stop_credit_reversal', credit id) the next credit is (credit, base_type || '_again',
-- reversal id). Returns the active credit (null if none) and the free reference for a new one.
create or replace function private.stop_credit_chain(p_base_type text, p_base_id uuid,
                                                     out active_entry uuid, out next_ref_type text, out next_ref_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_type text := p_base_type;
  v_ref uuid := p_base_id;
  v_credit uuid;
  v_rev uuid;
begin
  loop
    select id into v_credit from public.balance_entries where type = 'credit' and ref_type = v_type and ref_id = v_ref;
    if v_credit is null then
      active_entry := null; next_ref_type := v_type; next_ref_id := v_ref;
      return;
    end if;
    select id into v_rev from public.balance_entries
    where type = 'adjust' and ref_type = 'stop_credit_reversal' and ref_id = v_credit;
    if v_rev is null then
      active_entry := v_credit; next_ref_type := null; next_ref_id := null;
      return;
    end if;
    v_type := p_base_type || '_again';
    v_ref := v_rev;
  end loop;
end;
$$;

-- Gives a failed stop's charged meals back at the price charged (the M5/P6 rule; office stops
-- credit each member). Idempotent; returns the stop's (first) credit entry or null.
create or replace function private.post_stop_credit(p_stop uuid, p_actor uuid, p_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.delivery_stops;
  v_run public.delivery_runs;
  v_chain record;
  v_meals integer;
  v_amount integer;
  v_entry uuid;
  v_one uuid;
  r_o record;
begin
  select * into v_s from public.delivery_stops where id = p_stop;
  select * into v_run from public.delivery_runs where id = v_s.run_id;
  if v_s.office_id is null then
    select * into v_chain from private.stop_credit_chain('delivery_stop', p_stop);
    if v_chain.active_entry is not null then
      return v_chain.active_entry;
    end if;
    select coalesce(sum(o.qty), 0), coalesce(sum(o.qty * coalesce(o.price_per_meal_paise, 0)), 0)
    into v_meals, v_amount
    from public.meal_orders o where o.stop_id = p_stop and (o.status <> 'skipped' or o.charged)
      and exists (select 1 from public.balance_entries b where b.type = 'meal' and b.ref_type = 'meal_order' and b.ref_id = o.id);
    if v_meals > 0 then
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
      values (v_s.kitchen_id, v_s.customer_id, 'credit', v_meals, v_amount, v_chain.next_ref_type, v_chain.next_ref_id,
              'Missed delivery: ' || v_s.failed_reason, p_actor, coalesce(p_at, private.now()))
      on conflict (type, ref_type, ref_id) where ref_id is not null do nothing
      returning id into v_entry;
      if v_entry is not null then
        perform private.sync_balance_status(v_s.kitchen_id, v_s.customer_id);
        perform private.notify_customer(v_s.kitchen_id, v_s.customer_id, 'delivery_credit',
          jsonb_build_object('meals', v_meals, 'service_date', v_run.service_date, 'slot', v_run.slot),
          'delivery_credit:' || p_stop);
      end if;
    end if;
    return v_entry;
  end if;

  for r_o in
    select o.id, o.customer_id, o.qty, o.qty * coalesce(o.price_per_meal_paise, 0) as amount
    from public.meal_orders o where o.stop_id = p_stop and (o.status <> 'skipped' or o.charged)
      and exists (select 1 from public.balance_entries b where b.type = 'meal' and b.ref_type = 'meal_order' and b.ref_id = o.id)
  loop
    select * into v_chain from private.stop_credit_chain('delivery_stop_order', r_o.id);
    if v_chain.active_entry is not null then
      v_entry := coalesce(v_entry, v_chain.active_entry);
      continue;
    end if;
    v_one := null;
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
    values (v_s.kitchen_id, r_o.customer_id, 'credit', r_o.qty, r_o.amount, v_chain.next_ref_type, v_chain.next_ref_id,
            'Missed delivery: ' || v_s.failed_reason, p_actor, coalesce(p_at, private.now()))
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
  return v_entry;
end;
$$;

-- Takes back the stop's active credits with an 'adjust' row each (the ledger is append-only).
create or replace function private.reverse_stop_credit(p_stop uuid, p_actor uuid, p_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.delivery_stops;
  v_chain record;
  v_n integer := 0;
  v_e public.balance_entries;
  r_o record;
begin
  select * into v_s from public.delivery_stops where id = p_stop;
  for v_chain in
    select c.active_entry from private.stop_credit_chain('delivery_stop', p_stop) c where v_s.office_id is null
    union all
    select c.active_entry from public.meal_orders o, private.stop_credit_chain('delivery_stop_order', o.id) c
    where v_s.office_id is not null and o.stop_id = p_stop
  loop
    continue when v_chain.active_entry is null;
    select * into v_e from public.balance_entries where id = v_chain.active_entry;
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
    values (v_e.kitchen_id, v_e.customer_id, 'adjust', -v_e.meals, -v_e.amount_paise, 'stop_credit_reversal', v_e.id,
            left('Delivery corrected: ' || coalesce(p_note, ''), 300), p_actor, private.now())
    on conflict (type, ref_type, ref_id) where ref_id is not null do nothing;
    perform private.sync_balance_status(v_e.kitchen_id, v_e.customer_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- M5/P6 do_fail_stop with one change: a kitchen-fault reason recorded by anyone but an owner of
-- the kitchen waits for the owner (credit_status 'pending', owners alerted in the app); an owner's
-- own failure credits at once ('approved').
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
  v_owner := exists (select 1 from public.members m where m.kitchen_id = v_s.kitchen_id and m.user_id = p_actor and m.role = 'owner');

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
      jsonb_build_object('stop_id', p_stop, 'reason', p_reason, 'service_date', v_run.service_date, 'slot', v_run.slot,
        'meals', (select coalesce(sum(o.qty), 0) from public.meal_orders o where o.stop_id = p_stop and o.status <> 'skipped'),
        'customer_name', (select coalesce(ofc.name, cu.name) from public.customers cu
                          left join public.offices ofc on ofc.id = v_s.office_id where cu.id = v_s.customer_id),
        'rider_name', (select m.display_name from public.members m where m.kitchen_id = v_s.kitchen_id and m.user_id = p_actor)),
      'stop_credit_request:' || p_stop);
  end if;

  if coalesce(p_tiffins_returned, 0) > 0 then
    insert into public.tiffin_ledger (kitchen_id, customer_id, stop_id, tiffins_returned, created_by, created_at)
    values (v_s.kitchen_id, v_s.customer_id, p_stop, p_tiffins_returned, p_actor, v_at)
    on conflict (stop_id) where stop_id is not null do nothing;
  end if;

  return private.stop_result(p_stop);
end;
$$;

-- Owner approves (posts the credit) or rejects a rider's kitchen-fault credit.
create or replace function public.decide_stop_credit(p_stop uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.delivery_stops;
  v_entry uuid;
begin
  select * into v_s from public.delivery_stops where id = p_stop for update;
  if v_s.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_s.kitchen_id, '{owner}');
  if p_approve is null then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;
  if v_s.credit_status is distinct from 'pending' or v_s.status <> 'failed' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  if p_approve then
    v_entry := private.post_stop_credit(p_stop, auth.uid(), private.now());
  end if;
  update public.delivery_stops
  set credit_status = case when p_approve then 'approved' else 'rejected' end,
      credit_entry_id = coalesce(v_entry, credit_entry_id),
      credit_decided_by = auth.uid(), credit_decided_at = private.now(), credit_note = left(nullif(trim(p_note), ''), 300)
  where id = p_stop;
  return private.stop_result(p_stop) || jsonb_build_object('credit_status', case when p_approve then 'approved' else 'rejected' end);
end;
$$;

-- Credit requests of a kitchen (default: waiting ones; p_status null = every decision in p_days).
create or replace function public.stop_credit_requests(p_kitchen uuid, p_status text default 'pending', p_days integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'stop_id', s.id, 'run_id', s.run_id, 'service_date', dr.service_date, 'slot', dr.slot, 'route_name', rt.name,
      'customer_id', s.customer_id, 'customer_name', coalesce(ofc.name, cu.name), 'office', s.office_id is not null,
      'reason', s.failed_reason, 'note', s.failed_note, 'done_at', s.done_at,
      'rider_name', (select m.display_name from public.members m where m.kitchen_id = s.kitchen_id and m.user_id = s.done_by),
      'meals', (select coalesce(sum(o.qty), 0) from public.meal_orders o where o.stop_id = s.id and (o.status <> 'skipped' or o.charged)),
      'amount_paise', (select coalesce(sum(o.qty * coalesce(o.price_per_meal_paise, 0)), 0) from public.meal_orders o
                       where o.stop_id = s.id and (o.status <> 'skipped' or o.charged)),
      'credit_status', s.credit_status, 'credit_entry_id', s.credit_entry_id, 'credit_note', s.credit_note,
      'decided_at', s.credit_decided_at,
      'decided_by_name', (select m.display_name from public.members m where m.kitchen_id = s.kitchen_id and m.user_id = s.credit_decided_by)
    ) order by s.done_at desc)
    from public.delivery_stops s
    join public.delivery_runs dr on dr.id = s.run_id
    join public.delivery_routes rt on rt.id = dr.route_id
    join public.customers cu on cu.id = s.customer_id
    left join public.offices ofc on ofc.id = s.office_id
    where s.kitchen_id = p_kitchen and s.credit_status is not null
      and (p_status is null or s.credit_status = p_status)
      and (s.credit_status = 'pending' or s.done_at >= private.now() - make_interval(days => least(greatest(coalesce(p_days, 14), 1), 90)))
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 6. Owner corrects a recorded stop outcome
-- ===========================================================================
-- p_status 'pending' = try again (the run reopens if it was finished); 'delivered' = it did arrive
-- (no proof, marked by the owner); 'failed' with a reason. A note is required (kept on the stop and
-- in the audit log). Credits follow: leaving a kitchen-fault failure reverses its credit; entering
-- one posts it (the owner's decision counts as the approval). Cash already confirmed blocks a
-- change away from 'delivered' (reject or adjust the payment first); pending cash is rejected.
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
-- 7. Cash handover
-- ===========================================================================

-- Owner: cash collected by each person, waiting for confirmation, and what was settled lately.
create or replace function public.cash_handover(p_kitchen uuid, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := private.now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90));
begin
  perform private.require_role(p_kitchen, '{owner}');
  return jsonb_build_object(
    'since', v_since,
    'collectors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', x.collected_by,
        'name', coalesce((select m.display_name from public.members m where m.kitchen_id = p_kitchen and m.user_id = x.collected_by),
                         'Former member'),
        'role', (select m.role from public.members m where m.kitchen_id = p_kitchen and m.user_id = x.collected_by),
        'pending_count', x.pending_count, 'pending_paise', x.pending_paise,
        'confirmed_count', x.confirmed_count, 'confirmed_paise', x.confirmed_paise,
        'rejected_count', x.rejected_count, 'rejected_paise', x.rejected_paise,
        'pending', x.items
      ) order by x.pending_paise desc, x.collected_by)
      from (
        select p.collected_by,
               count(*) filter (where p.status = 'pending') as pending_count,
               coalesce(sum(p.amount_paise) filter (where p.status = 'pending'), 0) as pending_paise,
               count(*) filter (where p.status = 'paid' and p.confirmed_at >= v_since) as confirmed_count,
               coalesce(sum(p.amount_paise) filter (where p.status = 'paid' and p.confirmed_at >= v_since), 0) as confirmed_paise,
               count(*) filter (where p.status = 'cancelled' and p.updated_at >= v_since) as rejected_count,
               coalesce(sum(p.amount_paise) filter (where p.status = 'cancelled' and p.updated_at >= v_since), 0) as rejected_paise,
               coalesce(jsonb_agg(jsonb_build_object(
                 'payment_id', p.id, 'customer_id', p.customer_id, 'customer_name', cu.name, 'amount_paise', p.amount_paise,
                 'meals', p.meals, 'collected_at', p.created_at, 'note', p.note,
                 'service_date', (select o.service_date from public.meal_orders o where o.id = p.meal_order_id),
                 'slot', (select o.slot from public.meal_orders o where o.id = p.meal_order_id)
               ) order by p.created_at) filter (where p.status = 'pending'), '[]'::jsonb) as items
        from public.payments p
        join public.customers cu on cu.id = p.customer_id
        where p.kitchen_id = p_kitchen and p.method = 'cash' and p.collected_by is not null
          and (p.status = 'pending' or (p.status = 'paid' and p.confirmed_at >= v_since)
               or (p.status = 'cancelled' and p.updated_at >= v_since))
        group by p.collected_by
      ) x), '[]'::jsonb));
end;
$$;

-- Owner confirms a person's handed-over cash in one step (all pending, or the listed payments).
-- Each payment goes through confirm_payment, so the money rules stay in one place.
create or replace function public.confirm_rider_cash(p_kitchen uuid, p_rider uuid, p_payment_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n integer := 0;
  v_paise bigint := 0;
begin
  perform private.require_role(p_kitchen, '{owner}');
  if p_rider is null then
    raise exception 'invalid_rider' using errcode = '22023';
  end if;
  for v_id in
    select p.id from public.payments p
    where p.kitchen_id = p_kitchen and p.collected_by = p_rider and p.method = 'cash' and p.status = 'pending'
      and (p_payment_ids is null or p.id = any (p_payment_ids))
    order by p.created_at
  loop
    perform public.confirm_payment(v_id, null);
    v_n := v_n + 1;
    v_paise := v_paise + (select amount_paise from public.payments where id = v_id);
  end loop;
  return jsonb_build_object('confirmed', v_n, 'paise', v_paise);
end;
$$;

-- The caller's own collected cash, per kitchen: what to hand over and what was settled lately.
create or replace function public.my_cash_handover()
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
    select jsonb_agg(x.j order by x.kitchen_name)
    from (
      select k.name as kitchen_name, jsonb_build_object(
        'kitchen_id', k.id, 'kitchen_name', k.name,
        'pending_count', count(*) filter (where p.status = 'pending'),
        'pending_paise', coalesce(sum(p.amount_paise) filter (where p.status = 'pending'), 0),
        'confirmed_paise', coalesce(sum(p.amount_paise) filter (where p.status = 'paid'), 0),
        'rejected_paise', coalesce(sum(p.amount_paise) filter (where p.status = 'cancelled'), 0),
        'pending', coalesce(jsonb_agg(jsonb_build_object('payment_id', p.id, 'customer_name', cu.name,
                                                         'amount_paise', p.amount_paise, 'collected_at', p.created_at)
                                      order by p.created_at) filter (where p.status = 'pending'), '[]'::jsonb)
      ) as j
      from public.payments p
      join public.kitchens k on k.id = p.kitchen_id
      join public.customers cu on cu.id = p.customer_id
      where p.collected_by = auth.uid() and p.method = 'cash'
        and p.kitchen_id = any (private.kitchen_ids())
        and (p.status = 'pending' or p.updated_at >= private.now() - interval '7 days')
      group by k.id, k.name
    ) x
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- Grants (fail-closed)
-- ===========================================================================
grant select (credit_status, credit_decided_at, credit_note, corrected_at, correction_note)
  on public.delivery_stops to authenticated;

revoke execute on function private.default_rider(uuid), private.member_left_routes(),
  private.slot_addresses(uuid, public.meal_slot), private.ensure_route(uuid, public.meal_slot, text, uuid),
  private.import_row_route(), private.stop_credit_chain(text, uuid), private.post_stop_credit(uuid, uuid, timestamptz),
  private.reverse_stop_credit(uuid, uuid, text)
  from public, anon, authenticated;

revoke execute on function public.unassigned_runs, public.area_routes, public.assign_routes_by_area,
  public.decide_stop_credit, public.stop_credit_requests, public.correct_stop, public.cash_handover,
  public.confirm_rider_cash, public.my_cash_handover
  from public, anon;
grant execute on function public.unassigned_runs, public.area_routes, public.assign_routes_by_area,
  public.decide_stop_credit, public.stop_credit_requests, public.correct_stop, public.cash_handover,
  public.confirm_rider_cash, public.my_cash_handover
  to authenticated;
