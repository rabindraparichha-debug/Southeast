-- Vendor-first wave 2, item 22: void, backdate and idempotency for payments, purchases and waste.
--
--   * record_payment(..., p_client_op, p_paid_at): a retried call with the same key returns the
--     first payment (a double tap on a slow network records one payment). p_paid_at backdates a
--     payment (not in the future, at most 400 days back); the ledger row carries that date.
--     Monthly customers: rupees only (meals 0); prepaid: meals = amount ÷ price per meal as before.
--   * void_payment(payment, reason): marks a recorded cash/UPI/bank payment 'voided' (with who,
--     when and why; the payments audit row carries the reason) and appends one reversal row to the
--     ledger (type 'adjust', ref_type 'payment_void'). Nothing is updated or deleted in the ledger.
--     FIFO refund valuation skips the voided lot and its reversal.
--   * record_purchase(..., p_client_op) and record_waste(..., p_client_op): same key, one write.

alter table public.payments
  add column client_op uuid,
  add column voided_at timestamptz,
  add column voided_by uuid references auth.users (id),
  add column void_reason text,
  add constraint payments_void_reason check (status <> 'voided' or (void_reason is not null and voided_at is not null));
create unique index payments_client_op_idx on public.payments (kitchen_id, client_op) where client_op is not null;

alter table public.purchases add column client_op uuid;
create unique index purchases_client_op_idx on public.purchases (kitchen_id, client_op) where client_op is not null;

-- ---------------------------------------------------------------------------
-- FIFO lots ignore voided payments (their recharge lot and its reversal cancel out exactly).
-- ---------------------------------------------------------------------------
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
  from public.balance_entries b
  where b.customer_id = p_customer and b.meals < 0 and b.ref_type is distinct from 'payment_void';

  for r in
    select b.id, b.created_at, b.seq, b.meals, b.amount_paise
    from public.balance_entries b
    where b.customer_id = p_customer and b.meals > 0
      and not (b.type = 'recharge' and b.ref_type = 'payment'
               and exists (select 1 from public.balance_entries v
                           where v.type = 'adjust' and v.ref_type = 'payment_void' and v.ref_id = b.ref_id))
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

-- ---------------------------------------------------------------------------
-- Record a cash / UPI-to-vendor / bank payment (owner or manager).
-- ---------------------------------------------------------------------------
drop function public.record_payment(uuid, integer, public.payment_method, integer, text, text);
create function public.record_payment(
  p_customer uuid,
  p_amount_paise integer,
  p_method public.payment_method,
  p_meals integer default null,
  p_receipt_photo_path text default null,
  p_note text default null,
  p_client_op uuid default null,
  p_paid_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_now timestamptz := private.now();
  v_paid_at timestamptz;
  v_price integer;
  v_meals integer;
  v_id uuid;
  v_existing public.payments;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  -- Idempotent retry: the same key returns the first payment (only for the same customer).
  if p_client_op is not null then
    select * into v_existing from public.payments where kitchen_id = v_c.kitchen_id and client_op = p_client_op;
    if v_existing.id is not null then
      if v_existing.customer_id <> p_customer then
        raise exception 'invalid_client_op' using errcode = '22023';
      end if;
      return v_existing.id;
    end if;
  end if;
  if p_method not in ('cash', 'upi_manual', 'bank_transfer') then
    raise exception 'invalid_method' using errcode = '22023';
  end if;
  if coalesce(p_amount_paise, 0) <= 0 or p_amount_paise > 10000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  v_paid_at := coalesce(p_paid_at, v_now);
  if v_paid_at > v_now + interval '10 minutes' or v_paid_at < v_now - interval '400 days' then
    raise exception 'invalid_paid_at' using errcode = '22023';
  end if;
  if v_c.billing_mode = 'monthly' then
    v_meals := 0;  -- pay-later: rupees only
  else
    v_price := private.customer_unit_price(p_customer);
    v_meals := coalesce(p_meals, case when v_price > 0 then p_amount_paise / v_price end);
    if coalesce(v_meals, 0) <= 0 or v_meals > 1000 then
      raise exception 'invalid_meals' using errcode = '22023';
    end if;
  end if;

  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, receipt_photo_path, note,
                               created_by, confirmed_by, confirmed_at, paid_at, created_at, client_op)
  values (v_c.kitchen_id, p_customer, p_method, 'paid', p_amount_paise, v_meals, p_receipt_photo_path,
          nullif(trim(p_note), ''), auth.uid(), auth.uid(), v_now, v_paid_at, v_now, p_client_op)
  on conflict (kitchen_id, client_op) where client_op is not null do nothing
  returning id into v_id;
  if v_id is null then
    -- A concurrent retry with the same key won the race.
    select id into v_id from public.payments where kitchen_id = v_c.kitchen_id and client_op = p_client_op;
    return v_id;
  end if;
  perform private.post_recharge(v_id);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Void a recorded payment (owner or manager), with a reason. Online payments are refunded instead.
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

