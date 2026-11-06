-- Wave 4 (onboarding), step 6: "Export my kitchen" and "Request to close my kitchen"
-- (audit Phase 1 step 7: a vendor who leaves can take their data; nothing is deleted).
--
--   * export_kitchen(kitchen, part, offset, limit): owner only, one page of one part at a time
--     (customers, subscriptions, payments, balance_entries, meal_orders of the last 12 months).
--     The web page turns the parts into CSV files inside one ZIP. Customer pages carry full phone
--     numbers, so each customers page read is logged (audit_log ACCESS, reason kitchen_export).
--   * kitchen_close_requests: the owner files a request; the platform team handles it by hand
--     (export, suspend, erase what the law allows) and records the outcome. No destructive delete.

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
  if p_part = 'customers' then
    select coalesce(jsonb_agg(x.j order by x.created_at, x.id), '[]'::jsonb), count(*) into v_rows, v_n from (
      select c.id, c.created_at, jsonb_build_object(
        'id', c.id, 'name', c.name,
        'phone', case when c.deleted_at is null and c.phone_enc is not null then private.decrypt_phone(c.phone_enc) end,
        'whatsapp_opt_in', c.whatsapp_opt_in, 'language', c.preferred_language, 'diet', c.diet, 'source', c.source,
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

-- ---------------------------------------------------------------------------
-- Close requests
-- ---------------------------------------------------------------------------
create table public.kitchen_close_requests (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  requested_by uuid not null references auth.users (id),
  reason text check (reason is null or length(reason) <= 1000),
  status text not null default 'open' check (status in ('open', 'withdrawn', 'closed', 'declined')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id),
  resolution_note text check (resolution_note is null or length(resolution_note) <= 1000)
);
create unique index kitchen_close_requests_open_idx on public.kitchen_close_requests (kitchen_id) where status = 'open';

create trigger kitchen_close_requests_audit after insert or update or delete on public.kitchen_close_requests
  for each row execute function private.audit_row();

alter table public.kitchen_close_requests enable row level security;
create policy kitchen_close_requests_select on public.kitchen_close_requests for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
revoke all on public.kitchen_close_requests from anon, authenticated;
grant select on public.kitchen_close_requests to authenticated;

create or replace function public.request_kitchen_close(p_kitchen uuid, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner}');
  if length(coalesce(p_reason, '')) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  select id into v_id from public.kitchen_close_requests where kitchen_id = p_kitchen and status = 'open';
  if v_id is not null then
    return v_id;   -- already filed: one open request per kitchen
  end if;
  insert into public.kitchen_close_requests (kitchen_id, requested_by, reason, created_at)
  values (p_kitchen, auth.uid(), nullif(trim(p_reason), ''), private.now())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.withdraw_kitchen_close(p_kitchen uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  update public.kitchen_close_requests set status = 'withdrawn', resolved_at = private.now(), resolved_by = auth.uid()
  where kitchen_id = p_kitchen and status = 'open';
end;
$$;

create or replace function public.admin_close_requests(p_status text default 'open')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'kitchen_id', r.kitchen_id, 'kitchen', k.name, 'kitchen_status', k.status,
                                        'reason', r.reason, 'status', r.status, 'created_at', r.created_at,
                                        'resolved_at', r.resolved_at, 'resolution_note', r.resolution_note,
                                        'requested_by_last4', right(u.phone, 4)) order by r.created_at desc)
    from public.kitchen_close_requests r join public.kitchens k on k.id = r.kitchen_id
    left join auth.users u on u.id = r.requested_by
    where p_status is null or r.status = p_status), '[]'::jsonb);
end;
$$;

create or replace function public.admin_resolve_close_request(p_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.kitchen_close_requests;
  v_note text;
begin
  perform private.require_admin();
  v_note := private.require_reason(p_note);
  if coalesce(p_status, '') not in ('closed', 'declined') then
    raise exception 'invalid_option' using errcode = '22023';
  end if;
  select * into v_r from public.kitchen_close_requests where id = p_id for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_r.status <> 'open' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  update public.kitchen_close_requests
  set status = p_status, resolved_at = private.now(), resolved_by = auth.uid(), resolution_note = v_note
  where id = p_id;
  perform private.log_admin_action(v_r.kitchen_id, 'close_request_' || p_status, p_id::text, v_note,
    jsonb_build_object('status', v_r.status, 'reason', v_r.reason), jsonb_build_object('status', p_status));
end;
$$;

revoke execute on function public.export_kitchen, public.request_kitchen_close, public.withdraw_kitchen_close,
  public.admin_close_requests, public.admin_resolve_close_request from public, anon;
grant execute on function public.export_kitchen, public.request_kitchen_close, public.withdraw_kitchen_close,
  public.admin_close_requests, public.admin_resolve_close_request to authenticated;
