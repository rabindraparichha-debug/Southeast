-- Vendor-first wave 2, item 21: monthly customer statement, bills for the month, CSV exports and
-- the printable register built on the server.
--
--   customer_statement(customer, month)  every ledger row of the month with a running balance;
--                                        opening + rows = closing, and closing = the ledger total up to
--                                        month end (so it always reconciles). A meal belongs to the month
--                                        of its service date (a 1st-of-month lunch is locked the evening
--                                        before); every other row to its IST date.
--   monthly_bills(kitchen, month)        one line per customer with activity: opening, meals charged,
--                                        paid, credits, refunds, adjustments, closing.
--   export_payments_csv(kitchen, from, to), export_dues_aging_csv(kitchen),
--   export_rider_cash_csv(kitchen, from, to)   CSV text (UTF-8, header row, rupees with 2 decimals).
--   register_sheet(kitchen, start, days) one JSON document (no 1,000-row API cap): who eats when,
--                                        balance in meals and rupees.
-- Who: owner, manager and accountant (accountants see masked phone numbers).

-- ---------------------------------------------------------------------------
-- CSV helpers
-- ---------------------------------------------------------------------------
create or replace function private.csv_text(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Quote every text cell; neutralise spreadsheet formulas (=, +, -, @ at the start).
  select '"' || replace(case when coalesce(p, '') ~ '^[=+\-@]' then '''' || p else coalesce(p, '') end, '"', '""') || '"';
$$;

create or replace function private.csv_rupees(p_paise bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_paise is null then '' else to_char(p_paise / 100.0, 'FM999999990.00') end;
$$;

-- A customer's ledger rows with their statement date: a meal's service date, else the IST date.
create or replace function private.ledger_rows(p_customer uuid)
returns table (id uuid, created_at timestamptz, seq bigint, eff_date date, type public.balance_entry_type, ref_type text,
               ref_id uuid, meals integer, amount_paise integer, note text, service_date date, slot public.meal_slot,
               qty smallint, price integer)
language sql
stable
set search_path = ''
as $$
  select b.id, b.created_at, b.seq, coalesce(o.service_date, (b.created_at at time zone 'Asia/Kolkata')::date),
         b.type, b.ref_type, b.ref_id, b.meals, b.amount_paise, b.note, o.service_date, o.slot, o.qty, o.price_per_meal_paise
  from public.balance_entries b
  left join public.meal_orders o on b.ref_type = 'meal_order' and o.id = b.ref_id
  where b.customer_id = p_customer;
$$;

-- ---------------------------------------------------------------------------
-- Customer statement (model: office_statement)
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
        'paid_paise', coalesce(sum(r.amount_paise) filter (where r.type = 'recharge'), 0),
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

-- Bills for the month: one line per customer with ledger activity or a balance.
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
                   coalesce(sum(b.amount_paise) filter (where b.eff >= v_first and b.type = 'recharge'), 0) as paid,
                   coalesce(sum(b.amount_paise) filter (where b.eff >= v_first and b.type = 'credit'), 0) as credits,
                   coalesce(-sum(b.amount_paise) filter (where b.eff >= v_first and b.type = 'refund'), 0) as refunds,
                   coalesce(sum(b.amount_paise) filter (where b.eff >= v_first and b.type = 'adjust'), 0) as adjusts,
                   coalesce(sum(b.amount_paise) filter (where b.eff >= v_first), 0) as net,
                   coalesce(sum(b.meals) filter (where b.eff >= v_first), 0) as net_meals
            from public.customers c
            join (select be.customer_id, be.type, be.meals, be.amount_paise,
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
-- CSV exports
-- ---------------------------------------------------------------------------
create or replace function public.export_payments_csv(p_kitchen uuid, p_from date, p_to date)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if p_to > p_from + 366 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;
  return 'date,customer,billing_mode,method,status,amount_rupees,meals,collected_by,confirmed_by,note,void_reason,payment_id' || E'\n'
    || coalesce(string_agg(concat_ws(',',
         ((coalesce(p.paid_at, p.created_at)) at time zone 'Asia/Kolkata')::date::text,
         private.csv_text(c.name), c.billing_mode::text, p.method::text, p.status::text,
         private.csv_rupees(p.amount_paise), p.meals::text,
         private.csv_text((select m.display_name from public.members m where m.kitchen_id = p.kitchen_id and m.user_id = p.collected_by)),
         private.csv_text((select m.display_name from public.members m where m.kitchen_id = p.kitchen_id and m.user_id = p.confirmed_by)),
         private.csv_text(p.note), private.csv_text(p.void_reason), p.id::text), E'\n'
         order by coalesce(p.paid_at, p.created_at), p.id) || E'\n', '')
  from public.payments p join public.customers c on c.id = p.customer_id
  where p.kitchen_id = p_kitchen
    and p.status in ('paid', 'pending', 'voided', 'review', 'cancelled')
    and ((coalesce(p.paid_at, p.created_at)) at time zone 'Asia/Kolkata')::date between p_from and p_to;
end;
$$;

create or replace function public.export_dues_aging_csv(p_kitchen uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
  return 'customer,billing_mode,amount_owed_rupees,meals_owed,since,days,bucket,customer_id' || E'\n'
    || coalesce(string_agg(concat_ws(',',
         private.csv_text(c.name), c.billing_mode::text, private.csv_rupees(d.amount_owed_paise), d.meals_owed::text,
         d.since::text, (v_today - d.since)::text,
         case when v_today - d.since <= 30 then '0-30' when v_today - d.since <= 60 then '31-60'
              when v_today - d.since <= 90 then '61-90' else '90+' end,
         c.id::text), E'\n' order by d.amount_owed_paise desc, c.name) || E'\n', '')
  from private.dues(p_kitchen) d join public.customers c on c.id = d.customer_id;
end;
$$;

-- Cash collected at the door by riders (or anyone recording it on a stop), with who confirmed it.
create or replace function public.export_rider_cash_csv(p_kitchen uuid, p_from date, p_to date)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if p_to > p_from + 366 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;
  return 'date,rider,customer,amount_rupees,status,confirmed_by,confirmed_at,note,payment_id' || E'\n'
    || coalesce(string_agg(concat_ws(',',
         (p.created_at at time zone 'Asia/Kolkata')::date::text,
         private.csv_text((select m.display_name from public.members m where m.kitchen_id = p.kitchen_id and m.user_id = p.collected_by)),
         private.csv_text(c.name), private.csv_rupees(p.amount_paise), p.status::text,
         private.csv_text((select m.display_name from public.members m where m.kitchen_id = p.kitchen_id and m.user_id = p.confirmed_by)),
         coalesce(to_char(p.confirmed_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'), ''),
         private.csv_text(p.note), p.id::text), E'\n' order by p.created_at, p.id) || E'\n', '')
  from public.payments p join public.customers c on c.id = p.customer_id
  where p.kitchen_id = p_kitchen and p.collected_by is not null and p.method = 'cash'
    and (p.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to;
end;
$$;

-- ---------------------------------------------------------------------------
-- Printable register (replaces the page's direct table reads, which the API caps at 1,000 rows)
-- ---------------------------------------------------------------------------
create or replace function public.register_sheet(p_kitchen uuid, p_start date, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end date;
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
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
               'area', a.area, 'landmark', a.landmark, 'billing_mode', c.billing_mode,
               'balance_meals', coalesce(bal.meals, 0), 'balance_paise', coalesce(bal.paise, 0),
               'marks', coalesce((select jsonb_object_agg(x.d, x.m) from (
                          select o.service_date::text as d, jsonb_object_agg(o.slot, o.mark) as m
                          from o where o.customer_id = c.id group by o.service_date) x), '{}'::jsonb))
             order by a.area nulls last, c.name, c.id)
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
-- Grants (fail closed)
-- ---------------------------------------------------------------------------
revoke execute on function private.csv_text(text), private.csv_rupees(bigint), private.ledger_rows(uuid)
  from public, anon, authenticated;
revoke execute on function public.customer_statement(uuid, date), public.monthly_bills(uuid, date),
  public.export_payments_csv(uuid, date, date), public.export_dues_aging_csv(uuid), public.export_rider_cash_csv(uuid, date, date),
  public.register_sheet(uuid, date, integer)
  from public, anon;
grant execute on function public.customer_statement(uuid, date), public.monthly_bills(uuid, date),
  public.export_payments_csv(uuid, date, date), public.export_dues_aging_csv(uuid), public.export_rider_cash_csv(uuid, date, date),
  public.register_sheet(uuid, date, integer)
  to authenticated;
