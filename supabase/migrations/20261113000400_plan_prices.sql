-- Wave 4 (onboarding), step 4: plan price changes with a start date ("₹80 from next month",
-- audit Phase 1 step 4). Each meal is charged the price in force on its own service date.
--
--   * plan_prices: dated prices per plan. The price for a date is the newest row (not cancelled)
--     whose effective_from is on or before it; without one, plans.price_per_meal_paise.
--   * set_plan_price(plan, price, from): from = today (or empty) changes the price now; a later
--     date schedules it. cancel_plan_price removes a scheduled change that has not started.
--   * plans.price_per_meal_paise stays "the price today" for every screen: the 00:05 IST job
--     'tiffin-plan-prices' moves it when a scheduled price starts. Charging never depends on that
--     job: the lock reads plan_prices directly (private.charge_orders, redefined below).
--   * A direct price edit (the plans table UPDATE grant) still works and is recorded as a change
--     from today, so nothing scheduled is lost and older unfrozen meals keep their price.

create table public.plan_prices (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  plan_id uuid not null,
  price_per_meal_paise integer not null check (price_per_meal_paise > 0 and price_per_meal_paise <= 100000),
  effective_from date not null,            -- '-infinity' = the price before the first recorded change
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id),
  seq bigint generated always as identity,  -- tie-break: the later of two changes for the same date wins
  unique (id, kitchen_id),
  foreign key (plan_id, kitchen_id) references public.plans (id, kitchen_id) on delete cascade
);
create index plan_prices_plan_idx on public.plan_prices (plan_id, effective_from desc, seq desc)
  where cancelled_at is null;

create trigger plan_prices_audit after insert or update or delete on public.plan_prices
  for each row execute function private.audit_row();

alter table public.plan_prices enable row level security;
-- Prices are money: owner only, like plans (staff have no money access). Admins read all.
create policy plan_prices_select on public.plan_prices for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
revoke all on public.plan_prices from anon, authenticated;
grant select on public.plan_prices to authenticated;

-- The price of one meal of a plan on a service date.
create or replace function private.plan_price_on(p_plan uuid, p_date date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select pp.price_per_meal_paise from public.plan_prices pp
     where pp.plan_id = p_plan and pp.cancelled_at is null and pp.effective_from <= p_date
     order by pp.effective_from desc, pp.seq desc limit 1),
    (select p.price_per_meal_paise from public.plans p where p.id = p_plan));
$$;

-- Before the first dated change of a plan, remember the price it had until then.
create or replace function private.plan_price_baseline(p_plan uuid, p_kitchen uuid, p_price integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.plan_prices where plan_id = p_plan and cancelled_at is null
                   and effective_from < private.ist_today()) then
    insert into public.plan_prices (kitchen_id, plan_id, price_per_meal_paise, effective_from, created_by, created_at)
    values (p_kitchen, p_plan, p_price, '-infinity', null, private.now());
  end if;
end;
$$;

-- plans.price_per_meal_paise changed (an edit now, or the daily job starting a scheduled price).
create or replace function private.plans_price_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.plan_price_baseline(new.id, new.kitchen_id, old.price_per_meal_paise);
  if private.plan_price_on(new.id, private.ist_today()) is distinct from new.price_per_meal_paise then
    insert into public.plan_prices (kitchen_id, plan_id, price_per_meal_paise, effective_from, created_by, created_at)
    values (new.kitchen_id, new.id, new.price_per_meal_paise, private.ist_today(), auth.uid(), private.now());
  end if;
  return null;
end;
$$;

create trigger plans_price_history after update of price_per_meal_paise on public.plans
  for each row when (old.price_per_meal_paise is distinct from new.price_per_meal_paise)
  execute function private.plans_price_history();

