-- Merge of vendor-first wave 2 (wave2/integrated, migrations 20261108000100 – 0900, decision D-156)
-- into m9-p5-p6 (wave 1, login, screens, held-back apps 20261116*, wave 4 20261113*).
--
-- Migration timestamps decide which `create or replace` wins. A scan of every function, policy,
-- trigger, column default, cron job and view that wave 2 defines against every other migration found:
--   * private.nightly: wave 1 (20261107000500) and wave 2 (20261108000300). Already reconciled on
--     wave2/integrated by 20261108000900_wave2_review_fixes.sql (wave 1's per-step error isolation +
--     prepaid-only auto-cancel, D-115). No later migration redefines it, so that body stays final.
--   * public.commission_statement: base (20261107000100) and wave 2 (exact owner, '{owner}', true). Wave 2's
--     body is the base body plus the exact-owner check: nothing to merge.
--   * policy platform_commission_reversals_select: same, exact owner from wave 2.
-- No migration after wave 2 redefines a wave 2 object, and wave 2 redefines no wave 4 or held-back apps
-- object. Wave 2's rider_request_change type check (§D) and the production sheet copied to managers (§E,
-- trigger notifications_outbox_copy_to_managers) are already in 20261108000900.
--
-- What this migration adds: places where a later wave, written without wave 2's roles or columns, needs
-- them (both behaviours kept):
--   1. plan_prices_select (wave 4, 20261113000400): accountants read plans and money (D-156), so they
--      read dated prices too ('{owner,accountant}'; owner includes managers).
--   2. public.export_kitchen (wave 4, last body 20261113000700): the customers part also exports wave 2's
--      billing_mode (payments and balance entries already export every column, voids included).
--      Still exact owner (D-142): managers and accountants never export.
--   3. public.report_sync_reject (held-back apps, last body 20261116000200): when the phone names no
--      kitchen, a manager's membership counts like an owner's (managers deliver too, D-156); the
--      require_role('{owner,rider}') check below already expands to managers. Wave 2's queued rider change
--      requests (queue kind 'request') that the server refuses are reported too (action 'request'), so the
--      owner sees them like any other refused rider action.

-- 1. Dated plan prices: readable by accountants (wave 4 + wave 2).
drop policy plan_prices_select on public.plan_prices;
create policy plan_prices_select on public.plan_prices for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,accountant}'))::uuid[]) or (select private.is_platform_admin()));

-- 2. Export my kitchen: wave 4's body (20261113000700) + wave 2's customers.billing_mode.
create or replace function public.export_kitchen(p_kitchen uuid, p_part text, p_offset integer default 0,
                                                 p_limit integer default 2000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 5000);
  v_from date := (private.ist_today() - interval '12 months')::date;
  v_rows jsonb;
  v_n integer;
