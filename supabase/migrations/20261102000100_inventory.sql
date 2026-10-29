-- M6: kitchen operations (inventory), Petpooja-style but simpler.
-- Items, suppliers, purchases with bill photo and supplier credit dues; recipes per portion with
-- automatic consumption when a slot locks; stock-take with variance (reason required above a
-- threshold); wastage with a reason; alerts (low stock, price jump > 15%, high variance); cost
-- per meal (ingredients + gas + packaging) and margin. Stock is the sum of stock_moves: never stored.

create type public.stock_unit as enum ('kg', 'g', 'l', 'ml', 'pc');
create type public.item_category as enum ('grain', 'pulse', 'vegetable', 'dairy', 'meat', 'spice', 'oil', 'gas', 'packaging', 'other');
create type public.stock_move_type as enum ('purchase', 'consume', 'waste', 'adjust', 'count');

alter table public.kitchen_settings
  add column gas_paise_per_meal integer not null default 0 check (gas_paise_per_meal between 0 and 10000),
  add column packaging_paise_per_meal integer not null default 0 check (packaging_paise_per_meal between 0 and 10000),
  add column variance_reason_pct numeric(5, 2) not null default 2 check (variance_reason_pct between 0 and 100),
  add column price_jump_pct numeric(5, 2) not null default 15 check (price_jump_pct between 1 and 500);
grant update (gas_paise_per_meal, packaging_paise_per_meal, variance_reason_pct, price_jump_pct) on public.kitchen_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.items (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  name text not null check (length(trim(name)) between 1 and 60),
  unit public.stock_unit not null,              -- every quantity of this item is stored in this unit
  category public.item_category not null default 'other',
  min_qty numeric(12, 3) not null default 0 check (min_qty >= 0),
  last_price_paise integer check (last_price_paise >= 0),   -- per unit, from the latest purchase
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id)
);
create unique index items_name_idx on public.items (kitchen_id, lower(name));

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  name text not null check (length(trim(name)) between 1 and 80),
  phone text check (length(phone) <= 20),      -- a business contact, not customer data
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id)
);
create unique index suppliers_name_idx on public.suppliers (kitchen_id, lower(name));

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  supplier_id uuid,
  bill_no text,
  bill_date date not null,
  bill_photo_path text,                        -- storage: bills/<kitchen_id>/...
  total_paise integer not null check (total_paise >= 0),
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (id, kitchen_id),
  foreign key (supplier_id, kitchen_id) references public.suppliers (id, kitchen_id)
);
create index purchases_kitchen_idx on public.purchases (kitchen_id, bill_date desc);

create table public.purchase_lines (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  purchase_id uuid not null,
  item_id uuid not null,
  qty numeric(12, 3) not null check (qty > 0),         -- item unit
  unit_price_paise integer not null check (unit_price_paise >= 0),
  amount_paise integer not null check (amount_paise >= 0),
  price_jump_pct numeric(7, 2),                        -- vs the recent average price (item_unit_cost), when above the kitchen's threshold
  foreign key (purchase_id, kitchen_id) references public.purchases (id, kitchen_id) on delete cascade,
  foreign key (item_id, kitchen_id) references public.items (id, kitchen_id)
);
create index purchase_lines_item_idx on public.purchase_lines (item_id);

-- Payments to suppliers (append-only). Credit due = purchases − payments.
create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  supplier_id uuid not null,
  purchase_id uuid,
  amount_paise integer not null check (amount_paise > 0),
  method public.payment_method not null default 'cash',
  note text,
  paid_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  foreign key (supplier_id, kitchen_id) references public.suppliers (id, kitchen_id),
  foreign key (purchase_id, kitchen_id) references public.purchases (id, kitchen_id)
);

-- The stock ledger (append-only). qty in the item's unit: + in, − out.
create table public.stock_moves (
  id bigint generated always as identity primary key,
  kitchen_id uuid not null,
  item_id uuid not null,
  type public.stock_move_type not null,
  qty numeric(12, 3) not null check (qty <> 0),
  unit_cost_paise integer check (unit_cost_paise >= 0),
  ref_type text,
  ref_id uuid,
  reason text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (type not in ('consume', 'waste') or qty < 0),
  check (type <> 'purchase' or qty > 0),
  check (type <> 'waste' or reason is not null),
  foreign key (item_id, kitchen_id) references public.items (id, kitchen_id)
);
create index stock_moves_item_idx on public.stock_moves (item_id, created_at);
-- One consumption per item per locked slot (the lock is idempotent, so is this).
create unique index stock_moves_ref_idx on public.stock_moves (type, ref_type, ref_id, item_id) where ref_id is not null;

create table public.dishes (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  name text not null check (length(trim(name)) between 1 and 60),
  -- Which diets get this dish (dal: everyone; chicken curry: non-veg only).
  serves public.diet_type[] not null default '{veg,nonveg,jain}' check (cardinality(serves) between 1 and 3),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id)
);
create unique index dishes_name_idx on public.dishes (kitchen_id, lower(name));

create table public.recipe_lines (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  dish_id uuid not null,
  item_id uuid not null,
  qty_per_portion numeric(12, 4) not null check (qty_per_portion > 0),   -- item unit
  updated_at timestamptz not null default now(),
  unique (dish_id, item_id),
  foreign key (dish_id, kitchen_id) references public.dishes (id, kitchen_id) on delete cascade,
  foreign key (item_id, kitchen_id) references public.items (id, kitchen_id)
);

