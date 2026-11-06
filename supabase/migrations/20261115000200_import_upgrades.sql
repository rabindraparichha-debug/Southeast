-- Held-back vendor-first item (audit Phase 1 step 5, "First customers"): import upgrades.
--
--   * Chunks: the web wizard sends a file in chunks (one call each) so a register of hundreds of rows
--     never hits the statement timeout. Every chunk carries the same client-made batch id (p_batch) and
--     the file position of its first row (p_first_row), so row numbers are file-wide. The server is
--     idempotent per row: a row number already saved in this batch is not processed again; its first
--     outcome is reported (a retried chunk after a lost response creates nothing twice). Chunks of one
--     batch run one at a time (advisory lock). Old 4-argument calls still work (one chunk, new batch).
--   * Status column: active (default) | paused | stopped.
--       paused  → the subscription(s) are created and paused from 'paused_from' (blank or a past date:
--                 today, IST; never before the start date), open-ended, through private.apply_change.
--       stopped → the customer, address and opening balance or dues are saved, but no subscription
--                 (a stopped customer who still owes money can be collected from); plans are ignored.
--     A paused-from date with no status means paused.
--   * More than one plan: a 'plan_2' column (same start date, tiffins and status), and repeated rows
--     (the same phone AND name as a customer saved earlier in this batch, any chunk) add their plan(s)
--     to that customer instead of failing. A repeated row that adds nothing stays 'duplicate_in_file';
--     opening balance and dues belong on the first row only ('balance_on_repeated_row'); a plan the
--     customer already has from this file is 'same_plan_twice'.
--   * Diet: a blank diet takes the (first) plan's diet, since meals are cooked to the plan's diet. A diet
--     that differs from a plan's diet is saved as given and reported as a warning
--     ('diet_differs_from_plan'); the result has a 'warnings' list next to 'errors'.
--   * The default start date is the IST date (private.ist_today()), as before.
--   * Result: batch_id, total, imported (rows), failed, errors, warnings, customers (new customers),
--     merged (repeated rows that added a plan), already_done (rows skipped because this batch had them).
--     A row this batch already saved reports what it did the first time: a new customer (the first
--     saved row for that customer in the batch) or a merge, with its warnings (import_rows.warnings),
--     so a retried chunk gives the same totals and warnings as the lost response would have.
--   * Billing and opening-balance columns (wave 2) are unchanged.

-- Warnings a saved row had (diet_differs_from_plan, stopped_plan_ignored), reported again on a retry.
alter table public.import_rows add column warnings text[] not null default '{}';

create or replace function private.parse_import_status(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case regexp_replace(lower(coalesce(p, '')), '[^a-z]', '', 'g')
    when '' then 'active'
    when 'active' then 'active'
    when 'running' then 'active'
    when 'on' then 'active'
    when 'yes' then 'active'
    when 'chalu' then 'active'
    when 'paused' then 'paused'
    when 'pause' then 'paused'
    when 'hold' then 'paused'
    when 'onhold' then 'paused'
    when 'break' then 'paused'
    when 'stopped' then 'stopped'
    when 'stop' then 'stopped'
    when 'left' then 'stopped'
    when 'inactive' then 'stopped'
    when 'closed' then 'stopped'
    when 'cancelled' then 'stopped'
    when 'canceled' then 'stopped'
    when 'discontinued' then 'stopped'
    when 'off' then 'stopped'
    when 'no' then 'stopped'
    when 'band' then 'stopped'
  end;
$$;

drop function public.import_customers(uuid, jsonb, boolean, text);
create function public.import_customers(
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

revoke execute on function private.parse_import_status(text) from public, anon, authenticated;
revoke execute on function public.import_customers(uuid, jsonb, boolean, text, uuid, integer, integer) from public, anon;
grant execute on function public.import_customers(uuid, jsonb, boolean, text, uuid, integer, integer) to authenticated;
