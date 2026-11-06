-- Merge of the held-back DB items (held/db-final-r2, migrations 20261115000100 – 0300, decision D-157)
-- into m9-p5-p6 (wave 1, login, screens, held-back apps, wave 4, wave 5, wave 2 + 20261130000100).
--
-- Migration timestamps decide which `create or replace` wins. held/db was written on wave2/db, before
-- wave 2's integration review fixes (20261108000900) and before wave 1. A scan of every function,
-- policy, trigger and view it defines against every other migration found:
--   * public.rider_today (wave 1, 20261107000500): held/db-final-r2 no longer re-creates it; its
--     20261115000300 only patches an older "pending/sent/sending" otp_sent test to "sent" and is a
--     no-op on wave 1's body, so wave 1's changed / changed_at / skipped-diet rules stay (pinned in
--     18_merge_held_db). Nothing to merge.
--   * public.import_customers: wave 2 (20261108000500, then 20261108000900) and held/db (20261115000200,
--     chunked batches, status, second plan, repeated rows). held/db started from wave2/db's body and so
--     dropped wave 2's review fix 6: a monthly row with an opening meal balance but no plan is refused
--     (balance_needs_plan), and no 0/0 opening-balance ledger row is written. Union below.
--   * public.wa_claim_outbox: wave 2 (20261108000800, then 20261108000900) and held/db (20261115000300,
--     claimed_at for the stuck-row sweep). held/db dropped wave 2's review fix 8: while customer_whatsapp
--     is off, rows queued before the gate are cancelled at claim time. Union below.
--   * private.compute_churn, private.queue_customer_reminders (wave 2 20261108000300 -> held/db): held/db
--     starts from wave 2's bodies; no other wave changed them. private.payer_templates, platform_metrics,
--     wa_complete_outbox, wa_message_status: base bodies only before held/db. Nothing to merge.