create table public.stock_takes (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  status text not null default 'open' check (status in ('open', 'closed')),
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid references auth.users (id),
  closed_by uuid references auth.users (id),
  unique (id, kitchen_id)
);
create unique index stock_takes_one_open_idx on public.stock_takes (kitchen_id) where status = 'open';

create table public.stock_take_lines (
  stock_take_id uuid not null,
  kitchen_id uuid not null,
  item_id uuid not null,
  expected_qty numeric(12, 3) not null,        -- book stock when this item was counted (refreshed on every count)
  counted_qty numeric(12, 3) check (counted_qty >= 0),
  variance numeric(12, 3) generated always as (counted_qty - expected_qty) stored,
  reason text,
  primary key (stock_take_id, item_id),
  foreign key (stock_take_id, kitchen_id) references public.stock_takes (id, kitchen_id) on delete cascade,
  foreign key (item_id, kitchen_id) references public.items (id, kitchen_id)
);

create trigger items_updated_at before update on public.items for each row execute function private.set_updated_at();
create trigger suppliers_updated_at before update on public.suppliers for each row execute function private.set_updated_at();
create trigger dishes_updated_at before update on public.dishes for each row execute function private.set_updated_at();
create trigger recipe_lines_updated_at before update on public.recipe_lines for each row execute function private.set_updated_at();

create trigger stock_moves_append_only before update or delete on public.stock_moves
  for each row execute function private.forbid_mutation();
create trigger supplier_payments_append_only before update or delete on public.supplier_payments
  for each row execute function private.forbid_mutation();

create trigger items_audit after insert or update or delete on public.items for each row execute function private.audit_row();
create trigger purchases_audit after insert or update or delete on public.purchases for each row execute function private.audit_row();
create trigger purchase_lines_audit after insert or update or delete on public.purchase_lines for each row execute function private.audit_row();
create trigger supplier_payments_audit after insert on public.supplier_payments for each row execute function private.audit_row();
create trigger stock_moves_audit after insert on public.stock_moves for each row execute function private.audit_row();
create trigger recipe_lines_audit after insert or update or delete on public.recipe_lines for each row execute function private.audit_row();
create trigger stock_take_lines_audit after insert or update or delete on public.stock_take_lines for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Convert a quantity between units of the same kind (kg↔g, l↔ml); pc only to pc.
create or replace function private.convert_qty(p_qty numeric, p_from public.stock_unit, p_to public.stock_unit)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  f numeric;
  t numeric;
begin
  if p_from is null or p_from = p_to then
    return p_qty;
  end if;
  f := case p_from when 'kg' then 1000 when 'g' then 1 when 'l' then 1000 when 'ml' then 1 else null end;
  t := case p_to when 'kg' then 1000 when 'g' then 1 when 'l' then 1000 when 'ml' then 1 else null end;
  if f is null or t is null or (p_from in ('kg', 'g')) <> (p_to in ('kg', 'g')) then
    raise exception 'unit_mismatch' using errcode = '22023';
  end if;
  return p_qty * f / t;
end;
$$;

create or replace function private.item_stock(p_item uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(qty), 0)::numeric(12, 3) from public.stock_moves where item_id = p_item;
$$;

-- Cost of one unit: weighted average of the last 90 days of purchases, else the last price.
create or replace function private.item_unit_cost(p_item uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select round(sum(pl.amount_paise)::numeric / nullif(sum(pl.qty), 0))::integer
     from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
     where pl.item_id = p_item and p.bill_date >= private.ist_today() - 90),
    (select last_price_paise from public.items where id = p_item), 0);
$$;

