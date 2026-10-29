-- M5: rider mode.
-- Saved routes (one ordered list of addresses per route and slot), daily runs and stops built at
-- lock, proof of delivery (OTP or photo + GPS + time), failed deliveries (kitchen-fault failures
-- post a credit), offline sync that keeps the device timestamp, tiffin tracking, the vendor live
-- board and monthly rider stats.
--
-- Route order: a built-in nearest-neighbour + 2-opt heuristic always works; the route-optimize
-- Edge Function uses VROOM when VROOM_URL is set and saves through save_route_order (D-067).

create type public.run_status as enum ('planned', 'out', 'done');
create type public.stop_status as enum ('pending', 'delivered', 'failed');
create type public.proof_type as enum ('otp', 'photo', 'none');
create type public.fail_reason as enum (
  'not_home', 'wrong_address', 'refused', 'unreachable',          -- customer side
  'kitchen_late', 'food_issue', 'missing_meal', 'rider_issue',    -- kitchen side: credit
  'other'
);

-- Failures the kitchen is responsible for (its own riders included) credit the meals back.
create or replace function private.is_kitchen_fault(p_reason public.fail_reason)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_reason in ('kitchen_late', 'food_issue', 'missing_meal', 'rider_issue');
$$;

-- Great-circle distance in km.
create or replace function private.km_between(lat1 double precision, lng1 double precision,
                                              lat2 double precision, lng2 double precision)
returns double precision
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 2 * 6371.0088 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))));
$$;

-- Road distance is longer than straight-line distance; used for planned km.
create or replace function private.road_factor()
returns numeric
language sql
immutable
set search_path = ''
as $$
  select 1.3::numeric;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.delivery_routes (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  slot public.meal_slot not null,
  name text not null check (length(trim(name)) between 1 and 60),
  rider_id uuid references auth.users (id),   -- default rider; a run can be reassigned for one day
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id),
  unique (id, kitchen_id, slot),
  unique (kitchen_id, slot, name)
);

-- The saved order: one row per address per slot. Drag reorders and moves write here, so the
-- next day's run comes out the same.
create table public.route_stops (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  route_id uuid not null,
  slot public.meal_slot not null,
  address_id uuid not null,
  seq integer not null,
  pinned boolean not null default false,      -- placed by hand
  updated_at timestamptz not null default now(),
  unique (kitchen_id, slot, address_id),
  foreign key (route_id, kitchen_id, slot) references public.delivery_routes (id, kitchen_id, slot) on delete cascade,
  foreign key (address_id, kitchen_id) references public.addresses (id, kitchen_id) on delete cascade
);
create index route_stops_route_idx on public.route_stops (route_id, seq);

create table public.delivery_runs (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  route_id uuid not null,
  service_date date not null,
  slot public.meal_slot not null,
  rider_id uuid references auth.users (id),
  status public.run_status not null default 'planned',
  planned_km numeric(7, 2),
  started_at timestamptz,
  finished_at timestamptz,
  last_lat double precision,
  last_lng double precision,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id),
  unique (route_id, service_date),
  foreign key (route_id, kitchen_id, slot) references public.delivery_routes (id, kitchen_id, slot)
);
create index delivery_runs_day_idx on public.delivery_runs (kitchen_id, service_date, slot);
create index delivery_runs_rider_idx on public.delivery_runs (rider_id, service_date);

create table public.delivery_stops (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  run_id uuid not null,
  customer_id uuid not null,
  address_id uuid,
  seq integer not null,
  meal_count smallint not null check (meal_count >= 0),
  status public.stop_status not null default 'pending',
  proof_type public.proof_type,
  otp text,                                   -- delivery code sent to the customer; not readable via the API
  otp_attempts smallint not null default 0,
  otp_ok boolean,
  photo_path text,                            -- storage: proofs/<kitchen_id>/...
  gps_lat double precision,
  gps_lng double precision,
  gps_accuracy_m real,
  gps_distance_m integer,                     -- distance from the saved pin, for review
  done_at timestamptz,                        -- when the rider marked it (device time, kept when synced later)
  device_at timestamptz,                      -- raw device time if it had to be clamped
  synced_at timestamptz,                      -- when the server received it
  offline boolean not null default false,
  failed_reason public.fail_reason,
  failed_note text,
  kitchen_fault boolean,
  credit_entry_id uuid,
  tiffins_out smallint not null default 0 check (tiffins_out between 0 and 20),
  tiffins_returned smallint not null default 0 check (tiffins_returned between 0 and 20),
  cash_payment_id uuid,
  client_op_id uuid unique,                   -- idempotency key from the device (offline queue)
  done_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id),
  unique nulls not distinct (run_id, customer_id, address_id),
  check (status <> 'failed' or failed_reason is not null),
  check (status <> 'delivered' or proof_type is not null),
  foreign key (run_id, kitchen_id) references public.delivery_runs (id, kitchen_id) on delete cascade,
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (address_id, kitchen_id) references public.addresses (id, kitchen_id)
);
create index delivery_stops_run_idx on public.delivery_stops (run_id, seq);
create index delivery_stops_customer_idx on public.delivery_stops (customer_id);

-- Tiffin boxes: append-only. Outstanding = sum(tiffins_out - tiffins_returned) per customer.
create table public.tiffin_ledger (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  customer_id uuid not null,
  stop_id uuid,
  tiffins_out smallint not null default 0 check (tiffins_out >= 0),
  tiffins_returned smallint not null default 0 check (tiffins_returned >= 0),
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (tiffins_out > 0 or tiffins_returned > 0),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (stop_id, kitchen_id) references public.delivery_stops (id, kitchen_id)
);
create index tiffin_ledger_customer_idx on public.tiffin_ledger (kitchen_id, customer_id);
create unique index tiffin_ledger_stop_idx on public.tiffin_ledger (stop_id) where stop_id is not null;

alter table public.meal_orders add column stop_id uuid;
alter table public.meal_orders
  add constraint meal_orders_stop_fk foreign key (stop_id, kitchen_id)
    references public.delivery_stops (id, kitchen_id) on delete set null (stop_id),
  add constraint meal_orders_run_fk foreign key (run_id, kitchen_id)
    references public.delivery_runs (id, kitchen_id) on delete set null (run_id);
create index meal_orders_stop_idx on public.meal_orders (stop_id);

create trigger delivery_routes_updated_at before update on public.delivery_routes
  for each row execute function private.set_updated_at();
create trigger delivery_runs_updated_at before update on public.delivery_runs
  for each row execute function private.set_updated_at();
create trigger delivery_stops_updated_at before update on public.delivery_stops
  for each row execute function private.set_updated_at();

create trigger tiffin_ledger_append_only before update or delete on public.tiffin_ledger
  for each row execute function private.forbid_mutation();

create trigger delivery_routes_audit after insert or update or delete on public.delivery_routes
  for each row execute function private.audit_row();
create trigger delivery_runs_audit after insert or update or delete on public.delivery_runs
  for each row execute function private.audit_row();
