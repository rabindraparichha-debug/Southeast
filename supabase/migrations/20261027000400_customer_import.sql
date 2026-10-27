-- M1 / 1.3 Bulk customer import (Excel/CSV parsed in the browser, rows sent as JSON).
-- Each row is processed in its own savepoint: bad rows are reported with error
-- codes and never block good rows. The server re-validates everything; the
-- client-side preview (packages/core/src/import.ts) uses the same error codes.

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  file_name text,
  total_rows integer not null default 0,
  imported_rows integer not null default 0,
  error_rows integer not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index import_batches_kitchen_idx on public.import_batches (kitchen_id, created_at desc);

create table public.import_rows (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  row_number integer not null,
  -- The submitted row with the phone number removed (only its last 4 digits kept).
  raw jsonb not null,
  status text not null check (status in ('imported', 'error')),
  errors text[] not null default '{}',
  customer_id uuid,
  unique (batch_id, row_number)
);

create trigger import_batches_audit after insert or update or delete on public.import_batches
  for each row execute function private.audit_row();

alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;

create policy import_batches_select on public.import_batches for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy import_rows_select on public.import_rows for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

create or replace function private.parse_diet(p text)
returns public.diet_type
language sql
immutable
set search_path = ''
as $$
  select case regexp_replace(lower(coalesce(p, '')), '[^a-z]', '', 'g')
    when '' then 'veg'
    when 'veg' then 'veg'
    when 'vegetarian' then 'veg'
    when 'nonveg' then 'nonveg'
    when 'nonvegetarian' then 'nonveg'
    when 'nv' then 'nonveg'
    when 'jain' then 'jain'
  end::public.diet_type;
$$;

create or replace function private.parse_language(p text)
returns public.language_code
language sql
immutable
set search_path = ''
as $$
  select case lower(trim(coalesce(p, '')))
    when '' then 'en'
    when 'en' then 'en'
    when 'english' then 'en'
    when 'or' then 'or'
    when 'od' then 'or'
    when 'odia' then 'or'
    when 'oriya' then 'or'
    when 'hi' then 'hi'
    when 'hindi' then 'hi'
  end::public.language_code;
$$;

-- p_rows: JSON array of objects with keys
--   name, phone, diet, language, line1, area, landmark, delivery_notes, notes,
--   lat, lng, plan (plan name), start_date (YYYY-MM-DD), qty
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

revoke all on public.import_batches, public.import_rows from anon, authenticated;
grant select on public.import_batches, public.import_rows to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.kitchen_ids(public.member_role[]) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;

revoke execute on function public.import_customers from public, anon;
grant execute on function public.import_customers to authenticated;