create or replace function private.notify_owners_stock(p_kitchen uuid, p_item uuid, p_kind text, p_payload jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select p_kitchen, 'whatsapp', 'member', m.user_id, 'stock_alert',
         p_payload || jsonb_build_object('kind', p_kind),
         'stock_alert:' || p_kind || ':' || p_item || ':' || private.ist_today() || ':' || m.user_id
  from public.members m where m.kitchen_id = p_kitchen and m.role = 'owner'
  on conflict (dedupe_key) do nothing;
$$;

-- After stock goes down: tell the owner once a day per item when it falls to or below the minimum.
create or replace function private.check_low_stock(p_item uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_i public.items;
  v_stock numeric;
begin
  select * into v_i from public.items where id = p_item;
  if v_i.min_qty <= 0 or not v_i.active then
    return;
  end if;
  v_stock := private.item_stock(p_item);
  if v_stock <= v_i.min_qty then
    perform private.notify_owners_stock(v_i.kitchen_id, p_item, 'low_stock',
      jsonb_build_object('item', v_i.name, 'stock', v_stock, 'unit', v_i.unit, 'min_qty', v_i.min_qty));
  end if;
end;
$$;

-- Portions per dish for a slot: counted orders whose diet the dish serves, for the slot's menu dishes.
create or replace function private.slot_portions(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns table (dish_id uuid, dish_name text, portions integer)
language sql
stable
security definer
set search_path = ''
as $$
  with menu as (
    select distinct lower(trim(x)) as name
    from public.menus m, unnest(m.dishes) x
    where m.kitchen_id = p_kitchen and m.service_date = p_date and m.slot = p_slot
  )
  select d.id, d.name,
         coalesce((select sum(o.qty) from public.meal_orders o
                   where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot
                     and (o.status <> 'skipped' or o.charged) and o.diet = any (d.serves)), 0)::integer
  from menu join public.dishes d on d.kitchen_id = p_kitchen and lower(d.name) = menu.name and d.active;
$$;

-- At lock: deduct the expected ingredients (recipes × portions). One move per item per slot.
create or replace function private.consume_for_slot(p_kitchen uuid, p_date date, p_slot public.meal_slot, p_snapshot uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
  r record;
begin
  insert into public.stock_moves (kitchen_id, item_id, type, qty, unit_cost_paise, ref_type, ref_id, reason, created_at)
  select p_kitchen, rl.item_id, 'consume', -round(sum(rl.qty_per_portion * sp.portions), 3),
         private.item_unit_cost(rl.item_id), 'count_snapshot', p_snapshot,
         'Recipes for ' || p_date || ' ' || p_slot, private.now()
  from private.slot_portions(p_kitchen, p_date, p_slot) sp
  join public.recipe_lines rl on rl.dish_id = sp.dish_id
  where sp.portions > 0
  group by rl.item_id
  having round(sum(rl.qty_per_portion * sp.portions), 3) > 0
  on conflict (type, ref_type, ref_id, item_id) where ref_id is not null do nothing;
  get diagnostics v_n = row_count;
  for r in select item_id from public.stock_moves where ref_type = 'count_snapshot' and ref_id = p_snapshot and type = 'consume' loop
    perform private.check_low_stock(r.item_id);
  end loop;
  return v_n;
end;
$$;

-- Hooked to the lock (count_snapshots insert). Stock problems must never block the lock.
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
    raise warning 'consume_for_slot failed for % % %: %', new.kitchen_id, new.service_date, new.slot, sqlerrm;
  end;
  return null;
end;
$$;

create trigger count_snapshots_consume after insert on public.count_snapshots
  for each row execute function private.snapshot_consume();

-- Stock-take lines that need a reason before closing: |variance| above the kitchen's % of the
-- expected quantity (and above a tiny floor so rounding never asks for a reason).
create or replace function private.needs_reason(p_kitchen uuid, p_expected numeric, p_variance numeric)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_variance is not null and abs(p_variance) > 0.0005
     and abs(p_variance) > abs(p_expected) * (select variance_reason_pct from public.kitchen_settings where kitchen_id = p_kitchen) / 100;
$$;

-- ---------------------------------------------------------------------------
-- RPCs: items, suppliers, purchases (owner + staff; supplier money: owner)
-- ---------------------------------------------------------------------------
create or replace function public.create_item(p_kitchen uuid, p_name text, p_unit public.stock_unit,
  p_category public.item_category default 'other', p_min_qty numeric default 0,
  p_opening_qty numeric default 0, p_opening_price_paise integer default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  if coalesce(p_opening_qty, 0) < 0 or coalesce(p_min_qty, 0) < 0 then
    raise exception 'invalid_qty' using errcode = '22023';
  end if;
  insert into public.items (kitchen_id, name, unit, category, min_qty, last_price_paise)
  values (p_kitchen, trim(p_name), p_unit, coalesce(p_category, 'other'), coalesce(p_min_qty, 0), p_opening_price_paise)
  returning id into v_id;
  if coalesce(p_opening_qty, 0) > 0 then
    insert into public.stock_moves (kitchen_id, item_id, type, qty, unit_cost_paise, reason, created_by, created_at)
    values (p_kitchen, v_id, 'adjust', p_opening_qty, p_opening_price_paise, 'Opening stock', auth.uid(), private.now());
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'already_exists' using errcode = '23505';
end;
$$;

create or replace function public.update_item(p_item uuid, p_name text default null, p_category public.item_category default null,
  p_min_qty numeric default null, p_active boolean default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.items where id = p_item;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner,staff}');
  if p_min_qty is not null and p_min_qty < 0 then
    raise exception 'invalid_qty' using errcode = '22023';
  end if;
  update public.items set name = coalesce(nullif(trim(p_name), ''), name), category = coalesce(p_category, category),
         min_qty = coalesce(p_min_qty, min_qty), active = coalesce(p_active, active)
  where id = p_item;
exception when unique_violation then
  raise exception 'already_exists' using errcode = '23505';
end;
$$;

create or replace function public.upsert_supplier(p_kitchen uuid, p_name text, p_phone text default null, p_notes text default null,
  p_supplier uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  if p_supplier is null then
    insert into public.suppliers (kitchen_id, name, phone, notes) values (p_kitchen, trim(p_name), nullif(trim(p_phone), ''), nullif(trim(p_notes), ''))
    returning id into v_id;
  else
    update public.suppliers set name = coalesce(nullif(trim(p_name), ''), name), phone = coalesce(nullif(trim(p_phone), ''), phone),
           notes = coalesce(nullif(trim(p_notes), ''), notes)
    where id = p_supplier and kitchen_id = p_kitchen returning id into v_id;
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'already_exists' using errcode = '23505';
end;
$$;

-- A supplier bill. p_lines: [{item_id, qty, unit (optional, converted to the item's unit), amount_paise}].
-- Prices jump > the kitchen's threshold (15%) are flagged and the owner is told.
create or replace function public.record_purchase(p_kitchen uuid, p_lines jsonb, p_supplier uuid default null,
  p_bill_date date default null, p_bill_no text default null, p_photo_path text default null,
  p_paid_now_paise integer default 0, p_notes text default null)
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

  insert into public.purchases (kitchen_id, supplier_id, bill_no, bill_date, bill_photo_path, total_paise, notes, created_by, created_at)
  values (p_kitchen, p_supplier, nullif(trim(p_bill_no), ''), coalesce(p_bill_date, private.ist_today()), p_photo_path, 0,
          nullif(trim(p_notes), ''), auth.uid(), private.now())
  returning id into v_id;

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
      v_jumps := v_jumps || jsonb_build_object('item', v_item.name, 'pct', v_jump)
                 || case when private.has_role(p_kitchen, '{owner}')
                         then jsonb_build_object('from_paise', v_prev, 'to_paise', v_price) else '{}'::jsonb end;
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
  return jsonb_build_object('purchase_id', v_id, 'total_paise', v_total, 'price_jumps', v_jumps);
end;
$$;

create or replace function public.pay_supplier(p_supplier uuid, p_amount_paise integer, p_method public.payment_method default 'cash',
  p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
  v_id uuid;
begin
  select kitchen_id into v_kitchen from public.suppliers where id = p_supplier;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  if coalesce(p_amount_paise, 0) <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  insert into public.supplier_payments (kitchen_id, supplier_id, amount_paise, method, note, created_by, paid_at)
  values (v_kitchen, p_supplier, p_amount_paise, coalesce(p_method, 'cash'), nullif(trim(p_note), ''), auth.uid(), private.now())
  returning id into v_id;
  return v_id;
end;
$$;

-- Credit dues per supplier (owner only).
create or replace function public.supplier_dues(p_kitchen uuid)
returns table (supplier_id uuid, name text, phone text, purchased_paise integer, paid_paise integer, due_paise integer,
               last_bill_date date)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_role(p_kitchen, '{owner}');
  return query
  select s.id, s.name, s.phone,
         coalesce((select sum(total_paise) from public.purchases p where p.supplier_id = s.id), 0)::integer,
         coalesce((select sum(amount_paise) from public.supplier_payments sp where sp.supplier_id = s.id), 0)::integer,
         (coalesce((select sum(total_paise) from public.purchases p where p.supplier_id = s.id), 0)
          - coalesce((select sum(amount_paise) from public.supplier_payments sp where sp.supplier_id = s.id), 0))::integer,
         (select max(bill_date) from public.purchases p where p.supplier_id = s.id)
  from public.suppliers s
  where s.kitchen_id = p_kitchen
  order by 6 desc, 2;
end;
$$;

-- Stock list: book stock, value at cost, low flag.
create or replace function public.stock_levels(p_kitchen uuid)
returns table (item_id uuid, name text, unit public.stock_unit, category public.item_category, stock numeric, min_qty numeric,
               low boolean, unit_cost_paise integer, value_paise integer, active boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_owner boolean;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  v_owner := private.has_role(p_kitchen, '{owner}');
  return query
  select i.id, i.name, i.unit, i.category, private.item_stock(i.id), i.min_qty,
         i.min_qty > 0 and private.item_stock(i.id) <= i.min_qty,
         case when v_owner then private.item_unit_cost(i.id) end,
         case when v_owner then round(greatest(private.item_stock(i.id), 0) * private.item_unit_cost(i.id))::integer end, i.active
  from public.items i where i.kitchen_id = p_kitchen
  order by i.active desc, (i.min_qty > 0 and private.item_stock(i.id) <= i.min_qty) desc, i.name;
end;
$$;

create or replace function public.record_waste(p_item uuid, p_qty numeric, p_reason text, p_unit public.stock_unit default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_i public.items;
  v_qty numeric;
begin
  select * into v_i from public.items where id = p_item;
  if v_i.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_i.kitchen_id, '{owner,staff}');
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  v_qty := round(private.convert_qty(p_qty, coalesce(p_unit, v_i.unit), v_i.unit), 3);
  if v_qty is null or v_qty <= 0 then
    raise exception 'invalid_qty' using errcode = '22023';
  end if;
  insert into public.stock_moves (kitchen_id, item_id, type, qty, unit_cost_paise, reason, created_by, created_at)
  values (v_i.kitchen_id, p_item, 'waste', -v_qty, private.item_unit_cost(p_item), trim(p_reason), auth.uid(), private.now());
  perform private.check_low_stock(p_item);
end;
$$;

-- Corrections outside a stock-take (owner): + or −, with a reason.
create or replace function public.adjust_stock(p_item uuid, p_qty numeric, p_reason text, p_unit public.stock_unit default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_i public.items;
  v_qty numeric;
begin
  select * into v_i from public.items where id = p_item;
  if v_i.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_i.kitchen_id, '{owner}');
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  v_qty := round(private.convert_qty(p_qty, coalesce(p_unit, v_i.unit), v_i.unit), 3);
  if v_qty is null or v_qty = 0 then
    raise exception 'invalid_qty' using errcode = '22023';
  end if;
  insert into public.stock_moves (kitchen_id, item_id, type, qty, unit_cost_paise, reason, created_by, created_at)
  values (v_i.kitchen_id, p_item, 'adjust', v_qty, private.item_unit_cost(p_item), trim(p_reason), auth.uid(), private.now());
  perform private.check_low_stock(p_item);
end;
$$;

-- ---------------------------------------------------------------------------
-- Recipes
-- ---------------------------------------------------------------------------
create or replace function public.upsert_dish(p_kitchen uuid, p_name text, p_serves public.diet_type[] default '{veg,nonveg,jain}',
  p_dish uuid default null, p_active boolean default true)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  if p_dish is null then
    insert into public.dishes (kitchen_id, name, serves, active) values (p_kitchen, trim(p_name), p_serves, coalesce(p_active, true))
    returning id into v_id;
  else
    update public.dishes set name = coalesce(nullif(trim(p_name), ''), name), serves = coalesce(p_serves, serves),
           active = coalesce(p_active, active)
    where id = p_dish and kitchen_id = p_kitchen returning id into v_id;
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'already_exists' using errcode = '23505';
end;
$$;

-- Quantity per portion in any unit of the item's kind ("30 g" of dal stocked in kg → 0.03).
-- p_qty 0 removes the line.
create or replace function public.set_recipe_line(p_dish uuid, p_item uuid, p_qty numeric, p_unit public.stock_unit default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d public.dishes;
  v_i public.items;
  v_qty numeric;
begin
  select * into v_d from public.dishes where id = p_dish;
  select * into v_i from public.items where id = p_item;
  if v_d.id is null or v_i.id is null or v_i.kitchen_id <> v_d.kitchen_id then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_d.kitchen_id, '{owner,staff}');
  if coalesce(p_qty, 0) = 0 then
    delete from public.recipe_lines where dish_id = p_dish and item_id = p_item;
    return 0;
  end if;
  v_qty := round(private.convert_qty(p_qty, coalesce(p_unit, v_i.unit), v_i.unit), 4);
  if v_qty <= 0 then
    raise exception 'invalid_qty' using errcode = '22023';
  end if;
  insert into public.recipe_lines (kitchen_id, dish_id, item_id, qty_per_portion) values (v_d.kitchen_id, p_dish, p_item, v_qty)
  on conflict (dish_id, item_id) do update set qty_per_portion = excluded.qty_per_portion;
  return v_qty;
end;
$$;

-- Dishes with recipe lines and ingredient cost per portion.
create or replace function public.dish_costs(p_kitchen uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'dish_id', d.id, 'name', d.name, 'serves', d.serves, 'active', d.active,
      'cost_per_portion_paise', coalesce((select round(sum(rl.qty_per_portion * private.item_unit_cost(rl.item_id)))
                                          from public.recipe_lines rl where rl.dish_id = d.id), 0),
      'lines', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'item', i.name, 'unit', i.unit,
                                            'qty_per_portion', rl.qty_per_portion,
                                            'cost_paise', round(rl.qty_per_portion * private.item_unit_cost(i.id))) order by i.name)
                         from public.recipe_lines rl join public.items i on i.id = rl.item_id where rl.dish_id = d.id), '[]'::jsonb)
    ) order by d.active desc, d.name)
    from public.dishes d where d.kitchen_id = p_kitchen), '[]'::jsonb);
end;
$$;

-- What to cook: portions per dish and ingredient quantities for a slot (preview before the lock,
-- final after), with stock on hand, shortfalls and menu dishes that have no recipe yet.
create or replace function public.production_plan(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  return jsonb_build_object(
    'dishes', coalesce((select jsonb_agg(jsonb_build_object('dish_id', dish_id, 'name', dish_name, 'portions', portions) order by dish_name)
                        from private.slot_portions(p_kitchen, p_date, p_slot)), '[]'::jsonb),
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'item', i.name, 'unit', i.unit, 'qty', x.qty,
                                          'stock', private.item_stock(i.id), 'short', greatest(0, x.qty - private.item_stock(i.id)))
                       order by i.name)
      from (select rl.item_id, round(sum(rl.qty_per_portion * sp.portions), 3) as qty
            from private.slot_portions(p_kitchen, p_date, p_slot) sp join public.recipe_lines rl on rl.dish_id = sp.dish_id
            group by rl.item_id) x
      join public.items i on i.id = x.item_id), '[]'::jsonb),
    'no_recipe', coalesce((
      select jsonb_agg(distinct trim(x))
      from public.menus m, unnest(m.dishes) x
      where m.kitchen_id = p_kitchen and m.service_date = p_date and m.slot = p_slot
        and not exists (select 1 from public.dishes d join public.recipe_lines rl on rl.dish_id = d.id
                        where d.kitchen_id = p_kitchen and lower(d.name) = lower(trim(x)) and d.active)), '[]'::jsonb),
    'consumed', exists (select 1 from public.stock_moves sm join public.count_snapshots cs on cs.id = sm.ref_id
                        where sm.ref_type = 'count_snapshot' and cs.kitchen_id = p_kitchen and cs.service_date = p_date and cs.slot = p_slot)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock-take
-- ---------------------------------------------------------------------------
create or replace function public.start_stock_take(p_kitchen uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  select id into v_id from public.stock_takes where kitchen_id = p_kitchen and status = 'open';
  if v_id is not null then
    return v_id;  -- carry on with the open count
  end if;
  insert into public.stock_takes (kitchen_id, created_by, started_at) values (p_kitchen, auth.uid(), private.now()) returning id into v_id;
  insert into public.stock_take_lines (stock_take_id, kitchen_id, item_id, expected_qty)
  select v_id, p_kitchen, i.id, private.item_stock(i.id) from public.items i where i.kitchen_id = p_kitchen and i.active;
  return v_id;
end;
$$;

-- The baseline is the book stock at the moment the item is counted, so anything consumed, wasted
-- or bought before that (a slot lock, say) isn't counted twice. p_counted null clears the count;
-- p_reason '' clears the reason.
create or replace function public.set_stock_count(p_stock_take uuid, p_item uuid, p_counted numeric default null,
  p_unit public.stock_unit default null, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.stock_takes;
  v_i public.items;
  v_qty numeric;
  v_line public.stock_take_lines;
begin
  select * into v_t from public.stock_takes where id = p_stock_take;
  select * into v_i from public.items where id = p_item;
  if v_t.id is null or v_i.id is null or v_i.kitchen_id <> v_t.kitchen_id then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_t.kitchen_id, '{owner,staff}');
  if v_t.status <> 'open' then
    raise exception 'stock_take_closed' using errcode = '22023';
  end if;
  v_qty := case when p_counted is null then null else round(private.convert_qty(p_counted, coalesce(p_unit, v_i.unit), v_i.unit), 3) end;
  if v_qty < 0 then
    raise exception 'invalid_qty' using errcode = '22023';
  end if;
  insert into public.stock_take_lines (stock_take_id, kitchen_id, item_id, expected_qty, counted_qty, reason)
  values (p_stock_take, v_t.kitchen_id, p_item, private.item_stock(p_item), v_qty, nullif(trim(p_reason), ''))
  on conflict (stock_take_id, item_id) do update
    set counted_qty = excluded.counted_qty, expected_qty = excluded.expected_qty,
        reason = case when p_reason is null then public.stock_take_lines.reason else excluded.reason end
  returning * into v_line;
  return jsonb_build_object('item_id', p_item, 'expected', v_line.expected_qty, 'counted', v_line.counted_qty,
    'variance', v_line.variance, 'needs_reason', private.needs_reason(v_t.kitchen_id, v_line.expected_qty, v_line.variance)
                                                 and v_line.reason is null);
end;
$$;

-- The count sheet with variances and the lines that still need a reason.
create or replace function public.stock_take_review(p_stock_take uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t public.stock_takes;
begin
  select * into v_t from public.stock_takes where id = p_stock_take;
  if v_t.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_t.kitchen_id, '{owner,staff}');
  return jsonb_build_object('id', v_t.id, 'status', v_t.status, 'started_at', v_t.started_at, 'closed_at', v_t.closed_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'item_id', i.id, 'item', i.name, 'unit', i.unit, 'expected', l.expected_qty, 'counted', l.counted_qty,
        'variance', l.variance, 'variance_value_paise', round(coalesce(l.variance, 0) * private.item_unit_cost(i.id)),
        'variance_pct', case when l.expected_qty <> 0 then round(l.variance * 100 / l.expected_qty, 1) end,
        'reason', l.reason, 'needs_reason', private.needs_reason(v_t.kitchen_id, l.expected_qty, l.variance) and l.reason is null)
      order by (private.needs_reason(v_t.kitchen_id, l.expected_qty, l.variance) and l.reason is null) desc, i.name)
      from public.stock_take_lines l join public.items i on i.id = l.item_id where l.stock_take_id = v_t.id), '[]'::jsonb));