create trigger delivery_stops_audit after insert or update or delete on public.delivery_stops
  for each row execute function private.audit_row();
create trigger tiffin_ledger_audit after insert on public.tiffin_ledger
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- Route ordering
-- ---------------------------------------------------------------------------

-- Open path from a start point through every point: nearest neighbour, then 2-opt until no
-- improving move is left. Returns 1-based indexes in visit order. Fine for a few hundred stops.
create or replace function private.tsp_order(p_lat double precision[], p_lng double precision[],
                                             p_start_lat double precision, p_start_lng double precision)
returns integer[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  n integer := coalesce(array_length(p_lat, 1), 0);
  m integer;
  d double precision[];        -- (n+1)^2 distance matrix; node 0 is the start
  lat double precision[];
  lng double precision[];
  path integer[];              -- path[1] = 0 (start), then nodes
  used boolean[];
  cur integer;
  best integer;
  best_d double precision;
  i integer;
  j integer;
  a integer; b integer; c integer; e integer;
  delta double precision;
  improved boolean := true;
  passes integer := 0;
  seg integer[];
begin
  if n = 0 then
    return '{}';
  elsif n = 1 then
    return '{1}';
  end if;
  m := n + 1;
  lat := array_prepend(p_start_lat, p_lat);
  lng := array_prepend(p_start_lng, p_lng);
  d := array_fill(0::double precision, array[m * m]);
  for i in 0..n loop
    for j in i + 1..n loop
      delta := private.km_between(lat[i + 1], lng[i + 1], lat[j + 1], lng[j + 1]);
      d[i * m + j + 1] := delta;
      d[j * m + i + 1] := delta;
    end loop;
  end loop;

  -- Nearest neighbour.
  used := array_fill(false, array[m]);
  used[1] := true;
  path := array[0];
  cur := 0;
  for i in 1..n loop
    best := null;
    best_d := null;
    for j in 1..n loop
      if not used[j + 1] and (best_d is null or d[cur * m + j + 1] < best_d) then
        best := j;
        best_d := d[cur * m + j + 1];
      end if;
    end loop;
    used[best + 1] := true;
    path := path || best;
    cur := best;
  end loop;

  -- 2-opt on the open path (the start is fixed, the end is free). path is 1-based, length m.
  while improved and passes < 100 loop
    improved := false;
    passes := passes + 1;
    for i in 2..m - 1 loop
      for j in i + 1..m loop
        a := path[i - 1]; b := path[i]; c := path[j];
        if j < m then
          e := path[j + 1];
          delta := d[a * m + c + 1] + d[b * m + e + 1] - d[a * m + b + 1] - d[c * m + e + 1];
        else
          delta := d[a * m + c + 1] - d[a * m + b + 1];
        end if;
        if delta < -1e-9 then
          select array_agg(path[k] order by k desc) into seg from generate_series(i, j) k;
          path := path[1:i - 1] || seg || path[j + 1:m];
          improved := true;
        end if;
      end loop;
    end loop;
  end loop;

  return path[2:m];
end;
$$;

-- Planned km for a path from the kitchen through the given points (road factor applied).
create or replace function private.path_km(p_lat double precision[], p_lng double precision[],
                                           p_start_lat double precision, p_start_lng double precision)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_km double precision := 0;
  v_lat double precision := p_start_lat;
  v_lng double precision := p_start_lng;
  i integer;
begin
  if p_start_lat is null or coalesce(array_length(p_lat, 1), 0) = 0 then
    return 0;
  end if;
  for i in 1..array_length(p_lat, 1) loop
    continue when p_lat[i] is null;
    v_km := v_km + private.km_between(v_lat, v_lng, p_lat[i], p_lng[i]);
    v_lat := p_lat[i];
    v_lng := p_lng[i];
  end loop;
  return round((v_km * private.road_factor())::numeric, 2);
end;
$$;

-- Rewrite a route's saved order from scratch with the built-in optimiser. Addresses without a pin
-- keep their relative order at the end. Pinned (hand-placed) flags are cleared: this is an explicit
-- "optimise" action.
create or replace function private.optimize_route_order(p_route uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_k public.kitchens;
  v_ids uuid[];
  v_lat double precision[];
  v_lng double precision[];
  v_order integer[];
  v_rest uuid[];
  i integer;
begin
  select k.* into v_k from public.kitchens k join public.delivery_routes r on r.kitchen_id = k.id where r.id = p_route;
  select array_agg(rs.address_id order by rs.seq), array_agg(a.lat order by rs.seq), array_agg(a.lng order by rs.seq)
  into v_ids, v_lat, v_lng
  from public.route_stops rs join public.addresses a on a.id = rs.address_id
  where rs.route_id = p_route and a.lat is not null and a.lng is not null;

  select array_agg(rs.address_id order by rs.seq) into v_rest
  from public.route_stops rs join public.addresses a on a.id = rs.address_id
  where rs.route_id = p_route and (a.lat is null or a.lng is null);

  if v_ids is not null then
    v_order := private.tsp_order(v_lat, v_lng, coalesce(v_k.lat, v_lat[1]), coalesce(v_k.lng, v_lng[1]));
    for i in 1..array_length(v_order, 1) loop
      update public.route_stops set seq = i, pinned = false, updated_at = now()
      where route_id = p_route and address_id = v_ids[v_order[i]];
    end loop;
  end if;
  if v_rest is not null then
    for i in 1..array_length(v_rest, 1) loop
      update public.route_stops set seq = coalesce(array_length(v_ids, 1), 0) + i, pinned = false, updated_at = now()
      where route_id = p_route and address_id = v_rest[i];
    end loop;
  end if;
end;
$$;

-- Put a new address into the saved order of a route at the cheapest position (least added
-- distance). Without a pin it goes to the end.
create or replace function private.insert_route_stop(p_route uuid, p_address uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.delivery_routes;
  v_k public.kitchens;
  v_a public.addresses;
  v_best_pos integer;
  v_best double precision;
  v_cost double precision;
  v_prev_lat double precision;
  v_prev_lng double precision;
  v_max integer;
  r record;
begin
  select * into v_r from public.delivery_routes where id = p_route;
  select * into v_k from public.kitchens where id = v_r.kitchen_id;
  select * into v_a from public.addresses where id = p_address;
  select coalesce(max(seq), 0) into v_max from public.route_stops where route_id = p_route;
  v_best_pos := v_max + 1;

  if v_a.lat is not null and v_a.lng is not null then
    v_prev_lat := v_k.lat;
    v_prev_lng := v_k.lng;
    v_best := null;
    for r in
      select rs.seq, a.lat, a.lng
      from public.route_stops rs join public.addresses a on a.id = rs.address_id
      where rs.route_id = p_route and a.lat is not null and a.lng is not null
      order by rs.seq
    loop
      if v_prev_lat is not null then
        v_cost := private.km_between(v_prev_lat, v_prev_lng, v_a.lat, v_a.lng)
                + private.km_between(v_a.lat, v_a.lng, r.lat, r.lng)
                - private.km_between(v_prev_lat, v_prev_lng, r.lat, r.lng);
      else
        v_cost := private.km_between(v_a.lat, v_a.lng, r.lat, r.lng);
      end if;
      if v_best is null or v_cost < v_best then
        v_best := v_cost;
        v_best_pos := r.seq;
      end if;
      v_prev_lat := r.lat;
      v_prev_lng := r.lng;
    end loop;
    -- Appending after the last pinned point.
    if v_prev_lat is not null and (v_best is null or private.km_between(v_prev_lat, v_prev_lng, v_a.lat, v_a.lng) < v_best) then
      select coalesce(max(rs.seq), 0) + 1 into v_best_pos
      from public.route_stops rs join public.addresses a on a.id = rs.address_id
      where rs.route_id = p_route and a.lat is not null;
    end if;
  end if;

  update public.route_stops set seq = seq + 1 where route_id = p_route and seq >= v_best_pos;
  insert into public.route_stops (kitchen_id, route_id, slot, address_id, seq)
  values (v_r.kitchen_id, p_route, v_r.slot, p_address, v_best_pos)
  on conflict (kitchen_id, slot, address_id) do update
    set route_id = excluded.route_id, seq = excluded.seq, pinned = false, updated_at = now();
end;
$$;

-- The active route an unplaced address should join: the route with the nearest saved point;
-- else the first route. Creates "Route 1" when the kitchen has none for this slot.
create or replace function private.route_for_address(p_kitchen uuid, p_slot public.meal_slot, p_address uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.addresses;
  v_route uuid;
  v_rider uuid;
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
    -- Default rider: the kitchen's only rider, if it has exactly one.
    select case when count(*) = 1 then (array_agg(user_id))[1] end into v_rider
    from public.members where kitchen_id = p_kitchen and role = 'rider';
    -- "Route N" with the first free N (a paused "Route 1" may exist).
    insert into public.delivery_routes (kitchen_id, slot, name, rider_id)
    select p_kitchen, p_slot, 'Route ' || n, v_rider
    from generate_series(1, 1000) n
    where not exists (select 1 from public.delivery_routes
                      where kitchen_id = p_kitchen and slot = p_slot and name = 'Route ' || n)
    order by n limit 1
    returning id into v_route;
  end if;
  return v_route;
end;
$$;

-- ---------------------------------------------------------------------------
-- Building runs
-- ---------------------------------------------------------------------------

-- Group the slot's deliverable orders into one run per route, ordered by the saved route order.
-- Idempotent: re-running syncs planned runs with the current orders (new orders join at their
-- saved or cheapest position, skipped ones leave) and never touches runs already out or done.
-- Skipped meals are not delivered, even when charged (late skip): the customer said no.
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
begin
  perform pg_advisory_xact_lock(hashtextextended('runs:' || p_kitchen || ':' || p_date || ':' || p_slot, 0));
  select * into v_k from public.kitchens where id = p_kitchen;

  -- 1. Every deliverable address needs a place in an active route.
  for r in
    select distinct o.address_id
    from public.meal_orders o
    left join public.route_stops rs on rs.kitchen_id = o.kitchen_id and rs.slot = o.slot and rs.address_id = o.address_id
    left join public.delivery_routes dr on dr.id = rs.route_id
    where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
      and o.status <> 'skipped' and o.address_id is not null
      and (rs.id is null or not dr.active)
  loop
    perform private.insert_route_stop(private.route_for_address(p_kitchen, p_slot, r.address_id), r.address_id);
  end loop;

  -- Orders without an address go to the first active route (at the end).
  if exists (select 1 from public.meal_orders o
             where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
               and o.status <> 'skipped' and o.address_id is null) then
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
  for r in
    with ord as (
      select o.id, o.customer_id, o.address_id, o.qty,
             coalesce(rs.route_id, (select id from public.delivery_routes
                                    where kitchen_id = p_kitchen and slot = p_slot and active
                                    order by created_at, name limit 1)) as route_id,
             coalesce(rs.seq, 1000000) as route_seq
      from public.meal_orders o
      left join public.route_stops rs on rs.kitchen_id = o.kitchen_id and rs.slot = o.slot and rs.address_id = o.address_id
      where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot and o.status <> 'skipped'
    )
    select route_id from ord group by route_id
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
    if to_regclass('pg_temp.want_stops') is null then
      create temporary table want_stops (
        customer_id uuid, address_id uuid, meal_count integer, route_seq integer, sort_name text, order_ids uuid[]
      ) on commit drop;
    end if;
    truncate pg_temp.want_stops;
    insert into pg_temp.want_stops
    select o.customer_id, o.address_id, sum(o.qty), min(coalesce(rs.seq, 1000000)), min(cu.name), array_agg(o.id)
    from public.meal_orders o
    join public.customers cu on cu.id = o.customer_id
    join public.delivery_runs dr on dr.id = v_run
    left join public.route_stops rs on rs.kitchen_id = o.kitchen_id and rs.slot = o.slot and rs.address_id = o.address_id
    where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot and o.status <> 'skipped'
      and coalesce(rs.route_id, (select id from public.delivery_routes
                                 where kitchen_id = p_kitchen and slot = p_slot and active
                                 order by created_at, name limit 1)) = dr.route_id
    group by o.customer_id, o.address_id;

    -- Orders in this run that are no longer wanted leave it.
    update public.meal_orders o set run_id = null, stop_id = null, stop_seq = null
    where o.run_id = v_run
      and not exists (select 1 from pg_temp.want_stops w where o.id = any (w.order_ids));
    delete from public.delivery_stops s
    where s.run_id = v_run and s.status = 'pending'
      and not exists (select 1 from pg_temp.want_stops w
                      where w.customer_id = s.customer_id and w.address_id is not distinct from s.address_id);

    insert into public.delivery_stops (kitchen_id, run_id, customer_id, address_id, seq, meal_count)
    select p_kitchen, v_run, w.customer_id, w.address_id,
           row_number() over (order by w.route_seq, w.sort_name), w.meal_count
    from pg_temp.want_stops w
    on conflict (run_id, customer_id, address_id) do update set meal_count = excluded.meal_count;

    -- Renumber 1..n in saved order.
    update public.delivery_stops s set seq = x.rn
    from (
      select s2.id, row_number() over (order by w.route_seq, w.sort_name) as rn
      from public.delivery_stops s2
      join pg_temp.want_stops w on w.customer_id = s2.customer_id and w.address_id is not distinct from s2.address_id
      where s2.run_id = v_run
    ) x
    where s.id = x.id and s.seq is distinct from x.rn;

    update public.meal_orders o set run_id = v_run, stop_id = s.id, stop_seq = s.seq
    from pg_temp.want_stops w
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

-- Runs are built when a slot locks. A routing problem must never block the lock itself.
create or replace function private.snapshot_build_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.build_runs(new.kitchen_id, new.service_date, new.slot);
  exception when others then
    raise warning 'build_runs failed for % % %: %', new.kitchen_id, new.service_date, new.slot, sqlerrm;
  end;
  return null;
end;
$$;

create trigger count_snapshots_build_runs after insert on public.count_snapshots
  for each row execute function private.snapshot_build_runs();

-- Rebuild the saved route order of a run's addresses from a new run order, keeping the places
-- of addresses that are not in today's run.
create or replace function private.persist_run_order(p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_route uuid;
  v_slots integer[];
  v_addrs uuid[];
  i integer;
begin
  select route_id into v_route from public.delivery_runs where id = p_run;
  -- The positions (seq) the run's addresses occupy in the saved route, ascending...
  select array_agg(rs.seq order by rs.seq) into v_slots
  from public.route_stops rs
  where rs.route_id = v_route
    and rs.address_id in (select address_id from public.delivery_stops where run_id = p_run and address_id is not null);
  -- ...are refilled in the run's new order.
  select array_agg(s.address_id order by s.seq) into v_addrs
  from public.delivery_stops s
  join public.route_stops rs on rs.route_id = v_route and rs.address_id = s.address_id
  where s.run_id = p_run;
  if v_slots is null then
    return;
  end if;
  -- Move out of the way first (seq is not unique, but keep it tidy).
  for i in 1..array_length(v_addrs, 1) loop
    update public.route_stops set seq = v_slots[i], pinned = true, updated_at = now()
    where route_id = v_route and address_id = v_addrs[i];
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rider actions (internal, actor passed explicitly; the public RPCs check roles)
-- ---------------------------------------------------------------------------

-- Device time for an offline action: kept as recorded, but clamped to [service day - 1, now].
create or replace function private.client_time(p_at timestamptz, p_date date)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when p_at is null then private.now()
    when p_at > private.now() then private.now()
    when p_at < ((p_date - 1)::timestamp at time zone 'Asia/Kolkata') then ((p_date - 1)::timestamp at time zone 'Asia/Kolkata')
    else p_at
  end;
$$;

create or replace function private.do_start_run(p_run uuid, p_at timestamptz, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.delivery_runs;
  v_at timestamptz;
  v_rider_name text;
  v_total integer;
  r record;
begin
  select * into v_run from public.delivery_runs where id = p_run for update;
  if v_run.status <> 'planned' then
    return; -- already started (offline retry)
  end if;
  v_at := private.client_time(p_at, v_run.service_date);
  update public.delivery_runs
  set status = 'out', started_at = v_at, rider_id = coalesce(rider_id, p_actor)
  where id = p_run;

  update public.meal_orders set status = 'out'
  where run_id = p_run and status in ('locked', 'prepared', 'scheduled');

  select coalesce(m.display_name, 'Your rider') into v_rider_name
  from public.members m where m.kitchen_id = v_run.kitchen_id and m.user_id = coalesce(v_run.rider_id, p_actor);
  select count(*) into v_total from public.delivery_stops where run_id = p_run;

  for r in select * from public.delivery_stops where run_id = p_run and status = 'pending' order by seq loop
    update public.delivery_stops set otp = lpad((floor(random() * 10000))::integer::text, 4, '0')
    where id = r.id and otp is null;
    perform private.notify_customer(v_run.kitchen_id, r.customer_id, 'on_the_way',
      jsonb_build_object('rider_name', split_part(coalesce(v_rider_name, 'Your rider'), ' ', 1),
                         'otp', (select otp from public.delivery_stops where id = r.id),
                         'stop', r.seq, 'stops', v_total, 'slot', v_run.slot, 'service_date', v_run.service_date),
      'on_the_way:' || r.id);
  end loop;
end;
$$;

-- Result shape shared by complete/fail: {stop_id, status, otp_ok, conflict}.
create or replace function private.stop_result(p_stop uuid, p_conflict boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('stop_id', s.id, 'status', s.status, 'otp_ok', s.otp_ok, 'done_at', s.done_at,
                            'credit_entry_id', s.credit_entry_id, 'cash_payment_id', s.cash_payment_id,
                            'conflict', p_conflict)
  from public.delivery_stops s where s.id = p_stop;
$$;

create or replace function private.do_complete_stop(
  p_stop uuid, p_proof public.proof_type, p_otp text, p_photo_path text,
  p_lat double precision, p_lng double precision, p_accuracy real, p_at timestamptz,
  p_tiffins_out integer, p_tiffins_returned integer, p_cash_paise integer, p_client_op uuid,
  p_offline boolean, p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.delivery_stops;
  v_run public.delivery_runs;
  v_a public.addresses;
  v_at timestamptz;
  v_otp_ok boolean;
  v_dist integer;
  v_order uuid;
  v_payment uuid;
  v_price integer;
begin
  if p_client_op is not null and exists (select 1 from public.delivery_stops where client_op_id = p_client_op) then
    return private.stop_result((select id from public.delivery_stops where client_op_id = p_client_op));
  end if;
  select * into v_s from public.delivery_stops where id = p_stop for update;
  select * into v_run from public.delivery_runs where id = v_s.run_id for update;
  if v_s.status <> 'pending' then
    return private.stop_result(p_stop, true); -- first write wins
  end if;
  if p_proof is null then
    raise exception 'proof_required' using errcode = '22023';
  end if;
  if p_proof = 'photo' and nullif(trim(p_photo_path), '') is null then
    raise exception 'photo_required' using errcode = '22023';
  end if;
  if p_photo_path is not null and split_part(p_photo_path, '/', 1) <> v_s.kitchen_id::text then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;
  if coalesce(p_cash_paise, 0) < 0 or coalesce(p_tiffins_out, 0) < 0 or coalesce(p_tiffins_returned, 0) < 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  if p_proof = 'otp' then
    v_otp_ok := v_s.otp is not null and trim(coalesce(p_otp, '')) = v_s.otp;
    if not v_otp_ok and not coalesce(p_offline, false) then
      -- Online: let the rider retry, up to 5 wrong codes per stop.
      update public.delivery_stops set otp_attempts = otp_attempts + 1 where id = p_stop;
      if v_s.otp_attempts + 1 >= 5 then
        raise exception 'otp_locked' using errcode = '22023';
      end if;
      return jsonb_build_object('stop_id', p_stop, 'status', 'pending', 'otp_ok', false, 'conflict', false);
    end if;
  end if;

  v_at := private.client_time(p_at, v_run.service_date);
  select * into v_a from public.addresses where id = v_s.address_id;
  if p_lat is not null and v_a.lat is not null then
    v_dist := round(private.km_between(p_lat, p_lng, v_a.lat, v_a.lng) * 1000);
  end if;

  if v_run.status = 'planned' then
    perform private.do_start_run(v_run.id, v_at, p_actor);
  end if;

  if coalesce(p_cash_paise, 0) > 0 then
    select id into v_order from public.meal_orders where stop_id = p_stop order by created_at limit 1;
    v_price := private.customer_unit_price(v_s.customer_id);
    insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, note, collected_by,
                                 meal_order_id, created_by, created_at)
    values (v_s.kitchen_id, v_s.customer_id, 'cash', 'pending', p_cash_paise,
            greatest(1, coalesce(p_cash_paise / nullif(v_price, 0), 1)), 'Collected at the door', p_actor, v_order,
            p_actor, v_at)
    returning id into v_payment;
  end if;

  update public.delivery_stops
  set status = 'delivered', proof_type = p_proof, otp_ok = v_otp_ok, photo_path = nullif(trim(p_photo_path), ''),
      gps_lat = p_lat, gps_lng = p_lng, gps_accuracy_m = p_accuracy, gps_distance_m = v_dist,
      done_at = v_at, device_at = case when p_at is distinct from v_at then p_at end, synced_at = private.now(),
      offline = coalesce(p_offline, false), tiffins_out = coalesce(p_tiffins_out, 0),
      tiffins_returned = coalesce(p_tiffins_returned, 0), cash_payment_id = v_payment, client_op_id = p_client_op,
      done_by = p_actor
  where id = p_stop;

  update public.meal_orders set status = 'delivered' where stop_id = p_stop and status <> 'skipped';

  if coalesce(p_tiffins_out, 0) > 0 or coalesce(p_tiffins_returned, 0) > 0 then
    insert into public.tiffin_ledger (kitchen_id, customer_id, stop_id, tiffins_out, tiffins_returned, created_by, created_at)
    values (v_s.kitchen_id, v_s.customer_id, p_stop, coalesce(p_tiffins_out, 0), coalesce(p_tiffins_returned, 0), p_actor, v_at)
    on conflict (stop_id) where stop_id is not null do nothing;
  end if;

  return private.stop_result(p_stop);
end;
$$;

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
  v_s public.delivery_stops;
  v_run public.delivery_runs;
  v_at timestamptz;
  v_fault boolean;
  v_meals integer;
  v_amount integer;
  v_entry uuid;
begin
  if p_client_op is not null and exists (select 1 from public.delivery_stops where client_op_id = p_client_op) then
    return private.stop_result((select id from public.delivery_stops where client_op_id = p_client_op));
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
  if v_fault then
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

create or replace function private.do_finish_run(p_run uuid, p_at timestamptz, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.delivery_runs;
begin
  select * into v_run from public.delivery_runs where id = p_run for update;
  if v_run.status = 'done' then
    return;
  end if;
  if exists (select 1 from public.delivery_stops where run_id = p_run and status = 'pending') then
    raise exception 'stops_pending' using errcode = '22023';
  end if;
  update public.delivery_runs
  set status = 'done', started_at = coalesce(started_at, private.client_time(p_at, service_date)),
      finished_at = private.client_time(p_at, service_date)
  where id = p_run;
end;
$$;

-- The caller must be the run's rider (or an owner of the kitchen). Riders act only on today's runs.
create or replace function private.require_run_access(p_run uuid)
returns public.delivery_runs
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_run public.delivery_runs;
begin
  select * into v_run from public.delivery_runs where id = p_run;
  if v_run.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if private.has_role(v_run.kitchen_id, '{owner}') then
    return v_run;
  end if;
  perform private.require_role(v_run.kitchen_id, '{rider}');
  if v_run.rider_id is distinct from auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Offline actions may sync the next morning; allow yesterday's runs too.
  if v_run.service_date not between private.ist_today() - 1 and private.ist_today() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_run;
end;
$$;

-- Today's runs of the calling user, for the RLS policies below.
create or replace function private.my_run_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(id), '{}') from public.delivery_runs
  where rider_id = auth.uid() and service_date = private.ist_today();
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs: riders
-- ---------------------------------------------------------------------------

-- Everything the rider app caches for offline use: today's runs and stops (masked phones).
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
          'id', s.id, 'seq', s.seq, 'customer_id', s.customer_id, 'name', cu.name,
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
                              where n.dedupe_key like 'on_the_way:' || s.id || '%' and n.status in ('pending', 'sent', 'sending'))
        ) order by s.seq)
        from public.delivery_stops s
        join public.customers cu on cu.id = s.customer_id
        left join public.addresses a on a.id = s.address_id
        where s.run_id = dr.id), '[]'::jsonb)
    ) order by dr.slot, rt.name)
    from public.delivery_runs dr
    join public.kitchens k on k.id = dr.kitchen_id
    join public.delivery_routes rt on rt.id = dr.route_id
    where dr.rider_id = auth.uid() and dr.service_date = private.ist_today()
      and exists (select 1 from public.members m where m.kitchen_id = dr.kitchen_id and m.user_id = auth.uid())
  ), '[]'::jsonb);
