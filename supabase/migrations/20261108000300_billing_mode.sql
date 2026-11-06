-- Vendor-first wave 2, item 20 (D-115): billing mode per customer, with a rupee ledger.
--
--   * customers.billing_mode: 'monthly' (pay later: meals go on the khata, the vendor collects at
--     month end, nothing is ever suspended or cancelled automatically) or 'prepaid' (today's
--     meal-balance behaviour: low balance, suspend at the credit limit, cancel after the grace days).
--   * kitchen_settings.default_billing_mode (default 'monthly'): new customers take it unless the
--     caller says otherwise. Platform-sourced customers (Phase 2 trial flow) default to prepaid.
--   * The ledger stays one table (balance_entries). For a monthly customer the RUPEE balance is
--     Σ amount_paise; dues = −that when negative. Each meal entry carries its own price (frozen at
--     lock), so dues are Σ of each meal's own amount, a mid-month price change affects only later
--     meals and lunch ₹60 + dinner ₹40 add up right. Monthly payments carry 0 meals (rupees only);
--     a free-meal credit for a monthly customer is valued at that meal's price.
--   * Prepaid dues (negative meal balance) are now valued from the owed meals' own prices too
--     (newest meals first), not today's plan price.
--   * set_billing_mode() switches a customer and converts the balance once (two adjust rows).
--   * Automatic refunds on cancellation stay prepaid-only: unused_value() is 0 for monthly
--     customers, so private.refund_on_cancel (not redefined here) never refunds them.

create type public.billing_mode as enum ('monthly', 'prepaid');

alter table public.kitchen_settings add column default_billing_mode public.billing_mode not null default 'monthly';
grant update (default_billing_mode) on public.kitchen_settings to authenticated;

alter table public.customers add column billing_mode public.billing_mode;
-- Existing customers were created under the prepaid rules; keep them prepaid.
update public.customers set billing_mode = 'prepaid' where billing_mode is null;
alter table public.customers alter column billing_mode set not null;
grant select (billing_mode) on public.customers to authenticated;

-- Monthly payments and refunds carry no meals (rupees only).
alter table public.payments drop constraint payments_meals_check;
alter table public.payments add constraint payments_meals_check check (meals >= 0 and meals <= 1000);
alter table public.refunds drop constraint refunds_meals_check;
alter table public.refunds add constraint refunds_meals_check check (meals >= 0);

-- New customers take the kitchen default (platform-sourced ones: prepaid).
create or replace function private.customer_billing_default()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.billing_mode is null then
    new.billing_mode := case
      when new.platform_sourced then 'prepaid'::public.billing_mode
      else coalesce((select ks.default_billing_mode from public.kitchen_settings ks where ks.kitchen_id = new.kitchen_id),
                    'monthly'::public.billing_mode)
    end;
  end if;
  return new;
end;
$$;

create trigger customers_billing_default before insert on public.customers
  for each row execute function private.customer_billing_default();

-- The apps read billing_mode with the customer (column added at the end of the view).
create or replace view public.customers_v
with (security_invoker = on) as
select
  c.id,
  c.kitchen_id,
  c.name,
  public.customer_phone(c.id) as phone,
  c.phone_last4,
  c.diet,
  c.preferred_language,
  c.whatsapp_opt_in,
  c.source,
  c.platform_sourced,
  c.notes,
  c.consent_at,
  c.created_at,
  c.updated_at,
  a.id as address_id,
  a.line1,
  a.area,
  a.landmark,
  a.delivery_notes,
  a.lat,
  a.lng,
  c.billing_mode
from public.customers c
left join public.addresses a on a.customer_id = c.id and a.is_default
where c.deleted_at is null;

-- ---------------------------------------------------------------------------
-- Valuation helpers
-- ---------------------------------------------------------------------------