end;
$$;

-- Abandon an open count (nothing is posted).
create or replace function public.cancel_stock_take(p_stock_take uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.stock_takes;
begin
  select * into v_t from public.stock_takes where id = p_stock_take for update;
  if v_t.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_t.kitchen_id, '{owner,staff}');
  if v_t.status <> 'open' then
    raise exception 'stock_take_closed' using errcode = '22023';
  end if;
  delete from public.stock_takes where id = p_stock_take;
end;
$$;

-- Closing posts a 'count' move per counted line with a variance, so book stock becomes the
-- counted stock. Refused while a significant variance has no reason.
create or replace function public.close_stock_take(p_stock_take uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.stock_takes;
  v_missing integer;
  v_posted integer;
  r record;
begin
  select * into v_t from public.stock_takes where id = p_stock_take for update;
  if v_t.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_t.kitchen_id, '{owner,staff}');
  if v_t.status <> 'open' then
    raise exception 'stock_take_closed' using errcode = '22023';
  end if;
  select count(*) into v_missing from public.stock_take_lines l
  where l.stock_take_id = p_stock_take and private.needs_reason(v_t.kitchen_id, l.expected_qty, l.variance) and l.reason is null;
  if v_missing > 0 then
    raise exception 'reason_required' using errcode = '22023', detail = v_missing || ' item(s) need a reason';
  end if;
  insert into public.stock_moves (kitchen_id, item_id, type, qty, unit_cost_paise, ref_type, ref_id, reason, created_by, created_at)
  select v_t.kitchen_id, l.item_id, 'count', l.variance, private.item_unit_cost(l.item_id), 'stock_take', p_stock_take,
         coalesce(l.reason, 'Stock-take'), auth.uid(), private.now()
  from public.stock_take_lines l
  where l.stock_take_id = p_stock_take and l.counted_qty is not null and l.variance <> 0
  on conflict (type, ref_type, ref_id, item_id) where ref_id is not null do nothing;
  get diagnostics v_posted = row_count;
  update public.stock_takes set status = 'closed', closed_at = private.now(), closed_by = auth.uid() where id = p_stock_take;
  -- High variance (> 10% of expected): tell the owner.
  for r in select l.*, i.name, i.unit from public.stock_take_lines l join public.items i on i.id = l.item_id
           where l.stock_take_id = p_stock_take and l.expected_qty <> 0 and abs(l.variance) > abs(l.expected_qty) * 0.10 loop
    perform private.notify_owners_stock(v_t.kitchen_id, r.item_id, 'variance',
      jsonb_build_object('item', r.name, 'variance', r.variance, 'unit', r.unit, 'reason', r.reason));
  end loop;
  for r in select item_id from public.stock_take_lines where stock_take_id = p_stock_take loop
    perform private.check_low_stock(r.item_id);
  end loop;
  return jsonb_build_object('stock_take_id', p_stock_take, 'adjustments', v_posted);
