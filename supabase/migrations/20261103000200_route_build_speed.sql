-- Speed: a route's first build no longer places each new address by cheapest insertion
-- (quadratic) before optimising the whole route anyway; it appends, then optimises once.
-- Found by the M8 load test (50 kitchens × 100 subscriptions locked at 21:00).

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
  v_route uuid;
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
    v_route := private.route_for_address(p_kitchen, p_slot, r.address_id);
    if exists (select 1 from public.delivery_runs x where x.route_id = v_route)
       or exists (select 1 from public.route_stops rs where rs.route_id = v_route and rs.pinned) then
      perform private.insert_route_stop(v_route, r.address_id);
    else
      -- First build of this route: it is optimised as a whole just below, so append.
      insert into public.route_stops (kitchen_id, route_id, slot, address_id, seq)
      values (p_kitchen, v_route, p_slot, r.address_id,
              (select coalesce(max(seq), 0) + 1 from public.route_stops where route_id = v_route))
      on conflict (kitchen_id, slot, address_id) do update
        set route_id = excluded.route_id, seq = excluded.seq, pinned = false, updated_at = now();
    end if;
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

