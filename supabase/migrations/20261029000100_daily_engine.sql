-- M2 / 1.4 Daily engine: meal generation, skip/pause/resume/address/cancel,
-- cutoffs, idempotent lock, statuses, owner summary queue.
--
-- How it fits together
--   * schedule_changes is an append-only log of every request (who, when, which channel, late or not).
--   * private.refresh_orders() reconciles meal_orders for the next 7 days from subscriptions + changes.
--     It never touches a (date, slot) that is frozen: its cutoff has passed or it is already locked.
--   * Changes that land on frozen meals are applied directly: a late skip keeps the meal in the
--     count and charges it (status 'skipped' + charged = true).
--   * private.lock_slot() freezes a slot: writes count_snapshots and one 'meal' balance entry per
--     counted order. Running it twice is a no-op (snapshot unique key + ledger unique key).
--   * pg_cron: run_due_locks() every minute, nightly() at 00:30 IST, owner summaries at 22:00 IST.
--
-- Counted order = status <> 'skipped' or charged.

-- ---------------------------------------------------------------------------
-- Time. private.now() lets tests and the local seed simulate a clock; it is only
-- honoured for a direct postgres session (never for API roles via PostgREST).
-- ---------------------------------------------------------------------------
create or replace function private.now()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
           when session_user = 'postgres' and nullif(current_setting('app.now', true), '') is not null
             then current_setting('app.now', true)::timestamptz
           else now()
         end;
$$;

create or replace function private.ist_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (private.now() at time zone 'Asia/Kolkata')::date;
$$;

-- The instant changes close for a meal (IST wall-clock cutoff -> timestamptz).
create or replace function private.cutoff_at(p_kitchen public.kitchens, p_date date, p_slot public.meal_slot)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case p_slot
    when 'lunch' then ((p_date - (case when p_kitchen.cutoff_lunch_prev_day then 1 else 0 end)) + p_kitchen.cutoff_lunch)
                      at time zone 'Asia/Kolkata'
    when 'dinner' then ((p_date - (case when p_kitchen.cutoff_dinner_prev_day then 1 else 0 end)) + p_kitchen.cutoff_dinner)
                      at time zone 'Asia/Kolkata'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Enums and tables
-- ---------------------------------------------------------------------------
create type public.order_status as enum ('scheduled', 'locked', 'prepared', 'out', 'delivered', 'failed', 'skipped');
create type public.change_type as enum ('skip', 'pause', 'resume', 'address', 'cancel');
create type public.change_channel as enum ('whatsapp', 'web', 'vendor', 'rider');
create type public.balance_entry_type as enum ('recharge', 'meal', 'credit', 'refund', 'adjust');

alter table public.subscriptions add constraint subscriptions_id_kitchen_key unique (id, kitchen_id);

create table public.schedule_changes (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  subscription_id uuid not null,
  type public.change_type not null,
  from_date date not null,
  to_date date,                       -- null = open-ended (pause until resumed, permanent address)
  slot public.meal_slot,              -- null = every slot of the plan
  address_id uuid,
  requested_at timestamptz not null default now(),
  after_cutoff boolean not null default false,
  late_waived boolean not null default false,
  channel public.change_channel not null,
  requested_by uuid references auth.users (id),
  note text,
  check (to_date is null or to_date >= from_date),
  check ((type = 'address') = (address_id is not null)),
  check (type <> 'skip' or to_date is not null),
  foreign key (subscription_id, kitchen_id) references public.subscriptions (id, kitchen_id),
  foreign key (address_id, kitchen_id) references public.addresses (id, kitchen_id)
);
create index schedule_changes_sub_idx on public.schedule_changes (subscription_id, requested_at);
create index schedule_changes_kitchen_idx on public.schedule_changes (kitchen_id, requested_at desc);