end;
$$;

-- ---------------------------------------------------------------------------
-- Alerts and costs
-- ---------------------------------------------------------------------------
create or replace function public.inventory_alerts(p_kitchen uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner boolean;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  v_owner := private.has_role(p_kitchen, '{owner}');
  return
    coalesce((select jsonb_agg(jsonb_build_object('type', 'low_stock', 'item_id', i.id, 'item', i.name, 'unit', i.unit,
                                                  'stock', private.item_stock(i.id), 'min_qty', i.min_qty))
              from public.items i where i.kitchen_id = p_kitchen and i.active and i.min_qty > 0
                and private.item_stock(i.id) <= i.min_qty), '[]'::jsonb)
    || coalesce((select jsonb_agg(jsonb_build_object('type', 'price_jump', 'item_id', i.id, 'item', i.name, 'unit', i.unit,
                                                     'pct', pl.price_jump_pct, 'bill_date', p.bill_date,
                                                     'unit_price_paise', case when v_owner then pl.unit_price_paise end)
                                  order by p.bill_date desc)
                 from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id join public.items i on i.id = pl.item_id
                 where pl.kitchen_id = p_kitchen and pl.price_jump_pct is not null and p.bill_date >= private.ist_today() - 7), '[]'::jsonb)
    || coalesce((select jsonb_agg(jsonb_build_object('type', 'variance', 'item_id', i.id, 'item', i.name, 'unit', i.unit,
                                                     'variance', l.variance, 'pct', round(l.variance * 100 / l.expected_qty, 1),
                                                     'reason', l.reason, 'date', t.closed_at::date))
                 from public.stock_take_lines l join public.stock_takes t on t.id = l.stock_take_id join public.items i on i.id = l.item_id
                 where l.kitchen_id = p_kitchen and t.status = 'closed' and t.closed_at >= private.now() - interval '7 days'
                   and l.expected_qty <> 0 and abs(l.variance) > abs(l.expected_qty) * 0.10), '[]'::jsonb);
end;
$$;

-- Cost per meal and margin over a date range (by service date). Owner only.
-- Ingredients = recipe consumption at lock; waste and stock-take losses shown separately;
-- gas and packaging from the kitchen's per-meal settings; revenue = meals charged.
create or replace function public.cost_report(p_kitchen uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_meals integer;
  v_revenue bigint;
  v_ingredients bigint;
  v_waste bigint;
  v_shrink bigint;
  v_gas integer;
  v_pack integer;
  v_cost bigint;
begin
  perform private.require_role(p_kitchen, '{owner}');
  select coalesce(sum(o.qty), 0), coalesce(sum(o.qty * coalesce(o.price_per_meal_paise, 0)), 0)
  into v_meals, v_revenue
  from public.meal_orders o
  where o.kitchen_id = p_kitchen and o.service_date between p_from and p_to and o.locked_at is not null
    and (o.status <> 'skipped' or o.charged);
  select coalesce(sum(-sm.qty * coalesce(sm.unit_cost_paise, 0)), 0) into v_ingredients
  from public.stock_moves sm join public.count_snapshots cs on cs.id = sm.ref_id
  where sm.ref_type = 'count_snapshot' and sm.type = 'consume' and cs.kitchen_id = p_kitchen and cs.service_date between p_from and p_to;
  select coalesce(sum(-sm.qty * coalesce(sm.unit_cost_paise, 0)), 0) into v_waste
  from public.stock_moves sm
  where sm.kitchen_id = p_kitchen and sm.type = 'waste'
    and sm.created_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and sm.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata');
  select coalesce(sum(-sm.qty * coalesce(sm.unit_cost_paise, 0)), 0) into v_shrink
  from public.stock_moves sm
  where sm.kitchen_id = p_kitchen and sm.type = 'count'
    and sm.created_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and sm.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata');
  select gas_paise_per_meal, packaging_paise_per_meal into v_gas, v_pack from public.kitchen_settings where kitchen_id = p_kitchen;
  v_cost := v_ingredients + v_waste + greatest(v_shrink, 0) + v_meals * (coalesce(v_gas, 0) + coalesce(v_pack, 0));
  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'meals', v_meals, 'revenue_paise', v_revenue,
    'ingredients_paise', v_ingredients, 'waste_paise', v_waste, 'stock_loss_paise', v_shrink,
    'gas_paise', v_meals * coalesce(v_gas, 0), 'packaging_paise', v_meals * coalesce(v_pack, 0),
    'total_cost_paise', v_cost,
    'cost_per_meal_paise', case when v_meals > 0 then round(v_cost::numeric / v_meals) end,
    'revenue_per_meal_paise', case when v_meals > 0 then round(v_revenue::numeric / v_meals) end,
    'margin_per_meal_paise', case when v_meals > 0 then round((v_revenue - v_cost)::numeric / v_meals) end,
    'margin_pct', case when v_revenue > 0 then round((v_revenue - v_cost) * 100.0 / v_revenue, 1) end,
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.service_date, 'meals', d.meals,
                         'ingredients_paise', coalesce((select sum(-sm.qty * coalesce(sm.unit_cost_paise, 0))
                                                        from public.stock_moves sm join public.count_snapshots cs on cs.id = sm.ref_id
                                                        where sm.ref_type = 'count_snapshot' and sm.type = 'consume'
                                                          and cs.kitchen_id = p_kitchen and cs.service_date = d.service_date), 0))
                       order by d.service_date)
      from (select o.service_date, sum(o.qty) as meals from public.meal_orders o
            where o.kitchen_id = p_kitchen and o.service_date between p_from and p_to and o.locked_at is not null
              and (o.status <> 'skipped' or o.charged)
            group by o.service_date) d), '[]'::jsonb));