drop function public.record_purchase(uuid, jsonb, uuid, date, text, text, integer, text);
create function public.record_purchase(p_kitchen uuid, p_lines jsonb, p_supplier uuid default null,
  p_bill_date date default null, p_bill_no text default null, p_photo_path text default null,
  p_paid_now_paise integer default 0, p_notes text default null, p_client_op uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_total integer := 0;
  v_jump numeric;
  v_threshold numeric;
  v_jumps jsonb := '[]';
  l jsonb;
  v_item public.items;
  v_qty numeric;
  v_amount integer;
  v_price integer;
  v_prev integer;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  -- Idempotent retry: the same key returns the first bill.
  if p_client_op is not null then
    select id, total_paise into v_id, v_total from public.purchases where kitchen_id = p_kitchen and client_op = p_client_op;
    if v_id is not null then
      return jsonb_build_object('purchase_id', v_id, 'total_paise', v_total, 'price_jumps', '[]'::jsonb, 'duplicate', true);
    end if;
    v_total := 0;
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines' using errcode = '22023';
  end if;
  if p_supplier is not null and not exists (select 1 from public.suppliers where id = p_supplier and kitchen_id = p_kitchen) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_photo_path is not null and split_part(p_photo_path, '/', 1) <> p_kitchen::text then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;
  if coalesce(p_paid_now_paise, 0) > 0 and not private.has_role(p_kitchen, '{owner}') then
    raise exception 'forbidden' using errcode = '42501';  -- paying suppliers is money: owner only
  end if;
  if coalesce(p_paid_now_paise, 0) > 0 and p_supplier is null then
    raise exception 'supplier_required' using errcode = '22023';
  end if;
  select price_jump_pct into v_threshold from public.kitchen_settings where kitchen_id = p_kitchen;

  insert into public.purchases (kitchen_id, supplier_id, bill_no, bill_date, bill_photo_path, total_paise, notes, created_by, created_at,
                                client_op)
  values (p_kitchen, p_supplier, nullif(trim(p_bill_no), ''), coalesce(p_bill_date, private.ist_today()), p_photo_path, 0,
          nullif(trim(p_notes), ''), auth.uid(), private.now(), p_client_op)
  on conflict (kitchen_id, client_op) where client_op is not null do nothing
  returning id into v_id;
  if v_id is null then
    -- A concurrent retry with the same key won the race.
    select id, total_paise into v_id, v_total from public.purchases where kitchen_id = p_kitchen and client_op = p_client_op;
    return jsonb_build_object('purchase_id', v_id, 'total_paise', v_total, 'price_jumps', '[]'::jsonb, 'duplicate', true);
  end if;

  for l in select * from jsonb_array_elements(p_lines) loop
    select * into v_item from public.items where id = (l ->> 'item_id')::uuid and kitchen_id = p_kitchen;
    if v_item.id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    begin
      v_qty := round(private.convert_qty((l ->> 'qty')::numeric, coalesce((l ->> 'unit')::public.stock_unit, v_item.unit), v_item.unit), 3);
      v_amount := (l ->> 'amount_paise')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_qty' using errcode = '22023';
    end;
    if v_qty is null or v_qty <= 0 or v_amount is null or v_amount < 0 then
      raise exception 'invalid_qty' using errcode = '22023';
    end if;
    v_price := round(v_amount / v_qty);
    v_prev := private.item_unit_cost(v_item.id);
    v_jump := case when v_prev > 0 then round((v_price - v_prev) * 100.0 / v_prev, 2) end;
    insert into public.purchase_lines (kitchen_id, purchase_id, item_id, qty, unit_price_paise, amount_paise, price_jump_pct)
    values (p_kitchen, v_id, v_item.id, v_qty, v_price, v_amount, case when v_jump > v_threshold then v_jump end);
    insert into public.stock_moves (kitchen_id, item_id, type, qty, unit_cost_paise, ref_type, ref_id, created_by, created_at)
    values (p_kitchen, v_item.id, 'purchase', v_qty, v_price, 'purchase', v_id, auth.uid(), private.now());
    update public.items set last_price_paise = v_price where id = v_item.id;
    if v_jump > v_threshold then
      -- Prices are the owner's business: staff see only the percentage.
      v_jumps := v_jumps || jsonb_build_array(jsonb_build_object('item', v_item.name, 'pct', v_jump)
                 || case when private.has_role(p_kitchen, '{owner}')
                         then jsonb_build_object('from_paise', v_prev, 'to_paise', v_price) else '{}'::jsonb end);
      perform private.notify_owners_stock(p_kitchen, v_item.id, 'price_jump',
        jsonb_build_object('item', v_item.name, 'pct', v_jump, 'from_paise', v_prev, 'to_paise', v_price, 'unit', v_item.unit));
    end if;
    v_total := v_total + v_amount;
  end loop;
  update public.purchases set total_paise = v_total where id = v_id;

  if coalesce(p_paid_now_paise, 0) > 0 then
    insert into public.supplier_payments (kitchen_id, supplier_id, purchase_id, amount_paise, note, created_by, paid_at)
    values (p_kitchen, p_supplier, v_id, least(p_paid_now_paise, v_total), 'Paid with the bill', auth.uid(), private.now());
  end if;
  return jsonb_build_object('purchase_id', v_id, 'total_paise', v_total, 'price_jumps', v_jumps, 'duplicate', false);
end;
$$;

drop function public.record_waste(uuid, numeric, text, public.stock_unit);
create function public.record_waste(p_item uuid, p_qty numeric, p_reason text, p_unit public.stock_unit default null,
  p_client_op uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_i public.items;
  v_qty numeric;
  v_op_item uuid;
begin
  select * into v_i from public.items where id = p_item;
  if v_i.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_i.kitchen_id, '{owner,staff}');
  -- Idempotent retry: the same key writes one waste move (and only for the same item).
  if p_client_op is not null then
    select item_id into v_op_item from public.stock_moves
    where type = 'waste' and ref_type = 'client_op' and ref_id = p_client_op limit 1;
    if v_op_item is not null then
      if v_op_item <> p_item then
        raise exception 'invalid_client_op' using errcode = '22023';
      end if;
      return;
    end if;
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  v_qty := round(private.convert_qty(p_qty, coalesce(p_unit, v_i.unit), v_i.unit), 3);
  if v_qty is null or v_qty <= 0 then
    raise exception 'invalid_qty' using errcode = '22023';
  end if;
  insert into public.stock_moves (kitchen_id, item_id, type, qty, unit_cost_paise, reason, ref_type, ref_id, created_by, created_at)
  values (v_i.kitchen_id, p_item, 'waste', -v_qty, private.item_unit_cost(p_item), trim(p_reason),
          case when p_client_op is not null then 'client_op' end, p_client_op, auth.uid(), private.now())
  on conflict (type, ref_type, ref_id, item_id) where ref_id is not null do nothing;
  perform private.check_low_stock(p_item);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (fail closed)
-- ---------------------------------------------------------------------------
revoke execute on function public.record_payment(uuid, integer, public.payment_method, integer, text, text, uuid, timestamptz),
  public.void_payment(uuid, text),
  public.record_purchase(uuid, jsonb, uuid, date, text, text, integer, text, uuid),
  public.record_waste(uuid, numeric, text, public.stock_unit, uuid)
  from public, anon;
grant execute on function public.record_payment(uuid, integer, public.payment_method, integer, text, text, uuid, timestamptz),
  public.void_payment(uuid, text),
  public.record_purchase(uuid, jsonb, uuid, date, text, text, integer, text, uuid),
  public.record_waste(uuid, numeric, text, public.stock_unit, uuid)
  to authenticated;