end;
$$;

create or replace function public.start_run(p_run uuid, p_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_run_access(p_run);
  perform private.do_start_run(p_run, p_at, auth.uid());
end;
$$;

-- Mark a stop delivered. p_at is the device time when the rider tapped (kept when synced later);
-- p_client_op makes retries from the offline queue safe. Wrong OTP online: returns otp_ok=false
-- and the stop stays pending; offline: recorded with otp_ok=false for the owner to review.
create or replace function public.complete_stop(
  p_stop uuid,
  p_proof public.proof_type,
  p_otp text default null,
  p_photo_path text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_accuracy real default null,
  p_at timestamptz default null,
  p_tiffins_out integer default 0,
  p_tiffins_returned integer default 0,
  p_cash_paise integer default 0,
  p_client_op uuid default null,
  p_offline boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
begin
  select run_id into v_run from public.delivery_stops where id = p_stop;
  if v_run is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_run_access(v_run);
  return private.do_complete_stop(p_stop, p_proof, p_otp, p_photo_path, p_lat, p_lng, p_accuracy, p_at,
                                  p_tiffins_out, p_tiffins_returned, p_cash_paise, p_client_op, p_offline, auth.uid());
end;
$$;

create or replace function public.fail_stop(
  p_stop uuid,
  p_reason public.fail_reason,
  p_note text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_at timestamptz default null,
  p_tiffins_returned integer default 0,
  p_client_op uuid default null,
  p_offline boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
begin
  select run_id into v_run from public.delivery_stops where id = p_stop;
  if v_run is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_run_access(v_run);
  return private.do_fail_stop(p_stop, p_reason, p_note, p_lat, p_lng, p_at, p_tiffins_returned, p_client_op,
                              p_offline, auth.uid());
end;
$$;

create or replace function public.finish_run(p_run uuid, p_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_run_access(p_run);
  perform private.do_finish_run(p_run, p_at, auth.uid());
end;
$$;

-- Live location for the board (only while the run is out).
create or replace function public.rider_ping(p_run uuid, p_lat double precision, p_lng double precision)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_run_access(p_run);
  update public.delivery_runs set last_lat = p_lat, last_lng = p_lng, last_seen_at = private.now()
  where id = p_run and status = 'out';
end;
$$;

-- The number to call, only for the rider's own pending stop on a run that is out. Logged.
-- True call masking (a virtual number) needs a telephony provider (D-069).
create or replace function public.rider_call_number(p_stop uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.delivery_stops;
  v_run public.delivery_runs;
begin
  select * into v_s from public.delivery_stops where id = p_stop;
  if v_s.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_run := private.require_run_access(v_s.run_id);
  if not private.has_role(v_s.kitchen_id, '{owner}')
     and (v_run.status <> 'out' or v_s.status <> 'pending' or v_run.service_date <> private.ist_today()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.audit_access(v_s.kitchen_id, 'customers', v_s.customer_id::text,
                               jsonb_build_object('reason', 'rider_call', 'stop_id', p_stop));
  return (select private.decrypt_phone(phone_enc) from public.customers where id = v_s.customer_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs: owner / staff
-- ---------------------------------------------------------------------------
create or replace function public.plan_runs(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  return private.build_runs(p_kitchen, p_date, p_slot);
end;
$$;

create or replace function public.create_route(p_kitchen uuid, p_slot public.meal_slot, p_name text, p_rider uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  if p_rider is not null and not exists (select 1 from public.members where kitchen_id = p_kitchen and user_id = p_rider
                                          and role in ('owner', 'rider')) then
    raise exception 'invalid_rider' using errcode = '22023';
  end if;
  insert into public.delivery_routes (kitchen_id, slot, name, rider_id)
  values (p_kitchen, p_slot, trim(p_name), p_rider)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'already_exists' using errcode = '23505';
end;
$$;

create or replace function public.update_route(p_route uuid, p_name text default null, p_rider uuid default null,
                                               p_active boolean default null, p_clear_rider boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.delivery_routes;
begin
  select * into v_r from public.delivery_routes where id = p_route;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner,staff}');
  if p_rider is not null and not exists (select 1 from public.members where kitchen_id = v_r.kitchen_id and user_id = p_rider
                                          and role in ('owner', 'rider')) then
    raise exception 'invalid_rider' using errcode = '22023';
  end if;
  update public.delivery_routes
  set name = coalesce(nullif(trim(p_name), ''), name),
      rider_id = case when p_clear_rider then null else coalesce(p_rider, rider_id) end,
      active = coalesce(p_active, active)
  where id = p_route;
  -- Planned runs follow the route's rider.
  update public.delivery_runs dr set rider_id = r.rider_id
  from public.delivery_routes r
  where r.id = p_route and dr.route_id = p_route and dr.status = 'planned' and dr.service_date >= private.ist_today()
    and (p_rider is not null or p_clear_rider);
exception when unique_violation then
  raise exception 'already_exists' using errcode = '23505';
end;
$$;

-- One day's rider for a run (the route keeps its default rider).
create or replace function public.assign_run(p_run uuid, p_rider uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.delivery_runs;
begin
  select * into v_run from public.delivery_runs where id = p_run;
  if v_run.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_run.kitchen_id, '{owner,staff}');
  if p_rider is not null and not exists (select 1 from public.members where kitchen_id = v_run.kitchen_id
                                          and user_id = p_rider and role in ('owner', 'rider')) then
    raise exception 'invalid_rider' using errcode = '22023';
  end if;
  if v_run.status = 'done' then
    raise exception 'run_closed' using errcode = '22023';
  end if;
  update public.delivery_runs set rider_id = p_rider where id = p_run;
end;
$$;

-- Drag reorder of a run (also while it is out; finished stops keep their recorded times). The new
-- order is written back to the saved route and marks those addresses as hand-placed, so tomorrow's
-- run comes out the same.
create or replace function public.reorder_run(p_run uuid, p_stop_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.delivery_runs;
  v_n integer;
begin
  select * into v_run from public.delivery_runs where id = p_run;
  if v_run.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_run.kitchen_id, '{owner,staff}');
  if v_run.status = 'done' then
    raise exception 'run_closed' using errcode = '22023';
  end if;
  select count(*) into v_n from public.delivery_stops where run_id = p_run;
  if v_n <> coalesce(array_length(p_stop_ids, 1), 0)
     or v_n <> (select count(*) from public.delivery_stops where run_id = p_run and id = any (p_stop_ids)) then
    raise exception 'invalid_order' using errcode = '22023';
  end if;
  update public.delivery_stops s set seq = x.ord
  from unnest(p_stop_ids) with ordinality as x(id, ord)
  where s.id = x.id and s.run_id = p_run;
  update public.meal_orders o set stop_seq = s.seq
  from public.delivery_stops s where s.run_id = p_run and o.stop_id = s.id;
  perform private.persist_run_order(p_run);
end;
$$;

-- Move a pending stop to another run of the same slot. Saved: the address joins that route.
create or replace function public.move_stop(p_stop uuid, p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.delivery_stops;
  v_from public.delivery_runs;
  v_to public.delivery_runs;
  v_seq integer;
begin
  select * into v_s from public.delivery_stops where id = p_stop;
  select * into v_from from public.delivery_runs where id = v_s.run_id;
  select * into v_to from public.delivery_runs where id = p_run;
  if v_s.id is null or v_to.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_s.kitchen_id, '{owner,staff}');
  if v_to.kitchen_id <> v_s.kitchen_id or v_to.service_date <> v_from.service_date or v_to.slot <> v_from.slot then
    raise exception 'invalid_run' using errcode = '22023';
  end if;
  if v_s.status <> 'pending' or v_to.status = 'done' then
    raise exception 'run_closed' using errcode = '22023';
  end if;
  if v_to.id = v_from.id then
    return;
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from public.delivery_stops where run_id = p_run;
  update public.delivery_stops set run_id = p_run, seq = v_seq where id = p_stop;
  -- Joining a run that is already out: the customer still needs a code and the message.
  if v_to.status = 'out' then
    update public.delivery_stops set otp = lpad((floor(random() * 10000))::integer::text, 4, '0'), otp_attempts = 0
    where id = p_stop and otp is null;
    update public.meal_orders set status = 'out' where stop_id = p_stop and status in ('locked', 'prepared', 'scheduled');
    perform private.notify_customer(v_s.kitchen_id, v_s.customer_id, 'on_the_way',
      jsonb_build_object('rider_name', split_part(coalesce((select display_name from public.members
                           where kitchen_id = v_s.kitchen_id and user_id = v_to.rider_id), 'Your rider'), ' ', 1),
                         'otp', (select otp from public.delivery_stops where id = p_stop),
                         'stop', v_seq, 'stops', v_seq, 'slot', v_to.slot, 'service_date', v_to.service_date),
      'on_the_way:' || p_stop || ':' || p_run);
  end if;
  update public.meal_orders set run_id = p_run, stop_seq = v_seq where stop_id = p_stop;
  if v_s.address_id is not null then
    update public.route_stops
    set route_id = v_to.route_id,
        seq = (select coalesce(max(seq), 0) + 1 from public.route_stops where route_id = v_to.route_id),
        pinned = true, updated_at = now()
    where kitchen_id = v_s.kitchen_id and slot = v_from.slot and address_id = v_s.address_id;
  end if;
  -- Close the gap in the old run.
  update public.delivery_stops s set seq = x.rn
  from (select id, row_number() over (order by seq) as rn from public.delivery_stops where run_id = v_from.id) x
  where s.id = x.id and s.seq <> x.rn;
  update public.meal_orders o set stop_seq = s.seq from public.delivery_stops s where s.run_id = v_from.id and o.stop_id = s.id;
end;
$$;

-- Saved order of a route (for the route editor and the VROOM Edge Function).
create or replace function public.route_points(p_route uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r public.delivery_routes;
begin
  select * into v_r from public.delivery_routes where id = p_route;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner,staff}');
  return jsonb_build_object(
    'route_id', v_r.id, 'name', v_r.name, 'slot', v_r.slot,
    'kitchen', (select jsonb_build_object('lat', lat, 'lng', lng) from public.kitchens where id = v_r.kitchen_id),
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object('address_id', rs.address_id, 'seq', rs.seq, 'pinned', rs.pinned,
                                          'customer_name', cu.name, 'area', a.area, 'landmark', a.landmark,
                                          'lat', a.lat, 'lng', a.lng) order by rs.seq)
      from public.route_stops rs
      join public.addresses a on a.id = rs.address_id
      join public.customers cu on cu.id = a.customer_id
      where rs.route_id = p_route), '[]'::jsonb));
end;
$$;

-- Replace a route's saved order (route editor, or the VROOM result with p_pinned = false).
-- Addresses not listed keep their relative order after the listed ones. Planned runs from today
-- on are re-synced.
create or replace function public.save_route_order(p_route uuid, p_address_ids uuid[], p_pinned boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.delivery_routes;
  v_n integer := coalesce(array_length(p_address_ids, 1), 0);
  d record;
begin
  select * into v_r from public.delivery_routes where id = p_route;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner,staff}');
  if exists (select 1 from unnest(p_address_ids) x(id)
             where not exists (select 1 from public.route_stops where route_id = p_route and address_id = x.id)) then
    raise exception 'invalid_order' using errcode = '22023';
  end if;
  update public.route_stops rs set seq = x.ord, pinned = coalesce(p_pinned, true), updated_at = now()
  from unnest(p_address_ids) with ordinality as x(id, ord)
  where rs.route_id = p_route and rs.address_id = x.id;
  update public.route_stops rs set seq = v_n + y.rn, updated_at = now()
  from (select id, row_number() over (order by seq) as rn from public.route_stops
        where route_id = p_route and not (address_id = any (coalesce(p_address_ids, '{}')))) y
  where rs.id = y.id;
  for d in select distinct service_date from public.delivery_runs
           where route_id = p_route and status = 'planned' and service_date >= private.ist_today() loop
    perform private.build_runs(v_r.kitchen_id, d.service_date, v_r.slot);
  end loop;
end;
$$;

-- Built-in optimiser (also the fallback when VROOM is not configured). Returns km before/after.
create or replace function public.optimize_route(p_route uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.delivery_routes;
  v_k public.kitchens;
  v_before numeric;
  v_after numeric;
  v_lat double precision[];
  v_lng double precision[];
  d record;
begin
  select * into v_r from public.delivery_routes where id = p_route;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner,staff}');
  select * into v_k from public.kitchens where id = v_r.kitchen_id;
  select array_agg(a.lat order by rs.seq), array_agg(a.lng order by rs.seq) into v_lat, v_lng
  from public.route_stops rs join public.addresses a on a.id = rs.address_id where rs.route_id = p_route;
  v_before := private.path_km(v_lat, v_lng, v_k.lat, v_k.lng);
  perform private.optimize_route_order(p_route);
  select array_agg(a.lat order by rs.seq), array_agg(a.lng order by rs.seq) into v_lat, v_lng
  from public.route_stops rs join public.addresses a on a.id = rs.address_id where rs.route_id = p_route;
  v_after := private.path_km(v_lat, v_lng, v_k.lat, v_k.lng);
  for d in select distinct service_date from public.delivery_runs
           where route_id = p_route and status = 'planned' and service_date >= private.ist_today() loop
    perform private.build_runs(v_r.kitchen_id, d.service_date, v_r.slot);
  end loop;
  return jsonb_build_object('km_before', v_before, 'km_after', v_after, 'engine', 'local');
end;
$$;

-- Vendor live board: runs, progress, last location, every stop's state.
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
            'id', s.id, 'seq', s.seq, 'customer_id', s.customer_id, 'customer_name', cu.name,
            'line1', a.line1, 'area', a.area, 'landmark', a.landmark, 'lat', a.lat, 'lng', a.lng,
            'meal_count', s.meal_count, 'status', s.status, 'proof_type', s.proof_type, 'otp_ok', s.otp_ok,
            'photo_path', s.photo_path, 'done_at', s.done_at, 'offline', s.offline, 'synced_at', s.synced_at,
            'failed_reason', s.failed_reason, 'failed_note', s.failed_note, 'kitchen_fault', s.kitchen_fault,
            'gps_distance_m', s.gps_distance_m, 'tiffins_out', s.tiffins_out, 'tiffins_returned', s.tiffins_returned,
            'cash_paise', case when v_owner then (select amount_paise from public.payments where id = s.cash_payment_id) end
          ) order by s.seq)
          from public.delivery_stops s
          join public.customers cu on cu.id = s.customer_id
          left join public.addresses a on a.id = s.address_id
          where s.run_id = dr.id), '[]'::jsonb)
      ) order by rt.name)
      from public.delivery_runs dr join public.delivery_routes rt on rt.id = dr.route_id
      where dr.kitchen_id = p_kitchen and dr.service_date = p_date and dr.slot = p_slot), '[]'::jsonb)
  );
