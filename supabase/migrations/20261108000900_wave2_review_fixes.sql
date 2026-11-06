-- Vendor-first wave 2: fixes from the integration review (after merging wave 1, login and screens).
-- Every function redefined here is listed in docs/DECISIONS.md D-156 ("Review fixes").
--
--  1. Owed meals are valued as the newest debt rows at their own price, and any meals owed beyond
--     them at the price per meal (private.recent_meals_value). A meal debt from an opening balance,
--     a correction or a billing-mode switch is no longer worth Rs 0. Switching monthly -> prepaid
--     with dues keeps the rupee debt on the conversion row, so switching back is exact.
--  2. void_payment refuses (billing_mode_changed) for a prepaid customer whose billing mode changed
--     after the payment: the conversion already moved that money into a meal lot, so the owner posts
--     an adjustment instead.
--  3. private.nightly: wave 1's error-isolated version (per step, per kitchen, per subscription),
--     with the D-115 rule that only prepaid customers are cancelled automatically.
--  4. private.dues in one pass (window functions; no correlated scans per owed customer).
--  5. Bills and statements report payments net of voids (a voided payment is not "paid").
--  6. Import: a monthly row with an opening meal balance but no plan is refused (balance_needs_plan);
--     no 0/0 ledger rows.
--  7. invite_member never adds an existing account directly: always a pending invite, claimed only
--     by claim_invites in a session signed in with a code (wave 2). A stranger who pre-registers the
--     number with a password is stopped only by the hosted "Confirm phone" setting (launch blocker,
--     docs/LOGIN.md): GoTrue gives code-only accounts a random password too, so SQL cannot tell them apart.
--  8. The customer_whatsapp gate also applies at send time, to rows queued before the gate, and to
--     the webhook's bot replies (wa_receive tells the webhook); pending rows get an expiry.
--  9. Accountants get no addresses from search_customers or register_sheet.
-- 10. Conversations follow phone changes and erasures (re-linked to the oldest customer still on
--     that phone, else unlinked); wa_receive also repairs a stale link.
-- 11. Managers cannot read inbox replies, broadcasts or inbox alerts in notifications_outbox.
-- 12. Rider requests: only skip, pause, resume, cancel and address; the approver (not the rider) is
--     the actor of the applied change and of any "don't charge" credit.
-- 13. Production sheets and new-platform-customer alerts reach managers too (copied at insert).

-- ---------------------------------------------------------------------------
-- 1. Valuing owed meals; billing-mode conversion
-- ---------------------------------------------------------------------------
-- Value of the newest p_meals owed meals. Debt rows, newest first: meals (their frozen price) and
-- adjustments that removed meals (their own amount, or the price per meal when they carry none).
-- Meals owed beyond every debt row are valued at the price per meal.
create or replace function private.recent_meals_value(p_customer uuid, p_meals integer)
returns bigint
language sql
stable
set search_path = ''
as $$
  select case when coalesce(p_meals, 0) <= 0 then 0::bigint else
    (coalesce(round(sum(case when x.cum <= p_meals then x.amt
                             else x.amt * (p_meals - (x.cum - x.q))::numeric / x.q end)), 0)
     + greatest(0, p_meals - coalesce(sum(x.q), 0)) * coalesce(private.customer_unit_price(p_customer), 0))::bigint end
  from (select d.q, d.amt, sum(d.q) over (order by d.created_at desc, d.seq desc) as cum
        from (select -b.meals as q, b.created_at, b.seq,
                     case when b.type = 'meal' or b.amount_paise < 0 then -b.amount_paise
                          else -b.meals * coalesce(private.customer_unit_price(p_customer), 0) end as amt
              from public.balance_entries b
              where b.customer_id = p_customer and b.meals < 0
                and (b.type = 'meal' or (b.type = 'adjust' and b.ref_type is distinct from 'billing_mode_reset'))) d) x
  where x.cum - x.q < p_meals;
