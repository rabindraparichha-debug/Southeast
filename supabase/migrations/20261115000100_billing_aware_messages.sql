-- Held-back vendor-first item (audit Phase 2 step 6 "Reminders do not know how the customer pays",
-- Phase 1 step 7 churn note): customer messages and the at-risk list know how the customer pays (D-115).
--
--   * Daily low-balance reminder: prepaid customers only. (Monthly subscriptions never reach
--     'low_balance', but the reminder no longer trusts the status alone.)
--   * Dues reminders on day 1, 3 and 7: prepaid only (wave 2, unchanged).
--   * Monthly (pay-later) customers get one 'statement_ready' message for the month that ended,
--     queued by the nightly run on the 1st–3rd (IST; the dedupe key makes it once per month), and only
--     while the platform flag customer_whatsapp is on: nothing is stored while Phase 1 runs offline.
--     Sent only when something is still unpaid for that month (payments made since count).
--   * Payment receipts for monthly customers become 'payment_receipt_monthly' (amount paid, amount
--     still to pay) at outbox insert; a monthly payment carries 0 meals, so the meal receipt was wrong.
--     post_recharge is unchanged. Both new templates are money messages, so they go to the payer (P5).
--   * Churn: a monthly customer is never flagged just for owing. 'dues_overdue' = part of the khata
--     older than kitchen_settings.dues_overdue_days (default 40: a month of meals plus 10 days to pay)
--     is still unpaid, where payments and credits settle the oldest charges first.

alter table public.kitchen_settings add column dues_overdue_days integer not null default 40
  check (dues_overdue_days between 7 and 365);
grant update (dues_overdue_days) on public.kitchen_settings to authenticated;

-- What is still unpaid of the charges dated on or before p_cutoff (a meal counts from its service
-- date, every other row from its IST date), after every payment, credit and refund to date.
-- Charges: meals and negative adjustments (opening dues, corrections, billing-mode conversions);
-- everything else (payments, credits, refunds, payment voids) is the pool that settles them, oldest first.
create or replace function private.unpaid_through(p_customer uuid, p_cutoff date)
returns table (unpaid_paise bigint, oldest_unpaid date)
language sql
stable
set search_path = ''
as $$
  with r as (
    select coalesce(o.service_date, (b.created_at at time zone 'Asia/Kolkata')::date) as eff, b.amount_paise as amt,
           b.created_at, b.seq,
           (b.amount_paise < 0 and (b.type = 'meal' or (b.type = 'adjust' and b.ref_type is distinct from 'payment_void'))) as charge
    from public.balance_entries b
    left join public.meal_orders o on b.ref_type = 'meal_order' and o.id = b.ref_id
    where b.customer_id = p_customer
  ),
  t as (
    select greatest(coalesce(sum(r.amt) filter (where not r.charge), 0), 0) as pool,
           coalesce(-sum(r.amt) filter (where r.charge and r.eff <= p_cutoff), 0) as old_charges
    from r
  ),
  c as (
    select r.eff, sum(-r.amt) over (order by r.eff, r.created_at, r.seq) as cum from r where r.charge
  )
  select greatest(t.old_charges - t.pool, 0)::bigint,
         case when t.old_charges > t.pool then (select min(c.eff) from c where c.cum > t.pool) end
  from t;
$$;

-- Money messages that go to the payer of an eater (P5): add a '_payer' template for each.
create or replace function private.payer_templates()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['low_balance_reminder', 'dues_reminder', 'payment_receipt', 'refund_notice', 'refund_receipt',
               'payment_receipt_monthly', 'statement_ready'];
$$;

-- BEFORE INSERT on the outbox; fires before the gate and the payer routing (triggers run in name order).
create or replace function private.outbox_billing_variant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bal bigint;
begin
  if exists (select 1 from public.customers c where c.id = new.recipient_id and c.billing_mode = 'monthly') then
    v_bal := private.rupee_balance(new.recipient_id);
    new.template := 'payment_receipt_monthly';
    new.payload := coalesce(new.payload, '{}'::jsonb)
      || jsonb_build_object('due_paise', greatest(-v_bal, 0), 'advance_paise', greatest(v_bal, 0));
  end if;
  return new;
end;
$$;

