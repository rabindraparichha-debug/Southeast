-- Vendor-first wave 3 (ops), item 30: make engine health visible.
--
-- * engine_heartbeats: one row per scheduled engine job, stamped at the end of every successful run
--   (private.run_job wraps the job; a failed run rolls back, so last_ok_at goes stale and pg_cron
--   logs the failure in cron.job_run_details as before: no error is swallowed).
-- * private.engine_health(): critical jobs scheduled and fresh, slots past their cutoff with orders
--   but no count snapshot ("count not frozen"), tiffin-* jobs whose latest run failed, and wave 1's
--   engine_errors table when it exists (to_regclass guard + dynamic SQL, so this works with or
--   without it).
-- * public.engine_health() for the admin tile, public.ops_health() (service role, no names or ids)
--   for the ops-health Edge Function and a free uptime pinger.
-- * public.freeze_slot(): "Freeze now" for an owner when a slot's cutoff passed without a lock.
--   It goes through the one lock path (private.lock_slot, idempotent) and the same balance sync
--   the lock job runs; it never posts meal entries itself.

-- ---------------------------------------------------------------------------
-- Heartbeats
-- ---------------------------------------------------------------------------
create table public.engine_heartbeats (
  job text primary key check (job ~ '^[a-z0-9-]{3,60}$'),
  last_ok_at timestamptz,
  last_duration_ms integer,
  last_result jsonb,
  ok_count bigint not null default 0,
  created_at timestamptz not null default now()
);
-- Read through engine_health() / ops_health() only: RLS on, no policies, no grants.
alter table public.engine_heartbeats enable row level security;
revoke all on public.engine_heartbeats from anon, authenticated;

-- The jobs the health check expects. Critical ones make the platform unhealthy when stale.
create or replace function private.engine_jobs()
returns table (job text, critical boolean, max_age interval)
language sql
immutable
set search_path = ''
as $$
  values ('tiffin-lock-due-slots', true, interval '5 minutes'),
         ('tiffin-nightly', true, interval '26 hours'),
         ('tiffin-owner-summary', true, interval '26 hours'),
         ('tiffin-purge', false, interval '26 hours'),
         ('tiffin-storage-retention', false, interval '26 hours');
$$;

insert into public.engine_heartbeats (job) select j.job from private.engine_jobs() j on conflict do nothing;

create or replace function private.record_heartbeat(p_job text, p_started timestamptz, p_result jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.engine_heartbeats (job, last_ok_at, last_duration_ms, last_result, ok_count)
  values (p_job, private.now(), greatest(0, (extract(epoch from clock_timestamp() - p_started) * 1000)::integer), p_result, 1)
  on conflict (job) do update
    set last_ok_at = excluded.last_ok_at, last_duration_ms = excluded.last_duration_ms,
        last_result = excluded.last_result, ok_count = public.engine_heartbeats.ok_count + 1;
$$;

-- pg_cron entry point for the engine jobs. Calls the job by name (whatever version the latest
-- migration defines) and stamps the heartbeat only if it finished.
create or replace function private.run_job(p_job text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t0 timestamptz := clock_timestamp();
  v_result jsonb;
begin
  case p_job
    when 'tiffin-lock-due-slots' then perform private.run_due_locks();
    when 'tiffin-nightly' then perform private.nightly();
    when 'tiffin-owner-summary' then perform private.queue_owner_summaries();
    when 'tiffin-purge' then v_result := private.purge_old_data();   -- defined by the retention migration
    else raise exception 'unknown_job' using errcode = '22023';
  end case;
  perform private.record_heartbeat(p_job, v_t0, v_result);
end;
$$;

select cron.schedule('tiffin-lock-due-slots', '* * * * *', $$select private.run_job('tiffin-lock-due-slots')$$);
select cron.schedule('tiffin-nightly', '0 19 * * *', $$select private.run_job('tiffin-nightly')$$);              -- 00:30 IST
select cron.schedule('tiffin-owner-summary', '30 16 * * *', $$select private.run_job('tiffin-owner-summary')$$); -- 22:00 IST

-- ---------------------------------------------------------------------------
-- Health
-- ---------------------------------------------------------------------------
-- Slots whose cutoff passed (5-minute grace for the minute job) with counted, unlocked orders and no
-- count snapshot, in non-suspended kitchens, for the last 7 days and tomorrow.
create or replace function private.overdue_slots(p_kitchen uuid default null)
returns table (kitchen_id uuid, kitchen_name text, service_date date, slot public.meal_slot, cutoff_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select k.id, k.name, d.d::date, sl.slot, private.cutoff_at(k, d.d::date, sl.slot)
  from public.kitchens k
  cross join generate_series(private.ist_today() - 7, private.ist_today() + 1, interval '1 day') as d(d)
  cross join unnest(enum_range(null::public.meal_slot)) as sl(slot)
  where k.status <> 'suspended'
    and (p_kitchen is null or k.id = p_kitchen)
    and private.cutoff_at(k, d.d::date, sl.slot) <= private.now() - interval '5 minutes'
    and not exists (select 1 from public.count_snapshots cs
                    where cs.kitchen_id = k.id and cs.service_date = d.d::date and cs.slot = sl.slot)
    and exists (select 1 from public.meal_orders o
                where o.kitchen_id = k.id and o.service_date = d.d::date and o.slot = sl.slot
                  and o.locked_at is null and (o.status <> 'skipped' or o.charged))
  order by d.d, sl.slot, k.name;
$$;

-- Wave 1's engine_errors: one open row (resolved_at is null) per failing kitchen/job/date/slot,
-- last_seen_at bumped on every retry, resolved when the same work later succeeds or dismissed by the
-- owner/admin. The engine catches these failures (nightly steps, lock, run building, stock use), so
-- pg_cron sees success and the heartbeat stays fresh: an open row is the only trace. Any open row seen
-- in the last 26 hours makes the platform unhealthy (a daily step that failed at 00:30 stays red until
-- the next night or a fix); older open rows still show on the admin tile.
create or replace function private.engine_error_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := private.now() - interval '26 hours';
  v_open bigint;
  v_recent bigint;
  v_by_job jsonb;
  v_items jsonb;
begin
  select count(*), count(*) filter (where e.last_seen_at > v_since)
  into v_open, v_recent
  from public.engine_errors e where e.resolved_at is null;

  select coalesce(jsonb_object_agg(x.job, x.n), '{}'::jsonb) into v_by_job
  from (select e.job, count(*) as n from public.engine_errors e
        where e.resolved_at is null and e.last_seen_at > v_since group by e.job) x;

  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kitchen_id', i.kitchen_id, 'kitchen', k.name, 'job', i.job,
           'service_date', i.service_date, 'slot', i.slot, 'message', left(i.message, 300), 'attempts', i.attempts,
           'first_seen_at', i.first_seen_at, 'last_seen_at', i.last_seen_at) order by i.last_seen_at desc), '[]'::jsonb)
  into v_items
  from (select * from public.engine_errors e where e.resolved_at is null order by e.last_seen_at desc limit 20) i
  left join public.kitchens k on k.id = i.kitchen_id;

  return jsonb_build_object('tracked', true, 'window_hours', 26, 'open', v_open, 'recent', v_recent,
                            'by_job', v_by_job, 'items', v_items);