create table public.meal_orders (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  subscription_id uuid not null,
  customer_id uuid not null,
  plan_id uuid not null,
  service_date date not null,
  slot public.meal_slot not null,
  qty smallint not null check (qty > 0),
  diet public.diet_type not null,
  address_id uuid,
  status public.order_status not null default 'scheduled',
  skip_reason text check (skip_reason in ('skip', 'pause')),
  -- A skip that arrived after the cutoff: the meal stays in the count and is charged.
  charged boolean not null default false,
  change_id uuid references public.schedule_changes (id),
  price_per_meal_paise integer,       -- frozen at lock
  locked_at timestamptz,
  run_id uuid,                        -- delivery run (M5)
  stop_seq integer,                   -- stop order within the run (M5)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, service_date, slot),
  unique (id, kitchen_id),
  check (status <> 'skipped' or skip_reason is not null),
  check (not charged or status = 'skipped'),
  foreign key (subscription_id, kitchen_id) references public.subscriptions (id, kitchen_id),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (plan_id, kitchen_id) references public.plans (id, kitchen_id),
  foreign key (address_id, kitchen_id) references public.addresses (id, kitchen_id)
);
create index meal_orders_slot_idx on public.meal_orders (kitchen_id, service_date, slot);
create index meal_orders_customer_idx on public.meal_orders (customer_id, service_date);

create table public.count_snapshots (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  service_date date not null,
  slot public.meal_slot not null,
  totals jsonb not null,
  locked_at timestamptz not null,
  unique (kitchen_id, service_date, slot)
);

-- Prepaid meal ledger. Balance = sum(meals) per customer per kitchen. Append-only.
-- M2 posts only 'meal' entries (at lock); recharges/credits/refunds arrive in M3.
create table public.balance_entries (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  customer_id uuid not null,
  type public.balance_entry_type not null,
  meals integer not null,             -- + adds to the balance, - consumes it
  amount_paise integer not null default 0,
  ref_type text,
  ref_id uuid,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id)
);
create index balance_entries_customer_idx on public.balance_entries (kitchen_id, customer_id);
-- One entry of each type per referenced row: makes the lock (and later webhooks) idempotent.
create unique index balance_entries_ref_idx on public.balance_entries (type, ref_type, ref_id) where ref_id is not null;

create table public.subscription_events (
  id bigint generated always as identity primary key,
  kitchen_id uuid not null,
  subscription_id uuid not null,
  from_status public.subscription_status,
  to_status public.subscription_status not null,
  reason text,
  actor_id uuid,
  created_at timestamptz not null default now(),
  foreign key (subscription_id, kitchen_id) references public.subscriptions (id, kitchen_id)
);
create index subscription_events_sub_idx on public.subscription_events (subscription_id, created_at);

create table public.menus (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  service_date date not null,
  slot public.meal_slot not null,
  dishes text[] not null default '{}',
  notes text,
  published boolean not null default false,
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kitchen_id, service_date, slot)
);

-- Outbound messages. Written by the engine; delivered by the worker in M4 (WhatsApp/push).
create table public.notifications_outbox (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid references public.kitchens (id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'push', 'sms')),
  recipient_type text not null check (recipient_type in ('member', 'customer')),
  recipient_id uuid not null,
  template text not null,
  payload jsonb not null default '{}',
  dedupe_key text unique,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  send_after timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_outbox_pending_idx on public.notifications_outbox (send_after) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Triggers: append-only logs, audit, updated_at, status history
-- ---------------------------------------------------------------------------
create trigger schedule_changes_append_only before update or delete on public.schedule_changes
  for each row execute function private.forbid_mutation();
create trigger count_snapshots_append_only before update or delete on public.count_snapshots
  for each row execute function private.forbid_mutation();
create trigger balance_entries_append_only before update or delete on public.balance_entries
  for each row execute function private.forbid_mutation();
create trigger subscription_events_append_only before update or delete on public.subscription_events
  for each row execute function private.forbid_mutation();
create trigger balance_entries_no_truncate before truncate on public.balance_entries
  for each statement execute function private.forbid_mutation();

create trigger meal_orders_updated_at before update on public.meal_orders
  for each row execute function private.set_updated_at();
create trigger menus_updated_at before update on public.menus
  for each row execute function private.set_updated_at();

-- Audit: changes and snapshots (one row per change / per lock). balance_entries is itself an
-- immutable ledger with created_by + ref, so it is not duplicated into audit_log row by row.
create trigger schedule_changes_audit after insert on public.schedule_changes
  for each row execute function private.audit_row();