create trigger notifications_outbox_billing before insert on public.notifications_outbox
  for each row when (new.recipient_type = 'customer' and new.template = 'payment_receipt')
  execute function private.outbox_billing_variant();

-- Statement-ready messages for the month containing p_month (monthly customers with something unpaid).
create or replace function private.queue_statement_messages(p_month date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first date := date_trunc('month', p_month)::date;
  v_last date := (date_trunc('month', p_month) + interval '1 month')::date - 1;
  v_n integer;
begin
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select c.kitchen_id, 'whatsapp', 'customer', c.id, 'statement_ready',
         jsonb_build_object('month', to_char(v_first, 'YYYY-MM'), 'meals', m.meals, 'charged_paise', m.charged,
                            'amount_due_paise', u.unpaid_paise),
         'statement_ready:' || c.id || ':' || to_char(v_first, 'YYYY-MM')
  from public.customers c
  join public.kitchens k on k.id = c.kitchen_id and k.status <> 'suspended'
  cross join lateral (
    select coalesce(-sum(b.meals), 0)::integer as meals, coalesce(-sum(b.amount_paise), 0)::bigint as charged
    from public.balance_entries b
    join public.meal_orders o on o.id = b.ref_id
    where b.customer_id = c.id and b.type = 'meal' and b.ref_type = 'meal_order'
      and o.service_date between v_first and v_last
  ) m
  cross join lateral private.unpaid_through(c.id, v_last) u
  where c.billing_mode = 'monthly' and c.deleted_at is null and u.unpaid_paise > 0
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
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
  -- Daily low-balance reminder: prepaid customers only (D-115).
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select s.kitchen_id, 'whatsapp', 'customer', s.customer_id, 'low_balance_reminder',
         jsonb_build_object('balance_meals', (select sum(meals) from public.balance_entries where customer_id = s.customer_id)),
         'low_balance_reminder:' || s.customer_id || ':' || v_today
  from public.subscriptions s
  join public.customers c on c.id = s.customer_id and c.billing_mode = 'prepaid'
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

  -- Monthly customers: the bill for the month that ended (1st–3rd, once per month), Phase 2 only.
  if extract(day from v_today) <= 3 and private.feature_enabled('customer_whatsapp') then
    v_n := v_n + private.queue_statement_messages((date_trunc('month', v_today) - interval '1 day')::date);
  end if;
  return v_n;
end;
$$;

-- Churn: 'balance_out' stays prepaid-only; monthly customers are flagged 'dues_overdue' only when
-- part of what they owe is older than the kitchen's dues_overdue_days and still unpaid.
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
             case when od.unpaid_paise > 0 then 'dues_overdue' end,
             case when sk.n >= 3 then 'skips' end,
             case when cp.n > 0 then 'open_complaint' end,
             case when ps.since < v_now - interval '7 days' then 'paused_long' end,
             case when c.platform_sourced and (tr.stuck or ld.stuck) then 'trial_not_converted' end
           ], null) as reasons,
           jsonb_strip_nulls(jsonb_build_object('balance_meals', case when c.billing_mode = 'prepaid' then b.meals end,
             'last_recharge_at', rc.last_at, 'skips_7d', sk.n,
             'open_complaints', cp.n, 'paused_since', ps.since,
             'overdue_paise', nullif(od.unpaid_paise, 0), 'oldest_unpaid', od.oldest_unpaid,
             'overdue_days', case when od.unpaid_paise > 0 then coalesce(ks.dues_overdue_days, 40) end)) as detail
    from public.customers c
    left join public.kitchen_settings ks on ks.kitchen_id = c.kitchen_id
    left join lateral (select coalesce(sum(be.meals), 0)::integer as meals from public.balance_entries be where be.customer_id = c.id) b on true
    left join lateral (select max(be.created_at) as last_at from public.balance_entries be
                       where be.customer_id = c.id and be.type = 'recharge') rc on true
    left join lateral (select u.unpaid_paise, u.oldest_unpaid
                       from private.unpaid_through(c.id, v_today - coalesce(ks.dues_overdue_days, 40)) u
                       where c.billing_mode = 'monthly') od on true
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

revoke execute on function private.unpaid_through(uuid, date), private.outbox_billing_variant(),
  private.queue_statement_messages(date)
  from public, anon, authenticated;