end;
$$;

create or replace function private.engine_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.now();
  v_jobs jsonb;
  v_overdue jsonb;
  v_overdue_n integer;
  v_failing jsonb;
  v_failing_n integer;
  v_fail_24h bigint;
  v_errors jsonb := private.engine_error_counts();
  v_ok boolean;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'job', j.job, 'critical', j.critical, 'max_age_minutes', extract(epoch from j.max_age)::integer / 60,
           'scheduled', cj.jobid is not null, 'active', coalesce(cj.active, false), 'schedule', cj.schedule,
           'last_ok_at', h.last_ok_at, 'last_duration_ms', h.last_duration_ms, 'last_result', h.last_result,
           'stale', coalesce(h.last_ok_at, h.created_at, v_now) < v_now - j.max_age,
           'healthy', cj.jobid is not null and coalesce(cj.active, false)
                      and coalesce(h.last_ok_at, h.created_at, v_now) >= v_now - j.max_age)
         order by j.critical desc, j.job), '[]'::jsonb)
  into v_jobs
  from private.engine_jobs() j
  left join public.engine_heartbeats h on h.job = j.job
  left join cron.job cj on cj.jobname = j.job;

  select count(*), coalesce(jsonb_agg(jsonb_build_object('kitchen_id', o.kitchen_id, 'kitchen', o.kitchen_name,
           'service_date', o.service_date, 'slot', o.slot, 'cutoff_at', o.cutoff_at)) filter (where o.rn <= 20), '[]'::jsonb)
  into v_overdue_n, v_overdue
  from (select x.*, row_number() over (order by x.service_date, x.slot, x.kitchen_name) as rn from private.overdue_slots() x) o;

  -- Latest finished run of every tiffin-* job. A failure is cleared by the next successful run, or by
  -- a heartbeat stamped after it (a manual private.run_job rerun writes no cron log row). Only the
  -- critical engine jobs make the platform unhealthy; other failed jobs are warnings on the tile.
  select count(*) filter (where f.critical), coalesce(jsonb_agg(jsonb_build_object('job', f.jobname, 'at', f.start_time,
           'critical', f.critical, 'message', left(coalesce(f.return_message, ''), 300)) order by f.jobname), '[]'::jsonb)
  into v_failing_n, v_failing
  from (select j.jobname, d.start_time, d.return_message,
               coalesce((select ej.critical from private.engine_jobs() ej where ej.job = j.jobname), false) as critical
        from cron.job j
        cross join lateral (select r.status, r.return_message, r.start_time from cron.job_run_details r
                            where r.jobid = j.jobid and r.status in ('succeeded', 'failed')
                            order by r.runid desc limit 1) d
        left join public.engine_heartbeats h on h.job = j.jobname
        where j.jobname like 'tiffin-%' and d.status = 'failed'
          and not coalesce(h.last_ok_at > d.start_time, false)) f;

  select count(*) into v_fail_24h
  from cron.job_run_details r join cron.job j on j.jobid = r.jobid
  where j.jobname like 'tiffin-%' and r.status = 'failed' and r.start_time > v_now - interval '24 hours';

  v_ok := not exists (select 1 from jsonb_array_elements(v_jobs) e
                      where (e ->> 'critical')::boolean and not (e ->> 'healthy')::boolean)
          and v_overdue_n = 0 and v_failing_n = 0 and (v_errors ->> 'recent')::bigint = 0;

  return jsonb_build_object(
    'ok', v_ok,
    'checked_at', v_now,
    'jobs', v_jobs,
    'overdue_slots', jsonb_build_object('count', v_overdue_n, 'items', v_overdue),
    'cron', jsonb_build_object('failing', v_failing, 'failures_24h', v_fail_24h),
    'engine_errors', v_errors
  );
