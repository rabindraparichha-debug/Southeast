-- Held-back apps track, item 1 (docs/VENDOR_FIRST_AUDIT.md item 24, "a new rider_sync_rejects table").
--
-- The rider apps keep an action the server refused in a "needs attention" list on the phone, with
-- its photo and cash amount (wave 1). The owner never heard about it: if the rider discarded it or
-- lost the phone, the cash record was gone. Now the apps also send a short report of each refused
-- action here (best effort, never blocking the queue), and the owner sees an open list on the
-- delivery page / Today screen and marks each one handled.
--
-- What is stored: kitchen, rider, run and stop (when they still exist), the action kind, the error
-- code, a whitelisted summary (proof type, failure reason, a note with long digit runs removed,
-- tiffin counts, GPS yes/no, labels), the cash amount, "had a photo" (never the photo or its path),
-- the device time of the action and of the refusal. Never the delivery code typed, never a phone.
--
-- Access: the rider (or an owner delivering) reports for their own kitchen; riders read only their
-- own rows; owners read and resolve their kitchen's; platform admins read and resolve all. Staff
-- get nothing (cash is money). A later successful sync of the same action (same client op on
-- delivery_stops) closes the report by itself.
-- Decision: docs/DECISIONS.md D-126.

create table public.rider_sync_rejects (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  rider_id uuid references auth.users (id) on delete set null,
  run_id uuid,
  stop_id uuid,
  client_op uuid not null,                       -- the queued action's idempotency key
  action text not null check (action in ('start', 'complete', 'fail', 'finish')),
  error_code text not null check (length(error_code) between 1 and 120),
  summary jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
  cash_paise integer not null default 0 check (cash_paise between 0 and 10000000),
  had_photo boolean not null default false,
  acted_at timestamptz not null,                 -- when the rider tapped (device time)
  refused_at timestamptz not null,               -- when the phone got the refusal (device time)
  reported_at timestamptz not null default now(),
  reports integer not null default 1 check (reports >= 1),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id),   -- null when a later sync closed it by itself
  resolution_note text check (length(resolution_note) <= 500),
  unique (id, kitchen_id),
  unique (rider_id, client_op),
  foreign key (run_id, kitchen_id) references public.delivery_runs (id, kitchen_id) on delete set null (run_id),
  foreign key (stop_id, kitchen_id) references public.delivery_stops (id, kitchen_id) on delete set null (stop_id)
);
create index rider_sync_rejects_open_idx on public.rider_sync_rejects (kitchen_id, reported_at desc) where resolved_at is null;
create index rider_sync_rejects_kitchen_idx on public.rider_sync_rejects (kitchen_id, reported_at desc);
create index rider_sync_rejects_client_op_idx on public.rider_sync_rejects (client_op) where resolved_at is null;
-- Foreign keys with ON DELETE SET NULL probe these when runs or stops are rebuilt (keep it an index lookup).
create index rider_sync_rejects_run_idx on public.rider_sync_rejects (run_id, kitchen_id) where run_id is not null;
create index rider_sync_rejects_stop_idx on public.rider_sync_rejects (stop_id, kitchen_id) where stop_id is not null;

alter table public.rider_sync_rejects enable row level security;
create policy rider_sync_rejects_select on public.rider_sync_rejects for select to authenticated
  using (
    kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[])
    or rider_id = (select auth.uid())
    or (select private.is_platform_admin())
  );
revoke all on public.rider_sync_rejects from anon, authenticated;
grant select on public.rider_sync_rejects to authenticated;

create trigger rider_sync_rejects_audit after insert or update or delete on public.rider_sync_rejects
  for each row execute function private.audit_row();

