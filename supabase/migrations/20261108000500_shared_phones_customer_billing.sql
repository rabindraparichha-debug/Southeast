-- Vendor-first wave 2, D-118 (customers may share a phone) + item 20 customer entry points.
--
--   * The unique (kitchen, phone) index becomes a plain index: siblings or a family phone can be
--     several customers of one kitchen.
--   * Duplicate rule (create, update, import): the same phone AND the same name (case and spaces
--     ignored) is the same person → 'already_exists' / 'duplicate_in_file'. The same phone with a
--     different name needs p_allow_shared_phone (create) or "allow_shared_phone": true (update)
--     → otherwise 'phone_in_use'. Import accepts a shared phone when the names differ.
--   * Every lookup by phone hash was checked so none can raise too_many_rows / unique_violation:
--       search_customers   returns all matches (roles migration)
--       wa_receive         routes by kitchen; the conversation links to the oldest customer on
--                          that phone in the kitchen (deterministic; D-156)
--       wa_select_kitchen  same deterministic pick
--       portal_get         a sibling's page shares the phone's conversation but shows its own data
--       convert_lead       unchanged (EXISTS: a phone already in the kitchen → already_customer)
--       wa_claim_outbox    joins the conversation by (kitchen, phone) → at most one (outbox migration)
--       rider_call_number, set_payer, invites: by id, not phone.
--   * create_customer / import take a billing mode (null = kitchen default) and opening balances:
--     prepaid in meals ('balance'), monthly in rupees ('dues', + owed / − advance).

drop index public.customers_kitchen_phone_idx;
create index customers_kitchen_phone_idx on public.customers (kitchen_id, phone_hash) where deleted_at is null;

-- Name comparison for the duplicate rule.
create or replace function private.same_name(a text, b text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(trim(coalesce(a, '')), '\s+', ' ', 'g')) = lower(regexp_replace(trim(coalesce(b, '')), '\s+', ' ', 'g'));
$$;

drop function private.insert_customer(uuid, text, text, public.diet_type, public.language_code, text, jsonb,
  public.customer_source, text);