end;
$$;

-- Admin tile.
create or replace function public.engine_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return private.engine_health();
end;
$$;

-- For the ops-health Edge Function (service role): booleans and counts only, no names or ids.
create or replace function public.ops_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb := private.engine_health();
  v_job jsonb := coalesce((select jsonb_object_agg(e ->> 'job', (e ->> 'healthy')::boolean)
                           from jsonb_array_elements(v -> 'jobs') e where (e ->> 'critical')::boolean), '{}'::jsonb);
begin
  return jsonb_build_object(
    'ok', (v ->> 'ok')::boolean,
    'checked_at', v -> 'checked_at',
    'checks', jsonb_build_object(
      'lock_job', coalesce((v_job ->> 'tiffin-lock-due-slots')::boolean, false),
      'nightly_job', coalesce((v_job ->> 'tiffin-nightly')::boolean, false),
      'summary_job', coalesce((v_job ->> 'tiffin-owner-summary')::boolean, false),
      'overdue_slots', (v -> 'overdue_slots' ->> 'count')::integer,
      'failing_jobs', (select count(*) from jsonb_array_elements(v -> 'cron' -> 'failing') e where (e ->> 'critical')::boolean),
      'job_warnings', (select count(*) from jsonb_array_elements(v -> 'cron' -> 'failing') e where not (e ->> 'critical')::boolean),
      'engine_errors', (v -> 'engine_errors' ->> 'recent')::bigint));
end;
$$;

-- ---------------------------------------------------------------------------
-- Freeze now (owner): lock a slot whose cutoff passed but which the engine has not locked.
-- ---------------------------------------------------------------------------
create or replace function public.freeze_slot(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_k public.kitchens;
  v_existing uuid;
  v_snap uuid;
begin
  perform private.require_role(p_kitchen, '{owner}');
  if p_date is null or p_slot is null then
    raise exception 'date_required' using errcode = '22023';
  end if;
  select * into v_k from public.kitchens where id = p_kitchen;
  if v_k.status = 'suspended' then
    raise exception 'kitchen_suspended' using errcode = '42501';
  end if;
  if private.cutoff_at(v_k, p_date, p_slot) > private.now() then
    raise exception 'before_cutoff' using errcode = '22023';
  end if;
  if p_date < private.ist_today() - 7 then
    raise exception 'out_of_range' using errcode = '22023';
  end if;
  select id into v_existing from public.count_snapshots
  where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot;
  v_snap := private.lock_slot(p_kitchen, p_date, p_slot);
  if v_existing is null then
    -- Same follow-up as the lock job: meals just charged may change balance states.
    perform private.sync_balance_status(p_kitchen, null);
  end if;
  -- As run_due_locks does after a lock: the slot is locked now, so its lock error (if any) is closed.
  -- run_due_locks never revisits a slot with a snapshot, so nothing else would close it.
  perform private.resolve_engine_errors(p_kitchen, 'lock', p_date, p_slot);
  return jsonb_build_object('snapshot_id', v_snap, 'already_locked', v_existing is not null,
    'locked_at', (select cs.locked_at from public.count_snapshots cs where cs.id = v_snap));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (fail closed)
-- ---------------------------------------------------------------------------
revoke execute on function private.engine_jobs, private.record_heartbeat, private.run_job, private.overdue_slots,
  private.engine_error_counts, private.engine_health from public, anon, authenticated;
revoke execute on function public.engine_health, public.ops_health, public.freeze_slot from public, anon, authenticated;
grant execute on function public.engine_health, public.freeze_slot to authenticated;
grant execute on function public.ops_health to service_role;