end;
$$;

-- Tiffins returned at the kitchen, or a correction.
create or replace function public.record_tiffins(p_customer uuid, p_out integer, p_returned integer, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
  v_id uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner,staff}');
  if coalesce(p_out, 0) < 0 or coalesce(p_returned, 0) < 0 or coalesce(p_out, 0) + coalesce(p_returned, 0) = 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  -- Can't take back more boxes than the customer holds.
  if coalesce(p_returned, 0) > coalesce(p_out, 0) + coalesce((select sum(tiffins_out - tiffins_returned) from public.tiffin_ledger
                                                              where kitchen_id = v_kitchen and customer_id = p_customer), 0) then
    raise exception 'too_many_returned' using errcode = '22023';
  end if;
  insert into public.tiffin_ledger (kitchen_id, customer_id, tiffins_out, tiffins_returned, note, created_by, created_at)
  values (v_kitchen, p_customer, coalesce(p_out, 0), coalesce(p_returned, 0), nullif(trim(p_note), ''), auth.uid(), private.now())
  returning id into v_id;
  return v_id;
end;
$$;

-- Customers holding tiffins (outstanding > 0), most first. Flag: unreturned for 2+ days.
create or replace function public.tiffin_balances(p_kitchen uuid)
returns table (customer_id uuid, customer_name text, area text, outstanding integer, last_out_at timestamptz, overdue boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  return query
  select t.customer_id, cu.name, a.area, sum(t.tiffins_out - t.tiffins_returned)::integer,
         max(t.created_at) filter (where t.tiffins_out > 0),
         sum(t.tiffins_out - t.tiffins_returned) >= 2
           and coalesce(max(t.created_at) filter (where t.tiffins_returned > 0), '-infinity') < private.now() - interval '2 days'
  from public.tiffin_ledger t
  join public.customers cu on cu.id = t.customer_id
  left join public.addresses a on a.customer_id = t.customer_id and a.is_default
  where t.kitchen_id = p_kitchen
  group by t.customer_id, cu.name, a.area
  having sum(t.tiffins_out - t.tiffins_returned) > 0
  order by 4 desc, 2;
end;
$$;

-- Monthly numbers per rider, for the vendor to pay riders: shifts, stops, km, proof rate, cash.
create or replace function public.rider_stats(p_kitchen uuid, p_month date)
returns table (rider_id uuid, rider_name text, shifts integer, days integer, stops_delivered integer,
               stops_failed integer, proof_rate numeric, km numeric, cash_collected_paise integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  perform private.require_role(p_kitchen, '{owner}');
  return query
  with runs as (
    select dr.* from public.delivery_runs dr
    where dr.kitchen_id = p_kitchen and dr.service_date >= v_from and dr.service_date < v_to
      and dr.status = 'done' and dr.rider_id is not null
  ), st as (
    select r.rider_id,
           count(*) filter (where s.status = 'delivered') as delivered,
           count(*) filter (where s.status = 'failed') as failed,
           count(*) filter (where s.status = 'delivered' and (s.otp_ok or s.photo_path is not null)) as proved
    from runs r join public.delivery_stops s on s.run_id = r.id
    group by r.rider_id
  )
  select r.rider_id, m.display_name, count(*)::integer, count(distinct r.service_date)::integer,
         coalesce(max(st.delivered), 0)::integer, coalesce(max(st.failed), 0)::integer,
         case when coalesce(max(st.delivered), 0) = 0 then null
              else round(100.0 * max(st.proved) / max(st.delivered), 1) end,
         coalesce(sum(r.planned_km), 0),
         coalesce((select sum(p.amount_paise) from public.payments p
                   where p.kitchen_id = p_kitchen and p.collected_by = r.rider_id and p.method = 'cash'
                     and p.status in ('pending', 'paid')
                     and p.created_at >= (v_from::timestamp at time zone 'Asia/Kolkata')
                     and p.created_at < (v_to::timestamp at time zone 'Asia/Kolkata')), 0)::integer
  from runs r
  left join public.members m on m.kitchen_id = p_kitchen and m.user_id = r.rider_id
  left join st on st.rider_id = r.rider_id
  group by r.rider_id, m.display_name
  order by 2;
end;
$$;

-- Packing list in route order: run by run, then stop order.
create or replace function public.packing_list(p_kitchen uuid, p_date date, p_slot public.meal_slot)
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
  stop_seq integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  return query
  select o.id, cu.name, a.line1, a.landmark, a.area, a.delivery_notes, cu.notes, o.qty, o.diet, p.name, o.status,
         o.charged, o.stop_seq
  from public.meal_orders o
  join public.customers cu on cu.id = o.customer_id
  join public.plans p on p.id = o.plan_id
  left join public.addresses a on a.id = o.address_id
  left join public.delivery_runs dr on dr.id = o.run_id
  left join public.delivery_routes rt on rt.id = dr.route_id
  where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
    and (o.status <> 'skipped' or o.charged)
  order by rt.name nulls last, o.stop_seq nulls last, a.area nulls last, a.landmark nulls last, cu.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Proof photos: private bucket, one folder per kitchen (proofs/<kitchen_id>/...).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy proofs_read on storage.objects for select to authenticated
  using (bucket_id = 'proofs'
         and ((storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}'))::text[])
              or (select private.is_platform_admin())));
create policy proofs_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'proofs'
              and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner,rider}'))::text[]));

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.delivery_routes enable row level security;
alter table public.route_stops enable row level security;
alter table public.delivery_runs enable row level security;
alter table public.delivery_stops enable row level security;
alter table public.tiffin_ledger enable row level security;

create policy delivery_routes_select on public.delivery_routes for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy route_stops_select on public.route_stops for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
-- Riders: only their own runs, today only.
create policy delivery_runs_select on public.delivery_runs for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[])
         or id = any ((select private.my_run_ids())::uuid[])
         or (select private.is_platform_admin()));