-- Long digit runs (phone numbers) never reach the table, even inside a rider's note.
create or replace function private.strip_numbers(p_text text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(left(trim(regexp_replace(coalesce(p_text, ''), '\+?\d[\d -]{4,}\d', '…', 'g')), p_max), '');
$$;

-- Only these keys, with these shapes, are kept from what the phone sends.
create or replace function private.sync_reject_summary(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  s jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_out jsonb := '{}';
  v_date date;
  k text;
begin
  if s ->> 'service_date' ~ '^\d{4}-\d{2}-\d{2}$' then
    begin
      v_date := (s ->> 'service_date')::date;
    exception when others then
      v_date := null;
    end;
  end if;
  v_out := jsonb_build_object(
    'proof', case when s ->> 'proof' in ('otp', 'photo', 'none') then s ->> 'proof' end,
    'reason', case when s ->> 'reason' ~ '^[a-z_]{1,30}$' then s ->> 'reason' end,
    'note', private.strip_numbers(s ->> 'note', 200),
    'stop_label', private.strip_numbers(s ->> 'stop_label', 80),
    'route_label', private.strip_numbers(s ->> 'route_label', 60),
    'service_date', v_date::text,
    'slot', case when s ->> 'slot' in ('lunch', 'dinner') then s ->> 'slot' end
  );
  foreach k in array array['tiffins_out', 'tiffins_returned'] loop
    if jsonb_typeof(s -> k) = 'number' then
      v_out := v_out || jsonb_build_object(k, least(greatest(round((s ->> k)::numeric), 0), 99)::integer);
    end if;
  end loop;
  foreach k in array array['gps', 'offline', 'scanned'] loop
    if jsonb_typeof(s -> k) = 'boolean' then
      v_out := v_out || jsonb_build_object(k, s -> k);
    end if;
  end loop;
  return jsonb_strip_nulls(v_out);
end;
$$;

-- ---------------------------------------------------------------------------
-- The rider apps report a refused action. Idempotent per (rider, client op): the same report sent
-- again changes nothing; a newer refusal of the same action (the rider tried again) updates it,
-- counts it and opens it again.
-- Kitchen: the run's (or stop's) when it still exists, else p_kitchen (from the phone's cache),
-- else the caller's only rider/owner kitchen.
-- ---------------------------------------------------------------------------
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
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_stop is not null then
    select * into v_stop from public.delivery_stops where id = p_stop;
  end if;
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
  -- Everything named must belong to that kitchen (and the stop to that run).
  if (p_kitchen is not null and p_kitchen <> v_kitchen)
     or (v_stop.id is not null and v_stop.kitchen_id <> v_kitchen)
     or (v_run.id is not null and v_run.kitchen_id <> v_kitchen)
     or (v_stop.id is not null and p_run is not null and v_stop.run_id <> p_run) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_client_op is null or p_kind is null or p_kind not in ('start', 'complete', 'fail', 'finish') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if coalesce(p_cash_paise, 0) not between 0 and 10000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  select * into v_old from public.rider_sync_rejects where rider_id = v_uid and client_op = p_client_op for update;
  if v_old.id is not null then
    if v_old.kitchen_id <> v_kitchen then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if v_refused <= v_old.refused_at then
      return v_old.id;   -- the same report again (a retried request)
    end if;
    update public.rider_sync_rejects
    set error_code = coalesce(private.strip_numbers(p_error, 120), 'unknown'),
        summary = private.sync_reject_summary(p_summary), cash_paise = coalesce(p_cash_paise, 0),
        had_photo = coalesce(p_had_photo, false), refused_at = v_refused, reported_at = private.now(),
        reports = reports + 1, resolved_at = null, resolved_by = null, resolution_note = null,
        run_id = coalesce(v_run.id, run_id), stop_id = coalesce(v_stop.id, stop_id)
    where id = v_old.id;
    return v_old.id;
  end if;

  if (select count(*) from public.rider_sync_rejects
      where kitchen_id = v_kitchen and rider_id = v_uid and resolved_at is null) >= 500 then
    raise exception 'too_many_requests' using errcode = '22023';
  end if;
  insert into public.rider_sync_rejects (kitchen_id, rider_id, run_id, stop_id, client_op, action, error_code, summary,
                                         cash_paise, had_photo, acted_at, refused_at, reported_at)
  values (v_kitchen, v_uid, v_run.id, v_stop.id, p_client_op, p_kind, coalesce(private.strip_numbers(p_error, 120), 'unknown'),
          private.sync_reject_summary(p_summary), coalesce(p_cash_paise, 0), coalesce(p_had_photo, false),
          coalesce(p_acted_at, v_refused), v_refused, private.now())
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner list (open first; resolved ones on request). Platform admins may pass p_kitchen = null.
-- ---------------------------------------------------------------------------
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
  left join public.customers c on c.id = ds.customer_id and c.kitchen_id = r.kitchen_id
  left join public.delivery_runs dr on dr.id = r.run_id and dr.kitchen_id = r.kitchen_id
  left join public.delivery_routes rt on rt.id = dr.route_id and rt.kitchen_id = r.kitchen_id
  where (p_kitchen is null or r.kitchen_id = p_kitchen)
    and (coalesce(p_include_resolved, false) or r.resolved_at is null)
  order by (r.resolved_at is null) desc, r.reported_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- Owner (or the platform team) marks a report handled, with an optional note ("cash received").
create or replace function public.resolve_sync_reject(p_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.rider_sync_rejects;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_r from public.rider_sync_rejects where id = p_id for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.is_platform_admin() then
    perform private.require_role(v_r.kitchen_id, '{owner}');
  end if;
  if v_r.resolved_at is not null then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  if length(p_note) > 500 then
    raise exception 'invalid_message' using errcode = '22023';
  end if;
  update public.rider_sync_rejects
  set resolved_at = private.now(), resolved_by = auth.uid(), resolution_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_id;
end;
$$;

-- A later sync of the same action succeeded (the rider tapped "Try again"): close the report.
-- Fires only when complete_stop / fail_stop record a client op; never raises.
create or replace function private.close_synced_rejects()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    update public.rider_sync_rejects
    set resolved_at = private.now(), resolution_note = 'Synced later from the phone'
    where client_op = new.client_op_id and kitchen_id = new.kitchen_id and resolved_at is null;
  exception when others then
    raise warning 'could not close the rider sync report: %', sqlerrm;
  end;
  return null;
end;
$$;

create trigger delivery_stops_close_sync_rejects after update of client_op_id on public.delivery_stops
  for each row when (new.client_op_id is not null and old.client_op_id is distinct from new.client_op_id)
  execute function private.close_synced_rejects();

-- ---------------------------------------------------------------------------
-- Grants (fail-closed)
-- ---------------------------------------------------------------------------
revoke execute on function private.strip_numbers(text, integer), private.sync_reject_summary(jsonb),
  private.close_synced_rejects() from public, anon, authenticated;
revoke execute on function public.report_sync_reject(uuid, text, text, uuid, uuid, uuid, jsonb, integer, boolean, timestamptz, timestamptz),
  public.sync_rejects(uuid, boolean, integer), public.resolve_sync_reject(uuid, text) from public, anon;
grant execute on function public.report_sync_reject(uuid, text, text, uuid, uuid, uuid, jsonb, integer, boolean, timestamptz, timestamptz),
  public.sync_rejects(uuid, boolean, integer), public.resolve_sync_reject(uuid, text) to authenticated;