$$;

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
    -- Reset row: zero the meal count and move the rupees onto the converted balance, so the new row
    -- carries the advance (a FIFO lot) or the debt (owed meals keep their rupee value: switching back
    -- to monthly gives exactly the same dues).
    if v_meals <> 0 or (v_target_meals <> 0 and v_paise <> 0) then
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, note, created_by, created_at)
      values (v_c.kitchen_id, p_customer, 'adjust', -v_meals, case when v_target_meals <> 0 then -v_paise else 0 end,
              'billing_mode_reset', 'Changed to prepaid: meal count reset', p_actor, private.now());
    end if;
    if v_target_meals <> 0 then
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, note, created_by, created_at)
      values (v_c.kitchen_id, p_customer, 'adjust', v_target_meals, v_paise,
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

-- ---------------------------------------------------------------------------
-- 2. Void after a billing-mode switch
-- ---------------------------------------------------------------------------
create or replace function public.void_payment(p_payment uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.payments;
  v_e public.balance_entries;
begin
  select * into v_p from public.payments where id = p_payment for update;
  if v_p.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_p.kitchen_id, '{owner}');
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if v_p.status = 'voided' then
    return jsonb_build_object('payment_id', v_p.id, 'status', 'voided', 'already', true);
  end if;
  if v_p.status <> 'paid' or v_p.method not in ('cash', 'upi_manual', 'bank_transfer') then
    raise exception 'not_voidable' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('refund:' || v_p.customer_id, 0));
  -- A prepaid customer whose billing mode changed after this payment: the conversion already turned
  -- its money into a meal lot, so reversing the payment row alone would leave paid-for (and
  -- refundable) meals behind. The owner posts an adjustment instead. (For a monthly customer the
  -- reversal is exact in rupees, whatever happened in between.)
  select * into v_e from public.balance_entries where type = 'recharge' and ref_type = 'payment' and ref_id = p_payment;
  if v_e.id is not null
     and (select billing_mode from public.customers where id = v_p.customer_id) = 'prepaid'
     and exists (
       select 1 from public.balance_entries b
       where b.customer_id = v_p.customer_id and b.ref_type in ('billing_mode', 'billing_mode_reset')
         and (b.created_at, b.seq) > (v_e.created_at, v_e.seq)) then
    raise exception 'billing_mode_changed' using errcode = '22023';
  end if;

  update public.payments
  set status = 'voided', voided_at = private.now(), voided_by = auth.uid(), void_reason = trim(p_reason)
  where id = p_payment;

  select * into v_e from public.balance_entries where type = 'recharge' and ref_type = 'payment' and ref_id = p_payment;
  if v_e.id is not null then
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
    values (v_e.kitchen_id, v_e.customer_id, 'adjust', -v_e.meals, -v_e.amount_paise, 'payment_void', p_payment,
            'Payment voided: ' || trim(p_reason), auth.uid(), private.now())
    on conflict (type, ref_type, ref_id) where ref_id is not null do nothing;
  end if;
  perform private.sync_balance_status(v_p.kitchen_id, v_p.customer_id);
  return jsonb_build_object('payment_id', v_p.id, 'status', 'voided', 'already', false,
    'balance_meals', (select coalesce(sum(meals), 0) from public.balance_entries where customer_id = v_p.customer_id),
    'balance_paise', private.rupee_balance(v_p.customer_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Nightly: wave 1's error isolation + prepaid-only auto-cancel (D-115, D-123)
-- ---------------------------------------------------------------------------
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
  -- Prepaid customers only (D-115): monthly customers are never cancelled automatically.
  update public.engine_errors set resolved_at = private.now() where job = 'nightly_cancel' and resolved_at is null;
  for r in
    select s.id, s.kitchen_id, 'grace_expired' as reason
    from public.subscriptions s join public.kitchen_settings ks on ks.kitchen_id = s.kitchen_id
    join public.customers cu on cu.id = s.customer_id
    where s.status = 'suspended' and s.status_changed_at < private.now() - make_interval(days => ks.grace_days)
      and cu.billing_mode = 'prepaid'
    union all
    -- A trial never paid ends as cancelled once its grace period after the start date is over.
    select s.id, s.kitchen_id, 'trial_unpaid'
    from public.subscriptions s join public.kitchen_settings ks on ks.kitchen_id = s.kitchen_id
    join public.customers cu on cu.id = s.customer_id
    where s.status = 'trial' and s.start_date + ks.grace_days < v_today and cu.billing_mode = 'prepaid'
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

-- ---------------------------------------------------------------------------
-- 4. Dues in one pass
-- ---------------------------------------------------------------------------
-- Customers who owe money, with the date they went into debt (the first row after the last time
-- the balance was zero or positive).
--   monthly: amount = −rupee balance; meals = how many of the newest meals that covers.
--   prepaid: meals = −meal balance; amount = those owed meals valued by private.recent_meals_value.
create or replace function private.dues(p_kitchen uuid)
returns table (customer_id uuid, meals_owed integer, amount_owed_paise integer, since date)
language sql
stable
set search_path = ''
as $$
  with running as (
    select b.customer_id, b.created_at,
           sum(b.meals) over w as bal_meals,
           sum(b.amount_paise) over w as bal_paise
    from public.balance_entries b
    where b.kitchen_id = p_kitchen
    window w as (partition by b.customer_id order by b.created_at, b.seq)
  ),
  per_customer as (
    select b.customer_id, cu.billing_mode, sum(b.meals)::integer as meals, sum(b.amount_paise)::bigint as paise
    from public.balance_entries b join public.customers cu on cu.id = b.customer_id
    where b.kitchen_id = p_kitchen
    group by b.customer_id, cu.billing_mode
  ),
  owed as (
    select p.customer_id, p.billing_mode, p.meals, p.paise
    from per_customer p
    where (p.billing_mode = 'monthly' and p.paise < 0) or (p.billing_mode = 'prepaid' and p.meals < 0)
  ),
  last_ok as (
    select r.customer_id,
           max(r.created_at) filter (where case when o.billing_mode = 'monthly' then r.bal_paise >= 0
                                                else r.bal_meals >= 0 end) as at
    from running r join owed o on o.customer_id = r.customer_id
    group by r.customer_id
  ),
  since as (
    select r.customer_id, min(r.created_at) as at
    from running r join owed o on o.customer_id = r.customer_id
    join last_ok l on l.customer_id = r.customer_id
    where case when o.billing_mode = 'monthly' then r.bal_paise < 0 else r.bal_meals < 0 end
      and r.created_at > coalesce(l.at, '-infinity')
    group by r.customer_id
  )
  select o.customer_id,
         case when o.billing_mode = 'monthly' then private.recent_meals_for_amount(o.customer_id, -o.paise)
              else -o.meals end,
         (case when o.billing_mode = 'monthly' then -o.paise
               else private.recent_meals_value(o.customer_id, -o.meals) end)::integer,
         (s.at at time zone 'Asia/Kolkata')::date
  from owed o left join since s on s.customer_id = o.customer_id;
$$;

-- ---------------------------------------------------------------------------
-- 5. Statements and bills: paid net of voids
-- ---------------------------------------------------------------------------
create or replace function public.customer_statement(p_customer uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_open_meals integer;
  v_open_paise bigint;
  v_close_meals integer;
  v_close_paise bigint;
  v_lines jsonb;
  v_first date;
  v_last date;
begin
  select * into v_c from public.customers where id = p_customer;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner,accountant}');
  if p_month is null then
    raise exception 'date_required' using errcode = '22023';
  end if;
  v_first := date_trunc('month', p_month)::date;
  v_last := (date_trunc('month', p_month) + interval '1 month')::date - 1;

  select coalesce(sum(r.meals), 0)::integer, coalesce(sum(r.amount_paise), 0)::bigint into v_open_meals, v_open_paise
  from private.ledger_rows(p_customer) r where r.eff_date < v_first;
  select coalesce(sum(r.meals), 0)::integer, coalesce(sum(r.amount_paise), 0)::bigint into v_close_meals, v_close_paise
  from private.ledger_rows(p_customer) r where r.eff_date <= v_last;

  select coalesce(jsonb_agg(jsonb_build_object(
           'entry_id', x.id, 'at', x.created_at, 'date', x.eff_date,
           'type', x.type, 'ref_type', x.ref_type, 'meals', x.meals, 'amount_paise', x.amount_paise,
           'service_date', x.service_date, 'slot', x.slot, 'qty', x.qty, 'price_per_meal_paise', x.price,
           'method', x.method, 'note', x.note,
           'balance_meals', v_open_meals + x.run_meals, 'balance_paise', v_open_paise + x.run_paise)
         order by x.eff_date, x.created_at, x.seq), '[]'::jsonb)
  into v_lines
  from (select r.*, p.method,
               sum(r.meals) over (order by r.eff_date, r.created_at, r.seq) as run_meals,
               sum(r.amount_paise) over (order by r.eff_date, r.created_at, r.seq) as run_paise
        from private.ledger_rows(p_customer) r
        left join public.payments p on r.ref_type in ('payment', 'payment_void') and p.id = r.ref_id
        where r.eff_date between v_first and v_last) x;

  return jsonb_build_object(
    'customer', jsonb_build_object('id', v_c.id, 'name', v_c.name, 'billing_mode', v_c.billing_mode,
                                   'phone', public.customer_phone(v_c.id), 'kitchen_id', v_c.kitchen_id),
    'kitchen_name', (select name from public.kitchens where id = v_c.kitchen_id),
    'month', to_char(date_trunc('month', p_month), 'YYYY-MM'),
    'from', v_first, 'to', v_last,
    'opening', jsonb_build_object('meals', v_open_meals, 'paise', v_open_paise),
    'totals', (select jsonb_build_object(
        'meals_charged', coalesce(-sum(r.meals) filter (where r.type = 'meal'), 0),
        'charged_paise', coalesce(-sum(r.amount_paise) filter (where r.type = 'meal'), 0),
        -- Paid net of voids: a voided payment was never paid (its reversal is not an adjustment).
        'paid_paise', coalesce(sum(r.amount_paise) filter (where r.type = 'recharge'
                                                          or (r.type = 'adjust' and r.ref_type = 'payment_void')), 0),
        'credit_meals', coalesce(sum(r.meals) filter (where r.type = 'credit'), 0),
        'credit_paise', coalesce(sum(r.amount_paise) filter (where r.type = 'credit'), 0),
        'refund_paise', coalesce(-sum(r.amount_paise) filter (where r.type = 'refund'), 0),
        'voided_paise', coalesce(-sum(r.amount_paise) filter (where r.type = 'adjust' and r.ref_type = 'payment_void'), 0),
        'adjust_paise', coalesce(sum(r.amount_paise) filter (where r.type = 'adjust' and r.ref_type is distinct from 'payment_void'), 0),
        'net_meals', coalesce(sum(r.meals), 0),
        'net_paise', coalesce(sum(r.amount_paise), 0))
      from private.ledger_rows(p_customer) r where r.eff_date between v_first and v_last),
    'closing', jsonb_build_object('meals', v_close_meals, 'paise', v_close_paise),
    'amount_due_paise', case when v_c.billing_mode = 'monthly' then greatest(-v_close_paise, 0)
                             else private.recent_meals_value(v_c.id, greatest(-v_close_meals, 0)) end,
    'lines', v_lines);
end;
$$;

create or replace function public.monthly_bills(p_kitchen uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_first date := date_trunc('month', p_month)::date;
  v_last date := (date_trunc('month', p_month) + interval '1 month')::date - 1;
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
  if p_month is null then
    raise exception 'date_required' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'month', to_char(date_trunc('month', p_month), 'YYYY-MM'),
    'bills', coalesce((select jsonb_agg(jsonb_build_object(
        'customer_id', x.id, 'name', x.name, 'billing_mode', x.billing_mode,
        'opening_paise', x.open_paise, 'meals', x.meals, 'charged_paise', x.charged, 'paid_paise', x.paid,
        'credit_paise', x.credits, 'refund_paise', x.refunds, 'adjust_paise', x.adjusts,
        'closing_paise', x.open_paise + x.net, 'closing_meals', x.open_meals + x.net_meals,
        'amount_due_paise', case when x.billing_mode = 'monthly' then greatest(-(x.open_paise + x.net), 0) end)
        order by x.name)
      from (select c.id, c.name, c.billing_mode,
                   coalesce(sum(b.amount_paise) filter (where b.eff < v_first), 0) as open_paise,
                   coalesce(sum(b.meals) filter (where b.eff < v_first), 0) as open_meals,
                   coalesce(-sum(b.meals) filter (where b.eff >= v_first and b.type = 'meal'), 0) as meals,
                   coalesce(-sum(b.amount_paise) filter (where b.eff >= v_first and b.type = 'meal'), 0) as charged,
                   -- Paid net of voids; the void reversal is not an adjustment.
                   coalesce(sum(b.amount_paise) filter (where b.eff >= v_first and (b.type = 'recharge'
                            or (b.type = 'adjust' and b.ref_type = 'payment_void'))), 0) as paid,
                   coalesce(sum(b.amount_paise) filter (where b.eff >= v_first and b.type = 'credit'), 0) as credits,
                   coalesce(-sum(b.amount_paise) filter (where b.eff >= v_first and b.type = 'refund'), 0) as refunds,
                   coalesce(sum(b.amount_paise) filter (where b.eff >= v_first and b.type = 'adjust'
                                                         and b.ref_type is distinct from 'payment_void'), 0) as adjusts,
                   coalesce(sum(b.amount_paise) filter (where b.eff >= v_first), 0) as net,
                   coalesce(sum(b.meals) filter (where b.eff >= v_first), 0) as net_meals
            from public.customers c
            join (select be.customer_id, be.type, be.ref_type, be.meals, be.amount_paise,
                         coalesce(o.service_date, (be.created_at at time zone 'Asia/Kolkata')::date) as eff
                  from public.balance_entries be
                  left join public.meal_orders o on be.ref_type = 'meal_order' and o.id = be.ref_id
                  where be.kitchen_id = p_kitchen) b on b.customer_id = c.id and b.eff <= v_last
            where c.kitchen_id = p_kitchen
            group by c.id, c.name, c.billing_mode) x
      where x.meals <> 0 or x.paid <> 0 or x.credits <> 0 or x.refunds <> 0 or x.adjusts <> 0 or x.open_paise <> 0
         or x.open_meals <> 0), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Import: opening meals on a monthly row need a plan
-- ---------------------------------------------------------------------------
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
  v_seen_names text[] := '{}';
  v_billing public.billing_mode;
  v_mode public.billing_mode;
  v_default public.billing_mode;
  v_dues bigint;
  v_price integer;
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

  select default_billing_mode into v_default from public.kitchen_settings where kitchen_id = p_kitchen;

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
    v_billing := null;
    v_dues := null;
    v_phone := private.normalize_phone(v_row ->> 'phone');
    v_raw := (v_row - 'phone') || jsonb_build_object('phone_last4', right(v_phone, 4));

    if nullif(trim(v_row ->> 'name'), '') is null then
      v_errors := array_append(v_errors, 'name_required');
    end if;

    if v_phone is null then
      v_errors := array_append(v_errors, 'invalid_phone');
    else
      v_hash := private.phone_hash(v_phone);
      -- D-118: a shared phone is fine for a different name; the same phone and name is a duplicate.
      if exists (select 1 from unnest(v_seen, v_seen_names) as s(h, n)
                 where s.h = v_hash and private.same_name(s.n, v_row ->> 'name')) then
        v_errors := array_append(v_errors, 'duplicate_in_file');
      elsif exists (select 1 from public.customers
                    where kitchen_id = p_kitchen and phone_hash = v_hash and deleted_at is null
                      and private.same_name(name, v_row ->> 'name')) then
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

    -- Billing mode: monthly (pay later) or prepaid; blank = the kitchen default.
    if nullif(trim(v_row ->> 'billing'), '') is not null then
      v_billing := case
        when lower(trim(v_row ->> 'billing')) in ('monthly', 'month', 'month end', 'pay later', 'paylater', 'postpaid', 'khata', 'credit')
          then 'monthly'::public.billing_mode
        when lower(trim(v_row ->> 'billing')) in ('prepaid', 'advance', 'pre-paid') then 'prepaid'::public.billing_mode
      end;
      if v_billing is null then
        v_errors := array_append(v_errors, 'invalid_billing');
      end if;
    end if;
    v_mode := coalesce(v_billing, v_default, 'monthly');
    -- Opening dues in rupees (monthly customers): + owed, − advance paid.
    if nullif(trim(v_row ->> 'dues'), '') is not null then
      if (v_row ->> 'dues') ~ '^-?\d{1,6}(\.\d{1,2})?$' and abs((v_row ->> 'dues')::numeric) <= 100000 then
        v_dues := round((v_row ->> 'dues')::numeric * 100)::bigint;
        if v_mode <> 'monthly' and v_dues <> 0 then
          v_errors := array_append(v_errors, 'dues_need_monthly');
        end if;
      else
        v_errors := array_append(v_errors, 'invalid_dues');
      end if;
    end if;

    -- A monthly customer's opening meals become rupees at the plan price: without a plan there is
    -- no price, and the meals would silently disappear.
    if v_mode = 'monthly' and v_balance <> 0 and v_plan is null
       and not ('unknown_plan' = any (v_errors)) then
      v_errors := array_append(v_errors, 'balance_needs_plan');
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
          , 'import', 'import', v_mode);

        if v_plan is not null then
          select id into v_address from public.addresses where customer_id = v_customer and is_default;
          insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, qty, start_date, status)
          values (p_kitchen, v_customer, v_plan, v_address, v_qty, coalesce(v_start, private.ist_today()), 'active');
        end if;
        v_price := coalesce((select price_per_meal_paise from public.plans where id = v_plan), 0);
        if v_mode = 'monthly' then
          -- Rupee opening balance: dues (owed) and/or meals already paid for at the plan price.
          if v_balance * v_price - coalesce(v_dues, 0) <> 0 then
            insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note, created_by, created_at)
            values (p_kitchen, v_customer, 'adjust', 0, v_balance * v_price - coalesce(v_dues, 0),
                    'Opening balance (import)', auth.uid(), private.now());
          end if;
        elsif v_balance <> 0 then
          insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note, created_by, created_at)
          values (p_kitchen, v_customer, 'adjust', v_balance,
                  case when v_balance > 0 then v_balance * v_price else 0 end,
                  'Opening balance (import)', auth.uid(), private.now());
        end if;
        v_seen := v_seen || v_hash;
        v_seen_names := v_seen_names || (v_row ->> 'name');
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

