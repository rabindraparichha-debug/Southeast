-- Vendor-first wave 3 (ops), item 31 (part 3): retention.
--
-- * platform_settings 'retention' (enabled = purges run; value = days per kind, admin-editable with
--   admin_set_retention). Defaults: proof photos 90 days, dispatch photos 30, notebook-import photos
--   7, finished outbox rows 90, pg_cron run log 14.
-- * private.purge_old_data() (pg_cron 'tiffin-purge', 03:00 IST, through private.run_job so it has a
--   heartbeat): deletes old cron.job_run_details rows and finished outbox rows. If wave 2's
--   notifications_outbox.expires_at exists, pending rows that expired before the outbox window are
--   deleted too (column checked at run time, dynamic SQL).
-- * Storage: SQL cannot delete storage objects (storage.protect_delete), so the storage-retention
--   Edge Function (pg_cron 'tiffin-storage-retention', 03:15 IST) asks ops_expired_objects() what to
--   delete (expired photos in proofs, dispatch and imports, plus the erasure queue), removes them with
--   the Storage API and reports back with ops_mark_purged() and ops_heartbeat(). Receipts and
--   purchase bills are money records and are kept.

insert into public.platform_settings (key, enabled, value)
values ('retention', true, jsonb_build_object(
  'proof_photo_days', 90, 'dispatch_photo_days', 30, 'import_photo_days', 7, 'outbox_days', 90, 'cron_log_days', 14))
on conflict (key) do nothing;