end;
$$;

-- 22:00 owner summary, now with collections and low stock (both were placeholders).
create or replace function private.queue_owner_summaries()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_tomorrow date := private.ist_today() + 1;
  v_n integer;
begin
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select k.id, 'whatsapp', 'member', m.user_id, 'owner_daily_summary',
         jsonb_build_object(
           'service_date', v_tomorrow,
           'lunch', private.slot_totals(k.id, v_tomorrow, 'lunch'),
           'dinner', private.slot_totals(k.id, v_tomorrow, 'dinner'),
           'collections_paise', (select coalesce(sum(p.amount_paise), 0) from public.payments p
                                 where p.kitchen_id = k.id and p.status = 'paid'
                                   and p.paid_at >= (v_today::timestamp at time zone 'Asia/Kolkata')
                                   and p.paid_at < (v_tomorrow::timestamp at time zone 'Asia/Kolkata')),
           'low_stock', coalesce((select jsonb_agg(i.name order by i.name) from public.items i
                                  where i.kitchen_id = k.id and i.active and i.min_qty > 0
                                    and private.item_stock(i.id) <= i.min_qty), '[]'::jsonb)),
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
-- Storage: supplier bill photos (bills/<kitchen_id>/...), owner + staff.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bills', 'bills', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;
create policy bills_read on storage.objects for select to authenticated
  using (bucket_id = 'bills' and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner,staff}'))::text[]));