create trigger count_snapshots_audit after insert on public.count_snapshots
  for each row execute function private.audit_row();
create trigger menus_audit after insert or update or delete on public.menus
  for each row execute function private.audit_row();

create or replace function private.log_subscription_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.subscription_events (kitchen_id, subscription_id, from_status, to_status, reason, actor_id)
    values (new.kitchen_id, new.id, case when tg_op = 'UPDATE' then old.status end, new.status,
            coalesce(nullif(current_setting('app.status_reason', true), ''), lower(tg_op)), auth.uid());
  end if;
  return new;
end;
$$;

create trigger subscriptions_status_log after insert or update of status on public.subscriptions
  for each row execute function private.log_subscription_status();

-- ---------------------------------------------------------------------------
-- Holds: is a (subscription, date, slot) skipped or paused?
-- A resume ends every hold requested before it that had already started by the
-- resume date, for dates on or after the resume date.
-- ---------------------------------------------------------------------------
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
    and not exists (
      select 1 from public.schedule_changes r
      where r.subscription_id = p_subscription
        and r.type = 'resume'
        and r.requested_at > c.requested_at
        and r.from_date <= p_date
        and c.from_date <= r.from_date
        and (r.slot is null or r.slot = p_slot)
    )
  order by c.requested_at desc
  limit 1;
$$;

create or replace function private.address_for(p_subscription uuid, p_date date, p_slot public.meal_slot)
returns uuid
language sql
stable
set search_path = ''
as $$
  select c.address_id
  from public.schedule_changes c
  where c.subscription_id = p_subscription
    and c.type = 'address'
    and c.from_date <= p_date
    and (c.to_date is null or c.to_date >= p_date)
    and (c.slot is null or c.slot = p_slot)
  order by c.requested_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Reconcile meal_orders for the next p_days days (IST) with subscriptions + changes.
-- Frozen (date, slot) pairs are never touched. Returns rows inserted/updated/deleted.
-- Paused subscriptions are included: their held days come out as 'skipped' and the
-- days after the pause as 'scheduled'. Trial/suspended/cancelled generate nothing.
-- ---------------------------------------------------------------------------
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
         s.qty, p.diet,
         coalesce(private.address_for(s.id, d.d::date, sl.slot), s.address_id) as address_id,
         h.reason as skip_reason, h.change_id
  from public.subscriptions s
  join public.plans p on p.id = s.plan_id
  join public.kitchens k on k.id = s.kitchen_id
  cross join generate_series(v_today, v_today + p_days - 1, interval '1 day') as d(d)
  cross join unnest(p.slots) as sl(slot)
  left join lateral private.active_hold(s.id, d.d::date, sl.slot) h on true
  where s.status in ('active', 'low_balance', 'paused')
    and k.status <> 'suspended'
    and (p_kitchen is null or s.kitchen_id = p_kitchen)
    and (p_subscription is null or s.id = p_subscription)
    and d.d::date >= s.start_date
    and (s.end_date is null or d.d::date <= s.end_date)
    and extract(isodow from d.d)::smallint = any (p.days_of_week)
    and not (extract(isodow from d.d)::smallint = any (k.weekly_off))
    and v_now < private.cutoff_at(k, d.d::date, sl.slot)
    and not exists (select 1 from public.count_snapshots cs
                    where cs.kitchen_id = s.kitchen_id and cs.service_date = d.d::date and cs.slot = sl.slot);

  insert into public.meal_orders (kitchen_id, subscription_id, customer_id, plan_id, service_date, slot, qty, diet,
                                  address_id, status, skip_reason, change_id)
  select kitchen_id, subscription_id, customer_id, plan_id, service_date, slot, qty, diet, address_id,
         case when skip_reason is null then 'scheduled' else 'skipped' end::public.order_status, skip_reason, change_id
  from _desired
  on conflict (subscription_id, service_date, slot) do update set
    plan_id = excluded.plan_id,
    qty = excluded.qty,
    diet = excluded.diet,
    address_id = excluded.address_id,
    status = excluded.status,
    skip_reason = excluded.skip_reason,
    change_id = coalesce(excluded.change_id, public.meal_orders.change_id),
    -- A late (charged) skip stays charged while the hold stands; un-holding clears it.
    charged = case when excluded.status = 'skipped' then public.meal_orders.charged else false end
  where public.meal_orders.locked_at is null
    and public.meal_orders.status in ('scheduled', 'skipped')
    and (public.meal_orders.plan_id, public.meal_orders.qty, public.meal_orders.diet, public.meal_orders.address_id,
         public.meal_orders.status, public.meal_orders.skip_reason)
        is distinct from
        (excluded.plan_id, excluded.qty, excluded.diet, excluded.address_id, excluded.status, excluded.skip_reason);
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  -- Remove unlocked, unfrozen orders that are no longer wanted (ended, cancelled, plan changed…).
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