-- Price per meal used only to turn rupees into meals (prepaid payments, balance conversions,
-- valuing a free meal): the meal-weighted average of the customer's live subscriptions
-- (lunch ₹60 + dinner ₹40 → ₹50), else their latest plan. Dues and statements never use it.
create or replace function private.customer_unit_price(p_customer uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select round(sum(p.price_per_meal_paise::numeric * s.qty * cardinality(p.slots) * p.days_per_week)
                  / nullif(sum(s.qty * cardinality(p.slots) * p.days_per_week), 0))::integer
     from public.subscriptions s join public.plans p on p.id = s.plan_id
     where s.customer_id = p_customer and s.status in ('active', 'low_balance', 'paused', 'suspended', 'trial')),
    (select p.price_per_meal_paise
     from public.subscriptions s join public.plans p on p.id = s.plan_id
     where s.customer_id = p_customer
     order by s.created_at desc
     limit 1));
$$;

-- Rupee balance (khata) in paise: + advance, − owed. Authoritative for monthly customers.
create or replace function private.rupee_balance(p_customer uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(b.amount_paise), 0)::bigint from public.balance_entries b where b.customer_id = p_customer;
$$;

-- Value of the newest p_meals meals charged to a customer (each at its own price).
create or replace function private.recent_meals_value(p_customer uuid, p_meals integer)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(round(sum(case when x.cum <= p_meals then x.amt
                                 else x.amt * (p_meals - (x.cum - x.q))::numeric / x.q end)), 0)::bigint
  from (select -b.meals as q, -b.amount_paise as amt,
               sum(-b.meals) over (order by b.created_at desc, b.seq desc) as cum
        from public.balance_entries b
        where b.customer_id = p_customer and b.type = 'meal' and b.meals < 0) x
  where p_meals > 0 and x.cum - x.q < p_meals;
$$;

-- How many of the newest meals an owed amount covers (rounded up), for the dues list of monthly customers.
create or replace function private.recent_meals_for_amount(p_customer uuid, p_paise bigint)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(case when x.cum <= p_paise then x.q
                           else ceil(x.q * (p_paise - (x.cum - x.amt))::numeric / nullif(x.amt, 0)) end), 0)::integer
  from (select -b.meals as q, -b.amount_paise as amt,
               sum(-b.amount_paise) over (order by b.created_at desc, b.seq desc) as cum
        from public.balance_entries b
        where b.customer_id = p_customer and b.type = 'meal' and b.meals < 0 and b.amount_paise < 0) x
  where p_paise > 0 and x.cum - x.amt < p_paise;
$$;

-- Monthly customers: payments carry 0 meals; prepaid: a payment that reaches the ledger with
-- 0 meals (e.g. recorded while the customer was monthly) gets amount ÷ price per meal.
create or replace function private.payment_meals_for_mode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode public.billing_mode;
  v_price integer;
begin
  select billing_mode into v_mode from public.customers where id = new.customer_id;
  if v_mode = 'monthly' then
    new.meals := 0;
  elsif new.meals = 0 then
    v_price := private.customer_unit_price(new.customer_id);
    new.meals := least(greatest(1, coalesce(new.amount_paise / nullif(v_price, 0), 1)), 1000);
  end if;
  return new;
end;
$$;

create trigger payments_meals_for_mode before insert or update of meals on public.payments
  for each row execute function private.payment_meals_for_mode();