create function private.insert_customer(
  p_kitchen uuid,
  p_name text,
  p_phone_e164 text,
  p_diet public.diet_type,
  p_language public.language_code,
  p_notes text,
  p_address jsonb,
  p_source public.customer_source,
  p_channel text,
  p_billing_mode public.billing_mode default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- billing_mode null → the kitchen default (resolved here too, so bulk loads with triggers off work).
  insert into public.customers (kitchen_id, name, phone_enc, phone_hash, phone_last4, source,
    preferred_language, diet, notes, consent_at, consent_basis, created_by, billing_mode)
  values (p_kitchen, trim(p_name), private.encrypt_phone(p_phone_e164), private.phone_hash(p_phone_e164),
    right(p_phone_e164, 4), p_source, coalesce(p_language, 'en'), coalesce(p_diet, 'veg'),
    nullif(trim(p_notes), ''), private.now(), 'vendor_attested', auth.uid(),
    coalesce(p_billing_mode, (select ks.default_billing_mode from public.kitchen_settings ks where ks.kitchen_id = p_kitchen),
             'monthly'::public.billing_mode))
  returning id into v_id;

  if p_address is not null and p_address <> '{}'::jsonb then
    insert into public.addresses (kitchen_id, customer_id, line1, area, landmark, delivery_notes, lat, lng)
    values (p_kitchen, v_id, nullif(trim(p_address ->> 'line1'), ''), nullif(trim(p_address ->> 'area'), ''),
      nullif(trim(p_address ->> 'landmark'), ''), nullif(trim(p_address ->> 'delivery_notes'), ''),
      (p_address ->> 'lat')::double precision, (p_address ->> 'lng')::double precision);
  end if;

  insert into public.consents (kitchen_id, customer_id, purpose, basis, channel, recorded_by)
  values (p_kitchen, v_id, 'service_contact', 'vendor_attested', p_channel, auth.uid());

  return v_id;
end;
$$;

-- Owner or manager adds a customer. p_billing_mode null = the kitchen default. p_allow_shared_phone:
-- the vendor confirmed this is another person on a phone that already belongs to a customer.
drop function public.create_customer(uuid, text, text, boolean, public.diet_type, public.language_code, text, jsonb);
create function public.create_customer(
  p_kitchen uuid,
  p_name text,
  p_phone text,
  p_consent boolean,
  p_diet public.diet_type default 'veg',
  p_language public.language_code default 'en',
  p_notes text default null,
  p_address jsonb default null,
  p_billing_mode public.billing_mode default null,
  p_allow_shared_phone boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
begin
  perform private.require_role(p_kitchen, '{owner}');
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if exists (select 1 from public.customers
             where kitchen_id = p_kitchen and phone_hash = private.phone_hash(v_phone) and deleted_at is null
               and private.same_name(name, p_name)) then
    raise exception 'already_exists' using errcode = '23505';
  end if;
  if not coalesce(p_allow_shared_phone, false)
     and exists (select 1 from public.customers
                 where kitchen_id = p_kitchen and phone_hash = private.phone_hash(v_phone) and deleted_at is null) then
    raise exception 'phone_in_use' using errcode = '23505';
  end if;
  return private.insert_customer(p_kitchen, p_name, v_phone, p_diet, p_language, p_notes, p_address,
    'vendor', 'vendor', p_billing_mode);
end;
$$;

create or replace function public.update_customer(p_customer uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_phone text;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');

  if p_patch ? 'phone' then
    v_phone := private.normalize_phone(p_patch ->> 'phone');
    if v_phone is null then
      raise exception 'invalid_phone' using errcode = '22023';
    end if;
    -- D-118: another customer may share the number once the vendor confirms it.
    if exists (select 1 from public.customers
               where kitchen_id = v_c.kitchen_id and phone_hash = private.phone_hash(v_phone)
                 and deleted_at is null and id <> v_c.id
                 and private.same_name(name, coalesce(p_patch ->> 'name', v_c.name))) then
      raise exception 'already_exists' using errcode = '23505';
    end if;
    if not coalesce((p_patch ->> 'allow_shared_phone')::boolean, false)
       and exists (select 1 from public.customers
                   where kitchen_id = v_c.kitchen_id and phone_hash = private.phone_hash(v_phone)
                     and deleted_at is null and id <> v_c.id) then
      raise exception 'phone_in_use' using errcode = '23505';
    end if;
  end if;
  if p_patch ? 'name' and nullif(trim(p_patch ->> 'name'), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;

  update public.customers set
    name = case when p_patch ? 'name' then trim(p_patch ->> 'name') else name end,
    phone_enc = case when v_phone is not null then private.encrypt_phone(v_phone) else phone_enc end,
    phone_hash = case when v_phone is not null then private.phone_hash(v_phone) else phone_hash end,
    phone_last4 = case when v_phone is not null then right(v_phone, 4) else phone_last4 end,
    diet = case when p_patch ? 'diet' then (p_patch ->> 'diet')::public.diet_type else diet end,
    preferred_language = case when p_patch ? 'preferred_language'
      then (p_patch ->> 'preferred_language')::public.language_code else preferred_language end,
    notes = case when p_patch ? 'notes' then nullif(trim(p_patch ->> 'notes'), '') else notes end
  where id = p_customer;
end;
$$;

-- Import with billing mode and opening balances. Extra keys (both optional):
--   billing: monthly | prepaid (also: pay later, postpaid, khata, advance); blank = kitchen default
--   dues:    rupees owed at import (monthly customers; negative = advance paid)
--   balance: meals already paid for (prepaid; for a monthly customer it becomes rupees at the plan price)
-- A shared phone with a different name is imported (D-118); the same phone and name is a duplicate.
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
          if coalesce(v_dues, 0) <> 0 or v_balance <> 0 then
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

drop function private.conversation_context(uuid);
create function private.conversation_context(p_conversation uuid, p_customer uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
  v_k public.kitchens;
  v_cust public.customers;
  v_ks public.kitchen_settings;
  v_today date := private.ist_today();
  v_now timestamptz := private.now();
  v_value record;
  v_customer uuid;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- D-118: a customer sharing the phone's conversation (customer page) sees their own data.
  v_customer := coalesce(p_customer, v_c.customer_id);
  if p_customer is not null and not exists (select 1 from public.customers
                                            where id = p_customer and kitchen_id = v_c.kitchen_id
                                              and phone_hash = v_c.wa_phone_hash) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_c.kitchen_id is null or v_customer is null then
    return jsonb_build_object('conversation_id', v_c.id, 'matched', false, 'language', v_c.language, 'state', v_c.state);
  end if;
  select * into v_k from public.kitchens where id = v_c.kitchen_id;
  select * into v_cust from public.customers where id = v_customer;
  select * into v_ks from public.kitchen_settings where kitchen_id = v_c.kitchen_id;
  select * into v_value from private.unused_value(v_customer, null);

  return jsonb_build_object(
    'conversation_id', v_c.id,
    'matched', true,
    'language', v_c.language,
    'state', v_c.state,
    'handoff_open', v_c.handoff_open,
    'opted_in', v_cust.whatsapp_opt_in,
    'today', v_today,
    'customer', jsonb_build_object('id', v_cust.id, 'name', v_cust.name, 'diet', v_cust.diet),
    'kitchen', jsonb_build_object('id', v_k.id, 'name', v_k.name, 'slug', v_k.slug, 'fssai_no', v_k.fssai_no,
      'cutoff_lunch', v_k.cutoff_lunch, 'cutoff_lunch_prev_day', v_k.cutoff_lunch_prev_day,
      'cutoff_dinner', v_k.cutoff_dinner, 'cutoff_dinner_prev_day', v_k.cutoff_dinner_prev_day,
      'weekly_off', v_k.weekly_off, 'notice_days', v_ks.notice_days,
      'online_payments', exists (select 1 from public.kitchen_payout_accounts pa
                                 where pa.kitchen_id = v_k.id and pa.kyc_status = 'verified' and pa.razorpay_linked_account_id is not null)),
    'balance', jsonb_build_object(
      'meals', coalesce((select sum(meals) from public.balance_entries where customer_id = v_cust.id), 0),
      'value_paise', v_value.amount_paise,
      'low_threshold', v_ks.low_balance_meals,
      'billing_mode', v_cust.billing_mode,
      'balance_paise', private.rupee_balance(v_cust.id)),
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'plan', p.name,
        'slots', p.slots, 'price_paise', p.price_per_meal_paise, 'qty', s.qty, 'end_date', s.end_date) order by s.created_at)
      from public.subscriptions s join public.plans p on p.id = s.plan_id
      where s.customer_id = v_cust.id and s.status <> 'cancelled'), '[]'::jsonb),
    'meals', coalesce((select jsonb_agg(jsonb_build_object('subscription_id', o.subscription_id, 'date', o.service_date,
        'slot', o.slot, 'qty', o.qty, 'status', o.status, 'charged', o.charged, 'skip_reason', o.skip_reason,
        'locked', o.locked_at is not null,
        'open', o.locked_at is null and v_now < private.cutoff_at(v_k, o.service_date, o.slot),
        'cutoff_at', private.cutoff_at(v_k, o.service_date, o.slot)) order by o.service_date, o.slot)
      from public.meal_orders o where o.customer_id = v_cust.id and o.service_date between v_today and v_today + 7), '[]'::jsonb),
    'menus', coalesce((select jsonb_agg(jsonb_build_object('date', m.service_date, 'slot', m.slot, 'dishes', m.dishes)
        order by m.service_date, m.slot)
      from public.menus m where m.kitchen_id = v_k.id and m.published and m.service_date between v_today and v_today + 6), '[]'::jsonb),
    'open_complaint', (select id from public.complaints where customer_id = v_cust.id and status in ('open', 'escalated')
                       order by created_at desc limit 1)
  );
end;
$$;

create or replace function public.portal_get(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers;
  v_conv uuid;
  v_ctx jsonb;
begin
  v_cust := private.portal_customer(p_token);
  update public.customer_magic_links set last_used_at = private.now()
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  select id into v_conv from public.conversations where customer_id = v_cust.id and kitchen_id = v_cust.kitchen_id
  order by created_at limit 1;
  if v_conv is null then
    -- D-118: the phone's conversation may belong to another customer sharing it.
    select id into v_conv from public.conversations where kitchen_id = v_cust.kitchen_id and wa_phone_hash = v_cust.phone_hash;
  end if;
  if v_conv is null then
    insert into public.conversations (kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4, language)
    values (v_cust.kitchen_id, v_cust.id, v_cust.phone_hash, v_cust.phone_enc, v_cust.phone_last4, v_cust.preferred_language)
    on conflict (kitchen_id, wa_phone_hash) where kitchen_id is not null do nothing
    returning id into v_conv;
    if v_conv is null then
      select id into v_conv from public.conversations where kitchen_id = v_cust.kitchen_id and wa_phone_hash = v_cust.phone_hash;
    end if;
  end if;
  v_ctx := private.conversation_context(v_conv, v_cust.id);
  return v_ctx - 'state' - 'conversation_id' || jsonb_build_object(
    'phone_masked', private.mask_phone(v_cust.phone_last4),
    'addresses', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'label', a.label, 'line1', a.line1, 'area', a.area,
        'landmark', a.landmark, 'is_default', a.is_default) order by a.is_default desc, a.created_at)
      from public.addresses a where a.customer_id = v_cust.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('date', coalesce(p.paid_at, p.created_at), 'amount_paise', p.amount_paise,
        'meals', p.meals, 'method', p.method, 'status', p.status, 'short_url', case when p.status = 'created' then p.short_url end)
        order by p.created_at desc)
      from (select * from public.payments where customer_id = v_cust.id order by created_at desc limit 10) p), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('date', r.created_at, 'meals', r.meals, 'amount_paise', r.amount_paise,
        'status', r.status, 'method', r.method) order by r.created_at desc)
      from public.refunds r where r.customer_id = v_cust.id), '[]'::jsonb),
    'complaints', coalesce((select jsonb_agg(jsonb_build_object('date', c.created_at, 'category', c.category, 'status', c.status,
        'resolution_note', c.resolution_note) order by c.created_at desc)
      from public.complaints c where c.customer_id = v_cust.id), '[]'::jsonb))
    || private.portal_extras(v_cust);
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
    do update set contact_name = coalesce(excluded.contact_name, public.conversations.contact_name)
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

  return jsonb_build_object('duplicate', false, 'status', v_status, 'conversation_id', v_conv,
    'kitchens', case when v_status = 'choose_kitchen' then v_matches else '[]'::jsonb end);