-- 1. Import: held/db's chunked import (20261115000200) + wave 2's balance_needs_plan / no 0-0 row.
create or replace function public.import_customers(
  p_kitchen uuid,
  p_rows jsonb,
  p_consent boolean,
  p_file_name text default null,
  p_batch uuid default null,
  p_first_row integer default 1,
  p_total integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch uuid := coalesce(p_batch, gen_random_uuid());
  v_batch_kitchen uuid;
  v_row jsonb;
  v_idx integer;
  v_done public.import_rows;
  v_errors text[];
  v_warnings text[];
  v_phone text;
  v_hash text;
  v_diet public.diet_type;
  v_diet_given boolean;
  v_lang public.language_code;
  v_plans uuid[];
  v_plan uuid;
  v_plan2 uuid;
  v_start date;
  v_status text;
  v_paused_from date;
  v_pause_from date;
  v_qty integer;
  v_customer uuid;
  v_existing uuid;
  v_merge boolean;
  v_address uuid;
  v_sub uuid;
  v_imported integer := 0;
  v_failed integer := 0;
  v_new integer := 0;
  v_merged integer := 0;
  v_already integer := 0;
  v_report jsonb := '[]'::jsonb;
  v_warn_report jsonb := '[]'::jsonb;
  v_raw jsonb;
  v_balance integer;
  v_billing public.billing_mode;
  v_mode public.billing_mode;
  v_default public.billing_mode;
  v_dues bigint;
  v_price integer;
  v_today date := private.ist_today();
  v_saved uuid[] := '{}';
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
  if p_first_row is null or p_first_row < 1 or p_first_row > 100000 or coalesce(p_total, 0) not between 0 and 100000 then
    raise exception 'invalid_batch' using errcode = '22023';
  end if;

  -- One chunk of a batch at a time (also orders the repeated-row merges across chunks).
  perform pg_advisory_xact_lock(hashtextextended('import_batch:' || v_batch, 0));
  select kitchen_id into v_batch_kitchen from public.import_batches where id = v_batch;
  if v_batch_kitchen is null then
    insert into public.import_batches (id, kitchen_id, file_name, total_rows, created_by)
    values (v_batch, p_kitchen, p_file_name, coalesce(p_total, jsonb_array_length(p_rows)), auth.uid());
  elsif v_batch_kitchen <> p_kitchen then
    raise exception 'invalid_batch' using errcode = '22023';
  end if;

  select default_billing_mode into v_default from public.kitchen_settings where kitchen_id = p_kitchen;

  for v_row, v_idx in select e, (p_first_row + i - 1)::integer from jsonb_array_elements(p_rows) with ordinality as t(e, i) loop
    -- Idempotent per row: a row this batch already saved is reported as it was, never redone.
    select * into v_done from public.import_rows where batch_id = v_batch and row_number = v_idx;
    if v_done.id is not null then
      v_already := v_already + 1;
      if v_done.status = 'imported' then
        v_imported := v_imported + 1;
        -- The first saved row for a customer in this batch created it; later ones were merges.
        if exists (select 1 from public.import_rows ir
                   where ir.batch_id = v_batch and ir.customer_id = v_done.customer_id
                     and ir.status = 'imported' and ir.row_number < v_idx) then
          v_merged := v_merged + 1;
        else
          v_new := v_new + 1;
        end if;
        if cardinality(v_done.warnings) > 0 then
          v_warn_report := v_warn_report || jsonb_build_object('row', v_idx, 'warnings', to_jsonb(v_done.warnings));
        end if;
      else
        v_failed := v_failed + 1;
        v_report := v_report || jsonb_build_object('row', v_idx, 'errors', to_jsonb(v_done.errors));
      end if;
      continue;
    end if;

    v_errors := '{}';
    v_warnings := '{}';
    v_customer := null;
    v_existing := null;
    v_merge := false;
    v_plan := null;
    v_plan2 := null;
    v_plans := '{}';
    v_start := null;
    v_paused_from := null;
    v_qty := 1;
    v_balance := 0;
    v_billing := null;
    v_dues := null;
    v_hash := null;
    v_phone := private.normalize_phone(v_row ->> 'phone');
    v_raw := (v_row - 'phone') || jsonb_build_object('phone_last4', right(v_phone, 4));

    if nullif(trim(v_row ->> 'name'), '') is null then
      v_errors := array_append(v_errors, 'name_required');
    end if;

    if v_phone is null then
      v_errors := array_append(v_errors, 'invalid_phone');
    else
      v_hash := private.phone_hash(v_phone);
      -- D-118: a shared phone is fine for a different name; the same phone and name is the same person.
      select c.id into v_existing from public.customers c
      where c.kitchen_id = p_kitchen and c.phone_hash = v_hash and c.deleted_at is null
        and private.same_name(c.name, v_row ->> 'name')
      order by c.created_at
      limit 1;
      if v_existing is not null then
        if exists (select 1 from public.import_rows ir
                   where ir.batch_id = v_batch and ir.customer_id = v_existing and ir.status = 'imported') then
          v_merge := true; -- saved earlier in this file: this row adds its plan(s)
        else
          v_errors := array_append(v_errors, 'already_exists');
        end if;
      end if;
    end if;

    v_diet_given := nullif(trim(v_row ->> 'diet'), '') is not null;
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
      else
        v_plans := v_plans || v_plan;
      end if;
    end if;
    if nullif(trim(v_row ->> 'plan_2'), '') is not null then
      select id into v_plan2 from public.plans
      where kitchen_id = p_kitchen and active and lower(name) = lower(trim(v_row ->> 'plan_2'));
      if v_plan2 is null then
        v_errors := array_append(v_errors, 'unknown_second_plan');
      elsif v_plan2 = any (v_plans) then
        v_errors := array_append(v_errors, 'same_plan_twice');
      else
        v_plans := v_plans || v_plan2;
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
    if v_start is not null and nullif(trim(v_row ->> 'plan'), '') is null and nullif(trim(v_row ->> 'plan_2'), '') is null then
      v_errors := array_append(v_errors, 'start_date_requires_plan');
    end if;

    if nullif(trim(v_row ->> 'qty'), '') is not null then
      if (v_row ->> 'qty') ~ '^\d{1,2}$' and (v_row ->> 'qty')::integer between 1 and 20 then
        v_qty := (v_row ->> 'qty')::integer;
      else
        v_errors := array_append(v_errors, 'invalid_qty');
      end if;
    end if;

    -- Status: active | paused (from a date) | stopped (saved without a subscription).
    v_status := private.parse_import_status(v_row ->> 'status');
    if v_status is null then
      v_errors := array_append(v_errors, 'invalid_status');
    end if;
    if nullif(trim(v_row ->> 'paused_from'), '') is not null then
      if (v_row ->> 'paused_from') !~ '^\d{4}-\d{2}-\d{2}$' then
        v_errors := array_append(v_errors, 'invalid_pause_date');
      else
        begin
          v_paused_from := (v_row ->> 'paused_from')::date;
        exception when others then
          v_errors := array_append(v_errors, 'invalid_pause_date');
        end;
      end if;
      if nullif(trim(v_row ->> 'status'), '') is null then
        v_status := 'paused';
      elsif v_status is distinct from 'paused' then
        v_errors := array_append(v_errors, 'paused_from_needs_paused');
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

    -- Wave 2 review fix (20261108000900 §6): a monthly customer's opening meals become rupees at the
    -- plan price; without a plan there is no price, and the meals would silently disappear.
    if v_mode = 'monthly' and v_balance <> 0 and cardinality(v_plans) = 0
       and not ('unknown_plan' = any (v_errors)) then
      v_errors := array_append(v_errors, 'balance_needs_plan');
    end if;

    if (nullif(v_row ->> 'lat', '') is null) <> (nullif(v_row ->> 'lng', '') is null)
       or (nullif(v_row ->> 'lat', '') is not null
           and not ((v_row ->> 'lat') ~ '^-?\d+(\.\d+)?$' and (v_row ->> 'lng') ~ '^-?\d+(\.\d+)?$')) then
      v_errors := array_append(v_errors, 'invalid_location');
    end if;

    -- A repeated row only adds plans to the customer saved earlier in this file.
    if v_merge then
      if cardinality(v_plans) = 0 or v_status = 'stopped' then
        v_errors := array_append(v_errors, 'duplicate_in_file');
      elsif nullif(trim(v_row ->> 'balance'), '') is not null or nullif(trim(v_row ->> 'dues'), '') is not null then
        v_errors := array_append(v_errors, 'balance_on_repeated_row');
      elsif exists (select 1 from public.subscriptions s
                    where s.customer_id = v_existing and s.plan_id = any (v_plans) and s.status <> 'cancelled') then
        v_errors := array_append(v_errors, 'same_plan_twice');
      end if;
    end if;

    if cardinality(v_errors) = 0 then
      -- Meals are cooked to the plan's diet: a blank diet takes it; a diet written on the row that
      -- differs from a plan's diet is only a warning (a repeated row never changes the customer's diet).
      if not v_merge and not v_diet_given and cardinality(v_plans) > 0 and v_status <> 'stopped' then
        select p.diet into v_diet from public.plans p where p.id = v_plans[1];
      end if;
      if v_diet_given and v_status <> 'stopped'
         and exists (select 1 from public.plans p where p.id = any (v_plans) and p.diet <> v_diet) then
        v_warnings := array_append(v_warnings, 'diet_differs_from_plan');
      end if;
      if v_status = 'stopped' and cardinality(v_plans) > 0 then
        v_warnings := array_append(v_warnings, 'stopped_plan_ignored');
      end if;

      begin
        if v_merge then
          v_customer := v_existing;
        else
          v_customer := private.insert_customer(
            p_kitchen, v_row ->> 'name', v_phone, v_diet, v_lang, v_row ->> 'notes',
            jsonb_build_object('line1', v_row ->> 'line1', 'area', v_row ->> 'area',
              'landmark', v_row ->> 'landmark', 'delivery_notes', v_row ->> 'delivery_notes',
              'lat', nullif(v_row ->> 'lat', ''), 'lng', nullif(v_row ->> 'lng', ''))
            , 'import', 'import', v_mode);
        end if;

        if v_status <> 'stopped' and cardinality(v_plans) > 0 then
          select id into v_address from public.addresses where customer_id = v_customer and is_default;
          foreach v_plan in array v_plans loop
            insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, qty, start_date, status)
            values (p_kitchen, v_customer, v_plan, v_address, v_qty, coalesce(v_start, v_today), 'active')
            returning id into v_sub;
            if v_status = 'paused' then
              -- Paused from the given date; a past (or blank) date means from today, never before the start.
              v_pause_from := greatest(coalesce(v_paused_from, v_today), v_today, coalesce(v_start, v_today));
              perform private.apply_change(v_sub, 'pause', v_pause_from, null, null, null, 'vendor', true,
                                           'Paused when imported', false, auth.uid());
            end if;
          end loop;
        end if;

        if not v_merge then
          v_price := coalesce((select price_per_meal_paise from public.plans where id = v_plans[1]), 0);
          if v_mode = 'monthly' then
            -- Rupee opening balance: dues (owed) and/or meals already paid for at the plan price.
            -- Wave 2 review fix (20261108000900 §6): never a 0/0 ledger row.
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
        end if;
      exception when others then
        v_customer := null;
        v_errors := array_append(v_errors, 'db_error:' || sqlstate);
      end;
    end if;

    if cardinality(v_errors) = 0 then
      v_imported := v_imported + 1;
      if v_merge then
        v_merged := v_merged + 1;
      else
        v_new := v_new + 1;
      end if;
      v_saved := v_saved || v_customer;
      insert into public.import_rows (batch_id, kitchen_id, row_number, raw, status, customer_id, warnings)
      values (v_batch, p_kitchen, v_idx, v_raw, 'imported', v_customer, v_warnings);
      if cardinality(v_warnings) > 0 then
        v_warn_report := v_warn_report || jsonb_build_object('row', v_idx, 'warnings', to_jsonb(v_warnings));
      end if;
    else
      v_failed := v_failed + 1;
      insert into public.import_rows (batch_id, kitchen_id, row_number, raw, status, errors)
      values (v_batch, p_kitchen, v_idx, v_raw, 'error', v_errors);
      v_report := v_report || jsonb_build_object('row', v_idx, 'errors', to_jsonb(v_errors));
    end if;
  end loop;

  -- Balance states now rather than at the next lock (a prepaid opening balance can start low).
  foreach v_customer in array v_saved loop
    perform private.sync_balance_status(p_kitchen, v_customer);
  end loop;

  update public.import_batches b
  set imported_rows = x.imported, error_rows = x.failed, total_rows = greatest(b.total_rows, x.imported + x.failed)
  from (select count(*) filter (where status = 'imported')::integer as imported,
               count(*) filter (where status = 'error')::integer as failed
        from public.import_rows where batch_id = v_batch) x
  where b.id = v_batch;

  return jsonb_build_object('batch_id', v_batch, 'total', v_imported + v_failed,
    'imported', v_imported, 'failed', v_failed, 'errors', v_report, 'warnings', v_warn_report,
    'customers', v_new, 'merged', v_merged, 'already_done', v_already);
end;
$$;

-- 2. Outbox claim: held/db's claimed_at (20261115000300) + wave 2's send-time customer_whatsapp gate.
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
  -- Wave 2 review fix (20261108000900 §8): customer messages switched off (Phase 1, or an admin's
  -- kill switch): rows queued before are not sent either.
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
    update public.notifications_outbox o set status = 'sending', attempts = o.attempts + 1, claimed_at = private.now()
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
