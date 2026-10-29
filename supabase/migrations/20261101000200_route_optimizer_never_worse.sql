-- Fix: "Optimise" could return a slightly longer route than the current saved order, because
-- nearest neighbour + 2-opt does not always beat a good existing order. The optimiser now also
-- improves the current order with 2-opt and keeps the shorter result, so it never gets worse.

drop function private.tsp_order(double precision[], double precision[], double precision, double precision);

create or replace function private.tsp_order(p_lat double precision[], p_lng double precision[],
                                             p_start_lat double precision, p_start_lng double precision,
                                             p_init integer[] default null)
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

  if p_init is not null then
    -- Improve a given order instead of building one (it must list 1..n once each).
    path := array_prepend(0, p_init);
  else
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
  end if;

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
  v_a integer[];
  v_b integer[];
  v_order integer[];
  v_rest uuid[];
  v_slat double precision;
  v_slng double precision;
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
    v_slat := coalesce(v_k.lat, v_lat[1]);
    v_slng := coalesce(v_k.lng, v_lng[1]);
    v_a := private.tsp_order(v_lat, v_lng, v_slat, v_slng);
    v_b := private.tsp_order(v_lat, v_lng, v_slat, v_slng, (select array_agg(g order by g) from generate_series(1, array_length(v_ids, 1)) g));
    v_order := case when private.path_km((select array_agg(v_lat[x] order by o) from unnest(v_a) with ordinality u(x, o)),
                                         (select array_agg(v_lng[x] order by o) from unnest(v_a) with ordinality u(x, o)), v_slat, v_slng)
                      <= private.path_km((select array_agg(v_lat[x] order by o) from unnest(v_b) with ordinality u(x, o)),
                                         (select array_agg(v_lng[x] order by o) from unnest(v_b) with ordinality u(x, o)), v_slat, v_slng)
                    then v_a else v_b end;
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