begin
  perform private.require_role(p_kitchen, '{owner}');
  perform private.require_owner(p_kitchen);
  if p_part = 'customers' then
    select coalesce(jsonb_agg(x.j order by x.created_at, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select c.id, c.created_at, jsonb_build_object(
        'id', c.id, 'name', c.name,
        'phone', case when c.deleted_at is null and c.phone_enc is not null then private.decrypt_phone(c.phone_enc) end,
        'whatsapp_opt_in', c.whatsapp_opt_in, 'billing_mode', c.billing_mode, 'language', c.preferred_language, 'diet', c.diet, 'source', c.source,
        'notes', c.notes, 'address', a.line1, 'area', a.area, 'landmark', a.landmark, 'delivery_notes', a.delivery_notes,
        'lat', a.lat, 'lng', a.lng, 'consent_at', c.consent_at, 'created_at', c.created_at, 'erased_at', c.deleted_at) as j
      from public.customers c
      left join lateral (select ad.* from public.addresses ad where ad.customer_id = c.id
                         order by ad.is_default desc, ad.created_at desc limit 1) a on true
      where c.kitchen_id = p_kitchen
      order by c.created_at, c.id offset v_offset limit v_limit) x;
    perform private.audit_access(p_kitchen, 'customers', 'export',
      jsonb_build_object('reason', 'kitchen_export', 'offset', v_offset, 'rows', v_n));
  elsif p_part = 'subscriptions' then
    select coalesce(jsonb_agg(x.j order by x.created_at, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select s.id, s.created_at, to_jsonb(s) || jsonb_build_object('customer_name', c.name, 'plan_name', p.name) as j
      from public.subscriptions s join public.customers c on c.id = s.customer_id join public.plans p on p.id = s.plan_id
      where s.kitchen_id = p_kitchen
      order by s.created_at, s.id offset v_offset limit v_limit) x;
  elsif p_part = 'payments' then
    select coalesce(jsonb_agg(x.j order by x.created_at, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select py.id, py.created_at, to_jsonb(py) || jsonb_build_object('customer_name', c.name) as j
      from public.payments py join public.customers c on c.id = py.customer_id
      where py.kitchen_id = p_kitchen
      order by py.created_at, py.id offset v_offset limit v_limit) x;
  elsif p_part = 'balance_entries' then
    select coalesce(jsonb_agg(x.j order by x.created_at, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select b.id, b.created_at, to_jsonb(b) || jsonb_build_object('customer_name', c.name) as j
      from public.balance_entries b join public.customers c on c.id = b.customer_id
      where b.kitchen_id = p_kitchen
      order by b.created_at, b.id offset v_offset limit v_limit) x;
  elsif p_part = 'meal_orders' then
    select coalesce(jsonb_agg(x.j order by x.service_date, x.slot, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select o.id, o.service_date, o.slot, jsonb_build_object(
        'id', o.id, 'service_date', o.service_date, 'slot', o.slot, 'customer_id', o.customer_id, 'customer_name', c.name,
        'subscription_id', o.subscription_id, 'plan_name', p.name, 'qty', o.qty, 'diet', o.diet, 'status', o.status,
        'skip_reason', o.skip_reason, 'charged', o.charged, 'charge_waived', o.charge_waived,
        'price_per_meal_paise', o.price_per_meal_paise,
        'amount_paise', case when o.locked_at is not null and (o.status <> 'skipped' or o.charged)
                             then o.qty * coalesce(o.price_per_meal_paise, 0) end,
        'locked_at', o.locked_at) as j
      from public.meal_orders o join public.customers c on c.id = o.customer_id join public.plans p on p.id = o.plan_id
      where o.kitchen_id = p_kitchen and o.service_date >= v_from
      order by o.service_date, o.slot, o.id offset v_offset limit v_limit) x;
  else
    raise exception 'invalid_part' using errcode = '22023';
  end if;
  return jsonb_build_object('part', p_part, 'rows', v_rows,
                            'next_offset', case when v_n = v_limit then v_offset + v_limit end);
end;
$$;


-- 3. Refused rider action reports: held-back apps body (20261116000200) + managers who deliver and queued
--    change requests (wave 2).
alter table public.rider_sync_rejects drop constraint rider_sync_rejects_action_check;
alter table public.rider_sync_rejects add constraint rider_sync_rejects_action_check
  check (action in ('start', 'complete', 'fail', 'finish', 'request'));
create or replace function public.report_sync_reject(
  p_client_op uuid,
  p_kind text,
  p_error text,
  p_kitchen uuid default null,
  p_run uuid default null,
  p_stop uuid default null,
  p_summary jsonb default '{}',
  p_cash_paise integer default 0,
  p_had_photo boolean default false,
  p_acted_at timestamptz default null,
  p_refused_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_kitchen uuid;
  v_run public.delivery_runs;
  v_stop public.delivery_stops;
  v_refused timestamptz := coalesce(p_refused_at, private.now());
  v_old public.rider_sync_rejects;
  v_synced boolean;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_stop is not null then
    select * into v_stop from public.delivery_stops where id = p_stop;
  end if;
  -- The run the rider acted on (p_run); only when the phone did not name one, the stop's current run.
  if coalesce(p_run, v_stop.run_id) is not null then
    select * into v_run from public.delivery_runs where id = coalesce(p_run, v_stop.run_id);
  end if;
  v_kitchen := coalesce(v_run.kitchen_id, v_stop.kitchen_id, p_kitchen);
  if v_kitchen is null then
    select min(m.kitchen_id::text)::uuid into v_kitchen from public.members m
    where m.user_id = v_uid and m.role in ('rider', 'owner', 'manager')
    having count(*) = 1;
  end if;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner,rider}');
  -- Everything named must belong to that kitchen. The stop may sit on another run of it now (moved by
  -- the owner after the rider acted): that is the refusal being reported, so it is accepted.
  if (p_kitchen is not null and p_kitchen <> v_kitchen)
     or (v_stop.id is not null and v_stop.kitchen_id <> v_kitchen)
     or (v_run.id is not null and v_run.kitchen_id <> v_kitchen) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_client_op is null or p_kind is null or p_kind not in ('start', 'complete', 'fail', 'finish', 'request') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if coalesce(p_cash_paise, 0) not between 0 and 10000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  -- The same action already went through (the rider tried again and it synced before this report).
  v_synced := exists (select 1 from public.delivery_stops ds
                      where ds.client_op_id = p_client_op and ds.kitchen_id = v_kitchen);

  select * into v_old from public.rider_sync_rejects where rider_id = v_uid and client_op = p_client_op for update;
  if v_old.id is not null then
    if v_old.kitchen_id <> v_kitchen then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if v_refused <= v_old.refused_at or v_synced then
      return v_old.id;   -- the same report again (a retried request), or one the later sync overtook
    end if;
    update public.rider_sync_rejects
    set error_code = coalesce(private.strip_numbers(p_error, 120), 'unknown'),
        summary = private.sync_reject_summary(p_summary), cash_paise = coalesce(p_cash_paise, 0),
        had_photo = coalesce(p_had_photo, false), refused_at = v_refused, reported_at = private.now(),
        reports = reports + 1, resolved_at = null, resolved_by = null, resolution_note = null,
        run_id = coalesce(v_run.id, run_id), stop_id = coalesce(v_stop.id, stop_id),
        customer_id = coalesce(v_stop.customer_id, customer_id)
    where id = v_old.id;
    return v_old.id;
  end if;

  if not v_synced and (select count(*) from public.rider_sync_rejects
      where kitchen_id = v_kitchen and rider_id = v_uid and resolved_at is null) >= 500 then
    raise exception 'too_many_requests' using errcode = '22023';
  end if;
  insert into public.rider_sync_rejects (kitchen_id, rider_id, run_id, stop_id, customer_id, client_op, action, error_code,
                                         summary, cash_paise, had_photo, acted_at, refused_at, reported_at,
                                         resolved_at, resolution_note)
  values (v_kitchen, v_uid, v_run.id, v_stop.id, v_stop.customer_id, p_client_op, p_kind,
          coalesce(private.strip_numbers(p_error, 120), 'unknown'),
          private.sync_reject_summary(p_summary), coalesce(p_cash_paise, 0), coalesce(p_had_photo, false),
          coalesce(p_acted_at, v_refused), v_refused, private.now(),
          case when v_synced then private.now() end, case when v_synced then 'Synced later from the phone' end)
  returning id into v_id;
  return v_id;
end;
$$;


revoke execute on function public.export_kitchen(uuid, text, integer, integer) from public, anon;
grant execute on function public.export_kitchen(uuid, text, integer, integer) to authenticated;
revoke execute on function public.report_sync_reject(uuid, text, text, uuid, uuid, uuid, jsonb, integer, boolean, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.report_sync_reject(uuid, text, text, uuid, uuid, uuid, jsonb, integer, boolean, timestamptz, timestamptz)
  to authenticated;
