-- Vendor-first wave 1 (docs/VENDOR_FIRST_AUDIT.md "Recommended work order", items 8, 11, 12 and
-- 14-19; owner decision D-116). Phase 1 automates the vendor; customers stay offline.
--
--  8  rider_today: otp_sent only when the code message was really sent.
-- 11  Changes the vendor enters use the slot's real cutoff (the 19:00 phone-close rule is gone).
-- 12  The minute lock job handles errors per kitchen, catches up 7 days, and records failures in
--     the new engine_errors table (also run building, stock use and the nightly job). Cancelling a
--     subscription freezes and charges only that subscription's due meals.
-- 14  A dated permanent address move no longer redirects earlier meals; the first address fills
--     subscriptions that have none; set_default_address can apply a new default to subscriptions.
-- 15  'revoke' undoes one specific skip or pause; a resume honours its end date; holds list.
-- 16  reactivate_subscription.
-- 17  kitchen_closures (a day, or one meal of a day) and weekly off per meal.
-- 18  Changes after the lock reach the runs and the rider (pending stops of runs already out
--     too); office stops no longer break run building; rider_today flags changed stops.
-- 19  A meal skipped after the lock stays charged by default; "don't charge" posts one
--     idempotent credit linked to that meal, and the stop leaves the run.

-- ===========================================================================
-- Engine errors (item 12). One open row per kitchen/job/date/slot; repeats bump attempts.
-- Resolved automatically when the same work later succeeds, or dismissed by the owner/admin.
-- ===========================================================================
create table public.engine_errors (
  id bigint generated always as identity primary key,
  kitchen_id uuid references public.kitchens (id) on delete cascade,   -- null: a platform-wide step
  job text not null check (job in ('lock', 'build_runs', 'consume', 'nightly_status', 'nightly_balance',
                                   'nightly_cancel', 'nightly_refresh', 'nightly_reminders')),
  service_date date,
  slot public.meal_slot,
  sqlstate text,
  message text not null,
  attempts integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id)
);
create unique index engine_errors_open_idx on public.engine_errors (kitchen_id, job, service_date, slot)
  nulls not distinct where resolved_at is null;
create index engine_errors_kitchen_idx on public.engine_errors (kitchen_id, last_seen_at desc);

alter table public.engine_errors enable row level security;
-- Owner and staff see their kitchen's engine problems (staff press "Plan / refresh runs" too).
create policy engine_errors_select on public.engine_errors for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
revoke all on public.engine_errors from anon, authenticated;
grant select on public.engine_errors to authenticated;