-- ---------------------------------------------------------------------------
-- Status sync: paused while a pause covers today; cancelled once end_date has passed.
-- (Low balance / suspended transitions arrive with recharges in M3.)
-- ---------------------------------------------------------------------------
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
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Counts for one slot (used by the lock, live previews and the owner summary).
-- ---------------------------------------------------------------------------
create or replace function private.slot_totals(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with o as (
    select mo.*, (mo.status <> 'skipped' or mo.charged) as counted, p.name as plan_name, a.area
    from public.meal_orders mo
    join public.plans p on p.id = mo.plan_id
    left join public.addresses a on a.id = mo.address_id
    where mo.kitchen_id = p_kitchen and mo.service_date = p_date and mo.slot = p_slot
  )
  select jsonb_build_object(
    'total_meals', coalesce((select sum(qty) from o where counted), 0),
    'orders', (select count(*) from o where counted),
    'to_deliver', coalesce((select sum(qty) from o where status <> 'skipped'), 0),
    'skipped', (select count(*) from o where status = 'skipped' and not charged),
    'late_skips', (select count(*) from o where status = 'skipped' and charged),
    'by_diet', jsonb_build_object(
      'veg', coalesce((select sum(qty) from o where counted and diet = 'veg'), 0),
      'nonveg', coalesce((select sum(qty) from o where counted and diet = 'nonveg'), 0),
      'jain', coalesce((select sum(qty) from o where counted and diet = 'jain'), 0)),
    'by_plan', coalesce((select jsonb_agg(jsonb_build_object('plan', plan_name, 'meals', m) order by plan_name)
                         from (select plan_name, sum(qty) m from o where counted group by plan_name) x), '[]'::jsonb),
    'by_area', coalesce((select jsonb_agg(jsonb_build_object('area', area, 'meals', m) order by m desc, area)
                         from (select coalesce(area, 'No area') area, sum(qty) m from o where counted group by 1) x), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Lock one slot. Idempotent: a second call returns the existing snapshot and
-- writes nothing. Freezes orders, snapshots the count, posts one 'meal' entry per
-- counted order, queues the production sheet for the owner.
-- ---------------------------------------------------------------------------
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
begin
  perform pg_advisory_xact_lock(hashtextextended('lock:' || p_kitchen || ':' || p_date || ':' || p_slot, 0));

  select id into v_snapshot from public.count_snapshots
  where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot;
  if v_snapshot is not null then
    return v_snapshot;
  end if;

  update public.meal_orders o
  set status = case when o.status = 'scheduled' then 'locked'::public.order_status else o.status end,
      locked_at = v_now,
      price_per_meal_paise = p.price_per_meal_paise
  from public.plans p
  where p.id = o.plan_id and o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
    and o.locked_at is null;

  v_totals := private.slot_totals(p_kitchen, p_date, p_slot);

  insert into public.count_snapshots (kitchen_id, service_date, slot, totals, locked_at)
  values (p_kitchen, p_date, p_slot, v_totals, v_now)
  returning id into v_snapshot;

  -- Balance belongs to the eater for now; "parent pays" (payer_customer_id) is P5.
  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, created_at)
  select o.kitchen_id, o.customer_id, 'meal', -o.qty, -(o.qty * o.price_per_meal_paise), 'meal_order', o.id, v_now
  from public.meal_orders o
  where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
    and (o.status <> 'skipped' or o.charged)
  on conflict (type, ref_type, ref_id) where ref_id is not null do nothing;

  -- M6: deduct expected ingredients from stock using recipes (hook point).

  if (v_totals ->> 'orders')::integer > 0 then
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

-- Every minute: lock every slot whose cutoff has passed (catching up one day back).
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
  r record;
begin
  for r in
    select k.id, d.d::date as service_date, sl.slot
    from public.kitchens k
    cross join generate_series(v_today - 1, v_today + 1, interval '1 day') as d(d)
    cross join unnest(enum_range(null::public.meal_slot)) as sl(slot)
    where k.status <> 'suspended'
      and private.cutoff_at(k, d.d::date, sl.slot) <= v_now
      and not exists (select 1 from public.count_snapshots cs
                      where cs.kitchen_id = k.id and cs.service_date = d.d::date and cs.slot = sl.slot)
    order by d.d, sl.slot
  loop
    perform private.lock_slot(r.id, r.service_date, r.slot);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- 00:30 IST: statuses first (pauses starting/ending, cancellations), then 7 days of orders.
create or replace function private.nightly()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.sync_subscription_status(null);
  perform private.refresh_orders(null, null, 7);
end;
$$;

-- 22:00 IST: queue the owner's WhatsApp summary (delivered by the M4 worker).
create or replace function private.queue_owner_summaries()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tomorrow date := private.ist_today() + 1;
  v_n integer;
begin
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select k.id, 'whatsapp', 'member', m.user_id, 'owner_daily_summary',
         jsonb_build_object(
           'service_date', v_tomorrow,
           'lunch', private.slot_totals(k.id, v_tomorrow, 'lunch'),
           'dinner', private.slot_totals(k.id, v_tomorrow, 'dinner'),
           'collections_paise', null,   -- M3
           'low_stock', '[]'::jsonb),   -- M6
         'owner_daily_summary:' || k.id || ':' || v_tomorrow || ':' || m.user_id
  from public.kitchens k
  join public.members m on m.kitchen_id = k.id and m.role = 'owner'
  where k.status <> 'suspended'
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Applying a change (shared by the vendor RPC now, WhatsApp/web in M4, riders in M5).
-- Returns { change_id, after_cutoff, dry_run, affected: [{date, slot, late, charged}] }.
-- Vendor-entered changes ("by phone") close at kitchen_settings.phone_pause_close_time
-- the evening before; WhatsApp/web stay open until the slot cutoff.
-- ---------------------------------------------------------------------------
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
  v_change uuid;
  v_affected jsonb := '[]'::jsonb;
  v_late boolean := false;
  r record;
begin
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
    v_from := coalesce(p_from, v_today + v_settings.notice_days);
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

  -- Existing orders this change touches, and whether each is past its cutoff for this channel.
  for r in
    select o.id, o.service_date, o.slot, o.status, o.locked_at,
           (o.locked_at is not null or v_now >= private.cutoff_at(v_kitchen, o.service_date, o.slot)) as slot_frozen,
           (o.locked_at is not null
            or v_now >= case when p_channel = 'vendor'
                             then least(private.cutoff_at(v_kitchen, o.service_date, o.slot),
                                        ((o.service_date - 1) + v_settings.phone_pause_close_time) at time zone 'Asia/Kolkata')
                             else private.cutoff_at(v_kitchen, o.service_date, o.slot) end) as late
    from public.meal_orders o
    where o.subscription_id = p_subscription
      and o.service_date >= v_from
      and (v_to is null or o.service_date <= v_to)
      and (p_slot is null or o.slot = p_slot)
      and o.status not in ('out', 'delivered', 'failed')
      and (p_type <> 'resume' or o.status = 'skipped')
    order by o.service_date, o.slot
  loop
    if p_type in ('skip', 'pause') and r.status = 'skipped' then
      continue; -- already skipped: nothing changes and nothing new is charged
    end if;
    v_late := v_late or r.late;
    v_affected := v_affected || jsonb_build_object(
      'date', r.service_date, 'slot', r.slot, 'late', r.late,
      'charged', p_type in ('skip', 'pause') and r.late and (r.slot_frozen or not p_waive_late));
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
          v_now, v_late, v_late and p_waive_late, p_channel, p_actor, nullif(trim(p_note), ''))
  returning id into v_change;

  -- Late skip/pause: the meal stays in the count and is charged. A waiver only works
  -- while the slot itself is still open (i.e. inside the phone-close window).
  if p_type in ('skip', 'pause') then
    update public.meal_orders o
    set status = 'skipped', skip_reason = p_type::text, charged = true, change_id = v_change
    from jsonb_to_recordset(v_affected) as a("date" date, slot public.meal_slot, late boolean, charged boolean)
    where o.subscription_id = p_subscription and o.service_date = a."date" and o.slot = a.slot and a.charged;
  end if;

  -- Late address change: still apply it to frozen meals that have not left the kitchen.
  if p_type = 'address' then
    update public.meal_orders o set address_id = p_address
    where o.subscription_id = p_subscription and o.service_date >= v_from
      and (v_to is null or o.service_date <= v_to) and (p_slot is null or o.slot = p_slot)
      and o.status in ('scheduled', 'locked', 'prepared', 'skipped');
    if v_to is null and p_slot is null then
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

  return jsonb_build_object('dry_run', false, 'change_id', v_change, 'after_cutoff', v_late,
                            'affected', v_affected, 'from_date', v_from, 'to_date', v_to);
end;
$$;

-- ---------------------------------------------------------------------------
-- Keep orders in sync when subscriptions, plans or kitchen schedules change.
-- ---------------------------------------------------------------------------
create or replace function private.subscriptions_refresh_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_orders(null, new.id, 7);
  return null;
end;
$$;

create trigger subscriptions_refresh after insert or update of plan_id, qty, start_date, end_date, address_id, status
  on public.subscriptions for each row execute function private.subscriptions_refresh_orders();

create or replace function private.plans_refresh_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select id from public.subscriptions where plan_id = new.id and status <> 'cancelled' loop
    perform private.refresh_orders(null, r.id, 7);
  end loop;
  return null;
end;
$$;

create trigger plans_refresh after update of slots, days_of_week, diet on public.plans
  for each row execute function private.plans_refresh_orders();

create or replace function private.kitchens_refresh_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_orders(new.id, null, 7);
  return null;
end;
$$;

create trigger kitchens_refresh after update of weekly_off, cutoff_lunch, cutoff_lunch_prev_day, cutoff_dinner,
  cutoff_dinner_prev_day, status on public.kitchens
  for each row execute function private.kitchens_refresh_orders();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.schedule_changes enable row level security;
alter table public.meal_orders enable row level security;
alter table public.count_snapshots enable row level security;
alter table public.balance_entries enable row level security;
alter table public.subscription_events enable row level security;
alter table public.menus enable row level security;
alter table public.notifications_outbox enable row level security;

-- Counts and production: owner + staff. Money: owner only. Riders get their stops in M5.
create policy schedule_changes_select on public.schedule_changes for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy meal_orders_select on public.meal_orders for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy count_snapshots_select on public.count_snapshots for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy balance_entries_select on public.balance_entries for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy subscription_events_select on public.subscription_events for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy notifications_outbox_select on public.notifications_outbox for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy menus_select on public.menus for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy menus_insert on public.menus for insert to authenticated
  with check (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]));
