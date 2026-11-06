-- Held-back apps track, review fixes for refused-action reports (rider_sync_rejects, 20261116000100).
--
-- 1. A stop moved to another run (public.move_stop keeps the stop id, changes run_id) is the main case
--    the table exists for: the rider's queued action is refused with 'forbidden' and the report names
--    the OLD run. report_sync_reject used to refuse such a report ('forbidden', dropped by the phone).
--    Now only the kitchen must match: run, stop and p_kitchen all in the same kitchen. run_id stays the
--    run the rider acted on (null when that run is gone), stop_id the stop.
-- 2. A report that arrives after the same action already synced (delivery_stops.client_op_id = the
--    report's client op) is stored already closed ("Synced later from the phone") and never reopens
--    an existing report, so the owner is not sent chasing cash the server already recorded.
-- 3. customer_id (from the stop, at report time) so a customer's reports can still be found after the
--    stop is rebuilt away (erasure: the customer-erasure routine must blank summary.note / stop_label
--    of that customer's reports; see docs/DECISIONS.md, held-back apps track).
-- Decision: docs/DECISIONS.md, held-back apps track ("The server keeps a record of rider actions it refused").

alter table public.rider_sync_rejects add column customer_id uuid;
alter table public.rider_sync_rejects
  add constraint rider_sync_rejects_customer_fk foreign key (customer_id, kitchen_id)
  references public.customers (id, kitchen_id) on delete set null (customer_id);
create index rider_sync_rejects_customer_idx on public.rider_sync_rejects (customer_id, kitchen_id) where customer_id is not null;

update public.rider_sync_rejects r set customer_id = ds.customer_id
from public.delivery_stops ds
where ds.id = r.stop_id and ds.kitchen_id = r.kitchen_id and r.customer_id is null;

create or replace function public.report_sync_reject(
  p_client_op uuid,
  p_kind text,
  p_error text,
  p_kitchen uuid default null,
  p_run uuid default null,
  p_stop uuid default null,
  p_summary jsonb default '{}',
  p_cash_paise integer default 0,
  p_had_photo boolean default false,
  p_acted_at timestamptz default null,
  p_refused_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_kitchen uuid;
  v_run public.delivery_runs;
  v_stop public.delivery_stops;
  v_refused timestamptz := coalesce(p_refused_at, private.now());
  v_old public.rider_sync_rejects;
  v_synced boolean;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_stop is not null then
    select * into v_stop from public.delivery_stops where id = p_stop;
  end if;
  -- The run the rider acted on (p_run); only when the phone did not name one, the stop's current run.
  if coalesce(p_run, v_stop.run_id) is not null then
    select * into v_run from public.delivery_runs where id = coalesce(p_run, v_stop.run_id);
  end if;
  v_kitchen := coalesce(v_run.kitchen_id, v_stop.kitchen_id, p_kitchen);
  if v_kitchen is null then
    select min(m.kitchen_id::text)::uuid into v_kitchen from public.members m
    where m.user_id = v_uid and m.role in ('rider', 'owner')
    having count(*) = 1;
  end if;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner,rider}');
  -- Everything named must belong to that kitchen. The stop may sit on another run of it now (moved by
  -- the owner after the rider acted): that is the refusal being reported, so it is accepted.
  if (p_kitchen is not null and p_kitchen <> v_kitchen)
     or (v_stop.id is not null and v_stop.kitchen_id <> v_kitchen)
     or (v_run.id is not null and v_run.kitchen_id <> v_kitchen) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_client_op is null or p_kind is null or p_kind not in ('start', 'complete', 'fail', 'finish') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if coalesce(p_cash_paise, 0) not between 0 and 10000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  -- The same action already went through (the rider tried again and it synced before this report).
  v_synced := exists (select 1 from public.delivery_stops ds
                      where ds.client_op_id = p_client_op and ds.kitchen_id = v_kitchen);

  select * into v_old from public.rider_sync_rejects where rider_id = v_uid and client_op = p_client_op for update;
  if v_old.id is not null then
    if v_old.kitchen_id <> v_kitchen then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if v_refused <= v_old.refused_at or v_synced then
      return v_old.id;   -- the same report again (a retried request), or one the later sync overtook
    end if;
    update public.rider_sync_rejects
    set error_code = coalesce(private.strip_numbers(p_error, 120), 'unknown'),
        summary = private.sync_reject_summary(p_summary), cash_paise = coalesce(p_cash_paise, 0),
        had_photo = coalesce(p_had_photo, false), refused_at = v_refused, reported_at = private.now(),
        reports = reports + 1, resolved_at = null, resolved_by = null, resolution_note = null,
        run_id = coalesce(v_run.id, run_id), stop_id = coalesce(v_stop.id, stop_id),
        customer_id = coalesce(v_stop.customer_id, customer_id)
    where id = v_old.id;
    return v_old.id;
  end if;

  if not v_synced and (select count(*) from public.rider_sync_rejects
      where kitchen_id = v_kitchen and rider_id = v_uid and resolved_at is null) >= 500 then
    raise exception 'too_many_requests' using errcode = '22023';
  end if;
  insert into public.rider_sync_rejects (kitchen_id, rider_id, run_id, stop_id, customer_id, client_op, action, error_code,
                                         summary, cash_paise, had_photo, acted_at, refused_at, reported_at,
                                         resolved_at, resolution_note)
  values (v_kitchen, v_uid, v_run.id, v_stop.id, v_stop.customer_id, p_client_op, p_kind,
          coalesce(private.strip_numbers(p_error, 120), 'unknown'),
          private.sync_reject_summary(p_summary), coalesce(p_cash_paise, 0), coalesce(p_had_photo, false),
          coalesce(p_acted_at, v_refused), v_refused, private.now(),
          case when v_synced then private.now() end, case when v_synced then 'Synced later from the phone' end)
  returning id into v_id;
  return v_id;
end;
$$;

-- Owner list: the customer's name also when the stop was rebuilt away (customer_id kept on the report).
create or replace function public.sync_rejects(p_kitchen uuid, p_include_resolved boolean default false,
                                               p_limit integer default 50)
returns table (
  id uuid, kitchen_id uuid, rider_id uuid, rider_name text, run_id uuid, stop_id uuid, customer_name text,
  route_name text, service_date date, slot public.meal_slot, action text, error_code text, summary jsonb,
  cash_paise integer, had_photo boolean, acted_at timestamptz, refused_at timestamptz, reported_at timestamptz,
  reports integer, resolved_at timestamptz, resolved_by uuid, resolution_note text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_kitchen is null or private.is_platform_admin() then
    perform private.require_admin();
  else
    perform private.require_role(p_kitchen, '{owner}');
  end if;
  return query
  select r.id, r.kitchen_id, r.rider_id, m.display_name, r.run_id, r.stop_id,
         coalesce(c.name, r.summary ->> 'stop_label'), coalesce(rt.name, r.summary ->> 'route_label'),
         coalesce(dr.service_date, (r.summary ->> 'service_date')::date), coalesce(dr.slot, (r.summary ->> 'slot')::public.meal_slot),
         r.action, r.error_code, r.summary, r.cash_paise, r.had_photo, r.acted_at, r.refused_at, r.reported_at,
         r.reports, r.resolved_at, r.resolved_by, r.resolution_note
  from public.rider_sync_rejects r
  left join public.members m on m.kitchen_id = r.kitchen_id and m.user_id = r.rider_id
  left join public.delivery_stops ds on ds.id = r.stop_id and ds.kitchen_id = r.kitchen_id
  left join public.customers c on c.id = coalesce(ds.customer_id, r.customer_id) and c.kitchen_id = r.kitchen_id
  left join public.delivery_runs dr on dr.id = r.run_id and dr.kitchen_id = r.kitchen_id
  left join public.delivery_routes rt on rt.id = dr.route_id and rt.kitchen_id = r.kitchen_id
  where (p_kitchen is null or r.kitchen_id = p_kitchen)
    and (coalesce(p_include_resolved, false) or r.resolved_at is null)
  order by (r.resolved_at is null) desc, r.reported_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- create or replace keeps the existing grants; restated so this file reads fail-closed on its own.
revoke execute on function public.report_sync_reject(uuid, text, text, uuid, uuid, uuid, jsonb, integer, boolean, timestamptz, timestamptz),
  public.sync_rejects(uuid, boolean, integer) from public, anon;
grant execute on function public.report_sync_reject(uuid, text, text, uuid, uuid, uuid, jsonb, integer, boolean, timestamptz, timestamptz),
  public.sync_rejects(uuid, boolean, integer) to authenticated;