create policy delivery_stops_select on public.delivery_stops for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[])
         or run_id = any ((select private.my_run_ids())::uuid[])
         or (select private.is_platform_admin()));
create policy tiffin_ledger_select on public.tiffin_ledger for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));

revoke all on public.delivery_routes, public.route_stops, public.delivery_runs, public.delivery_stops,
  public.tiffin_ledger from anon, authenticated;
grant select on public.delivery_routes, public.route_stops, public.delivery_runs, public.tiffin_ledger to authenticated;
-- The OTP is the customer's secret; cash links are money (owner reads them through live_board).
grant select (id, kitchen_id, run_id, customer_id, address_id, seq, meal_count, status, proof_type, otp_attempts, otp_ok,
  photo_path, gps_lat, gps_lng, gps_accuracy_m, gps_distance_m, done_at, device_at, synced_at, offline, failed_reason,
  failed_note, kitchen_fault, tiffins_out, tiffins_returned, done_by, created_at, updated_at)
  on public.delivery_stops to authenticated;
grant select (stop_id) on public.meal_orders to authenticated;

grant execute on function private.my_run_ids() to authenticated;

revoke execute on function public.rider_today, public.start_run, public.complete_stop, public.fail_stop,
  public.finish_run, public.rider_ping, public.rider_call_number, public.plan_runs, public.create_route,
  public.update_route, public.assign_run, public.reorder_run, public.move_stop, public.route_points,
  public.save_route_order, public.optimize_route, public.live_board, public.record_tiffins, public.tiffin_balances,
  public.rider_stats
  from public, anon;
grant execute on function public.rider_today, public.start_run, public.complete_stop, public.fail_stop,
  public.finish_run, public.rider_ping, public.rider_call_number, public.plan_runs, public.create_route,
  public.update_route, public.assign_run, public.reorder_run, public.move_stop, public.route_points,
  public.save_route_order, public.optimize_route, public.live_board, public.record_tiffins, public.tiffin_balances,
  public.rider_stats
  to authenticated;