create policy menus_update on public.menus for update to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]))
  with check (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]));

-- Balances per customer (owner only, through balance_entries RLS).
create view public.customer_balances
with (security_invoker = on) as
select kitchen_id, customer_id, sum(meals)::integer as meals, sum(amount_paise)::integer as amount_paise
from public.balance_entries
group by kitchen_id, customer_id;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------

-- Owner records a customer's request (usually by phone). p_dry_run = true previews
-- the effect (which meals, late/charged) so the customer can be told before confirming.
create or replace function public.request_schedule_change(
  p_subscription uuid,
  p_type public.change_type,
  p_from date default null,
  p_to date default null,
  p_slot public.meal_slot default null,
  p_address uuid default null,
  p_waive_late boolean default false,
  p_note text default null,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.subscriptions where id = p_subscription;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  return private.apply_change(p_subscription, p_type, p_from, p_to, p_slot, p_address, 'vendor',
                              coalesce(p_waive_late, false), p_note, coalesce(p_dry_run, false), auth.uid());
end;
$$;

-- Live (or locked) count for one slot, plus cutoff info.
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
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  select * into v_kitchen from public.kitchens where id = p_kitchen;
  select * into v_snap from public.count_snapshots where kitchen_id = p_kitchen and service_date = p_date and slot = p_slot;
  return jsonb_build_object(
    'service_date', p_date,
    'slot', p_slot,
    'cutoff_at', private.cutoff_at(v_kitchen, p_date, p_slot),
    'weekly_off', extract(isodow from p_date)::smallint = any (v_kitchen.weekly_off),
    'locked', v_snap.id is not null,
    'locked_at', v_snap.locked_at,
    'locked_totals', v_snap.totals,
    'live', private.slot_totals(p_kitchen, p_date, p_slot)
  );
end;
$$;

-- "Changes since last count": defaults to changes after the kitchen's most recent lock.
create or replace function public.change_feed(p_kitchen uuid, p_since timestamptz default null, p_limit integer default 50)
returns table (
  change_id uuid,
  requested_at timestamptz,
  type public.change_type,
  from_date date,
  to_date date,
  slot public.meal_slot,
  channel public.change_channel,
  after_cutoff boolean,
  late_waived boolean,
  customer_id uuid,
  customer_name text,
  plan_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := p_since;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  if v_since is null then
    select max(locked_at) into v_since from public.count_snapshots where kitchen_id = p_kitchen;
  end if;
  return query
  select c.id, c.requested_at, c.type, c.from_date, c.to_date, c.slot, c.channel, c.after_cutoff, c.late_waived,
         cu.id, cu.name, p.name
  from public.schedule_changes c
  join public.subscriptions s on s.id = c.subscription_id
  join public.customers cu on cu.id = s.customer_id
  join public.plans p on p.id = s.plan_id
  where c.kitchen_id = p_kitchen and (v_since is null or c.requested_at > v_since)
  order by c.requested_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- Packing list for one slot (route order comes in M5; until then by area/landmark).
-- No phone numbers: staff use this too.
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
  where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
    and (o.status <> 'skipped' or o.charged)
  order by o.stop_seq nulls last, a.area nulls last, a.landmark nulls last, cu.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on public.schedule_changes, public.meal_orders, public.count_snapshots, public.balance_entries,
  public.subscription_events, public.menus, public.notifications_outbox, public.customer_balances
  from anon, authenticated;

grant select on public.schedule_changes, public.count_snapshots, public.subscription_events,
  public.notifications_outbox, public.balance_entries, public.customer_balances to authenticated;
-- price_per_meal_paise is money: not selectable through the API (staff can read orders).
grant select (id, kitchen_id, subscription_id, customer_id, plan_id, service_date, slot, qty, diet, address_id, status,
  skip_reason, charged, change_id, locked_at, run_id, stop_seq, created_at, updated_at) on public.meal_orders to authenticated;
grant select on public.menus to authenticated;
grant insert (kitchen_id, service_date, slot, dishes, notes, published) on public.menus to authenticated;
grant update (dishes, notes, published) on public.menus to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.kitchen_ids(public.member_role[]) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;

revoke execute on function public.request_schedule_change, public.slot_summary, public.change_feed, public.packing_list
  from public, anon;
grant execute on function public.request_schedule_change, public.slot_summary, public.change_feed, public.packing_list
  to authenticated;

-- ---------------------------------------------------------------------------
-- Schedules (pg_cron runs in UTC). IST = UTC + 05:30.
-- ---------------------------------------------------------------------------
select cron.schedule('tiffin-lock-due-slots', '* * * * *', 'select private.run_due_locks()');
select cron.schedule('tiffin-nightly', '0 19 * * *', 'select private.nightly()');               -- 00:30 IST
select cron.schedule('tiffin-owner-summary', '30 16 * * *', 'select private.queue_owner_summaries()'); -- 22:00 IST
