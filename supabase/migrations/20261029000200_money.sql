-- M3 Money: payments (Razorpay links, manual cash/UPI, rider cash at the door), recharges,
-- FIFO-valued refunds, credits/adjustments, balance-driven subscription states, dues,
-- reminders, collections report, receipt storage, Razorpay webhook processing.
--
-- Rules
--   * We never hold money: online links route to the kitchen's verified Razorpay linked
--     account (Route). Without one, only cash/UPI-to-vendor entries are possible.
--   * Balance = Σ balance_entries.meals. Every recharge/refund/credit is one ledger row.
--   * Refund value is FIFO: meals are consumed from the oldest purchase lot first, so
--     unused meals are valued at the price actually paid for the newest lots.
--   * Webhooks are idempotent twice over: webhook_events(provider, event_id) and the
--     unique (type, ref_type, ref_id) key on balance_entries.

-- ---------------------------------------------------------------------------
-- Types and tables
-- ---------------------------------------------------------------------------
create type public.payment_method as enum ('razorpay_link', 'razorpay_autopay', 'cash', 'upi_manual', 'bank_transfer');
-- created: link sent, not paid · pending: rider cash awaiting owner confirmation
-- review: provider amount did not match (no recharge until resolved)
create type public.payment_status as enum ('created', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'review');
create type public.refund_status as enum ('pending', 'processing', 'processed', 'failed');
create type public.refund_method as enum ('razorpay', 'cash', 'upi_manual', 'bank_transfer');

alter table public.subscriptions add column status_changed_at timestamptz not null default now();

-- Strict insertion order for the ledger (FIFO tie-break when entries share a timestamp).
alter table public.balance_entries add column seq bigint generated always as identity;
create unique index balance_entries_seq_idx on public.balance_entries (seq);

create or replace function private.touch_status_changed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := private.now();
  end if;
  return new;
end;
$$;

create trigger subscriptions_status_changed_at before update of status on public.subscriptions
  for each row execute function private.touch_status_changed_at();

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  customer_id uuid not null,
  method public.payment_method not null,
  status public.payment_status not null,
  amount_paise integer not null check (amount_paise > 0 and amount_paise <= 10000000),
  meals integer not null check (meals > 0 and meals <= 1000),
  description text,
  razorpay_payment_link_id text unique,
  razorpay_payment_id text unique,
  razorpay_order_id text,
  short_url text,
  expires_at timestamptz,
  settled_to_account text,            -- Razorpay linked account the money was routed to
  receipt_photo_path text,            -- storage: receipts/<kitchen_id>/...
  collected_by uuid references auth.users (id),
  meal_order_id uuid,
  confirmed_by uuid references auth.users (id),
  confirmed_at timestamptz,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (meal_order_id, kitchen_id) references public.meal_orders (id, kitchen_id)
);
create index payments_kitchen_idx on public.payments (kitchen_id, created_at desc);
create index payments_customer_idx on public.payments (customer_id, created_at desc);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  customer_id uuid not null,
  subscription_id uuid,
  meals integer not null check (meals > 0),
  amount_paise integer not null check (amount_paise >= 0),
  method public.refund_method,         -- chosen when the refund is paid out
  status public.refund_status not null default 'pending',
  payment_id uuid,                      -- original online payment, for Razorpay refunds
  razorpay_refund_id text unique,
  reason text not null,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  processed_by uuid references auth.users (id),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (subscription_id, kitchen_id) references public.subscriptions (id, kitchen_id),
  foreign key (payment_id, kitchen_id) references public.payments (id, kitchen_id)
);
create index refunds_kitchen_idx on public.refunds (kitchen_id, created_at desc);

-- Raw provider events, deduplicated on the provider's event id. Service role only.
create table public.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('razorpay', 'meta')),
  event_id text not null,
  event_type text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result text,
  unique (provider, event_id)
);

create trigger payments_updated_at before update on public.payments
  for each row execute function private.set_updated_at();
create trigger refunds_updated_at before update on public.refunds
  for each row execute function private.set_updated_at();
create trigger payments_audit after insert or update or delete on public.payments
  for each row execute function private.audit_row();
create trigger refunds_audit after insert or update or delete on public.refunds
  for each row execute function private.audit_row();