create policy bills_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'bills' and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner,staff}'))::text[]));

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.items enable row level security;
alter table public.suppliers enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_lines enable row level security;
alter table public.supplier_payments enable row level security;
alter table public.stock_moves enable row level security;
alter table public.dishes enable row level security;
alter table public.recipe_lines enable row level security;
alter table public.stock_takes enable row level security;
alter table public.stock_take_lines enable row level security;

-- Inventory is kitchen work: owner + staff. Supplier payments are money: owner only. Riders: nothing.
create policy items_select on public.items for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy suppliers_select on public.suppliers for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy purchases_select on public.purchases for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy purchase_lines_select on public.purchase_lines for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy supplier_payments_select on public.supplier_payments for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy stock_moves_select on public.stock_moves for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy dishes_select on public.dishes for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy recipe_lines_select on public.recipe_lines for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy stock_takes_select on public.stock_takes for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy stock_take_lines_select on public.stock_take_lines for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));

revoke all on public.items, public.suppliers, public.purchases, public.purchase_lines, public.supplier_payments,
  public.stock_moves, public.dishes, public.recipe_lines, public.stock_takes, public.stock_take_lines from anon, authenticated;
grant select on public.items, public.suppliers, public.purchases, public.purchase_lines, public.supplier_payments,
  public.stock_moves, public.dishes, public.recipe_lines, public.stock_takes, public.stock_take_lines to authenticated;

revoke execute on function public.create_item, public.update_item, public.upsert_supplier, public.record_purchase,
  public.pay_supplier, public.supplier_dues, public.stock_levels, public.record_waste, public.adjust_stock, public.upsert_dish,
  public.set_recipe_line, public.dish_costs, public.production_plan, public.start_stock_take, public.set_stock_count,
  public.stock_take_review, public.close_stock_take, public.cancel_stock_take, public.inventory_alerts, public.cost_report
  from public, anon;
grant execute on function public.create_item, public.update_item, public.upsert_supplier, public.record_purchase,
  public.pay_supplier, public.supplier_dues, public.stock_levels, public.record_waste, public.adjust_stock, public.upsert_dish,
  public.set_recipe_line, public.dish_costs, public.production_plan, public.start_stock_take, public.set_stock_count,
  public.stock_take_review, public.close_stock_take, public.cancel_stock_take, public.inventory_alerts, public.cost_report
  to authenticated;