-- ---------------------------------------------------------------------------
-- 7. Invites: membership only through a code sign-in
-- ---------------------------------------------------------------------------
create or replace function public.invite_member(
  p_kitchen uuid,
  p_phone text,
  p_role public.member_role,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner}', true);
  if p_role = 'owner' then
    raise exception 'cannot_invite_owner' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  -- Never add an existing account directly: anyone can create an account for a phone number they
  -- do not own (phone + password sign-up). Membership comes only from claim_invites, in a session
  -- signed in with a one-time code sent to that number.
  if exists (select 1 from public.members m join auth.users u on u.id = m.user_id
             where m.kitchen_id = p_kitchen and u.phone = substr(v_phone, 2)) then
    raise exception 'already_member' using errcode = '23505';
  end if;

  insert into public.member_invites (kitchen_id, phone_e164, role, display_name, invited_by)
  values (p_kitchen, v_phone, p_role, p_display_name, auth.uid())
  on conflict (kitchen_id, phone_e164) where accepted_at is null and revoked_at is null
  do update set role = excluded.role, display_name = excluded.display_name
  returning id into v_id;
  return jsonb_build_object('status', 'invited', 'invite_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Customer-message gate at send time; queued rows; webhook replies
-- ---------------------------------------------------------------------------
update public.notifications_outbox set expires_at = greatest(send_after, created_at) + interval '48 hours'
where status = 'pending' and expires_at is null;
update public.notifications_outbox set status = 'cancelled', last_error = 'customer_messages_off'
where status = 'pending' and recipient_type in ('customer', 'lead', 'vendor_application')
  and not private.feature_enabled('customer_whatsapp');

create or replace function public.wa_claim_outbox(p_limit integer default 25)
returns table (
  id uuid, kitchen_id uuid, template text, payload jsonb, recipient_type text, recipient_id uuid,
  phone_e164 text, language public.language_code, kitchen_name text, conversation_id uuid,
  in_window boolean, opted_in boolean, attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- Expired rows are never sent.
  update public.notifications_outbox o set status = 'cancelled', last_error = 'expired'
  where o.channel = 'whatsapp' and o.status = 'pending' and o.expires_at <= private.now();
  -- Customer messages switched off (Phase 1, or an admin's kill switch): rows queued before are
  -- not sent either.
  if not private.feature_enabled('customer_whatsapp') then
    update public.notifications_outbox o set status = 'cancelled', last_error = 'customer_messages_off'
    where o.channel = 'whatsapp' and o.status = 'pending' and o.recipient_type in ('customer', 'lead', 'vendor_application');
  end if;

  return query
  with due as (
    select o.id from public.notifications_outbox o
    where o.channel = 'whatsapp' and o.status = 'pending' and o.send_after <= private.now()
      and (o.expires_at is null or o.expires_at > private.now())
    order by o.send_after
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update skip locked
  ),
  claimed as (
    update public.notifications_outbox o set status = 'sending', attempts = o.attempts + 1
    from due where o.id = due.id
    returning o.*
  )
  select c.id, c.kitchen_id, c.template, c.payload, c.recipient_type, c.recipient_id,
         case c.recipient_type
           when 'customer' then private.decrypt_phone(cu.phone_enc)
           when 'lead' then private.decrypt_phone(l.phone_enc)
           when 'vendor_application' then private.decrypt_phone(va.phone_enc)
           else '+' || u.phone end,
         coalesce(cu.preferred_language, l.language, 'en'::public.language_code),
         k.name, coalesce(conv.id, pconv.id),
         coalesce(conv.last_inbound_at > private.now() - interval '24 hours',
                  pconv.last_inbound_at > private.now() - interval '24 hours', false),
         case c.recipient_type
           when 'customer' then coalesce(cu.whatsapp_opt_in, false)
           when 'lead' then coalesce(l.whatsapp_opt_in, false)
           when 'vendor_application' then coalesce(va.whatsapp_opt_in, false)
           else true end,
         c.attempts
  from claimed c
  left join public.kitchens k on k.id = c.kitchen_id
  left join public.customers cu on c.recipient_type = 'customer' and cu.id = c.recipient_id
  left join public.leads l on c.recipient_type = 'lead' and l.id = c.recipient_id
  left join public.vendor_applications va on c.recipient_type = 'vendor_application' and va.id = c.recipient_id
  left join auth.users u on c.recipient_type = 'member' and u.id = c.recipient_id
  -- D-118: the conversation is per (kitchen, phone), so customers sharing a phone share its window.
  left join public.conversations conv on c.recipient_type = 'customer' and conv.kitchen_id = c.kitchen_id
    and conv.wa_phone_hash = cu.phone_hash
  -- Leads and applicants chat with the platform number (conversation without a kitchen).
  left join public.conversations pconv on c.recipient_type in ('lead', 'vendor_application') and pconv.kitchen_id is null
    and pconv.wa_phone_hash = coalesce(l.phone_hash, va.phone_hash);
end;
$$;

create or replace function public.wa_receive(
  p_message_id text,
  p_from text,
  p_body text,
  p_payload jsonb,
  p_contact_name text default null,
  p_kitchen_hint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_from);
  v_hash text;
  v_matches jsonb;
  v_count integer;
  v_kitchen uuid;
  v_customer uuid;
  v_conv uuid;
  v_status text;
  v_lang public.language_code;
begin
  insert into public.webhook_events (provider, event_id, event_type, payload)
  values ('meta', p_message_id, 'message', jsonb_build_object('from_last4', right(coalesce(v_phone, p_from), 4), 'payload', p_payload))
  on conflict (provider, event_id) do nothing;
  if not found then
    return jsonb_build_object('duplicate', true);
  end if;
  if v_phone is null then
    return jsonb_build_object('duplicate', false, 'status', 'ignored');
  end if;
  v_hash := private.phone_hash(v_phone);

  -- One entry per kitchen. D-118: when several customers of a kitchen share the phone, the
  -- conversation links to the oldest of them (deterministic).
  select coalesce(jsonb_agg(jsonb_build_object('kitchen_id', x.kitchen_id, 'kitchen_name', x.kitchen_name, 'slug', x.slug,
                                               'customer_id', x.customer_id) order by x.kitchen_name), '[]'::jsonb), count(*)
  into v_matches, v_count
  from (select distinct on (k.id) k.id as kitchen_id, k.name as kitchen_name, k.slug, c.id as customer_id
        from public.customers c join public.kitchens k on k.id = c.kitchen_id
        where c.phone_hash = v_hash and c.deleted_at is null and k.status <> 'suspended'
        order by k.id, c.created_at, c.id) x;

  if v_count = 1 then
    v_kitchen := (v_matches -> 0 ->> 'kitchen_id')::uuid;
  elsif v_count > 1 then
    -- A kitchen code from an invite link ("Hi maa-tarini-tiffin") or the conversation used in the last 12 hours.
    select (m ->> 'kitchen_id')::uuid into v_kitchen from jsonb_array_elements(v_matches) m
    where p_kitchen_hint is not null and m ->> 'slug' = lower(p_kitchen_hint);
    if v_kitchen is null then
      select c.kitchen_id into v_kitchen from public.conversations c
      where c.wa_phone_hash = v_hash and c.kitchen_id is not null and c.last_inbound_at > private.now() - interval '12 hours'
      order by c.last_inbound_at desc limit 1;
    end if;
  end if;

  if v_kitchen is not null then
    select (m ->> 'customer_id')::uuid into v_customer from jsonb_array_elements(v_matches) m where (m ->> 'kitchen_id')::uuid = v_kitchen;
    select preferred_language into v_lang from public.customers where id = v_customer;
    insert into public.conversations (kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4, contact_name, language)
    values (v_kitchen, v_customer, v_hash, private.encrypt_phone(v_phone), right(v_phone, 4), p_contact_name, v_lang)
    on conflict (kitchen_id, wa_phone_hash) where kitchen_id is not null
    do update set contact_name = coalesce(excluded.contact_name, public.conversations.contact_name),
      -- Repair a stale link (the linked customer changed number or was erased): never talk about them.
      customer_id = case when exists (select 1 from public.customers lc
                                      where lc.id = public.conversations.customer_id and lc.deleted_at is null
                                        and lc.phone_hash = public.conversations.wa_phone_hash)
                         then public.conversations.customer_id else excluded.customer_id end
    returning id into v_conv;
    v_status := 'matched';
  else
    insert into public.conversations (kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4, contact_name)
    values (null, null, v_hash, private.encrypt_phone(v_phone), right(v_phone, 4), p_contact_name)
    on conflict (wa_phone_hash) where kitchen_id is null
    do update set contact_name = coalesce(excluded.contact_name, public.conversations.contact_name)
    returning id into v_conv;
    v_status := case when v_count > 1 then 'choose_kitchen' else 'unknown' end;
  end if;

  update public.conversations
  set last_inbound_at = private.now(), last_message_at = private.now(), unread_count = unread_count + 1
  where id = v_conv;
  insert into public.messages (conversation_id, kitchen_id, direction, body, payload, wa_message_id, handled_by, status, created_at)
  values (v_conv, v_kitchen, 'in', p_body, coalesce(p_payload, '{}'), p_message_id, 'customer', 'received', private.now());

  -- customer_messages: false while the customer_whatsapp flag is off; the webhook then stores the
  -- message for the owner's inbox and sends no bot reply.
  return jsonb_build_object('duplicate', false, 'status', v_status, 'conversation_id', v_conv,
    'kitchens', case when v_status = 'choose_kitchen' then v_matches else '[]'::jsonb end,
    'customer_messages', private.feature_enabled('customer_whatsapp'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. No addresses for accountants
-- ---------------------------------------------------------------------------
create or replace function public.search_customers(p_kitchen uuid, p_q text, p_limit integer default 50)
returns setof public.customers_v
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := trim(coalesce(p_q, ''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
  v_phone text;
  v_addr boolean;
  r public.customers_v;
begin
  perform private.require_role(p_kitchen, '{owner,staff,accountant}');
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  -- Accountants see no addresses (D-156). This function runs as its owner, so the addresses RLS
  -- does not hide them here: null them, and never search by them.
  v_addr := private.has_role(p_kitchen, '{owner,staff}');
  if not v_addr then
    for r in
      select * from public.customers_v v
      where v.kitchen_id = p_kitchen
        and (v_q = ''
             or (v_q ~ '^[0-9]{4}$' and v.phone_last4 = v_q)
             or (v_q !~ '^[0-9]{4}$' and v.name ilike '%' || v_q || '%'))
      order by v.name limit p_limit
    loop
      r.address_id := null; r.line1 := null; r.area := null; r.landmark := null;
      r.delivery_notes := null; r.lat := null; r.lng := null;
      return next r;
    end loop;
    return;
  end if;

  if v_q = '' then
    return query select * from public.customers_v v where v.kitchen_id = p_kitchen
      order by v.name limit p_limit;
  elsif length(v_digits) >= 10 and v_digits = regexp_replace(v_q, '[\s+\-]', '', 'g') then
    v_phone := private.normalize_phone(v_q);
    if v_phone is null or not private.has_role(p_kitchen, '{owner}') then
      return;
    end if;
    -- D-118: several customers may share a phone; return all of them.
    return query select v.* from public.customers_v v
      join public.customers c on c.id = v.id
      where c.kitchen_id = p_kitchen and c.phone_hash = private.phone_hash(v_phone)
      order by v.name, v.id;
  elsif v_q ~ '^[0-9]{4}$' then
    return query select * from public.customers_v v
      where v.kitchen_id = p_kitchen and v.phone_last4 = v_q order by v.name limit p_limit;
  else
    return query select * from public.customers_v v
      where v.kitchen_id = p_kitchen
        and (v.name ilike '%' || v_q || '%' or v.area ilike '%' || v_q || '%' or v.landmark ilike '%' || v_q || '%')
      order by v.name limit p_limit;
  end if;
end;
$$;

create or replace function public.register_sheet(p_kitchen uuid, p_start date, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end date;
  v_addr boolean;
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
  v_addr := private.has_role(p_kitchen, '{owner}');  -- accountants see no addresses (D-156)
  if p_start is null then
    raise exception 'date_required' using errcode = '22023';
  end if;
  if coalesce(p_days, 0) not between 1 and 31 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;
  v_end := p_start + p_days - 1;
  return jsonb_build_object(
    'kitchen_id', p_kitchen, 'start', p_start, 'end', v_end,
    'days', (select jsonb_agg(d::date order by d) from generate_series(p_start, v_end, interval '1 day') d),
    'rows', coalesce((
      with o as (
        select mo.customer_id, mo.service_date, mo.slot,
               case when mo.status = 'skipped' then case when mo.charged then 'L' when mo.skip_reason = 'pause' then 'P' else 'S' end
                    when mo.qty > 1 then '✓' || mo.qty else '✓' end as mark
        from public.meal_orders mo
        where mo.kitchen_id = p_kitchen and mo.service_date between p_start and v_end
      ),
      bal as (
        select b.customer_id, sum(b.meals)::integer as meals, sum(b.amount_paise)::bigint as paise
        from public.balance_entries b where b.kitchen_id = p_kitchen group by b.customer_id
      )
      select jsonb_agg(jsonb_build_object(
               'customer_id', c.id, 'name', c.name, 'phone', public.customer_phone(c.id),
               'area', case when v_addr then a.area end, 'landmark', case when v_addr then a.landmark end,
               'billing_mode', c.billing_mode,
               'balance_meals', coalesce(bal.meals, 0), 'balance_paise', coalesce(bal.paise, 0),
               'marks', coalesce((select jsonb_object_agg(x.d, x.m) from (
                          select o.service_date::text as d, jsonb_object_agg(o.slot, o.mark) as m
                          from o where o.customer_id = c.id group by o.service_date) x), '{}'::jsonb))
             order by case when v_addr then a.area end nulls last, c.name, c.id)
      from public.customers c
      left join public.addresses a on a.customer_id = c.id and a.is_default
      left join bal on bal.customer_id = c.id
      where c.kitchen_id = p_kitchen and c.deleted_at is null
        and (exists (select 1 from o where o.customer_id = c.id)
             or coalesce(bal.meals, 0) <> 0
             or (c.billing_mode = 'monthly' and coalesce(bal.paise, 0) <> 0))), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Conversations follow phone changes and erasures
-- ---------------------------------------------------------------------------
-- A conversation is per (kitchen, phone). When its customer changes number or is erased, it moves
-- to the oldest customer still on that phone in the kitchen (D-118), or is unlinked: a sibling who
-- later messages from the number must never see (or change) the old customer's meals and balance.
create or replace function private.relink_conversations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.phone_hash is not distinct from old.phone_hash and new.deleted_at is not distinct from old.deleted_at then
    return null;
  end if;
  update public.conversations cv
  set customer_id = (select c.id from public.customers c
                     where c.kitchen_id = cv.kitchen_id and c.phone_hash = cv.wa_phone_hash and c.deleted_at is null
                     order by c.created_at, c.id limit 1)
  where cv.customer_id = new.id
    and (new.deleted_at is not null or new.phone_hash is distinct from cv.wa_phone_hash);
  -- The new number may already have a conversation in this kitchen without a customer.
  if new.deleted_at is null and new.phone_hash is not null then
    update public.conversations cv
    set customer_id = (select c.id from public.customers c
                       where c.kitchen_id = cv.kitchen_id and c.phone_hash = cv.wa_phone_hash and c.deleted_at is null
                       order by c.created_at, c.id limit 1)
    where cv.kitchen_id = new.kitchen_id and cv.wa_phone_hash = new.phone_hash and cv.customer_id is null;
  end if;
  return null;
end;
$$;

create trigger customers_relink_conversations after update of phone_hash, deleted_at on public.customers
  for each row execute function private.relink_conversations();

-- ---------------------------------------------------------------------------
-- 11. Outbox rows: managers do not read inbox replies, broadcasts or inbox alerts (D-060)
-- ---------------------------------------------------------------------------
drop policy notifications_outbox_select on public.notifications_outbox;
create policy notifications_outbox_select on public.notifications_outbox for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[])
         or (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[])
             and template not in ('vendor_message', 'broadcast', 'inbox_alert'))
         or (select private.is_platform_admin()));

-- ---------------------------------------------------------------------------
-- 12. Rider requests: allowed types; the approver is the actor
-- ---------------------------------------------------------------------------
create or replace function public.rider_request_change(
  p_stop uuid,
  p_type public.change_type,
  p_from date,
  p_to date default null,
  p_slot public.meal_slot default null,
  p_note text default null,
  p_client_op uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.delivery_stops;
  v_today date := private.ist_today();
  v_sub uuid;
  v_subs uuid[];
  v_to date := p_to;
  v_existing public.change_requests;
  v_id uuid;
begin
  select * into v_s from public.delivery_stops where id = p_stop;
  if v_s.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- The stop's run must be the caller's (today or yesterday), or the caller an owner/manager.
  perform private.require_run_access(v_s.run_id);
  if p_client_op is not null then
    select * into v_existing from public.change_requests where client_op = p_client_op;
    if v_existing.id is not null then
      if v_existing.stop_id is distinct from p_stop or v_existing.requested_by <> auth.uid() then
        raise exception 'invalid_client_op' using errcode = '22023';
      end if;
      return jsonb_build_object('request_id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
    end if;
  end if;
  -- What a rider may write down at the door. ('revoke' is the vendor's Undo; it can never be approved.)
  if p_type is null or p_type not in ('skip', 'pause', 'resume', 'cancel', 'address') then
    raise exception 'invalid_type' using errcode = '22023';
  end if;
  if p_from is null then
    raise exception 'date_required' using errcode = '22023';
  end if;
  if p_from < v_today then
    raise exception 'date_in_past' using errcode = '22023';
  end if;
  if p_type = 'skip' then
    v_to := coalesce(p_to, p_from);
  elsif p_type = 'cancel' then
    v_to := null;
  end if;
  if v_to is not null and v_to < p_from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_to is not null and v_to > p_from + 90 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;
  if p_type = 'address' and nullif(trim(p_note), '') is null then
    raise exception 'note_required' using errcode = '22023';  -- the new address, in words
  end if;

  -- Which subscription: the customer's only live one, else the one on this stop, else the approver picks.
  select array_agg(s.id order by s.created_at) into v_subs
  from public.subscriptions s where s.customer_id = v_s.customer_id and s.status <> 'cancelled';
  if cardinality(v_subs) = 1 then
    v_sub := v_subs[1];
  else
    select array_agg(distinct o.subscription_id) into v_subs from public.meal_orders o where o.stop_id = p_stop;
    if cardinality(v_subs) = 1 then
      v_sub := v_subs[1];
    end if;
  end if;

  insert into public.change_requests (kitchen_id, customer_id, subscription_id, stop_id, type, from_date, to_date, slot, note,
                                      channel, requested_by, requested_at, client_op)
  values (v_s.kitchen_id, v_s.customer_id, v_sub, p_stop, p_type, p_from, v_to,
          case when p_type <> 'cancel' then p_slot end, nullif(trim(p_note), ''), 'rider', auth.uid(), private.now(), p_client_op)
  on conflict (client_op) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.change_requests where client_op = p_client_op;
    return jsonb_build_object('request_id', v_id, 'status', 'pending', 'duplicate', true);
  end if;
  return jsonb_build_object('request_id', v_id, 'status', 'pending', 'duplicate', false);
end;
$$;

create or replace function public.approve_change_request(
  p_request uuid,
  p_waive_late boolean default false,
  p_dry_run boolean default false,
  p_subscription uuid default null,
  p_address uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.change_requests;
  v_sub uuid;
  v_result jsonb;
begin
  select * into v_r from public.change_requests where id = p_request for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner}');
  if v_r.status = 'approved' then
    return v_r.result || jsonb_build_object('request_id', v_r.id, 'already', true);
  end if;
  if v_r.status <> 'pending' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  v_sub := coalesce(p_subscription, v_r.subscription_id);
  if v_sub is null then
    raise exception 'subscription_required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.subscriptions where id = v_sub and customer_id = v_r.customer_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_r.type = 'address' and p_address is null then
    raise exception 'invalid_address' using errcode = '22023';
  end if;

  v_result := private.apply_change(v_sub, v_r.type, v_r.from_date, v_r.to_date, v_r.slot,
                                   case when v_r.type = 'address' then p_address end, 'rider',
                                   coalesce(p_waive_late, false),
                                   concat_ws(' · ', 'Rider request', v_r.note), coalesce(p_dry_run, false), auth.uid());
  if coalesce(p_dry_run, false) then
    return v_result || jsonb_build_object('request_id', v_r.id);
  end if;
  update public.change_requests
  set status = 'approved', decided_by = auth.uid(), decided_at = private.now(), subscription_id = v_sub,
      change_id = (v_result ->> 'change_id')::uuid, result = v_result
  where id = p_request;
  return v_result || jsonb_build_object('request_id', v_r.id, 'already', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Owner alerts also reach managers (D-117)
-- ---------------------------------------------------------------------------
-- private.lock_slot (production sheet) and private.convert_lead (new platform customer) queue these
-- for owners. A copy goes to every manager of the kitchen. On the lock path: set-based, and never
-- raises (a failed copy must not undo the lock).
create or replace function private.copy_owner_alert_to_managers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.recipient_type <> 'member' or new.template not in ('production_sheet', 'new_platform_customer')
     or not exists (select 1 from public.members m where m.kitchen_id = new.kitchen_id and m.user_id = new.recipient_id
                    and m.role = 'owner') then
    return null;
  end if;
  begin
    insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload,
                                             dedupe_key, send_after)
    select new.kitchen_id, new.channel, 'member', m.user_id, new.template, new.payload,
           case when new.dedupe_key is not null then new.dedupe_key || ':manager:' || m.user_id end, new.send_after
    from public.members m
    where m.kitchen_id = new.kitchen_id and m.role = 'manager'
    on conflict (dedupe_key) do nothing;
  exception when others then
    raise warning 'manager alert copy failed: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

create trigger notifications_outbox_copy_to_managers after insert on public.notifications_outbox
  for each row execute function private.copy_owner_alert_to_managers();

-- ---------------------------------------------------------------------------
-- Grants (fail closed). Replaced functions keep their grants; new ones get nothing.
-- ---------------------------------------------------------------------------
revoke execute on function private.relink_conversations(), private.copy_owner_alert_to_managers()
  from public, anon, authenticated;