-- Owner: change a plan's price now (p_from today or null) or from a later date (up to a year ahead).
create or replace function public.set_plan_price(p_plan uuid, p_price_paise integer, p_from date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.plans;
  v_today date := private.ist_today();
  v_id uuid;
begin
  select * into v_plan from public.plans where id = p_plan;
  if v_plan.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_plan.kitchen_id, '{owner}');
  if p_price_paise is null or p_price_paise <= 0 or p_price_paise > 100000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_from is not null and p_from < v_today then
    raise exception 'date_in_past' using errcode = '22023';
  end if;
  if p_from is not null and p_from > v_today + 366 then
    raise exception 'date_too_far' using errcode = '22023';
  end if;

  if p_from is null or p_from = v_today then
    update public.plans set price_per_meal_paise = p_price_paise where id = p_plan;
    return jsonb_build_object('plan_id', p_plan, 'price_per_meal_paise', p_price_paise, 'effective_from', v_today,
                              'scheduled', false);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('plan_price:' || p_plan, 0));
  perform private.plan_price_baseline(p_plan, v_plan.kitchen_id, v_plan.price_per_meal_paise);
  -- A new price for the same start date replaces the one scheduled before.
  update public.plan_prices set cancelled_at = private.now(), cancelled_by = auth.uid()
  where plan_id = p_plan and effective_from = p_from and cancelled_at is null;
  insert into public.plan_prices (kitchen_id, plan_id, price_per_meal_paise, effective_from, created_by, created_at)
  values (v_plan.kitchen_id, p_plan, p_price_paise, p_from, auth.uid(), private.now())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'plan_id', p_plan, 'price_per_meal_paise', p_price_paise, 'effective_from', p_from,
                            'scheduled', true);
end;
$$;

-- Owner: drop a scheduled price that has not started yet.
create or replace function public.cancel_plan_price(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.plan_prices;
begin
  select * into v_row from public.plan_prices where id = p_id;
  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_row.kitchen_id, '{owner}');
  if v_row.cancelled_at is not null then
    return;
  end if;
  if v_row.effective_from <= private.ist_today() then
    raise exception 'already_started' using errcode = '22023';
  end if;
  update public.plan_prices set cancelled_at = private.now(), cancelled_by = auth.uid() where id = p_id;
end;
$$;

-- 00:05 IST: scheduled prices that start today become the plan's current price.
create or replace function private.apply_plan_prices()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_n integer;
begin
  update public.plans p set price_per_meal_paise = private.plan_price_on(p.id, v_today)
  where exists (select 1 from public.plan_prices pp where pp.plan_id = p.id and pp.cancelled_at is null
                  and pp.effective_from <= v_today and pp.effective_from > '-infinity')
    and private.plan_price_on(p.id, v_today) is distinct from p.price_per_meal_paise;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

select cron.schedule('tiffin-plan-prices', '35 18 * * *', $$select private.apply_plan_prices()$$); -- 00:05 IST

-- ===========================================================================
-- Freezing and charging (the only path that posts 'meal' entries).
-- Redefined from 20261107000500_vendor_first_engine.sql (wave 1); the only change: the frozen
-- price is the one in force on the slot's service date (plan_prices), not today's plan price.
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
      price_per_meal_paise = coalesce(pp.price_per_meal_paise, p.price_per_meal_paise)
  from public.plans p
  left join lateral (select x.price_per_meal_paise from public.plan_prices x
                     where x.plan_id = p.id and x.cancelled_at is null and x.effective_from <= p_date
                     order by x.effective_from desc, x.seq desc limit 1) pp on true
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

-- "Don't charge" credit. Redefined from 20261107000500_vendor_first_engine.sql (wave 1); the only
-- change: a meal not frozen yet is credited at the price of its service date (what the lock will charge).
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
  v_price := private.plan_price_on(v_o.plan_id, v_o.service_date);
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

revoke execute on function private.plan_price_on, private.plan_price_baseline, private.plans_price_history,
  private.apply_plan_prices, private.charge_orders, private.waive_meal_charge from public, anon, authenticated;
revoke execute on function public.set_plan_price, public.cancel_plan_price from public, anon;
grant execute on function public.set_plan_price, public.cancel_plan_price to authenticated;