-- Record a failure. Never raises: it is called from exception handlers on the lock path.
create or replace function private.record_engine_error(p_kitchen uuid, p_job text, p_date date, p_slot public.meal_slot,
                                                       p_sqlstate text, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise warning 'engine % failed for % % %: % (%)', p_job, p_kitchen, p_date, p_slot, p_message, p_sqlstate;
  begin
    insert into public.engine_errors (kitchen_id, job, service_date, slot, sqlstate, message, first_seen_at, last_seen_at)
    values (p_kitchen, p_job, p_date, p_slot, p_sqlstate, left(coalesce(p_message, 'unknown error'), 1000),
            private.now(), private.now())
    on conflict (kitchen_id, job, service_date, slot) where resolved_at is null do update
      set attempts = public.engine_errors.attempts + 1, last_seen_at = excluded.last_seen_at,
          sqlstate = excluded.sqlstate, message = excluded.message;
  exception when others then
    raise warning 'could not record the engine error: %', sqlerrm;
  end;
end;
$$;

-- The same work succeeded: close its open error (cheap: partial unique index).
create or replace function private.resolve_engine_errors(p_kitchen uuid, p_job text, p_date date, p_slot public.meal_slot)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.engine_errors set resolved_at = private.now()
  where resolved_at is null and kitchen_id is not distinct from p_kitchen and job = p_job
    and service_date is not distinct from p_date and slot is not distinct from p_slot;
$$;

-- Owner (or the platform team) dismisses an error that needs no retry.
create or replace function public.dismiss_engine_error(p_error bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.engine_errors where id = p_error;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.is_platform_admin() then
    perform private.require_role(v_kitchen, '{owner}');
  end if;
  update public.engine_errors set resolved_at = private.now(), resolved_by = auth.uid()
  where id = p_error and resolved_at is null;
end;
$$;

-- ===========================================================================
-- New columns
-- ===========================================================================
-- Item 15: a revoke row points at the skip or pause it undoes.
alter table public.schedule_changes add column revokes_change_id uuid references public.schedule_changes (id);
alter table public.schedule_changes add constraint schedule_changes_revoke_check
  check ((type = 'revoke') = (revokes_change_id is not null));
create unique index schedule_changes_revokes_idx on public.schedule_changes (revokes_change_id) where revokes_change_id is not null;

-- Item 19: a late skip whose charge the vendor waived ("don't charge"): the meal stays counted and
-- charged at lock, and one credit linked to it gives it back.
alter table public.meal_orders add column charge_waived boolean not null default false;
grant select (charge_waived) on public.meal_orders to authenticated;

-- Item 18: a stop added or changed after its run was built (shown to the rider as "changed").
alter table public.delivery_stops add column changed_at timestamptz;
grant select (changed_at) on public.delivery_stops to authenticated;

-- Item 17: weekly off for one meal ("Sunday dinner off"), on top of whole-day weekly_off.
alter table public.kitchens
  add column weekly_off_lunch smallint[] not null default '{}'
    check (weekly_off_lunch <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  add column weekly_off_dinner smallint[] not null default '{}'
    check (weekly_off_dinner <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]);
grant update (weekly_off_lunch, weekly_off_dinner) on public.kitchens to authenticated;

-- Item 11 / D-116: no longer used (vendor-entered changes follow the slot cutoff). Kept so older
-- app builds that still save the settings form keep working.
comment on column public.kitchen_settings.phone_pause_close_time is
  'Unused since D-116: vendor-entered changes use the slot cutoff. Kept for older app builds.';

-- ===========================================================================
-- Kitchen closures (item 17): no meals are generated, cooked or charged on a closed day/meal.
-- ===========================================================================
create table public.kitchen_closures (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  closed_on date not null,
  slot public.meal_slot,                -- null = the whole day
  reason text check (reason is null or length(reason) <= 200),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kitchen_closures_unique unique nulls not distinct (kitchen_id, closed_on, slot)
);
create trigger kitchen_closures_updated_at before update on public.kitchen_closures
  for each row execute function private.set_updated_at();
create trigger kitchen_closures_audit after insert or update or delete on public.kitchen_closures
  for each row execute function private.audit_row();

alter table public.kitchen_closures enable row level security;
create policy kitchen_closures_select on public.kitchen_closures for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
revoke all on public.kitchen_closures from anon, authenticated;
grant select on public.kitchen_closures to authenticated;

-- ===========================================================================
-- Holds (item 15). A revoked skip/pause no longer holds anything. A resume ends every hold
-- requested before it that had already started by the resume date, for dates on or after the
-- resume date and, if the resume has an end date, up to it (D-032).
-- ===========================================================================
create or replace function private.active_hold(p_subscription uuid, p_date date, p_slot public.meal_slot)
returns table (reason text, change_id uuid)
language sql
stable
set search_path = ''
as $$
  select c.type::text, c.id
  from public.schedule_changes c
  where c.subscription_id = p_subscription
    and c.type in ('skip', 'pause')
    and c.from_date <= p_date
    and (c.to_date is null or c.to_date >= p_date)
    and (c.slot is null or c.slot = p_slot)
    and not exists (select 1 from public.schedule_changes x where x.revokes_change_id = c.id)
    and not exists (
      select 1 from public.schedule_changes r
      where r.subscription_id = p_subscription
        and r.type = 'resume'
        and r.requested_at > c.requested_at
        and r.from_date <= p_date
        and (r.to_date is null or r.to_date >= p_date)
        and c.from_date <= r.from_date
        and (r.slot is null or r.slot = p_slot)
    )
  order by c.requested_at desc
  limit 1;
$$;

-- The same, as if p_ignore were already revoked (preview of an undo).
create or replace function private.active_hold(p_subscription uuid, p_date date, p_slot public.meal_slot, p_ignore uuid)
returns table (reason text, change_id uuid)
language sql
stable
set search_path = ''
as $$
  select c.type::text, c.id
  from public.schedule_changes c
  where c.subscription_id = p_subscription
    and c.id <> p_ignore
    and c.type in ('skip', 'pause')
    and c.from_date <= p_date
    and (c.to_date is null or c.to_date >= p_date)
    and (c.slot is null or c.slot = p_slot)
    and not exists (select 1 from public.schedule_changes x where x.revokes_change_id = c.id)
    and not exists (
      select 1 from public.schedule_changes r
      where r.subscription_id = p_subscription
        and r.type = 'resume'
        and r.requested_at > c.requested_at
        and r.from_date <= p_date
        and (r.to_date is null or r.to_date >= p_date)
        and c.from_date <= r.from_date
        and (r.slot is null or r.slot = p_slot)
    )
  order by c.requested_at desc
  limit 1;
$$;

-- ===========================================================================
-- Reconcile meal_orders (M2/P5) — now with closures, weekly off per meal and an address fallback
-- (the customer's default address when the subscription has none). Frozen slots never change.
-- ===========================================================================
create or replace function private.refresh_orders(
  p_kitchen uuid default null,
  p_subscription uuid default null,
  p_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_now timestamptz := private.now();
  v_total integer := 0;
  v_n integer;
begin
  drop table if exists pg_temp._desired;
  create temp table _desired on commit drop as
  select s.id as subscription_id, s.kitchen_id, s.customer_id, s.plan_id, d.d::date as service_date, sl.slot,
         s.qty,
         case when vo.veg then 'veg'::public.diet_type else p.diet end as diet,
         vo.veg as veg_override,
         coalesce(private.address_for(s.id, d.d::date, sl.slot), s.address_id,
                  (select a.id from public.addresses a where a.customer_id = s.customer_id
                   order by a.is_default desc, a.created_at desc limit 1)) as address_id,
         h.reason as skip_reason, h.change_id
  from public.subscriptions s
  join public.plans p on p.id = s.plan_id
  join public.kitchens k on k.id = s.kitchen_id
  join public.customers cu on cu.id = s.customer_id
  left join public.kitchen_settings ks on ks.kitchen_id = s.kitchen_id
  cross join generate_series(v_today, v_today + p_days - 1, interval '1 day') as d(d)
  cross join unnest(p.slots) as sl(slot)
  cross join lateral (
    select p.diet = 'nonveg' and (cu.observes_veg_days or cu.observes_kartika)
           and private.is_veg_day(ks, cu.observes_veg_days, cu.observes_kartika, d.d::date) as veg
  ) vo
  left join lateral private.active_hold(s.id, d.d::date, sl.slot) h on true
  where s.status in ('active', 'low_balance', 'paused')
    and k.status <> 'suspended'
    and (p_kitchen is null or s.kitchen_id = p_kitchen)
    and (p_subscription is null or s.id = p_subscription)
    and d.d::date >= s.start_date
    and (s.end_date is null or d.d::date <= s.end_date)
    and extract(isodow from d.d)::smallint = any (p.days_of_week)
    and not (extract(isodow from d.d)::smallint = any (k.weekly_off))
    and not (extract(isodow from d.d)::smallint = any (case sl.slot when 'lunch' then k.weekly_off_lunch
                                                                    else k.weekly_off_dinner end))
    and not exists (select 1 from public.kitchen_closures kc
                    where kc.kitchen_id = s.kitchen_id and kc.closed_on = d.d::date
                      and (kc.slot is null or kc.slot = sl.slot))
    and v_now < private.cutoff_at(k, d.d::date, sl.slot)
    and not exists (select 1 from public.count_snapshots cs
                    where cs.kitchen_id = s.kitchen_id and cs.service_date = d.d::date and cs.slot = sl.slot);

  insert into public.meal_orders (kitchen_id, subscription_id, customer_id, plan_id, service_date, slot, qty, diet,
                                  veg_override, address_id, status, skip_reason, change_id)
  select kitchen_id, subscription_id, customer_id, plan_id, service_date, slot, qty, diet, coalesce(veg_override, false),
         address_id, case when skip_reason is null then 'scheduled' else 'skipped' end::public.order_status, skip_reason, change_id
  from _desired
  on conflict (subscription_id, service_date, slot) do update set
    plan_id = excluded.plan_id,
    qty = excluded.qty,
    diet = excluded.diet,
    veg_override = excluded.veg_override,
    address_id = excluded.address_id,
    status = excluded.status,
    skip_reason = excluded.skip_reason,
    change_id = coalesce(excluded.change_id, public.meal_orders.change_id),
    -- A late (charged) skip stays charged while the hold stands; un-holding clears it.
    charged = case when excluded.status = 'skipped' then public.meal_orders.charged else false end
  where public.meal_orders.locked_at is null
    and public.meal_orders.status in ('scheduled', 'skipped')
    and (public.meal_orders.plan_id, public.meal_orders.qty, public.meal_orders.diet, public.meal_orders.veg_override,
         public.meal_orders.address_id, public.meal_orders.status, public.meal_orders.skip_reason)
        is distinct from
        (excluded.plan_id, excluded.qty, excluded.diet, excluded.veg_override, excluded.address_id, excluded.status,
         excluded.skip_reason);
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  -- Remove unlocked, unfrozen orders that are no longer wanted (ended, cancelled, closed…).
  delete from public.meal_orders o
  using public.kitchens k
  where k.id = o.kitchen_id
    and (p_kitchen is null or o.kitchen_id = p_kitchen)
    and (p_subscription is null or o.subscription_id = p_subscription)
    and o.service_date between v_today and v_today + p_days - 1
    and o.locked_at is null
    and o.status in ('scheduled', 'skipped')
    and v_now < private.cutoff_at(k, o.service_date, o.slot)
    and not exists (select 1 from public.count_snapshots cs
                    where cs.kitchen_id = o.kitchen_id and cs.service_date = o.service_date and cs.slot = o.slot)
    and not exists (select 1 from _desired d
                    where d.subscription_id = o.subscription_id and d.service_date = o.service_date and d.slot = o.slot);
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  drop table if exists pg_temp._desired;
  return v_total;
end;
$$;

-- Weekly off per meal also regenerates orders.
drop trigger kitchens_refresh on public.kitchens;
create trigger kitchens_refresh after update of weekly_off, weekly_off_lunch, weekly_off_dinner, cutoff_lunch,
  cutoff_lunch_prev_day, cutoff_dinner, cutoff_dinner_prev_day, status on public.kitchens
  for each row execute function private.kitchens_refresh_orders();

-- ===========================================================================
-- Freezing and charging (the only path that posts 'meal' entries). The lock calls it for the
-- whole slot; a cancellation calls it for that subscription's due meals only (item 12).
-- ===========================================================================
create or replace function private.charge_orders(p_kitchen uuid, p_date date, p_slot public.meal_slot,
                                                 p_subscription uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.now();
  v_n integer;
begin
  update public.meal_orders o
  set status = case when o.status = 'scheduled' then 'locked'::public.order_status else o.status end,
      locked_at = v_now,
      price_per_meal_paise = p.price_per_meal_paise
  from public.plans p
  where p.id = o.plan_id and o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
    and o.locked_at is null and (p_subscription is null or o.subscription_id = p_subscription);

  -- Balance belongs to the eater; one entry per counted order (unique on the order).
  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, created_at)
  select o.kitchen_id, o.customer_id, 'meal', -o.qty, -(o.qty * o.price_per_meal_paise), 'meal_order', o.id, v_now
  from public.meal_orders o
  where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
    and (p_subscription is null or o.subscription_id = p_subscription)
    and (o.status <> 'skipped' or o.charged)
  on conflict (type, ref_type, ref_id) where ref_id is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Lock one slot (M2). Idempotent. A closed slot cooks nothing: meals not yet frozen are dropped
-- and never charged (closures can only be set before the cutoff, so this is a safety net).
create or replace function private.lock_slot(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.now();
  v_snapshot uuid;
  v_totals jsonb;
  v_closed boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('lock:' || p_kitchen || ':' || p_date || ':' || p_slot, 0));

  select id into v_snapshot from public.count_snapshots
  where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot;
  if v_snapshot is not null then
    return v_snapshot;
  end if;

  v_closed := exists (select 1 from public.kitchen_closures kc
                      where kc.kitchen_id = p_kitchen and kc.closed_on = p_date and (kc.slot is null or kc.slot = p_slot));
  if v_closed then
    delete from public.meal_orders o
    where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot and o.locked_at is null;
  end if;

  perform private.charge_orders(p_kitchen, p_date, p_slot, null);

  v_totals := private.slot_totals(p_kitchen, p_date, p_slot);
  if v_closed then
    v_totals := v_totals || jsonb_build_object('closed', true);
  end if;

  insert into public.count_snapshots (kitchen_id, service_date, slot, totals, locked_at)
  values (p_kitchen, p_date, p_slot, v_totals, v_now)
  returning id into v_snapshot;

  -- Production sheet for the owner (not for slots caught up after an outage).
  if (v_totals ->> 'orders')::integer > 0 and p_date >= private.ist_today() then
    insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
    select p_kitchen, 'whatsapp', 'member', m.user_id, 'production_sheet',
           jsonb_build_object('service_date', p_date, 'slot', p_slot, 'totals', v_totals),
           'production_sheet:' || p_kitchen || ':' || p_date || ':' || p_slot || ':' || m.user_id
    from public.members m
    where m.kitchen_id = p_kitchen and m.role = 'owner'
    on conflict (dedupe_key) do nothing;
  end if;

  return v_snapshot;
end;
$$;

-- Every minute: lock every slot whose cutoff has passed. Each slot runs in its own subtransaction,
-- so one kitchen's error never blocks the others; a failing kitchen skips its later slots this
-- minute (they are retried next minute, in order) and the failure is recorded. Catch-up: yesterday
-- and tomorrow always (D-040: every slot past its cutoff gets a snapshot), and up to 7 days back
-- for slots that still have meals to freeze (after an outage).
create or replace function private.run_due_locks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.now();
  v_today date := private.ist_today();
  v_count integer := 0;
  v_failed uuid[] := '{}';
  r record;
begin
  for r in
    select k.id, d.d::date as service_date, sl.slot
    from public.kitchens k
    cross join generate_series(v_today - 7, v_today + 1, interval '1 day') as d(d)
    cross join unnest(enum_range(null::public.meal_slot)) as sl(slot)
    where k.status <> 'suspended'
      and private.cutoff_at(k, d.d::date, sl.slot) <= v_now
      and not exists (select 1 from public.count_snapshots cs
                      where cs.kitchen_id = k.id and cs.service_date = d.d::date and cs.slot = sl.slot)
      and (d.d::date >= v_today - 1
           or exists (select 1 from public.meal_orders o
                      where o.kitchen_id = k.id and o.service_date = d.d::date and o.slot = sl.slot and o.locked_at is null))
    order by k.id, d.d, sl.slot
  loop
    continue when r.id = any (v_failed);
    begin
      perform private.lock_slot(r.id, r.service_date, r.slot);
      -- Meals just charged may move customers to low balance / suspended (and drop later meals).
      perform private.sync_balance_status(r.id, null);
      perform private.resolve_engine_errors(r.id, 'lock', r.service_date, r.slot);
      v_count := v_count + 1;
    exception when others then
      v_failed := v_failed || r.id;
      perform private.record_engine_error(r.id, 'lock', r.service_date, r.slot, sqlstate, sqlerrm);
    end;
  end loop;
  return v_count;
end;
$$;

-- 00:30 IST. Each step (and each kitchen's meal generation, and each auto-cancel) has its own
-- error handling, so one bad row no longer rolls back the whole night; failures are recorded.
create or replace function private.nightly()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  r record;
begin
  begin
    perform private.sync_subscription_status(null);
    perform private.resolve_engine_errors(null, 'nightly_status', null, null);
  exception when others then
    perform private.record_engine_error(null, 'nightly_status', null, null, sqlstate, sqlerrm);
  end;

  begin
    perform private.sync_balance_status(null, null);
    perform private.resolve_engine_errors(null, 'nightly_balance', null, null);
  exception when others then
    perform private.record_engine_error(null, 'nightly_balance', null, null, sqlstate, sqlerrm);
  end;

  -- Auto-cancels, one subscription at a time (a failing refund must not block the rest).
  update public.engine_errors set resolved_at = private.now() where job = 'nightly_cancel' and resolved_at is null;
  for r in
    select s.id, s.kitchen_id, 'grace_expired' as reason
    from public.subscriptions s join public.kitchen_settings ks on ks.kitchen_id = s.kitchen_id
    where s.status = 'suspended' and s.status_changed_at < private.now() - make_interval(days => ks.grace_days)
    union all
    -- A trial never paid ends as cancelled once its grace period after the start date is over.
    select s.id, s.kitchen_id, 'trial_unpaid'
    from public.subscriptions s join public.kitchen_settings ks on ks.kitchen_id = s.kitchen_id
    where s.status = 'trial' and s.start_date + ks.grace_days < v_today
  loop
    begin
      perform set_config('app.status_reason', r.reason, true);
      update public.subscriptions set status = 'cancelled', cancelled_at = private.now() where id = r.id;
    exception when others then
      perform private.record_engine_error(r.kitchen_id, 'nightly_cancel', null, null, sqlstate, sqlerrm);
    end;
  end loop;
  perform set_config('app.status_reason', '', true);

  for r in select id from public.kitchens order by id loop
    begin
      perform private.refresh_orders(r.id, null, 7);
      perform private.resolve_engine_errors(r.id, 'nightly_refresh', null, null);
    exception when others then
      perform private.record_engine_error(r.id, 'nightly_refresh', null, null, sqlstate, sqlerrm);
    end;
  end loop;

  begin
    perform private.queue_customer_reminders();
    perform private.resolve_engine_errors(null, 'nightly_reminders', null, null);
  exception when others then
    perform private.record_engine_error(null, 'nightly_reminders', null, null, sqlstate, sqlerrm);
  end;
end;
$$;

-- Rebuild the runs of a locked slot after a late change. Never raises: a routing problem is
-- recorded (engine_errors) and must not undo the change or the lock that triggered it.
create or replace function private.resync_runs(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.count_snapshots cs
                 where cs.kitchen_id = p_kitchen and cs.service_date = p_date and cs.slot = p_slot) then
    return; -- runs are built at lock
  end if;
  begin
    perform private.build_runs(p_kitchen, p_date, p_slot);
    perform private.resolve_engine_errors(p_kitchen, 'build_runs', p_date, p_slot);
  exception when others then
    perform private.record_engine_error(p_kitchen, 'build_runs', p_date, p_slot, sqlstate, sqlerrm);
  end;
end;
$$;

-- Hooked to the lock (count_snapshots insert): runs are built; failures are recorded.
create or replace function private.snapshot_build_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.resync_runs(new.kitchen_id, new.service_date, new.slot);
  return null;
end;
$$;

-- Hooked to the lock: ingredients are consumed; failures are recorded (never block the lock).
create or replace function private.snapshot_consume()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.consume_for_slot(new.kitchen_id, new.service_date, new.slot, new.id);
  exception when others then
    perform private.record_engine_error(new.kitchen_id, 'consume', new.service_date, new.slot, sqlstate, sqlerrm);
  end;
  return null;
end;
$$;

-- Manual "Plan / refresh runs": a success also clears a recorded run-building failure.
create or replace function public.plan_runs(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  v_n := private.build_runs(p_kitchen, p_date, p_slot);
  perform private.resolve_engine_errors(p_kitchen, 'build_runs', p_date, p_slot);
  return v_n;
end;
$$;

-- When a customer's last live subscription is cancelled, refund their unused meals (M3). Meals of
-- THIS subscription already past their cutoff are frozen and charged first (they are being
-- cooked); other customers' meals are left to the lock job.
create or replace function private.refund_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    for r in
      select distinct o.service_date, o.slot
      from public.meal_orders o join public.kitchens k on k.id = o.kitchen_id
      where o.subscription_id = new.id and o.locked_at is null
        and private.now() >= private.cutoff_at(k, o.service_date, o.slot)
    loop
      perform private.charge_orders(new.kitchen_id, r.service_date, r.slot, new.id);
    end loop;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and not exists (select 1 from public.subscriptions s
                     where s.customer_id = new.customer_id and s.id <> new.id and s.status <> 'cancelled')
     and (select meals from private.unused_value(new.customer_id)) > 0 then
    perform private.create_refund(new.customer_id, null, 'Unused meals on cancellation', new.id, auth.uid());
  end if;
  return null;
end;
$$;

-- Status sync (M2/M3), plus: a dated permanent address move becomes the subscription's own
-- address once it starts (item 14; before that, refresh_orders uses it only from its date).
create or replace function private.sync_subscription_status(p_subscription uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_n integer := 0;
  v_rows integer;
begin
  perform set_config('app.status_reason', 'end_date_passed', true);
  update public.subscriptions s set status = 'cancelled', cancelled_at = coalesce(s.cancelled_at, private.now())
  where (p_subscription is null or s.id = p_subscription)
    and s.status <> 'cancelled' and s.end_date is not null and s.end_date < v_today;
  get diagnostics v_rows = row_count;
  v_n := v_n + v_rows;

  perform set_config('app.status_reason', 'pause_started', true);
  update public.subscriptions s set status = 'paused'
  where (p_subscription is null or s.id = p_subscription)
    and s.status in ('active', 'low_balance')
    and exists (select 1 from private.active_hold(s.id, v_today, 'lunch') h where h.reason = 'pause')
    and exists (select 1 from private.active_hold(s.id, v_today, 'dinner') h where h.reason = 'pause');
  get diagnostics v_rows = row_count;
  v_n := v_n + v_rows;

  perform set_config('app.status_reason', 'pause_ended', true);
  update public.subscriptions s set status = 'active'
  where (p_subscription is null or s.id = p_subscription)
    and s.status = 'paused'
    and not (exists (select 1 from private.active_hold(s.id, v_today, 'lunch') h where h.reason = 'pause')
             and exists (select 1 from private.active_hold(s.id, v_today, 'dinner') h where h.reason = 'pause'));
  get diagnostics v_rows = row_count;
  v_n := v_n + v_rows;
  perform set_config('app.status_reason', '', true);

  update public.subscriptions s set address_id = x.address_id
  from (
    select distinct on (c.subscription_id) c.subscription_id, c.address_id, c.from_date
    from public.schedule_changes c
    where c.type = 'address' and c.to_date is null and c.slot is null
      and (p_subscription is null or c.subscription_id = p_subscription)
    order by c.subscription_id, c.requested_at desc
  ) x
  where s.id = x.subscription_id and x.from_date <= v_today and s.status <> 'cancelled'
    and s.address_id is distinct from x.address_id;

  -- A subscription back from a pause may already be on a low or empty balance.
  if p_subscription is null then
    perform private.sync_balance_status(null, null);
  else
    perform private.sync_balance_status(null, (select customer_id from public.subscriptions where id = p_subscription));
  end if;
  return v_n;
end;
$$;

-- ===========================================================================
-- Changes (items 11, 14, 18, 19)
-- ===========================================================================

-- "Don't charge" for a meal skipped after the cutoff: one credit for that meal at the price it is
-- charged, linked to it (idempotent on the meal order), then the balance status is re-checked.
create or replace function private.waive_meal_charge(p_order uuid, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.meal_orders;
  v_price integer;
  v_entry uuid;
begin
  select * into v_o from public.meal_orders where id = p_order;
  if v_o.id is null or not v_o.charged then
    return null;
  end if;
  select price_per_meal_paise into v_price from public.plans where id = v_o.plan_id;
  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note,
                                      created_by, created_at)
  values (v_o.kitchen_id, v_o.customer_id, 'credit', v_o.qty, v_o.qty * coalesce(v_o.price_per_meal_paise, v_price),
          'meal_order_waiver', v_o.id, 'Skipped after the cutoff, not charged: ' || v_o.service_date || ' ' || v_o.slot,
          p_actor, private.now())
  on conflict (type, ref_type, ref_id) where ref_id is not null do nothing
  returning id into v_entry;
  update public.meal_orders set charge_waived = true where id = p_order and not charge_waived;
  if v_entry is not null then
    perform private.sync_balance_status(v_o.kitchen_id, v_o.customer_id);
  end if;
  return v_entry;
end;
$$;

-- Applying a change (vendor, WhatsApp, web). Returns
--   { dry_run, change_id, after_cutoff, from_date, to_date,
--     affected: [{order_id, date, slot, late, charged, credited}] }
-- * Every channel uses the slot's real cutoff (D-116; the 19:00 phone-close rule is gone).
-- * A skip/pause of a meal past its cutoff (or locked) keeps it counted and charged; with
--   p_waive_late ("don't charge", vendor only) one credit linked to the meal gives it back. A meal
--   already skipped late can be waived afterwards the same way.
-- * Meals on a run that is already out can still change while the rider has not reached them.
-- * Changes to locked meals rebuild that slot's runs, so the rider sees them.
create or replace function private.apply_change(
  p_subscription uuid,
  p_type public.change_type,
  p_from date,
  p_to date,
  p_slot public.meal_slot,
  p_address uuid,
  p_channel public.change_channel,
  p_waive_late boolean,
  p_note text,
  p_dry_run boolean,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions;
  v_kitchen public.kitchens;
  v_settings public.kitchen_settings;
  v_plan public.plans;
  v_now timestamptz := private.now();
  v_today date := private.ist_today();
  v_to date := p_to;
  v_from date := p_from;
  v_waive boolean := coalesce(p_waive_late, false);
  v_hold boolean := p_type in ('skip', 'pause');
  v_change uuid;
  v_affected jsonb := '[]'::jsonb;
  v_late boolean := false;
  r record;
begin
  if p_type = 'revoke' then
    raise exception 'invalid_type' using errcode = '22023'; -- undo goes through revoke_schedule_change
  end if;
  select * into v_sub from public.subscriptions where id = p_subscription;
  if v_sub.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_sub.status = 'cancelled' then
    raise exception 'subscription_cancelled' using errcode = '22023';
  end if;
  select * into v_kitchen from public.kitchens where id = v_sub.kitchen_id;
  select * into v_settings from public.kitchen_settings where kitchen_id = v_sub.kitchen_id;
  select * into v_plan from public.plans where id = v_sub.plan_id;

  if p_type = 'cancel' then
    v_from := coalesce(p_from, v_today + coalesce(v_settings.notice_days, 1));
    v_to := null;
  end if;
  if v_from is null then
    raise exception 'date_required' using errcode = '22023';
  end if;
  if v_from < v_today then
    raise exception 'date_in_past' using errcode = '22023';
  end if;
  if p_type = 'skip' then
    v_to := coalesce(p_to, v_from);
  end if;
  if v_to is not null and v_to < v_from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_to is not null and v_to > v_from + 90 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;
  if p_slot is not null and not (p_slot = any (v_plan.slots)) then
    raise exception 'slot_not_in_plan' using errcode = '22023';
  end if;
  if p_type = 'address' then
    if p_address is null or not exists (select 1 from public.addresses
                                        where id = p_address and customer_id = v_sub.customer_id) then
      raise exception 'invalid_address' using errcode = '22023';
    end if;
  end if;
  if p_type = 'cancel' and p_slot is not null then
    raise exception 'slot_not_allowed' using errcode = '22023';
  end if;

  -- Existing orders this change touches, and whether each is past its cutoff (or locked).
  for r in
    select o.id, o.service_date, o.slot, o.status, o.charged, o.charge_waived,
           (o.locked_at is not null or v_now >= private.cutoff_at(v_kitchen, o.service_date, o.slot)) as late
    from public.meal_orders o
    where o.subscription_id = p_subscription
      and o.service_date >= v_from
      and (v_to is null or o.service_date <= v_to)
      and (p_slot is null or o.slot = p_slot)
      and o.status not in ('delivered', 'failed')
      and (o.status <> 'out' or exists (select 1 from public.delivery_stops ds
                                        where ds.id = o.stop_id and ds.status = 'pending'))
      and (p_type <> 'resume' or o.status = 'skipped')
    order by o.service_date, o.slot
  loop
    if v_hold and r.status = 'skipped' then
      -- Already skipped: nothing new is charged. A charged late skip can still be waived.
      if r.charged and v_waive and not r.charge_waived then
        v_late := true;
        v_affected := v_affected || jsonb_build_object('order_id', r.id, 'date', r.service_date, 'slot', r.slot,
                                                       'late', true, 'charged', false, 'credited', true);
      end if;
      continue;
    end if;
    if v_hold then
      v_late := v_late or r.late;
    end if;
    v_affected := v_affected || jsonb_build_object(
      'order_id', r.id, 'date', r.service_date, 'slot', r.slot, 'late', r.late,
      'charged', v_hold and r.late and not v_waive,
      'credited', v_hold and r.late and v_waive);
  end loop;

  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'after_cutoff', v_late, 'affected', v_affected,
                              'from_date', v_from, 'to_date', v_to);
  end if;

  insert into public.schedule_changes (kitchen_id, subscription_id, type, from_date, to_date, slot, address_id,
                                       requested_at, after_cutoff, late_waived, channel, requested_by, note)
  values (v_sub.kitchen_id, p_subscription, p_type, v_from, v_to,
          case when p_type <> 'cancel' then p_slot end,
          case when p_type = 'address' then p_address end,
          v_now, v_late, v_late and v_waive, p_channel, p_actor, nullif(trim(p_note), ''))
  returning id into v_change;

  -- Late skip/pause: the meal stays in the count and is charged at lock (D-030); "don't charge"
  -- credits it back (D-116). On-time skips are applied by refresh_orders below.
  if v_hold then
    update public.meal_orders o
    set status = 'skipped', skip_reason = p_type::text, charged = true, change_id = v_change
    from jsonb_to_recordset(v_affected) as a(order_id uuid, late boolean)
    where o.id = a.order_id and a.late and o.status <> 'skipped';
    for r in select a.order_id from jsonb_to_recordset(v_affected) as a(order_id uuid, credited boolean) where a.credited loop
      perform private.waive_meal_charge(r.order_id, p_actor);
    end loop;
  end if;

  -- Address: also applied to frozen meals that have not reached the customer yet. A permanent
  -- move that starts today becomes the subscription's address now; a later one when it starts.
  if p_type = 'address' then
    update public.meal_orders o set address_id = p_address
    where o.subscription_id = p_subscription and o.service_date >= v_from
      and (v_to is null or o.service_date <= v_to) and (p_slot is null or o.slot = p_slot)
      and (o.status in ('scheduled', 'locked', 'prepared', 'skipped')
           or (o.status = 'out' and exists (select 1 from public.delivery_stops ds
                                            where ds.id = o.stop_id and ds.status = 'pending')));
    if v_to is null and p_slot is null and v_from <= v_today then
      update public.subscriptions set address_id = p_address where id = p_subscription;
    end if;
  end if;

  if p_type = 'cancel' then
    perform set_config('app.status_reason', 'cancel_requested', true);
    if v_from <= greatest(v_sub.start_date, v_today) then
      -- Effective today (or before the first meal): cancel now. Meals already frozen stay as they are.
      update public.subscriptions
      set status = 'cancelled', cancelled_at = v_now, end_date = greatest(v_sub.start_date, v_today)
      where id = p_subscription;
    else
      update public.subscriptions set end_date = least(coalesce(end_date, v_from - 1), v_from - 1)
      where id = p_subscription;
    end if;
    perform set_config('app.status_reason', '', true);
  end if;

  perform private.refresh_orders(null, p_subscription, 7);
  perform private.sync_subscription_status(p_subscription);

  -- Locked meals changed: their runs follow (the rider sees it).
  for r in
    select distinct a."date", a.slot
    from jsonb_to_recordset(v_affected) as a("date" date, slot public.meal_slot, late boolean)
    where a.late
  loop
    perform private.resync_runs(v_sub.kitchen_id, r."date", r.slot);
  end loop;

  return jsonb_build_object('dry_run', false, 'change_id', v_change, 'after_cutoff', v_late,
                            'affected', v_affected, 'from_date', v_from, 'to_date', v_to);
end;
$$;

-- Undo one specific skip or pause (item 15). Its days come back where the slot is still open
-- (frozen meals stay as they are); other skips and pauses are untouched. Returns
--   { dry_run, change_id, revoked_change_id, type, from_date, to_date, after_cutoff: false,
--     affected: [{date, slot, late: false, charged: false, credited: false}] }
create or replace function private.apply_revoke(p_change uuid, p_channel public.change_channel, p_note text,
                                                p_dry_run boolean, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.schedule_changes;
  v_sub public.subscriptions;
  v_kitchen public.kitchens;
  v_now timestamptz := private.now();
  v_change uuid;
  v_affected jsonb := '[]'::jsonb;
  r record;
begin
  select * into v_c from public.schedule_changes where id = p_change;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_c.type not in ('skip', 'pause') then
    raise exception 'cannot_revoke' using errcode = '22023';
  end if;
  if exists (select 1 from public.schedule_changes x where x.revokes_change_id = p_change) then
    raise exception 'already_revoked' using errcode = '22023';
  end if;
  select * into v_sub from public.subscriptions where id = v_c.subscription_id;
  if v_sub.status = 'cancelled' then
    raise exception 'subscription_cancelled' using errcode = '22023';
  end if;
  select * into v_kitchen from public.kitchens where id = v_sub.kitchen_id;

  for r in
    select o.service_date, o.slot
    from public.meal_orders o
    where o.subscription_id = v_c.subscription_id
      and o.status = 'skipped' and o.locked_at is null
      and v_now < private.cutoff_at(v_kitchen, o.service_date, o.slot)
      and not exists (select 1 from public.count_snapshots cs
                      where cs.kitchen_id = o.kitchen_id and cs.service_date = o.service_date and cs.slot = o.slot)
      and exists (select 1 from private.active_hold(o.subscription_id, o.service_date, o.slot) h where h.change_id = p_change)
      and not exists (select 1 from private.active_hold(o.subscription_id, o.service_date, o.slot, p_change))
    order by o.service_date, o.slot
  loop
    v_affected := v_affected || jsonb_build_object('date', r.service_date, 'slot', r.slot, 'late', false,
                                                   'charged', false, 'credited', false);
  end loop;

  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'revoked_change_id', p_change, 'type', v_c.type, 'after_cutoff', false,
                              'affected', v_affected, 'from_date', v_c.from_date, 'to_date', v_c.to_date);
  end if;

  insert into public.schedule_changes (kitchen_id, subscription_id, type, from_date, to_date, slot, requested_at,
                                       channel, requested_by, note, revokes_change_id)
  values (v_sub.kitchen_id, v_sub.id, 'revoke', v_c.from_date, v_c.to_date, v_c.slot, v_now, p_channel, p_actor,
          nullif(trim(p_note), ''), p_change)
  returning id into v_change;

  perform private.refresh_orders(null, v_sub.id, 7);
  perform private.sync_subscription_status(v_sub.id);

  return jsonb_build_object('dry_run', false, 'change_id', v_change, 'revoked_change_id', p_change, 'type', v_c.type,
                            'after_cutoff', false, 'affected', v_affected, 'from_date', v_c.from_date,
                            'to_date', v_c.to_date);
end;
$$;

-- Owner undoes one skip or pause (preview first with p_dry_run).
create or replace function public.revoke_schedule_change(p_change uuid, p_note text default null, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.schedule_changes where id = p_change;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  return private.apply_revoke(p_change, 'vendor', p_note, coalesce(p_dry_run, false), auth.uid());
end;
$$;

-- Skips and pauses that still matter for a subscription (today or later, not undone), for the
-- "Upcoming" list with Undo. resumed_from: the date an open-ended resume ends it, if any.
create or replace function public.subscription_holds(p_subscription uuid)
returns table (
  change_id uuid,
  type public.change_type,
  from_date date,
  to_date date,
  slot public.meal_slot,
  channel public.change_channel,
  requested_at timestamptz,
  after_cutoff boolean,
  note text,
  resumed_from date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
  v_today date := private.ist_today();
begin
  select kitchen_id into v_kitchen from public.subscriptions where id = p_subscription;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner,staff}');
  return query
  select h.id, h.type, h.from_date, h.to_date, h.slot, h.channel, h.requested_at, h.after_cutoff, h.note, h.resumed_from
  from (
    select c.*,
           (select min(r.from_date) from public.schedule_changes r
            where r.subscription_id = c.subscription_id and r.type = 'resume' and r.to_date is null
              and r.requested_at > c.requested_at and r.from_date >= c.from_date
              and (r.slot is null or r.slot = c.slot)) as resumed_from
    from public.schedule_changes c
    where c.subscription_id = p_subscription
      and c.type in ('skip', 'pause')
      and (c.to_date is null or c.to_date >= v_today)
      and not exists (select 1 from public.schedule_changes x where x.revokes_change_id = c.id)
  ) h
  where h.resumed_from is null or h.resumed_from > greatest(h.from_date, v_today)
  order by h.from_date, h.requested_at;
end;
$$;

-- ===========================================================================
-- Reactivate a cancelled subscription (item 16). Meals come back from p_from (default today).
-- The balance rules still apply: with an empty prepaid balance it may be suspended at once, and
-- the result says so. The transition is logged with reason 'reactivated'.
-- Returns { subscription_id, status, from_date }.
-- ===========================================================================
create or replace function public.reactivate_subscription(p_subscription uuid, p_from date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions;
  v_from date := coalesce(p_from, private.ist_today());
  v_status public.subscription_status;
begin
  select * into v_sub from public.subscriptions where id = p_subscription;
  if v_sub.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_sub.kitchen_id, '{owner}');
  if v_sub.status <> 'cancelled' then
    raise exception 'not_cancelled' using errcode = '22023';
  end if;
  if exists (select 1 from public.customers c where c.id = v_sub.customer_id and c.deleted_at is not null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.plans p where p.id = v_sub.plan_id and p.active) then
    raise exception 'plan_inactive' using errcode = '22023';
  end if;
  if v_from < private.ist_today() then
    raise exception 'date_in_past' using errcode = '22023';
  end if;
  if v_from > private.ist_today() + 90 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;

  perform set_config('app.status_reason', 'reactivated', true);
  update public.subscriptions
  set status = 'active', end_date = null, cancelled_at = null, start_date = greatest(start_date, v_from)
  where id = p_subscription;
  perform set_config('app.status_reason', '', true);
  perform private.sync_subscription_status(p_subscription);

  select status into v_status from public.subscriptions where id = p_subscription;
  return jsonb_build_object('subscription_id', p_subscription, 'status', v_status,
                            'from_date', greatest(v_sub.start_date, v_from));
end;
$$;

-- ===========================================================================
-- Addresses (item 14)
-- ===========================================================================

-- A new subscription with no address takes the customer's default (or latest) address.
create or replace function private.subscription_default_address()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.address_id is null then
    select a.id into new.address_id from public.addresses a
    where a.customer_id = new.customer_id and a.kitchen_id = new.kitchen_id
    order by a.is_default desc, a.created_at desc limit 1;
  end if;
  return new;
end;
$$;

create trigger subscriptions_default_address before insert on public.subscriptions
  for each row execute function private.subscription_default_address();

-- The customer's first address (e.g. added after a quick add on mobile) fills subscriptions that
-- have none, and meals already frozen without an address (not yet out) go there too.
create or replace function private.address_backfill_subscriptions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  update public.subscriptions s set address_id = new.id
  where s.customer_id = new.customer_id and s.address_id is null and s.status <> 'cancelled';
  for r in
    select distinct o.service_date, o.slot from public.meal_orders o
    where o.customer_id = new.customer_id and o.address_id is null
      and o.service_date >= private.ist_today() and o.status in ('scheduled', 'locked', 'prepared')
  loop
    update public.meal_orders o set address_id = new.id
    where o.customer_id = new.customer_id and o.address_id is null and o.service_date = r.service_date
      and o.slot = r.slot and o.status in ('scheduled', 'locked', 'prepared');
    perform private.resync_runs(new.kitchen_id, r.service_date, r.slot);
  end loop;
  return null;
end;
$$;

create trigger addresses_backfill_subscriptions after insert on public.addresses
  for each row execute function private.address_backfill_subscriptions();

-- Existing subscriptions without an address take the customer's default (or latest) one.
update public.subscriptions s
set address_id = (select a.id from public.addresses a where a.customer_id = s.customer_id and a.kitchen_id = s.kitchen_id
                  order by a.is_default desc, a.created_at desc limit 1)
where s.address_id is null and s.status <> 'cancelled'
  and exists (select 1 from public.addresses a where a.customer_id = s.customer_id and a.kitchen_id = s.kitchen_id);

-- "Make default", optionally moving every live subscription there from today (a permanent
-- address change per subscription, so meals and runs follow). Returns { address_id, subscriptions_moved }.
create or replace function public.set_default_address(p_address uuid, p_apply_to_subscriptions boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.addresses;
  v_n integer := 0;
  r record;
begin
  select * into v_a from public.addresses where id = p_address;
  if v_a.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_a.kitchen_id, '{owner}');
  update public.addresses set is_default = true where id = p_address and not is_default;
  if coalesce(p_apply_to_subscriptions, false) then
    for r in
      select s.id from public.subscriptions s
      where s.customer_id = v_a.customer_id and s.status <> 'cancelled'
      order by s.created_at
    loop
      perform private.apply_change(r.id, 'address', private.ist_today(), null, null, p_address, 'vendor', false,
                                   'Default address changed', false, auth.uid());
      v_n := v_n + 1;
    end loop;
  end if;
  return jsonb_build_object('address_id', p_address, 'subscriptions_moved', v_n);
end;
$$;

-- ===========================================================================
-- Runs (item 18). Planned runs are (re)synced in full as before. Runs already out keep their
-- delivered and failed stops; their pending stops follow late changes (a skipped meal leaves, an
-- emptied stop is removed, meal counts update, a new address joins as a new stop with a delivery
-- code). Stops grouped per customer and address (office stops: a billing customer's own meal to
-- the office address no longer hits the same stop twice). Stops added or changed on a run that
-- already existed are flagged (changed_at) for the rider.
-- ===========================================================================
create or replace function private.build_runs(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_k public.kitchens;
  v_now timestamptz := private.now();
  v_stops integer := 0;
  r record;
  v_s record;
  v_run uuid;
  v_lat double precision[];
  v_lng double precision[];
  v_route uuid;
  v_default_route uuid;
  v_existing uuid[];
  v_rider_name text;
begin
  perform pg_advisory_xact_lock(hashtextextended('runs:' || p_kitchen || ':' || p_date || ':' || p_slot, 0));
  select * into v_k from public.kitchens where id = p_kitchen;
  select coalesce(array_agg(id), '{}') into v_existing from public.delivery_runs
  where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot;

  -- The slot's deliverable orders with their stop key: an office member's meal goes to the office
  -- (billing customer + office address), everyone else to their own address (P6 offices).
  -- fixed_run: the order already sits on a run that is out or done.
  if to_regclass('pg_temp.runs_orders') is null then
    create temporary table runs_orders (
      order_id uuid, customer_id uuid, address_id uuid, office_id uuid, qty integer, sort_name text, fixed_run uuid
    ) on commit drop;
  end if;
  truncate pg_temp.runs_orders;
  insert into pg_temp.runs_orders
  select o.id,
         case when ofc.id is not null then ofc.billing_customer_id else o.customer_id end,
         case when ofc.id is not null then ofc.address_id else o.address_id end,
         ofc.id, o.qty, coalesce(ofc.name, cu.name),
         case when dr.status <> 'planned' then dr.id end
  from public.meal_orders o
  join public.customers cu on cu.id = o.customer_id
  left join public.offices ofc on ofc.id = cu.office_id and ofc.active
  left join public.delivery_runs dr on dr.id = o.run_id
  where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot and o.status <> 'skipped';

  if to_regclass('pg_temp.runs_wanted') is null then
    create temporary table runs_wanted (
      customer_id uuid, address_id uuid, office_id uuid, meal_count integer, route_seq integer, sort_name text, order_ids uuid[]
    ) on commit drop;
  end if;

  -- 0. Runs already out: orders that were skipped or moved to another address leave their
  --    pending stop; emptied pending stops go; meal counts follow.
  for v_run in
    select id from public.delivery_runs
    where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot and status = 'out'
  loop
    update public.meal_orders o
    set run_id = null, stop_id = null, stop_seq = null,
        status = case when o.status = 'out' then 'locked'::public.order_status else o.status end
    from public.delivery_stops s
    where s.id = o.stop_id and s.run_id = v_run and s.status = 'pending'
      and not exists (select 1 from pg_temp.runs_orders b
                      where b.order_id = o.id and b.customer_id = s.customer_id
                        and b.address_id is not distinct from s.address_id);
    update pg_temp.runs_orders b set fixed_run = null
    where b.fixed_run = v_run
      and not exists (select 1 from public.meal_orders o where o.id = b.order_id and o.run_id = v_run);
    delete from public.delivery_stops s
    where s.run_id = v_run and s.status = 'pending'
      and not exists (select 1 from public.meal_orders o where o.stop_id = s.id);
    update public.delivery_stops s set meal_count = x.n, changed_at = v_now
    from (select o.stop_id, sum(o.qty)::integer as n
          from public.meal_orders o join public.delivery_stops s2 on s2.id = o.stop_id
          where s2.run_id = v_run and s2.status = 'pending'
          group by o.stop_id) x
    where s.id = x.stop_id and s.meal_count is distinct from x.n;
  end loop;

  -- 1. Every address still to place needs a place in an active route.
  for r in
    select distinct b.address_id
    from pg_temp.runs_orders b
    left join public.route_stops rs on rs.kitchen_id = p_kitchen and rs.slot = p_slot and rs.address_id = b.address_id
    left join public.delivery_routes dr on dr.id = rs.route_id
    where b.address_id is not null and b.fixed_run is null
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
  if exists (select 1 from pg_temp.runs_orders b where b.address_id is null and b.fixed_run is null) then
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

  -- 2. One run per route that has meals to place.
  v_default_route := (select id from public.delivery_routes
                      where kitchen_id = p_kitchen and slot = p_slot and active
                      order by created_at, name limit 1);
  for r in
    select coalesce(rs.route_id, v_default_route) as route_id
    from pg_temp.runs_orders b
    left join public.route_stops rs on rs.kitchen_id = p_kitchen and rs.slot = p_slot and rs.address_id = b.address_id
    where b.fixed_run is null
    group by 1
  loop
    insert into public.delivery_runs (kitchen_id, route_id, service_date, slot, rider_id)
    select p_kitchen, r.route_id, p_date, p_slot, dr.rider_id from public.delivery_routes dr where dr.id = r.route_id
    on conflict (route_id, service_date) do nothing;
  end loop;

  -- 3. Planned runs: (re)synced in full.
  for v_run in
    select id from public.delivery_runs
    where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot and status = 'planned'
  loop
    truncate pg_temp.runs_wanted;
    insert into pg_temp.runs_wanted
    select b.customer_id, b.address_id, (array_agg(b.office_id) filter (where b.office_id is not null))[1], sum(b.qty),
           min(coalesce(rs.seq, 1000000)), min(b.sort_name), array_agg(b.order_id)
    from pg_temp.runs_orders b
    join public.delivery_runs dr on dr.id = v_run
    left join public.route_stops rs on rs.kitchen_id = p_kitchen and rs.slot = p_slot and rs.address_id = b.address_id
    where b.fixed_run is null and coalesce(rs.route_id, v_default_route) = dr.route_id
    group by b.customer_id, b.address_id;

    -- Orders in this run that are no longer wanted leave it.
    update public.meal_orders o set run_id = null, stop_id = null, stop_seq = null
    where o.run_id = v_run
      and not exists (select 1 from pg_temp.runs_wanted w where o.id = any (w.order_ids));
    delete from public.delivery_stops s
    where s.run_id = v_run and s.status = 'pending'
      and not exists (select 1 from pg_temp.runs_wanted w
                      where w.customer_id = s.customer_id and w.address_id is not distinct from s.address_id);

    insert into public.delivery_stops (kitchen_id, run_id, customer_id, address_id, office_id, seq, meal_count, changed_at)
    select p_kitchen, v_run, w.customer_id, w.address_id, w.office_id,
           row_number() over (order by w.route_seq, w.sort_name), w.meal_count,
           case when v_run = any (v_existing) then v_now end
    from pg_temp.runs_wanted w
    on conflict (run_id, customer_id, address_id) do update
      set meal_count = excluded.meal_count, office_id = excluded.office_id,
          changed_at = case when public.delivery_stops.meal_count is distinct from excluded.meal_count
                            then coalesce(excluded.changed_at, public.delivery_stops.changed_at)
                            else public.delivery_stops.changed_at end;

    -- Renumber 1..n in saved order.
    update public.delivery_stops s set seq = x.rn
    from (
      select s2.id, row_number() over (order by w.route_seq, w.sort_name) as rn
      from public.delivery_stops s2
      join pg_temp.runs_wanted w on w.customer_id = s2.customer_id and w.address_id is not distinct from s2.address_id
      where s2.run_id = v_run
    ) x
    where s.id = x.id and s.seq is distinct from x.rn;

    update public.meal_orders o set run_id = v_run, stop_id = s.id, stop_seq = s.seq
    from pg_temp.runs_wanted w
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

  -- 4. Runs already out: meals with no stop yet (a late address change) join at the end, with a
  --    delivery code and the customer's message, like a stop moved in by hand.
  for r in
    select dr.id, dr.route_id, dr.rider_id from public.delivery_runs dr
    where dr.kitchen_id = p_kitchen and dr.service_date = p_date and dr.slot = p_slot and dr.status = 'out'
  loop
    truncate pg_temp.runs_wanted;
    insert into pg_temp.runs_wanted
    select b.customer_id, b.address_id, (array_agg(b.office_id) filter (where b.office_id is not null))[1], sum(b.qty),
           min(coalesce(rs.seq, 1000000)), min(b.sort_name), array_agg(b.order_id)
    from pg_temp.runs_orders b
    left join public.route_stops rs on rs.kitchen_id = p_kitchen and rs.slot = p_slot and rs.address_id = b.address_id
    where b.fixed_run is null and coalesce(rs.route_id, v_default_route) = r.route_id
    group by b.customer_id, b.address_id;
    continue when not found;

    insert into public.delivery_stops (kitchen_id, run_id, customer_id, address_id, office_id, seq, meal_count, otp, changed_at)
    select p_kitchen, r.id, w.customer_id, w.address_id, w.office_id,
           (select coalesce(max(s.seq), 0) from public.delivery_stops s where s.run_id = r.id)
             + row_number() over (order by w.route_seq, w.sort_name),
           w.meal_count, lpad((floor(random() * 10000))::integer::text, 4, '0'), v_now
    from pg_temp.runs_wanted w
    on conflict (run_id, customer_id, address_id) do update
      set meal_count = public.delivery_stops.meal_count + excluded.meal_count, changed_at = excluded.changed_at
      where public.delivery_stops.status = 'pending';

    update public.meal_orders o
    set run_id = r.id, stop_id = s.id, stop_seq = s.seq,
        status = case when o.status in ('locked', 'prepared', 'scheduled') then 'out'::public.order_status else o.status end
    from pg_temp.runs_wanted w
    join public.delivery_stops s on s.run_id = r.id and s.customer_id = w.customer_id
                                 and s.address_id is not distinct from w.address_id and s.status = 'pending'
    where o.id = any (w.order_ids);

    v_rider_name := split_part(coalesce((select m.display_name from public.members m
                                         where m.kitchen_id = p_kitchen and m.user_id = r.rider_id), 'Your rider'), ' ', 1);
    for v_s in
      select s.id, s.customer_id, s.seq, s.otp from public.delivery_stops s
      where s.run_id = r.id and s.status = 'pending' and s.changed_at = v_now and s.otp is not null
        and not exists (select 1 from public.notifications_outbox n where n.dedupe_key like 'on_the_way:' || s.id || '%')
    loop
      perform private.notify_customer(p_kitchen, v_s.customer_id, 'on_the_way',
        jsonb_build_object('rider_name', v_rider_name, 'otp', v_s.otp, 'stop', v_s.seq,
                           'stops', (select count(*) from public.delivery_stops where run_id = r.id),
                           'slot', p_slot, 'service_date', p_date),
        'on_the_way:' || v_s.id);
    end loop;
  end loop;

  select count(*) into v_stops
  from public.delivery_stops s join public.delivery_runs dr on dr.id = s.run_id
  where dr.kitchen_id = p_kitchen and dr.service_date = p_date and dr.slot = p_slot;
  return v_stops;
end;
$$;

-- Rider's day (P6), now with: otp_sent only when the code message was really sent (item 8; a
-- pending or mock-queued message is not a code the customer has), and changed/changed_at for
-- stops added or changed after the run was built (item 18).
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
          'id', s.id, 'seq', s.seq, 'customer_id', s.customer_id, 'name', coalesce(ofc.name, cu.name), 'office', ofc.id is not null,
          'phone_masked', 'XXXXXX' || coalesce(cu.phone_last4, '????'),
          'line1', a.line1, 'area', a.area, 'landmark', a.landmark, 'delivery_notes', a.delivery_notes,
          'lat', a.lat, 'lng', a.lng, 'meal_count', s.meal_count,
          'diets', (select jsonb_object_agg(x.diet, x.n) from (
                      select o.diet, sum(o.qty)::integer as n from public.meal_orders o
                      where o.stop_id = s.id and o.status <> 'skipped' group by o.diet) x),
          'status', s.status, 'proof_type', s.proof_type, 'otp_ok', s.otp_ok, 'done_at', s.done_at,
          'failed_reason', s.failed_reason, 'tiffins_out', s.tiffins_out, 'tiffins_returned', s.tiffins_returned,
          'tiffins_with_customer', coalesce((select sum(t.tiffins_out - t.tiffins_returned)::integer
                                             from public.tiffin_ledger t
                                             where t.kitchen_id = s.kitchen_id and t.customer_id = s.customer_id), 0),
          'otp_sent', exists (select 1 from public.notifications_outbox n
                              where n.dedupe_key like 'on_the_way:' || s.id || '%' and n.status = 'sent'),
          'qr_token', s.qr_token,
          'changed', s.changed_at is not null,
          'changed_at', s.changed_at
        ) order by s.seq)
        from public.delivery_stops s
        join public.customers cu on cu.id = s.customer_id
        left join public.offices ofc on ofc.id = s.office_id
        left join public.addresses a on a.id = s.address_id
        where s.run_id = dr.id), '[]'::jsonb)
    ) order by dr.slot, k.name, rt.name)
    from public.delivery_runs dr
    join public.kitchens k on k.id = dr.kitchen_id
    join public.delivery_routes rt on rt.id = dr.route_id
    where dr.rider_id = auth.uid() and dr.service_date = private.ist_today()
      and exists (select 1 from public.members m where m.kitchen_id = dr.kitchen_id and m.user_id = auth.uid())
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- Slot summary (M2) with closures, weekly off per meal, and engine health:
--   closed / closure_reason, overdue (cutoff passed 5+ minutes ago and still not locked) and
--   engine_error (the open lock or run-building error for this slot, if any).
-- ===========================================================================
create or replace function public.slot_summary(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kitchen public.kitchens;
  v_snap public.count_snapshots;
  v_closure public.kitchen_closures;
  v_cutoff timestamptz;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  select * into v_kitchen from public.kitchens where id = p_kitchen;
  select * into v_snap from public.count_snapshots where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot;
  select * into v_closure from public.kitchen_closures
  where kitchen_id = p_kitchen and closed_on = p_date and (slot is null or slot = p_slot)
  order by slot nulls first limit 1;
  v_cutoff := private.cutoff_at(v_kitchen, p_date, p_slot);
  return jsonb_build_object(
    'service_date', p_date,
    'slot', p_slot,
    'cutoff_at', v_cutoff,
    'weekly_off', extract(isodow from p_date)::smallint = any (v_kitchen.weekly_off)
                  or extract(isodow from p_date)::smallint = any (case p_slot when 'lunch' then v_kitchen.weekly_off_lunch
                                                                              else v_kitchen.weekly_off_dinner end),
    'closed', v_closure.id is not null,
    'closure_reason', v_closure.reason,
    'locked', v_snap.id is not null,
    'locked_at', v_snap.locked_at,
    'locked_totals', v_snap.totals,
    'live', private.slot_totals(p_kitchen, p_date, p_slot),
    'overdue', v_snap.id is null and private.now() > v_cutoff + interval '5 minutes',
    'engine_error', (select e.message from public.engine_errors e
                     where e.kitchen_id = p_kitchen and e.service_date = p_date and e.slot = p_slot
                       and e.job in ('lock', 'build_runs') and e.resolved_at is null
                     order by e.last_seen_at desc limit 1)
  );
end;
$$;

-- ===========================================================================
-- Closures: owner adds or removes them (item 17). A closure can be set only while the slot(s)
-- are still open (before the cutoff, not locked): it never undoes a charge. Removing one brings
-- the meals back for the slots that are still open. p_dry_run counts the meals affected.
-- Both return { dry_run, closure_id?, service_date, slot, orders, meals }.
-- ===========================================================================
create or replace function public.set_kitchen_closure(p_kitchen uuid, p_date date, p_slot public.meal_slot default null,
                                                      p_reason text default null, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_k public.kitchens;
  v_id uuid;
  v_orders integer;
  v_meals integer;
begin
  perform private.require_role(p_kitchen, '{owner}');
  select * into v_k from public.kitchens where id = p_kitchen;
  if p_date is null then
    raise exception 'date_required' using errcode = '22023';
  end if;
  if p_date < private.ist_today() then
    raise exception 'date_in_past' using errcode = '22023';
  end if;
  if p_date > private.ist_today() + 366 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;
  if length(coalesce(p_reason, '')) > 200 then
    raise exception 'invalid_message' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(enum_range(null::public.meal_slot)) as sl(slot)
             where (p_slot is null or sl.slot = p_slot)
               and (private.now() >= private.cutoff_at(v_k, p_date, sl.slot)
                    or exists (select 1 from public.count_snapshots cs
                               where cs.kitchen_id = p_kitchen and cs.service_date = p_date and cs.slot = sl.slot))) then
    raise exception 'slot_locked' using errcode = '22023';
  end if;

  select count(*), coalesce(sum(o.qty), 0) into v_orders, v_meals
  from public.meal_orders o
  where o.kitchen_id = p_kitchen and o.service_date = p_date and (p_slot is null or o.slot = p_slot)
    and o.status <> 'skipped';
  if coalesce(p_dry_run, false) then
    return jsonb_build_object('dry_run', true, 'service_date', p_date, 'slot', p_slot, 'orders', v_orders, 'meals', v_meals);
  end if;

  insert into public.kitchen_closures (kitchen_id, closed_on, slot, reason, created_by, created_at)
  values (p_kitchen, p_date, p_slot, nullif(trim(p_reason), ''), auth.uid(), private.now())
  on conflict on constraint kitchen_closures_unique do update set reason = excluded.reason
  returning id into v_id;
  perform private.refresh_orders(p_kitchen, null, 7);
  return jsonb_build_object('dry_run', false, 'closure_id', v_id, 'service_date', p_date, 'slot', p_slot,
                            'orders', v_orders, 'meals', v_meals);
end;
$$;

create or replace function public.remove_kitchen_closure(p_kitchen uuid, p_date date, p_slot public.meal_slot default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orders integer;
  v_meals integer;
begin
  perform private.require_role(p_kitchen, '{owner}');
  delete from public.kitchen_closures
  where kitchen_id = p_kitchen and closed_on = p_date and slot is not distinct from p_slot;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.refresh_orders(p_kitchen, null, 7);
  select count(*), coalesce(sum(o.qty), 0) into v_orders, v_meals
  from public.meal_orders o
  where o.kitchen_id = p_kitchen and o.service_date = p_date and (p_slot is null or o.slot = p_slot)
    and o.status <> 'skipped';
  return jsonb_build_object('dry_run', false, 'service_date', p_date, 'slot', p_slot, 'orders', v_orders, 'meals', v_meals);
end;
$$;

-- ===========================================================================
-- Grants (fail-closed)
-- ===========================================================================
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.kitchen_ids(public.member_role[]) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;
grant execute on function private.my_run_ids() to authenticated;

revoke execute on function public.dismiss_engine_error(bigint), public.revoke_schedule_change(uuid, text, boolean),
  public.subscription_holds(uuid), public.reactivate_subscription(uuid, date), public.set_default_address(uuid, boolean),
  public.set_kitchen_closure(uuid, date, public.meal_slot, text, boolean),
  public.remove_kitchen_closure(uuid, date, public.meal_slot),
  public.plan_runs(uuid, date, public.meal_slot), public.rider_today(), public.slot_summary(uuid, date, public.meal_slot)
  from public, anon;
grant execute on function public.dismiss_engine_error(bigint), public.revoke_schedule_change(uuid, text, boolean),
  public.subscription_holds(uuid), public.reactivate_subscription(uuid, date), public.set_default_address(uuid, boolean),
  public.set_kitchen_closure(uuid, date, public.meal_slot, text, boolean),
  public.remove_kitchen_closure(uuid, date, public.meal_slot),
  public.plan_runs(uuid, date, public.meal_slot), public.rider_today(), public.slot_summary(uuid, date, public.meal_slot)
  to authenticated;