end;
$$;

create or replace function public.wa_select_kitchen(p_conversation uuid, p_kitchen uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
  v_customer uuid;
  v_conv uuid;
begin
  select * into v_c from public.conversations where id = p_conversation;
  -- D-118: the oldest customer on this phone in the kitchen (deterministic).
  select id into v_customer from public.customers
  where kitchen_id = p_kitchen and phone_hash = v_c.wa_phone_hash and deleted_at is null
  order by created_at, id limit 1;
  if v_customer is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.conversations (kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4, contact_name, language)
  values (p_kitchen, v_customer, v_c.wa_phone_hash, v_c.phone_enc, v_c.phone_last4, v_c.contact_name,
          (select preferred_language from public.customers where id = v_customer))
  on conflict (kitchen_id, wa_phone_hash) where kitchen_id is not null do nothing;
  select id into v_conv from public.conversations where kitchen_id = p_kitchen and wa_phone_hash = v_c.wa_phone_hash;
  update public.conversations set last_inbound_at = private.now(), last_message_at = private.now() where id = v_conv;
  return v_conv;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (fail closed)
-- ---------------------------------------------------------------------------
revoke execute on function private.same_name(text, text),
  private.insert_customer(uuid, text, text, public.diet_type, public.language_code, text, jsonb, public.customer_source, text, public.billing_mode),
  private.conversation_context(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.create_customer(uuid, text, text, boolean, public.diet_type, public.language_code, text, jsonb,
  public.billing_mode, boolean) from public, anon;
grant execute on function public.create_customer(uuid, text, text, boolean, public.diet_type, public.language_code, text, jsonb,
  public.billing_mode, boolean) to authenticated;