-- Days for one kind, clamped to sane bounds (falls back to the default if missing or invalid).
create or replace function private.retention_days(p_key text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_default integer := case p_key when 'proof_photo_days' then 90 when 'dispatch_photo_days' then 30
                                  when 'import_photo_days' then 7 when 'outbox_days' then 90 when 'cron_log_days' then 14 end;
  v_min integer := case p_key when 'proof_photo_days' then 7 when 'dispatch_photo_days' then 2
                              when 'import_photo_days' then 1 when 'outbox_days' then 7 when 'cron_log_days' then 2 end;
  v_raw jsonb;
begin
  if v_default is null then
    raise exception 'invalid_setting' using errcode = '22023';
  end if;
  select value -> p_key into v_raw from public.platform_settings where key = 'retention';
  if v_raw is null or jsonb_typeof(v_raw) <> 'number' then
    return v_default;
  end if;
  return least(greatest((v_raw #>> '{}')::numeric::integer, v_min), 3650);
end;
$$;

create or replace function private.purge_old_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.now();
  v_cron integer := 0;
  v_outbox integer := 0;
  v_expired integer := 0;
  v_outbox_cut timestamptz;
begin
  if not private.feature_enabled('retention') then
    return jsonb_build_object('skipped', true);
  end if;

  delete from cron.job_run_details
  where coalesce(end_time, start_time) < v_now - make_interval(days => private.retention_days('cron_log_days'));
  get diagnostics v_cron = row_count;

  v_outbox_cut := v_now - make_interval(days => private.retention_days('outbox_days'));
  delete from public.notifications_outbox
  where created_at < v_outbox_cut and status not in ('pending', 'sending');
  get diagnostics v_outbox = row_count;

  -- Wave 2 adds expires_at: rows that expired unsent are finished too.
  if exists (select 1 from pg_attribute where attrelid = 'public.notifications_outbox'::regclass
             and attname = 'expires_at' and not attisdropped) then
    execute 'delete from public.notifications_outbox where status = ''pending'' and expires_at < $1 and created_at < $1'
      using v_outbox_cut;
    get diagnostics v_expired = row_count;
  end if;

  return jsonb_build_object('cron_runs', v_cron, 'outbox', v_outbox + v_expired);
end;
$$;

select cron.schedule('tiffin-purge', '30 21 * * *', $$select private.run_job('tiffin-purge')$$);                       -- 03:00 IST
select cron.schedule('tiffin-storage-retention', '45 21 * * *', $$select private.kick_function('storage-retention')$$); -- 03:15 IST

-- ---------------------------------------------------------------------------
-- Storage retention (service role, called by the storage-retention Edge Function)
-- ---------------------------------------------------------------------------
-- What to delete next: the erasure queue first, then expired photos. p_now and p_prefix exist for
-- ops re-runs and tests (they only shift the clock or narrow the set).
create or replace function public.ops_expired_objects(p_limit integer default 500, p_now timestamptz default null,
  p_prefix text default null)
returns table (bucket text, name text, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, private.now());
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_on boolean := private.feature_enabled('retention');
begin
  return query
  select x.bucket, x.name, x.reason from (
    (select q.bucket, q.name, q.reason, 0 as pri, q.queued_at as ts
     from public.storage_purge_queue q
     where p_prefix is null or q.name like p_prefix || '%'
     order by q.queued_at limit v_limit)
    union all
    (select o.bucket_id, o.name, 'retention', 1, o.created_at
     from storage.objects o
     where v_on and o.name is not null and (p_prefix is null or o.name like p_prefix || '%')
       and ((o.bucket_id = 'proofs' and o.created_at < v_now - make_interval(days => private.retention_days('proof_photo_days')))
            or (o.bucket_id = 'dispatch' and o.created_at < v_now - make_interval(days => private.retention_days('dispatch_photo_days')))
            or (o.bucket_id = 'imports' and o.created_at < v_now - make_interval(days => private.retention_days('import_photo_days'))))
     limit v_limit)
  ) x
  order by x.pri, x.ts
  limit v_limit;
end;
$$;

-- After the Storage API removed them: drop them from the erasure queue.
create or replace function public.ops_mark_purged(p_bucket text, p_names text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.storage_purge_queue where bucket = p_bucket and name = any (coalesce(p_names, '{}'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Heartbeat for jobs that run outside the database (Edge Functions started by pg_cron).
create or replace function public.ops_heartbeat(p_job text, p_result jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job is distinct from 'tiffin-storage-retention' then
    raise exception 'unknown_job' using errcode = '22023';
  end if;
  perform private.record_heartbeat(p_job, clock_timestamp(), p_result);
end;
$$;

-- Admin: change retention days (merged into the current values) or switch purges off/on.
create or replace function public.admin_set_retention(p_values jsonb default null, p_enabled boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_val jsonb;
  v_clean jsonb := '{}'::jsonb;
begin
  perform private.require_admin();
  if p_values is not null and jsonb_typeof(p_values) <> 'object' then
    raise exception 'invalid_setting' using errcode = '22023';
  end if;
  for v_key, v_val in select e.key, e.value from jsonb_each(coalesce(p_values, '{}'::jsonb)) e loop
    if v_key not in ('proof_photo_days', 'dispatch_photo_days', 'import_photo_days', 'outbox_days', 'cron_log_days')
       or jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric <> trunc((v_val #>> '{}')::numeric)
       or (v_val #>> '{}')::numeric not between 1 and 3650 then
      raise exception 'invalid_setting' using errcode = '22023';
    end if;
    v_clean := v_clean || jsonb_build_object(v_key, (v_val #>> '{}')::integer);
  end loop;
  update public.platform_settings
  set value = value || v_clean, enabled = coalesce(p_enabled, enabled), updated_by = auth.uid()
  where key = 'retention';
  return (select jsonb_build_object('enabled', enabled, 'proof_photo_days', private.retention_days('proof_photo_days'),
            'dispatch_photo_days', private.retention_days('dispatch_photo_days'),
            'import_photo_days', private.retention_days('import_photo_days'),
            'outbox_days', private.retention_days('outbox_days'), 'cron_log_days', private.retention_days('cron_log_days'))
          from public.platform_settings where key = 'retention');
end;
$$;

revoke execute on function private.retention_days, private.purge_old_data from public, anon, authenticated;
revoke execute on function public.ops_expired_objects, public.ops_mark_purged, public.ops_heartbeat, public.admin_set_retention
  from public, anon, authenticated;
grant execute on function public.ops_expired_objects, public.ops_mark_purged, public.ops_heartbeat to service_role;
grant execute on function public.admin_set_retention to authenticated;