create trigger webhook_events_append_only before delete on public.webhook_events
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Price per meal for a customer: their live subscription's plan, else their latest plan.
create or replace function private.customer_unit_price(p_customer uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select p.price_per_meal_paise
  from public.subscriptions s join public.plans p on p.id = s.plan_id
  where s.customer_id = p_customer
  order by (s.status in ('active', 'low_balance', 'paused', 'suspended', 'trial')) desc, s.created_at desc
  limit 1;
$$;

-- Remaining purchase lots after FIFO consumption (oldest lot consumed first).
create or replace function private.remaining_lots(p_customer uuid)
returns table (entry_id uuid, created_at timestamptz, seq bigint, meals integer, amount_paise numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_consumed bigint;
  r record;
begin
  select coalesce(-sum(b.meals), 0) into v_consumed
  from public.balance_entries b where b.customer_id = p_customer and b.meals < 0;

  for r in
    select b.id, b.created_at, b.seq, b.meals, b.amount_paise
    from public.balance_entries b
    where b.customer_id = p_customer and b.meals > 0
    order by b.created_at, b.seq
  loop
    if v_consumed >= r.meals then
      v_consumed := v_consumed - r.meals;
      continue;
    end if;
    entry_id := r.id;
    created_at := r.created_at;
    seq := r.seq;
    meals := r.meals - v_consumed;
    amount_paise := r.amount_paise::numeric * (r.meals - v_consumed) / r.meals;
    v_consumed := 0;
    return next;
  end loop;
end;
$$;

-- Value of the oldest p_meals unused meals (all unused when null), FIFO.
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

-- Balance-driven states: active ⇄ low_balance → suspended (at -credit limit), back on recharge.
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
    select s.id,
           coalesce((select sum(be.meals) from public.balance_entries be where be.customer_id = s.customer_id), 0) as bal,
           ks.low_balance_meals, ks.credit_limit_meals
    from public.subscriptions s
    join public.kitchen_settings ks on ks.kitchen_id = s.kitchen_id
    where s.status in ('active', 'low_balance', 'suspended')
      and (p_kitchen is null or s.kitchen_id = p_kitchen)
      and (p_customer is null or s.customer_id = p_customer)
  ),
  target as (
    select id, case
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

-- Queue a WhatsApp message to a customer (delivered by the M4 worker).
create or replace function private.notify_customer(p_kitchen uuid, p_customer uuid, p_template text, p_payload jsonb, p_dedupe text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  values (p_kitchen, 'whatsapp', 'customer', p_customer, p_template, p_payload, p_dedupe)
  on conflict (dedupe_key) do nothing;
$$;

-- Post the recharge for a paid payment (idempotent), activate unpaid trials, resync states.
create or replace function private.post_recharge(p_payment uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.payments;
begin
  select * into v_p from public.payments where id = p_payment;
  if v_p.status <> 'paid' then
    return;
  end if;

  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, created_by, created_at)
  values (v_p.kitchen_id, v_p.customer_id, 'recharge', v_p.meals, v_p.amount_paise, 'payment', v_p.id,
          coalesce(v_p.confirmed_by, v_p.created_by), coalesce(v_p.paid_at, private.now()))
  on conflict (type, ref_type, ref_id) where ref_id is not null do nothing;
  if not found then
    return; -- already posted
  end if;

  perform set_config('app.status_reason', 'trial_paid', true);
  update public.subscriptions set status = 'active'
  where customer_id = v_p.customer_id and status = 'trial';
  perform set_config('app.status_reason', '', true);
  perform private.sync_balance_status(v_p.kitchen_id, v_p.customer_id);

  perform private.notify_customer(v_p.kitchen_id, v_p.customer_id, 'payment_receipt',
    jsonb_build_object('payment_id', v_p.id, 'amount_paise', v_p.amount_paise, 'meals', v_p.meals, 'method', v_p.method,
                       'balance_meals', (select sum(meals) from public.balance_entries where customer_id = v_p.customer_id)),
    'payment_receipt:' || v_p.id);
end;
$$;

-- Create a pending refund for unused meals (FIFO value) and take the meals out of the balance.
create or replace function private.create_refund(p_customer uuid, p_meals integer, p_reason text, p_subscription uuid, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
  v_value record;
  v_refund uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer;
  perform pg_advisory_xact_lock(hashtextextended('refund:' || p_customer, 0));
  select * into v_value from private.unused_value(p_customer, p_meals);
  if v_value.meals <= 0 then
    raise exception 'nothing_to_refund' using errcode = '22023';
  end if;
  if p_meals is not null and v_value.meals < p_meals then
    raise exception 'refund_exceeds_balance' using errcode = '22023';
  end if;

  insert into public.refunds (kitchen_id, customer_id, subscription_id, meals, amount_paise, reason, created_by,
                              created_at, payment_id)
  values (v_kitchen, p_customer, p_subscription, v_value.meals, v_value.amount_paise, p_reason, p_actor, private.now(),
          -- Most recent online payment that can still cover this refund (else it is paid in cash/UPI).
          (select p.id from public.payments p
           where p.customer_id = p_customer and p.status = 'paid' and p.method = 'razorpay_link'
             and p.amount_paise - coalesce((select sum(r.amount_paise) from public.refunds r
                                            where r.payment_id = p.id and r.status <> 'failed'), 0) >= v_value.amount_paise
           order by p.paid_at desc limit 1))
  returning id into v_refund;

  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
  values (v_kitchen, p_customer, 'refund', -v_value.meals, -v_value.amount_paise, 'refund', v_refund, p_reason, p_actor, private.now());

  perform private.sync_balance_status(v_kitchen, p_customer);
  perform private.notify_customer(v_kitchen, p_customer, 'refund_notice',
    jsonb_build_object('refund_id', v_refund, 'meals', v_value.meals, 'amount_paise', v_value.amount_paise),
    'refund_notice:' || v_refund);
  return v_refund;
end;
$$;

-- When a customer's last live subscription is cancelled, refund their unused meals (pro-rata).
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
    -- Meals past their cutoff are being cooked: lock (charge) them before valuing the refund,
    -- even if the minute-by-minute lock job has not reached them yet.
    for r in
      select distinct o.service_date, o.slot
      from public.meal_orders o join public.kitchens k on k.id = o.kitchen_id
      where o.subscription_id = new.id and o.locked_at is null
        and private.now() >= private.cutoff_at(k, o.service_date, o.slot)
    loop
      perform private.lock_slot(new.kitchen_id, r.service_date, r.slot);
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

create trigger subscriptions_refund_on_cancel after update of status on public.subscriptions
  for each row execute function private.refund_on_cancel();

-- ---------------------------------------------------------------------------
-- Engine updates: balance states after every lock and in the nightly run
-- ---------------------------------------------------------------------------
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
    -- Meals just charged may move customers to low balance / suspended (and drop later meals).
    perform private.sync_balance_status(r.id, null);
    v_count := v_count + 1;
  end loop;
  return v_count;
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
  update public.subscriptions s set status = 'cancelled', cancelled_at = private.now()
  from public.kitchen_settings ks
  where ks.kitchen_id = s.kitchen_id and s.status = 'suspended'
    and s.status_changed_at < private.now() - make_interval(days => ks.grace_days);

  -- A trial never paid ends as cancelled once its grace period after the start date is over.
  perform set_config('app.status_reason', 'trial_unpaid', true);
  update public.subscriptions s set status = 'cancelled', cancelled_at = private.now()
  from public.kitchen_settings ks
  where ks.kitchen_id = s.kitchen_id and s.status = 'trial'
    and s.start_date + ks.grace_days < v_today;
  perform set_config('app.status_reason', '', true);

  perform private.refresh_orders(null, null, 7);
  perform private.queue_customer_reminders();
end;
$$;

-- Status sync from M2, now also re-checking balances (e.g. after a pause ends).
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
  -- A subscription back from a pause may already be on a low or empty balance.
  if p_subscription is null then
    perform private.sync_balance_status(null, null);
  else
    perform private.sync_balance_status(null, (select customer_id from public.subscriptions where id = p_subscription));
  end if;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dues and reminders
-- ---------------------------------------------------------------------------

-- Customers who owe meals (balance below zero), with the date they went negative.
create or replace function private.dues(p_kitchen uuid)
returns table (customer_id uuid, meals_owed integer, amount_owed_paise integer, since date)
language sql
stable
set search_path = ''
as $$
  with running as (
    select b.customer_id, b.created_at,
           sum(b.meals) over (partition by b.customer_id order by b.created_at, b.id) as bal
    from public.balance_entries b
    where b.kitchen_id = p_kitchen
  ),
  current_bal as (
    select customer_id, sum(meals)::integer as bal
    from public.balance_entries where kitchen_id = p_kitchen group by customer_id
  )
  select c.customer_id, -c.bal, -c.bal * coalesce(private.customer_unit_price(c.customer_id), 0),
         (select (min(r.created_at) at time zone 'Asia/Kolkata')::date from running r
          where r.customer_id = c.customer_id and r.bal < 0
            and r.created_at > coalesce((select max(r2.created_at) from running r2
                                         where r2.customer_id = c.customer_id and r2.bal >= 0), '-infinity'))
  from current_bal c
  where c.bal < 0;
$$;

-- Nightly: low-balance reminders (daily) and dues reminders on day 1, 3 and 7.
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
    where v_today - d.since in (1, 3, 7)
    on conflict (dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Razorpay webhook processing (called by the razorpay-webhook Edge Function with
-- the service role after it verified the signature).
-- ---------------------------------------------------------------------------
create or replace function private.mark_payment_paid(p_payment uuid, p_rzp_payment_id text, p_amount integer, p_currency text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.payments;
  v_account text;
begin
  select * into v_p from public.payments where id = p_payment for update;
  if v_p.id is null then
    return 'unmatched';
  end if;
  if v_p.status = 'paid' then
    return 'already_paid';
  end if;
  if p_amount is distinct from v_p.amount_paise or coalesce(p_currency, 'INR') <> 'INR' then
    update public.payments set status = 'review', razorpay_payment_id = coalesce(razorpay_payment_id, p_rzp_payment_id),
      note = concat_ws(' · ', note, 'Amount mismatch: provider sent ' || p_amount || ' ' || coalesce(p_currency, ''))
    where id = p_payment;
    return 'amount_mismatch';
  end if;
  select razorpay_linked_account_id into v_account from public.kitchen_payout_accounts where kitchen_id = v_p.kitchen_id;
  update public.payments
  set status = 'paid', paid_at = private.now(), razorpay_payment_id = coalesce(razorpay_payment_id, p_rzp_payment_id),
      settled_to_account = v_account
  where id = p_payment;
  perform private.post_recharge(p_payment);
  return 'paid';
end;
$$;

create or replace function public.razorpay_process_event(p_event_id text, p_payload jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := p_payload ->> 'event';
  v_pay jsonb := p_payload -> 'payload' -> 'payment' -> 'entity';
  v_link jsonb := p_payload -> 'payload' -> 'payment_link' -> 'entity';
  v_ref jsonb := p_payload -> 'payload' -> 'refund' -> 'entity';
  v_payment uuid;
  v_refund uuid;
  v_result text;
begin
  if nullif(p_event_id, '') is null then
    raise exception 'event_id_required' using errcode = '22023';
  end if;
  insert into public.webhook_events (provider, event_id, event_type, payload)
  values ('razorpay', p_event_id, v_type, p_payload)
  on conflict (provider, event_id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  -- Find our payment: link reference_id/notes, payment notes, or a known Razorpay id.
  select p.id into v_payment from public.payments p
  where p.id::text = coalesce(v_link ->> 'reference_id', v_link -> 'notes' ->> 'payment_id', v_pay -> 'notes' ->> 'payment_id')
     or (v_link ->> 'id' is not null and p.razorpay_payment_link_id = v_link ->> 'id')
     or (v_pay ->> 'id' is not null and p.razorpay_payment_id = v_pay ->> 'id')
  limit 1;

  v_result := case
    when v_type in ('payment_link.paid', 'payment.captured') then
      case when v_payment is null then 'unmatched'
           else private.mark_payment_paid(v_payment, v_pay ->> 'id', (v_pay ->> 'amount')::integer, v_pay ->> 'currency') end
    when v_type = 'payment.failed' then
      case when v_payment is null then 'unmatched' else 'noted' end
    when v_type in ('payment_link.expired', 'payment_link.cancelled') then
      case when v_payment is null then 'unmatched' else 'link_closed' end
    when v_type in ('refund.processed', 'refund.failed') then 'refund'
    else 'ignored'
  end;

  if v_type in ('payment_link.expired', 'payment_link.cancelled') and v_payment is not null then
    update public.payments set status = case when v_type = 'payment_link.expired' then 'expired' else 'cancelled' end::public.payment_status
    where id = v_payment and status = 'created';
  end if;

  if v_type in ('refund.processed', 'refund.failed') then
    select r.id into v_refund from public.refunds r
    where r.razorpay_refund_id = v_ref ->> 'id' or r.id::text = v_ref -> 'notes' ->> 'refund_id'
    limit 1;
    if v_refund is null then
      v_result := 'unmatched';
    else
      update public.refunds
      set status = case when v_type = 'refund.processed' then 'processed' else 'failed' end::public.refund_status,
          razorpay_refund_id = coalesce(razorpay_refund_id, v_ref ->> 'id'),
          processed_at = case when v_type = 'refund.processed' then private.now() end
      where id = v_refund and status in ('pending', 'processing');
      v_result := case when v_type = 'refund.processed' then 'refund_processed' else 'refund_failed' end;
    end if;
  end if;

  update public.webhook_events set processed_at = private.now(), result = v_result
  where provider = 'razorpay' and event_id = p_event_id;
  return v_result;
end;
$$;

-- Edge Function helpers (service role): attach the Razorpay link to our payment row.
create or replace function public.attach_payment_link(p_payment uuid, p_link_id text, p_short_url text, p_expires_at timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.payments
  set razorpay_payment_link_id = p_link_id, short_url = p_short_url, expires_at = p_expires_at
  where id = p_payment and status = 'created';
$$;

create or replace function public.mark_refund_submitted(p_refund uuid, p_razorpay_refund_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.refunds set status = 'processing', method = 'razorpay', razorpay_refund_id = p_razorpay_refund_id
  where id = p_refund and status in ('pending', 'failed');
$$;

-- ---------------------------------------------------------------------------
-- Owner / rider RPCs
-- ---------------------------------------------------------------------------

-- Step 1 of a payment link (called by the Edge Function as the signed-in owner):
-- creates our payment row for N meals at the customer's plan price.
create or replace function public.create_payment_link_record(p_customer uuid, p_meals integer, p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_price integer;
  v_account public.kitchen_payout_accounts;
  v_id uuid;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  if coalesce(p_meals, 0) not between 1 and 200 then
    raise exception 'invalid_meals' using errcode = '22023';
  end if;
  select * into v_account from public.kitchen_payout_accounts where kitchen_id = v_c.kitchen_id;
  if v_account.razorpay_linked_account_id is null or v_account.kyc_status <> 'verified' then
    raise exception 'payout_account_not_verified' using errcode = '22023';
  end if;
  v_price := private.customer_unit_price(p_customer);
  if v_price is null then
    raise exception 'no_plan' using errcode = '22023';
  end if;

  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, description, created_by, created_at)
  values (v_c.kitchen_id, p_customer, 'razorpay_link', 'created', p_meals * v_price, p_meals,
          coalesce(nullif(trim(p_description), ''), p_meals || ' meals'), auth.uid(), private.now())
  returning id into v_id;

  return jsonb_build_object(
    'payment_id', v_id, 'amount_paise', p_meals * v_price, 'meals', p_meals,
    'linked_account_id', v_account.razorpay_linked_account_id,
    'customer_name', v_c.name, 'customer_phone', private.decrypt_phone(v_c.phone_enc),
    'kitchen_name', (select name from public.kitchens where id = v_c.kitchen_id));
end;
$$;

-- Owner records cash / UPI-to-vendor / bank transfer. Meals default to amount ÷ plan price (rounded down).
create or replace function public.record_payment(
  p_customer uuid,
  p_amount_paise integer,
  p_method public.payment_method,
  p_meals integer default null,
  p_receipt_photo_path text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_price integer;
  v_meals integer;
  v_id uuid;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  if p_method not in ('cash', 'upi_manual', 'bank_transfer') then
    raise exception 'invalid_method' using errcode = '22023';
  end if;
  if coalesce(p_amount_paise, 0) <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  v_price := private.customer_unit_price(p_customer);
  v_meals := coalesce(p_meals, case when v_price > 0 then p_amount_paise / v_price end);
  if coalesce(v_meals, 0) <= 0 then
    raise exception 'invalid_meals' using errcode = '22023';
  end if;

  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, receipt_photo_path, note,
                               created_by, confirmed_by, confirmed_at, paid_at, created_at)
  values (v_c.kitchen_id, p_customer, p_method, 'paid', p_amount_paise, v_meals, p_receipt_photo_path,
          nullif(trim(p_note), ''), auth.uid(), auth.uid(), private.now(), private.now(), private.now())
  returning id into v_id;
  perform private.post_recharge(v_id);
  return v_id;
end;
$$;

-- Rider records cash collected at the door for a delivery. Pending until the owner confirms.
create or replace function public.record_cash_at_door(p_meal_order uuid, p_amount_paise integer, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.meal_orders;
  v_price integer;
  v_id uuid;
begin
  select * into v_o from public.meal_orders where id = p_meal_order;
  if v_o.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_o.kitchen_id, '{owner,rider}');
  if coalesce(p_amount_paise, 0) <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  v_price := private.customer_unit_price(v_o.customer_id);
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, note, collected_by,
                               meal_order_id, created_by, created_at)
  values (v_o.kitchen_id, v_o.customer_id, 'cash', 'pending', p_amount_paise,
          greatest(1, coalesce(p_amount_paise / nullif(v_price, 0), 1)), nullif(trim(p_note), ''), auth.uid(), v_o.id, auth.uid(),
          private.now())
  returning id into v_id;
  return v_id;
end;
$$;

-- Owner confirms (optionally correcting meals) or rejects rider-collected cash.
create or replace function public.confirm_payment(p_payment uuid, p_meals integer default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.payments;
begin
  select * into v_p from public.payments where id = p_payment for update;
  if v_p.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_p.kitchen_id, '{owner}');
  if v_p.status <> 'pending' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  update public.payments
  set status = 'paid', meals = coalesce(p_meals, meals), confirmed_by = auth.uid(), confirmed_at = private.now(),
      paid_at = coalesce(paid_at, created_at)
  where id = p_payment;
  perform private.post_recharge(p_payment);
end;
$$;

create or replace function public.reject_payment(p_payment uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.payments;
begin
  select * into v_p from public.payments where id = p_payment for update;
  if v_p.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_p.kitchen_id, '{owner}');
  if v_p.status not in ('pending', 'created', 'review') then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  update public.payments set status = 'cancelled', note = concat_ws(' · ', note, nullif(trim(p_reason), ''))
  where id = p_payment;
end;
$$;

-- Owner gives free meals (kitchen's fault), enters an opening balance, or corrects the balance. Reason required.
create or replace function public.add_balance_entry(p_customer uuid, p_type public.balance_entry_type, p_meals integer, p_reason text)
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
  if coalesce(p_meals, 0) = 0 or (p_type = 'credit' and p_meals < 0) or abs(p_meals) > 200 then
    raise exception 'invalid_meals' using errcode = '22023';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  -- Credits are free meals (value 0). A positive adjustment (e.g. an opening balance the
  -- customer already paid for) carries the plan price so refunds value it correctly.
  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note, created_by, created_at)
  values (v_c.kitchen_id, p_customer, p_type, p_meals,
          case when p_type = 'adjust' and p_meals > 0 then p_meals * coalesce(private.customer_unit_price(p_customer), 0) else 0 end,
          trim(p_reason), auth.uid(), private.now())
  returning id into v_id;
  perform private.sync_balance_status(v_c.kitchen_id, p_customer);
  return v_id;
end;
$$;

-- Owner refunds unused meals (all when p_meals is null), FIFO-valued.
create or replace function public.refund_unused_meals(p_customer uuid, p_meals integer default null, p_reason text default null)
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
  return private.create_refund(p_customer, p_meals, coalesce(nullif(trim(p_reason), ''), 'Refund of unused meals'), null, auth.uid());
end;
$$;

-- Owner marks a refund as paid out in cash / UPI / bank.
create or replace function public.mark_refund_paid(p_refund uuid, p_method public.refund_method, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.refunds;
begin
  select * into v_r from public.refunds where id = p_refund for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner}');
  if p_method = 'razorpay' then
    raise exception 'invalid_method' using errcode = '22023';
  end if;
  if v_r.status not in ('pending', 'failed') then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  update public.refunds set status = 'processed', method = p_method, processed_by = auth.uid(), processed_at = private.now(),
    note = nullif(trim(p_note), '')
  where id = p_refund;
  perform private.notify_customer(v_r.kitchen_id, v_r.customer_id, 'refund_receipt',
    jsonb_build_object('refund_id', v_r.id, 'amount_paise', v_r.amount_paise, 'method', p_method), 'refund_receipt:' || v_r.id);
end;
$$;

-- What the razorpay-refund Edge Function needs to refund to the original online payment.
create or replace function public.refund_for_gateway(p_refund uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.refunds;
  v_p public.payments;
begin
  select * into v_r from public.refunds where id = p_refund;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner}');
  if v_r.status not in ('pending', 'failed') then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  select * into v_p from public.payments where id = v_r.payment_id;
  if v_p.id is null or v_p.method <> 'razorpay_link' or v_p.status <> 'paid' or v_p.razorpay_payment_id is null then
    raise exception 'no_online_payment' using errcode = '22023';
  end if;
  if v_r.amount_paise > v_p.amount_paise - coalesce((select sum(r.amount_paise) from public.refunds r
                                                    where r.payment_id = v_p.id and r.id <> v_r.id and r.status <> 'failed'), 0) then
    raise exception 'refund_exceeds_payment' using errcode = '22023';
  end if;
  return jsonb_build_object('refund_id', v_r.id, 'amount_paise', v_r.amount_paise, 'razorpay_payment_id', v_p.razorpay_payment_id);
end;
$$;

-- Import from M1, now with an opening balance column (meals the customer has already paid for).
-- p_rows: JSON array of objects with keys
--   name, phone, diet, language, line1, area, landmark, delivery_notes, notes,
--   lat, lng, plan (plan name), start_date (YYYY-MM-DD), qty, balance (opening balance in meals; M3)
-- p_consent: the vendor confirms these customers agreed to be contacted.
-- Returns { batch_id, total, imported, failed, errors: [{ row, errors: [code…] }] }.
create or replace function public.import_customers(
  p_kitchen uuid,
  p_rows jsonb,
  p_consent boolean,
  p_file_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch uuid;
  v_row jsonb;
  v_idx integer;
  v_errors text[];
  v_phone text;
  v_hash text;
  v_seen text[] := '{}';
  v_diet public.diet_type;
  v_lang public.language_code;
  v_plan uuid;
  v_start date;
  v_qty integer;
  v_customer uuid;
  v_address uuid;
  v_imported integer := 0;
  v_failed integer := 0;
  v_report jsonb := '[]'::jsonb;
  v_raw jsonb;
  v_balance integer;
begin
  perform private.require_role(p_kitchen, '{owner}');
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows_must_be_array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'too_many_rows' using errcode = '22023';
  end if;

  insert into public.import_batches (kitchen_id, file_name, total_rows, created_by)
  values (p_kitchen, p_file_name, jsonb_array_length(p_rows), auth.uid())
  returning id into v_batch;

  for v_row, v_idx in select e, i::integer from jsonb_array_elements(p_rows) with ordinality as t(e, i) loop
    v_errors := '{}';
    v_customer := null;
    v_plan := null;
    v_start := null;
    v_qty := 1;
    v_balance := 0;
    v_phone := private.normalize_phone(v_row ->> 'phone');
    v_raw := (v_row - 'phone') || jsonb_build_object('phone_last4', right(v_phone, 4));

    if nullif(trim(v_row ->> 'name'), '') is null then
      v_errors := array_append(v_errors, 'name_required');
    end if;

    if v_phone is null then
      v_errors := array_append(v_errors, 'invalid_phone');
    else
      v_hash := private.phone_hash(v_phone);
      if v_hash = any (v_seen) then
        v_errors := array_append(v_errors, 'duplicate_in_file');
      elsif exists (select 1 from public.customers
                    where kitchen_id = p_kitchen and phone_hash = v_hash and deleted_at is null) then
        v_errors := array_append(v_errors, 'already_exists');
      end if;
    end if;

    v_diet := private.parse_diet(v_row ->> 'diet');
    if v_diet is null then
      v_errors := array_append(v_errors, 'invalid_diet');
    end if;
    v_lang := private.parse_language(v_row ->> 'language');
    if v_lang is null then
      v_errors := array_append(v_errors, 'invalid_language');
    end if;

    if nullif(trim(v_row ->> 'plan'), '') is not null then
      select id into v_plan from public.plans
      where kitchen_id = p_kitchen and active and lower(name) = lower(trim(v_row ->> 'plan'));
      if v_plan is null then
        v_errors := array_append(v_errors, 'unknown_plan');
      end if;
    end if;

    if nullif(trim(v_row ->> 'start_date'), '') is not null then
      if (v_row ->> 'start_date') !~ '^\d{4}-\d{2}-\d{2}$' then
        v_errors := array_append(v_errors, 'invalid_date');
      else
        begin
          v_start := (v_row ->> 'start_date')::date;
        exception when others then
          v_errors := array_append(v_errors, 'invalid_date');
        end;
      end if;
    end if;
    if v_start is not null and nullif(trim(v_row ->> 'plan'), '') is null then
      v_errors := array_append(v_errors, 'start_date_requires_plan');
    end if;

    if nullif(trim(v_row ->> 'qty'), '') is not null then
      if (v_row ->> 'qty') ~ '^\d{1,2}$' and (v_row ->> 'qty')::integer between 1 and 20 then
        v_qty := (v_row ->> 'qty')::integer;
      else
        v_errors := array_append(v_errors, 'invalid_qty');
      end if;
    end if;

    if nullif(trim(v_row ->> 'balance'), '') is not null then
      if (v_row ->> 'balance') ~ '^-?\d{1,4}$' and (v_row ->> 'balance')::integer between -200 and 1000 then
        v_balance := (v_row ->> 'balance')::integer;
      else
        v_errors := array_append(v_errors, 'invalid_balance');
      end if;
    end if;

    if (nullif(v_row ->> 'lat', '') is null) <> (nullif(v_row ->> 'lng', '') is null)
       or (nullif(v_row ->> 'lat', '') is not null
           and not ((v_row ->> 'lat') ~ '^-?\d+(\.\d+)?$' and (v_row ->> 'lng') ~ '^-?\d+(\.\d+)?$')) then
      v_errors := array_append(v_errors, 'invalid_location');
    end if;

    if cardinality(v_errors) = 0 then
      begin
        v_customer := private.insert_customer(
          p_kitchen, v_row ->> 'name', v_phone, v_diet, v_lang, v_row ->> 'notes',
          jsonb_build_object('line1', v_row ->> 'line1', 'area', v_row ->> 'area',
            'landmark', v_row ->> 'landmark', 'delivery_notes', v_row ->> 'delivery_notes',
            'lat', nullif(v_row ->> 'lat', ''), 'lng', nullif(v_row ->> 'lng', ''))
          , 'import', 'import');

        if v_plan is not null then
          select id into v_address from public.addresses where customer_id = v_customer and is_default;
          insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, qty, start_date, status)
          values (p_kitchen, v_customer, v_plan, v_address, v_qty, coalesce(v_start, current_date), 'active');
        end if;
        if v_balance <> 0 then
          insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note, created_by, created_at)
          values (p_kitchen, v_customer, 'adjust', v_balance,
                  case when v_balance > 0 then v_balance * coalesce((select price_per_meal_paise from public.plans where id = v_plan), 0) else 0 end,
                  'Opening balance (import)', auth.uid(), private.now());
        end if;
        v_seen := v_seen || v_hash;
      exception when others then
        v_customer := null;
        v_errors := array_append(v_errors, 'db_error:' || sqlstate);
      end;
    end if;

    if cardinality(v_errors) = 0 then
      v_imported := v_imported + 1;
      insert into public.import_rows (batch_id, kitchen_id, row_number, raw, status, customer_id)
      values (v_batch, p_kitchen, v_idx, v_raw, 'imported', v_customer);
    else
      v_failed := v_failed + 1;
      insert into public.import_rows (batch_id, kitchen_id, row_number, raw, status, errors)
      values (v_batch, p_kitchen, v_idx, v_raw, 'error', v_errors);
      v_report := v_report || jsonb_build_object('row', v_idx, 'errors', to_jsonb(v_errors));
    end if;
  end loop;

  update public.import_batches set imported_rows = v_imported, error_rows = v_failed where id = v_batch;

  return jsonb_build_object('batch_id', v_batch, 'total', v_imported + v_failed,
    'imported', v_imported, 'failed', v_failed, 'errors', v_report);
end;
$$;

-- Value of a customer's unused meals (for the refund preview).
create or replace function public.unused_meals_value(p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
  v record;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  select * into v from private.unused_value(p_customer, null);
  return jsonb_build_object('meals', v.meals, 'amount_paise', v.amount_paise);
end;
$$;

create or replace function public.dues_list(p_kitchen uuid)
returns table (customer_id uuid, customer_name text, meals_owed integer, amount_owed_paise integer, since date)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  return query
  select d.customer_id, c.name, d.meals_owed, d.amount_owed_paise, d.since
  from private.dues(p_kitchen) d join public.customers c on c.id = d.customer_id
  order by d.amount_owed_paise desc;
end;
$$;

-- Collections report: money in by method and day, refunds, dues, prepaid-meal liability,
-- and the share of customers on WhatsApp / autopay.
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
  perform private.require_role(p_kitchen, '{owner}');
  for r in select c.id from public.customers c where c.kitchen_id = p_kitchen loop
    v_liability := v_liability + (select amount_paise from private.unused_value(r.id, null));
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
    'whatsapp_opt_in', (select count(*) from public.customers where kitchen_id = p_kitchen and deleted_at is null and whatsapp_opt_in),
    'live_subscriptions', (select count(*) from public.subscriptions where kitchen_id = p_kitchen and status <> 'cancelled'),
    'autopay_subscriptions', (select count(*) from public.subscriptions
       where kitchen_id = p_kitchen and status <> 'cancelled' and autopay_mandate_id is not null)
  );
end;
$$;

-- Admin: record the kitchen's Razorpay Route linked account (created/verified in Razorpay).
create or replace function public.set_payout_account(p_kitchen uuid, p_account_id text, p_kyc_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_account_id is not null and p_account_id !~ '^acc_[A-Za-z0-9]{6,}$' then
    raise exception 'invalid_account_id' using errcode = '22023';
  end if;
  update public.kitchen_payout_accounts
  set razorpay_linked_account_id = nullif(trim(p_account_id), ''), kyc_status = p_kyc_status
  where kitchen_id = p_kitchen;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Receipt photos: private bucket, one folder per kitchen (receipts/<kitchen_id>/...).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy receipts_read on storage.objects for select to authenticated
  using (bucket_id = 'receipts'
         and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}'))::text[]));
create policy receipts_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts'
              and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner,rider}'))::text[]));

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.webhook_events enable row level security;

create policy payments_select on public.payments for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[])
         or collected_by = (select auth.uid())
         or (select private.is_platform_admin()));
create policy refunds_select on public.refunds for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

revoke all on public.payments, public.refunds, public.webhook_events from anon, authenticated;
grant select on public.payments, public.refunds to authenticated;
grant select, insert, update on public.webhook_events to service_role;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.kitchen_ids(public.member_role[]) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;

revoke execute on function public.create_payment_link_record, public.record_payment, public.record_cash_at_door,
  public.confirm_payment, public.reject_payment, public.add_balance_entry, public.refund_unused_meals,
  public.mark_refund_paid, public.unused_meals_value, public.dues_list, public.money_report, public.set_payout_account,
  public.refund_for_gateway, public.razorpay_process_event, public.attach_payment_link, public.mark_refund_submitted
  from public, anon, authenticated;
grant execute on function public.create_payment_link_record, public.record_payment, public.record_cash_at_door,
  public.confirm_payment, public.reject_payment, public.add_balance_entry, public.refund_unused_meals,
  public.mark_refund_paid, public.unused_meals_value, public.dues_list, public.money_report, public.set_payout_account,
  public.refund_for_gateway to authenticated;
-- Only the Edge Functions (service role) may feed provider events and attach provider ids.
grant execute on function public.razorpay_process_event, public.attach_payment_link, public.mark_refund_submitted
  to service_role;