-- Monthly customers: a recharge adds rupees, not meals; a free-meal credit is worth that meal's
-- price (the meal it refers to, else the customer's price per meal). Prepaid rows are untouched.
create or replace function private.value_monthly_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price integer;
begin
  if not exists (select 1 from public.customers where id = new.customer_id and billing_mode = 'monthly') then
    return new;
  end if;
  if new.type = 'recharge' then
    new.meals := 0;
  elsif new.type = 'credit' and new.meals > 0 and new.amount_paise = 0 then
    if new.ref_type in ('meal_order', 'delivery_stop_order') then
      select o.price_per_meal_paise into v_price from public.meal_orders o where o.id = new.ref_id;
    end if;
    new.amount_paise := new.meals * coalesce(v_price, private.customer_unit_price(new.customer_id), 0);
  end if;
  return new;
end;
$$;

create trigger balance_entries_value_monthly before insert on public.balance_entries
  for each row when (new.type in ('recharge', 'credit')) execute function private.value_monthly_entry();

-- Value of the oldest p_meals unused PREPAID meals (FIFO). Always 0 for monthly customers, so the
-- automatic refund on cancellation (private.refund_on_cancel) applies to prepaid customers only.
create or replace function private.unused_value(p_customer uuid, p_meals integer default null)
returns table (meals integer, amount_paise integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_left integer := p_meals;
  v_meals integer := 0;
  v_amount numeric := 0;
  r record;
  v_take integer;
begin
  -- Monthly (pay-later) customers have no prepaid meals; their advance is the rupee balance.
  if exists (select 1 from public.customers c where c.id = p_customer and c.billing_mode = 'monthly') then
    meals := 0;
    amount_paise := 0;
    return next;
    return;
  end if;
  for r in select * from private.remaining_lots(p_customer) l order by l.created_at, l.seq loop
    v_take := case when v_left is null then r.meals else least(v_left, r.meals) end;
    exit when v_take <= 0;
    v_meals := v_meals + v_take;
    v_amount := v_amount + r.amount_paise * v_take / r.meals;
    if v_left is not null then
      v_left := v_left - v_take;
    end if;
  end loop;
  meals := v_meals;
  amount_paise := round(v_amount)::integer;
  return next;
end;
$$;

-- Balance-driven states apply to prepaid customers only. Monthly (pay-later) customers are never
-- moved to low balance or suspended (D-115); one switched from prepaid goes back to active.
create or replace function private.sync_balance_status(p_kitchen uuid default null, p_customer uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform set_config('app.status_reason', 'balance_changed', true);
  with b as (
    select s.id, cu.billing_mode,
           case when cu.billing_mode = 'prepaid'
                then coalesce((select sum(be.meals) from public.balance_entries be where be.customer_id = s.customer_id), 0)
           end as bal,
           ks.low_balance_meals, ks.credit_limit_meals
    from public.subscriptions s
    join public.customers cu on cu.id = s.customer_id
    join public.kitchen_settings ks on ks.kitchen_id = s.kitchen_id
    where s.status in ('active', 'low_balance', 'suspended')
      and (p_kitchen is null or s.kitchen_id = p_kitchen)
      and (p_customer is null or s.customer_id = p_customer)
  ),
  target as (
    select id, case
             when billing_mode = 'monthly' then 'active'
             when bal <= -credit_limit_meals then 'suspended'
             when bal <= low_balance_meals then 'low_balance'
             else 'active'
           end::public.subscription_status as status
    from b
  )
  update public.subscriptions s set status = t.status
  from target t
  where s.id = t.id and s.status is distinct from t.status;
  get diagnostics v_n = row_count;
  perform set_config('app.status_reason', '', true);
  return v_n;
end;
$$;

create or replace function private.nightly()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
begin
  perform private.sync_subscription_status(null);
  perform private.sync_balance_status(null, null);

  -- Suspended with no recharge for the kitchen's grace days -> cancelled.
  perform set_config('app.status_reason', 'grace_expired', true);
  -- Prepaid customers only (D-115): monthly customers are never cancelled automatically.
  update public.subscriptions s set status = 'cancelled', cancelled_at = private.now()
  from public.kitchen_settings ks, public.customers cu
  where ks.kitchen_id = s.kitchen_id and cu.id = s.customer_id and cu.billing_mode = 'prepaid'
    and s.status = 'suspended'
    and s.status_changed_at < private.now() - make_interval(days => ks.grace_days);

  -- A trial never paid ends as cancelled once its grace period after the start date is over.
  perform set_config('app.status_reason', 'trial_unpaid', true);
  update public.subscriptions s set status = 'cancelled', cancelled_at = private.now()
  from public.kitchen_settings ks, public.customers cu
  where ks.kitchen_id = s.kitchen_id and cu.id = s.customer_id and cu.billing_mode = 'prepaid'
    and s.status = 'trial'
    and s.start_date + ks.grace_days < v_today;
  perform set_config('app.status_reason', '', true);

  perform private.refresh_orders(null, null, 7);
  perform private.queue_customer_reminders();
end;
$$;

-- Customers who owe money, with the date they went into debt.
--   monthly: amount = −rupee balance; meals = how many of the newest meals that covers.
--   prepaid: meals = −meal balance; amount = those newest meals at their own prices.
create or replace function private.dues(p_kitchen uuid)
returns table (customer_id uuid, meals_owed integer, amount_owed_paise integer, since date)
language sql
stable
set search_path = ''
as $$
  with running as (
    select b.customer_id, b.created_at,
           sum(b.meals) over (partition by b.customer_id order by b.created_at, b.seq) as bal_meals,
           sum(b.amount_paise) over (partition by b.customer_id order by b.created_at, b.seq) as bal_paise
    from public.balance_entries b
    where b.kitchen_id = p_kitchen
  ),
  current_bal as (
    select b.customer_id, sum(b.meals)::integer as meals, sum(b.amount_paise)::bigint as paise
    from public.balance_entries b where b.kitchen_id = p_kitchen group by b.customer_id
  ),
  owed as (
    select cb.customer_id, cu.billing_mode, cb.meals, cb.paise
    from current_bal cb join public.customers cu on cu.id = cb.customer_id
    where (cu.billing_mode = 'monthly' and cb.paise < 0) or (cu.billing_mode = 'prepaid' and cb.meals < 0)
  )
  select o.customer_id,
         case when o.billing_mode = 'monthly' then private.recent_meals_for_amount(o.customer_id, -o.paise)
              else -o.meals end,
         (case when o.billing_mode = 'monthly' then -o.paise
               else private.recent_meals_value(o.customer_id, -o.meals) end)::integer,
         (select (min(r.created_at) at time zone 'Asia/Kolkata')::date from running r
          where r.customer_id = o.customer_id
            and case when o.billing_mode = 'monthly' then r.bal_paise < 0 else r.bal_meals < 0 end
            and r.created_at > coalesce((select max(r2.created_at) from running r2
                                         where r2.customer_id = o.customer_id
                                           and case when o.billing_mode = 'monthly' then r2.bal_paise >= 0
                                                    else r2.bal_meals >= 0 end), '-infinity'))
  from owed o;
$$;

create or replace function private.queue_customer_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_n integer := 0;
  v_rows integer;
  k record;
begin
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select s.kitchen_id, 'whatsapp', 'customer', s.customer_id, 'low_balance_reminder',
         jsonb_build_object('balance_meals', (select sum(meals) from public.balance_entries where customer_id = s.customer_id)),
         'low_balance_reminder:' || s.customer_id || ':' || v_today
  from public.subscriptions s
  where s.status = 'low_balance'
  on conflict (dedupe_key) do nothing;
  get diagnostics v_rows = row_count;
  v_n := v_n + v_rows;

  for k in select id from public.kitchens where status <> 'suspended' loop
    insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
    select k.id, 'whatsapp', 'customer', d.customer_id, 'dues_reminder',
           jsonb_build_object('meals_owed', d.meals_owed, 'amount_owed_paise', d.amount_owed_paise, 'since', d.since,
                              'day', v_today - d.since),
           'dues_reminder:' || d.customer_id || ':' || d.since || ':' || (v_today - d.since)
    from private.dues(k.id) d
    -- Monthly customers settle at month end (statement), not on day 1, 3 and 7 of a debt.
    where v_today - d.since in (1, 3, 7)
      and exists (select 1 from public.customers c where c.id = d.customer_id and c.billing_mode = 'prepaid')
    on conflict (dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;
  return v_n;
end;
$$;

-- Churn: 'balance_out' is a prepaid signal (a monthly customer is always below zero mid-month).
create or replace function private.compute_churn(p_kitchen uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_now timestamptz := private.now();
  v_n integer;
begin
  delete from public.churn_risks where p_kitchen is null or kitchen_id = p_kitchen;
  insert into public.churn_risks (kitchen_id, customer_id, reasons, detail, computed_on, computed_at)
  select x.kitchen_id, x.customer_id, x.reasons, x.detail, v_today, v_now
  from (
    select c.kitchen_id, c.id as customer_id,
           array_remove(array[
             case when c.billing_mode = 'prepaid' and b.meals <= 0 and coalesce(rc.last_at, '-infinity') < v_now - interval '3 days'
                  then 'balance_out' end,
             case when sk.n >= 3 then 'skips' end,
             case when cp.n > 0 then 'open_complaint' end,
             case when ps.since < v_now - interval '7 days' then 'paused_long' end,
             case when c.platform_sourced and (tr.stuck or ld.stuck) then 'trial_not_converted' end
           ], null) as reasons,
           jsonb_strip_nulls(jsonb_build_object('balance_meals', b.meals, 'last_recharge_at', rc.last_at, 'skips_7d', sk.n,
             'open_complaints', cp.n, 'paused_since', ps.since)) as detail
    from public.customers c
    left join lateral (select coalesce(sum(be.meals), 0)::integer as meals from public.balance_entries be where be.customer_id = c.id) b on true
    left join lateral (select max(be.created_at) as last_at from public.balance_entries be
                       where be.customer_id = c.id and be.type = 'recharge') rc on true
    left join lateral (select count(*)::integer as n from public.meal_orders o
                       where o.customer_id = c.id and o.status = 'skipped' and o.skip_reason = 'skip'
                         and o.service_date between v_today - 6 and v_today) sk on true
    left join lateral (select count(*)::integer as n from public.complaints cm
                       where cm.customer_id = c.id and cm.status in ('open', 'responded', 'escalated')) cp on true
    left join lateral (select min(s.status_changed_at) as since from public.subscriptions s
                       where s.customer_id = c.id and s.status = 'paused') ps on true
    left join lateral (select exists (select 1 from public.subscriptions s where s.customer_id = c.id and s.status = 'trial'
                                      and s.created_at < v_now - interval '3 days') as stuck) tr on true
    left join lateral (select exists (select 1 from public.leads l where l.customer_id = c.id and l.status = 'trial'
                                      and l.trial_at < v_now - interval '3 days') as stuck) ld on true
    where c.deleted_at is null
      and (p_kitchen is null or c.kitchen_id = p_kitchen)
      and exists (select 1 from public.subscriptions s where s.customer_id = c.id and s.status <> 'cancelled')
  ) x
  where cardinality(x.reasons) > 0;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Refunds: prepaid unchanged (FIFO meals); monthly refunds part or all of the advance in rupees.
-- p_amount_paise is used for monthly customers only (null = the whole advance).
-- ---------------------------------------------------------------------------
drop function private.create_refund(uuid, integer, text, uuid, uuid);
create function private.create_refund(p_customer uuid, p_meals integer, p_reason text, p_subscription uuid, p_actor uuid,
  p_amount_paise integer default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
  v_mode public.billing_mode;
  v_value record;
  v_meals integer;
  v_amount integer;
  v_advance bigint;
  v_refund uuid;
begin
  select kitchen_id, billing_mode into v_kitchen, v_mode from public.customers where id = p_customer;
  perform pg_advisory_xact_lock(hashtextextended('refund:' || p_customer, 0));
  if v_mode = 'monthly' then
    v_advance := greatest(private.rupee_balance(p_customer), 0);
    v_amount := coalesce(p_amount_paise,
                         case when p_meals is not null then p_meals * coalesce(private.customer_unit_price(p_customer), 0) end,
                         v_advance);
    if v_advance <= 0 or v_amount <= 0 then
      raise exception 'nothing_to_refund' using errcode = '22023';
    end if;
    if v_amount > v_advance then
      raise exception 'refund_exceeds_balance' using errcode = '22023';
    end if;
    v_meals := 0;
  else
    select * into v_value from private.unused_value(p_customer, p_meals);
    if v_value.meals <= 0 then
      raise exception 'nothing_to_refund' using errcode = '22023';
    end if;
    if p_meals is not null and v_value.meals < p_meals then
      raise exception 'refund_exceeds_balance' using errcode = '22023';
    end if;
    v_meals := v_value.meals;
    v_amount := v_value.amount_paise;
  end if;

  insert into public.refunds (kitchen_id, customer_id, subscription_id, meals, amount_paise, reason, created_by,
                              created_at, payment_id)
  values (v_kitchen, p_customer, p_subscription, v_meals, v_amount, p_reason, p_actor, private.now(),
          -- Most recent online payment that can still cover this refund (else it is paid in cash/UPI).
          (select p.id from public.payments p
           where p.customer_id = p_customer and p.status = 'paid' and p.method = 'razorpay_link'
             and p.amount_paise - coalesce((select sum(r.amount_paise) from public.refunds r
                                            where r.payment_id = p.id and r.status <> 'failed'), 0) >= v_amount
           order by p.paid_at desc limit 1))
  returning id into v_refund;

  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
  values (v_kitchen, p_customer, 'refund', -v_meals, -v_amount, 'refund', v_refund, p_reason, p_actor, private.now());

  perform private.sync_balance_status(v_kitchen, p_customer);
  perform private.notify_customer(v_kitchen, p_customer, 'refund_notice',
    jsonb_build_object('refund_id', v_refund, 'meals', v_meals, 'amount_paise', v_amount),
    'refund_notice:' || v_refund);
  return v_refund;
end;
$$;

drop function public.refund_unused_meals(uuid, integer, text);
create function public.refund_unused_meals(p_customer uuid, p_meals integer default null, p_reason text default null,
  p_amount_paise integer default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
begin
  select * into v_c from public.customers where id = p_customer;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  if p_amount_paise is not null and p_amount_paise <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  return private.create_refund(p_customer, p_meals,
    coalesce(nullif(trim(p_reason), ''), case when v_c.billing_mode = 'monthly' then 'Refund of advance' else 'Refund of unused meals' end),
    null, auth.uid(), p_amount_paise);
end;
$$;

-- Refund preview: prepaid → unused meals (FIFO value); monthly → the advance (positive rupee balance).
create or replace function public.unused_meals_value(p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v record;
  v_bal bigint;
begin
  select * into v_c from public.customers where id = p_customer;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner,accountant}');
  v_bal := private.rupee_balance(p_customer);
  if v_c.billing_mode = 'monthly' then
    return jsonb_build_object('billing_mode', 'monthly', 'meals', 0, 'amount_paise', greatest(v_bal, 0), 'balance_paise', v_bal);
  end if;
  select * into v from private.unused_value(p_customer, null);
  return jsonb_build_object('billing_mode', 'prepaid', 'meals', v.meals, 'amount_paise', v.amount_paise, 'balance_paise', v_bal);
end;
$$;

-- ---------------------------------------------------------------------------
-- Credits and adjustments. Monthly customers: adjustments are in rupees (p_amount_paise, signed:
-- − opening dues / correction owed, + advance already paid); a credit is free meals valued at
-- the price per meal. Prepaid unchanged (meals; positive adjustments carry the plan price).
-- ---------------------------------------------------------------------------
drop function public.add_balance_entry(uuid, public.balance_entry_type, integer, text);
create function public.add_balance_entry(p_customer uuid, p_type public.balance_entry_type, p_meals integer, p_reason text,
  p_amount_paise integer default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_id uuid;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  if p_type not in ('credit', 'adjust') then
    raise exception 'invalid_type' using errcode = '22023';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if v_c.billing_mode = 'monthly' and p_type = 'adjust' then
    if coalesce(p_amount_paise, 0) = 0 or abs(p_amount_paise) > 10000000 then
      raise exception 'invalid_amount' using errcode = '22023';
    end if;
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note, created_by, created_at)
    values (v_c.kitchen_id, p_customer, 'adjust', 0, p_amount_paise, trim(p_reason), auth.uid(), private.now())
    returning id into v_id;
  else
    if coalesce(p_meals, 0) = 0 or (p_type = 'credit' and p_meals < 0) or abs(p_meals) > 200 then
      raise exception 'invalid_meals' using errcode = '22023';
    end if;
    -- Credits are free meals (prepaid: value 0; monthly: valued by the ledger trigger). A positive
    -- prepaid adjustment (e.g. an opening balance already paid for) carries the price per meal.
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note, created_by, created_at)
    values (v_c.kitchen_id, p_customer, p_type, p_meals,
            case when p_type = 'adjust' and p_meals > 0 then p_meals * coalesce(private.customer_unit_price(p_customer), 0) else 0 end,
            trim(p_reason), auth.uid(), private.now())
    returning id into v_id;
  end if;
  perform private.sync_balance_status(v_c.kitchen_id, p_customer);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Switching a customer's billing mode (owner or manager). The balance is converted once:
--   monthly → prepaid: the meal balance becomes advance ÷ price per meal (rounded down; a debt
--     rounds up to whole meals owed). Two adjust rows: reset the meal count, then one lot holding
--     the advance, so FIFO refunds give back exactly the advance. (An advance smaller than one
--     meal's price gives 0 meals; it stays visible in the rupee balance.)
--   prepaid → monthly: the rupee balance becomes the value of the unused meals (paid lots at what
--     was paid, free meals at the price per meal), or minus the owed meals at their own prices.
-- ---------------------------------------------------------------------------
create or replace function private.convert_billing(p_customer uuid, p_mode public.billing_mode, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_price integer;
  v_meals integer;
  v_paise bigint;
  v_target_meals integer;
  v_target_paise bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('refund:' || p_customer, 0));
  select * into v_c from public.customers where id = p_customer for update;
  if v_c.billing_mode = p_mode then
    return;
  end if;
  v_price := private.customer_unit_price(p_customer);
  select coalesce(sum(b.meals), 0)::integer, coalesce(sum(b.amount_paise), 0)::bigint into v_meals, v_paise
  from public.balance_entries b where b.customer_id = p_customer;

  if p_mode = 'prepaid' then
    if v_paise <> 0 and coalesce(v_price, 0) <= 0 then
      raise exception 'no_plan' using errcode = '22023';
    end if;
    v_target_meals := case when v_paise >= 0 then floor(v_paise::numeric / nullif(v_price, 0))
                           else -ceil(-v_paise::numeric / nullif(v_price, 0)) end;
    v_target_meals := coalesce(v_target_meals, 0);
    -- Reset row: zero the meal count, and (when the advance becomes a lot) move the rupees into it.
    if v_meals <> 0 or (v_target_meals > 0 and v_paise <> 0) then
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, note, created_by, created_at)
      values (v_c.kitchen_id, p_customer, 'adjust', -v_meals, case when v_target_meals > 0 then -v_paise else 0 end,
              'billing_mode', 'Changed to prepaid: meal count reset', p_actor, private.now());
    end if;
    if v_target_meals <> 0 then
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, note, created_by, created_at)
      values (v_c.kitchen_id, p_customer, 'adjust', v_target_meals, case when v_target_meals > 0 then v_paise else 0 end,
              'billing_mode', 'Changed to prepaid: balance in meals', p_actor, private.now());
    end if;
  else
    if v_meals > 0 then
      select coalesce(round(sum(case when l.amount_paise > 0 then l.amount_paise else l.meals * coalesce(v_price, 0) end)), 0)
      into v_target_paise from private.remaining_lots(p_customer) l;
    elsif v_meals < 0 then
      v_target_paise := -private.recent_meals_value(p_customer, -v_meals);
    else
      v_target_paise := 0;
    end if;
    if v_target_paise <> v_paise then
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, note, created_by, created_at)
      values (v_c.kitchen_id, p_customer, 'adjust', 0, v_target_paise - v_paise, 'billing_mode',
              'Changed to monthly: balance in rupees', p_actor, private.now());
    end if;
  end if;

  update public.customers set billing_mode = p_mode where id = p_customer;
  perform private.sync_balance_status(v_c.kitchen_id, p_customer);
end;
$$;

create or replace function public.set_billing_mode(p_customer uuid, p_mode public.billing_mode)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  if p_mode is null then
    raise exception 'invalid_billing_mode' using errcode = '22023';
  end if;
  perform private.convert_billing(p_customer, p_mode, auth.uid());
  return jsonb_build_object('customer_id', p_customer, 'billing_mode', p_mode,
    'balance_meals', (select coalesce(sum(meals), 0) from public.balance_entries where customer_id = p_customer),
    'balance_paise', private.rupee_balance(p_customer));
end;
$$;

-- ---------------------------------------------------------------------------
-- Dues list and money report (owner, manager, accountant)
-- ---------------------------------------------------------------------------
drop function public.dues_list(uuid);
create function public.dues_list(p_kitchen uuid)
returns table (customer_id uuid, customer_name text, meals_owed integer, amount_owed_paise integer, since date,
               billing_mode public.billing_mode)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
  return query
  select d.customer_id, c.name, d.meals_owed, d.amount_owed_paise, d.since, c.billing_mode
  from private.dues(p_kitchen) d join public.customers c on c.id = d.customer_id
  order by d.amount_owed_paise desc, c.name;
end;
$$;

-- Collections report. Liability = prepaid meals not yet eaten (FIFO value) + monthly advances.
create or replace function public.money_report(p_kitchen uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_liability numeric := 0;
  r record;
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
  for r in select c.id, c.billing_mode from public.customers c where c.kitchen_id = p_kitchen loop
    if r.billing_mode = 'monthly' then
      v_liability := v_liability + greatest(private.rupee_balance(r.id), 0);
    else
      v_liability := v_liability + (select amount_paise from private.unused_value(r.id, null));
    end if;
  end loop;

  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'collected_paise', coalesce((select sum(amount_paise) from public.payments
       where kitchen_id = p_kitchen and status = 'paid' and (paid_at at time zone 'Asia/Kolkata')::date between p_from and p_to), 0),
    'by_method', coalesce((select jsonb_object_agg(method, total) from (
       select method, sum(amount_paise) total from public.payments
       where kitchen_id = p_kitchen and status = 'paid' and (paid_at at time zone 'Asia/Kolkata')::date between p_from and p_to
       group by method) x), '{}'::jsonb),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'paise', total) order by d) from (
       select (paid_at at time zone 'Asia/Kolkata')::date d, sum(amount_paise) total from public.payments
       where kitchen_id = p_kitchen and status = 'paid' and (paid_at at time zone 'Asia/Kolkata')::date between p_from and p_to
       group by 1) x), '[]'::jsonb),
    'refunded_paise', coalesce((select sum(amount_paise) from public.refunds
       where kitchen_id = p_kitchen and status = 'processed' and (processed_at at time zone 'Asia/Kolkata')::date between p_from and p_to), 0),
    'refunds_pending_paise', coalesce((select sum(amount_paise) from public.refunds
       where kitchen_id = p_kitchen and status in ('pending', 'processing', 'failed')), 0),
    'pending_cash_paise', coalesce((select sum(amount_paise) from public.payments where kitchen_id = p_kitchen and status = 'pending'), 0),
    'dues_paise', coalesce((select sum(amount_owed_paise) from private.dues(p_kitchen)), 0),
    'dues_customers', (select count(*) from private.dues(p_kitchen)),
    'liability_paise', round(v_liability)::integer,
    'customers', (select count(*) from public.customers where kitchen_id = p_kitchen and deleted_at is null),
    'monthly_customers', (select count(*) from public.customers where kitchen_id = p_kitchen and deleted_at is null and billing_mode = 'monthly'),
    'prepaid_customers', (select count(*) from public.customers where kitchen_id = p_kitchen and deleted_at is null and billing_mode = 'prepaid'),
    'whatsapp_opt_in', (select count(*) from public.customers where kitchen_id = p_kitchen and deleted_at is null and whatsapp_opt_in),
    'live_subscriptions', (select count(*) from public.subscriptions where kitchen_id = p_kitchen and status <> 'cancelled'),
    'autopay_subscriptions', (select count(*) from public.subscriptions
       where kitchen_id = p_kitchen and status <> 'cancelled' and autopay_mandate_id is not null)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (fail closed)
-- ---------------------------------------------------------------------------
revoke execute on function private.customer_billing_default(), private.customer_unit_price(uuid), private.rupee_balance(uuid),
  private.recent_meals_value(uuid, integer), private.recent_meals_for_amount(uuid, bigint), private.payment_meals_for_mode(),
  private.value_monthly_entry(), private.create_refund(uuid, integer, text, uuid, uuid, integer),
  private.convert_billing(uuid, public.billing_mode, uuid)
  from public, anon, authenticated;
revoke execute on function public.refund_unused_meals(uuid, integer, text, integer), public.add_balance_entry(uuid, public.balance_entry_type, integer, text, integer),
  public.set_billing_mode(uuid, public.billing_mode), public.dues_list(uuid)
  from public, anon;
grant execute on function public.refund_unused_meals(uuid, integer, text, integer), public.add_balance_entry(uuid, public.balance_entry_type, integer, text, integer),
  public.set_billing_mode(uuid, public.billing_mode), public.dues_list(uuid)
  to authenticated;
