-- Vendor-first wave 3 (riders track), audit item 29: owner notifications without WhatsApp.
--
-- * member_devices: Expo push tokens of signed-in members (own rows only; written through RPCs).
-- * Every member alert the engine already queues for WhatsApp (production sheet at lock, 22:00
--   summary, stock, late delivery, weather, inbox, new platform customer, switch-out) gets a 'push'
--   twin when the member has a registered device: an AFTER INSERT trigger, so lock_slot,
--   notify_owners and the other writers stay untouched (and managers get pushes once wave 2 sends
--   them the alerts).
-- * Alerts that exist only in the app (first: a rider's kitchen-fault credit waiting for approval)
--   are 'push' rows from private.notify_owners_push; they are never sent on WhatsApp.
-- * private.member_alert_text renders title/body/path for push and for the in-app list
--   (my_notifications), so both read the same words.
-- * The push-outbox Edge Function drains channel 'push' through the Expo Push API
--   (push_claim_outbox / push_complete_outbox, service role); pg_cron 'tiffin-push' kicks it.

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------
create table public.member_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null unique check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$'),
  platform text not null check (platform in ('android', 'ios', 'web')),
  app_version text check (length(app_version) <= 40),
  device_name text check (length(device_name) <= 80),
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index member_devices_user_idx on public.member_devices (user_id) where active;
create trigger member_devices_updated_at before update on public.member_devices
  for each row execute function private.set_updated_at();
-- Not audited: a device row holds no money, count, membership or customer data, and last_seen_at
-- changes on every app start (it would only grow audit_log).

-- In-app list: a member's own alerts, newest first.
create index notifications_outbox_member_idx on public.notifications_outbox (recipient_id, created_at desc)
  where recipient_type = 'member';
create index notifications_outbox_push_pending_idx on public.notifications_outbox (send_after)
  where channel = 'push' and status in ('pending', 'sending');

-- ---------------------------------------------------------------------------
-- Texts (English; Odia/Hindi come with audit item 35)
-- ---------------------------------------------------------------------------
create or replace function private.fmt_day(p_date text)
returns text
language sql
stable
set search_path = ''
as $$
  select case when p_date ~ '^\d{4}-\d{2}-\d{2}$' then to_char(p_date::date, 'Dy FMDD Mon') else coalesce(p_date, '') end;
$$;

create or replace function private.fmt_rupees(p_paise numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select '₹' || case when coalesce(p_paise, 0) % 100 = 0 then (coalesce(p_paise, 0) / 100)::bigint::text
                     else to_char(p_paise / 100.0, 'FM999999990.00') end;
$$;

create or replace function private.fmt_qty(p_qty text, p_unit text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(coalesce(trim(trailing '.' from trim(trailing '0' from
           case when p_qty ~ '^-?\d+(\.\d+)?$' then round(p_qty::numeric, 3)::text else p_qty end)), '0')
         || ' ' || coalesce(p_unit, ''));
$$;

-- {title, body, path} for a member alert. path is the app screen a tap opens.
create or replace function private.member_alert_text(p_template text, p_payload jsonb, p_kitchen_name text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  k text := coalesce(nullif(p_kitchen_name, ''), 'Your kitchen');
  v_slot text := initcap(coalesce(p ->> 'slot', ''));
begin
  return case p_template
    when 'production_sheet' then jsonb_build_object(
      'title', format('Final count: %s %s', v_slot, private.fmt_day(p ->> 'service_date')),
      'body', format('%s meals (veg %s, non-veg %s, Jain %s). Packing list is in the app.',
        coalesce(p #>> '{totals,total_meals}', '0'), coalesce(p #>> '{totals,by_diet,veg}', '0'),
        coalesce(p #>> '{totals,by_diet,nonveg}', '0'), coalesce(p #>> '{totals,by_diet,jain}', '0')),
      'path', '/')
    when 'owner_daily_summary' then jsonb_build_object(
      'title', format('%s: lunch %s, dinner %s', private.fmt_day(p ->> 'service_date'),
        coalesce(p #>> '{lunch,total_meals}', '0'), coalesce(p #>> '{dinner,total_meals}', '0')),
      'body', format('Counts are a preview until the cutoff. Collected today: %s. Low stock: %s.',
        case when p ? 'collections_paise' then private.fmt_rupees((p ->> 'collections_paise')::numeric) else 'see app' end,
        coalesce(nullif((select string_agg(x, ', ') from jsonb_array_elements_text(coalesce(p -> 'low_stock', '[]'::jsonb)) x), ''), 'none')),
      'path', '/')
    when 'stock_alert' then jsonb_build_object(
      'title', 'Stock alert',
      'body', case p ->> 'kind'
        when 'price_jump' then format('%s price up %s%% (%s to %s per %s)', p ->> 'item', p ->> 'pct',
          private.fmt_rupees((p ->> 'from_paise')::numeric), private.fmt_rupees((p ->> 'to_paise')::numeric), p ->> 'unit')
        when 'variance' then format('Stock-take found %s %s by %s%s', p ->> 'item',
          case when (p ->> 'variance')::numeric < 0 then 'short' else 'over' end,
          private.fmt_qty(abs((p ->> 'variance')::numeric)::text, p ->> 'unit'),
          case when p ->> 'reason' is not null then format(' (%s)', p ->> 'reason') else '' end)
        else format('%s is low: %s left (minimum %s)', p ->> 'item', private.fmt_qty(p ->> 'stock', p ->> 'unit'),
          private.fmt_qty(p ->> 'min_qty', p ->> 'unit')) end,
      'path', '/stock')
    when 'weather_alert' then jsonb_build_object(
      'title', case p ->> 'kind' when 'heat' then 'Severe heat expected' when 'rain_heat' then 'Heavy rain and heat expected'
                                 else 'Heavy rain expected' end,
      'body', format('During %s delivery on %s. Plan riders and packing.', lower(coalesce(nullif(v_slot, ''), 'lunch')),
        private.fmt_day(p ->> 'service_date')),
      'path', '/notifications')
    when 'late_delivery_alert' then jsonb_build_object(
      'title', 'Deliveries running late',
      'body', format('%s stop(s) on %s (%s) not delivered %s minutes after packing.', coalesce(p ->> 'pending_stops', '?'),
        coalesce(p ->> 'route_name', 'a route'), coalesce(p ->> 'rider_name', 'no rider'), coalesce(p ->> 'minutes', '90')),
      'path', '/notifications')
    when 'customer_switched_out' then jsonb_build_object(
      'title', 'A customer is moving',
      'body', format('%s moves to another kitchen from %s. Unused meals are refunded automatically.',
        coalesce(p ->> 'customer_name', 'A customer'), private.fmt_day(p ->> 'effective_date')),
      'path', '/notifications')
    when 'inbox_alert' then jsonb_build_object(
      'title', 'Needs a reply',
      'body', format('%s (%s)', coalesce(p ->> 'customer_name', 'A customer'),
        case when p ? 'complaint_id' then 'complaint: ' || coalesce(p ->> 'category', 'other') else coalesce(p ->> 'reason', 'message') end),
      'path', '/inbox')
    when 'new_platform_customer' then jsonb_build_object(
      'title', 'New customer from Tiffin',
      'body', format('%s (%s), %s, trial of %s meals.', coalesce(p ->> 'customer_name', 'A customer'), coalesce(p ->> 'area', '-'),
        coalesce(p ->> 'plan_name', ''), coalesce(p ->> 'trial_meals', '')),
      'path', '/customers')
    when 'stop_credit_request' then jsonb_build_object(
      'title', 'Credit to approve',
      'body', format('%s marked %s''s %s %s failed (%s). Give %s meal(s) back?', coalesce(p ->> 'rider_name', 'A rider'),
        coalesce(p ->> 'customer_name', 'a customer'), lower(coalesce(nullif(v_slot, ''), 'meal')),
        private.fmt_day(p ->> 'service_date'), replace(coalesce(p ->> 'reason', ''), '_', ' '), coalesce(p ->> 'meals', '1')),
      'path', '/handover')
    else jsonb_build_object('title', k, 'body', initcap(replace(coalesce(p_template, 'update'), '_', ' ')), 'path', '/notifications')
  end || jsonb_build_object('kitchen_name', k);
exception when others then
  -- A malformed payload must never stop a push or the list: fall back to the plain title.
  return jsonb_build_object('title', k, 'body', initcap(replace(coalesce(p_template, 'update'), '_', ' ')),
                            'path', '/notifications', 'kitchen_name', k);
end;
$$;

-- ---------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------

-- Push twin of a member's WhatsApp alert, only when the member has a device. Runs inside the lock
-- (production sheet): one indexed lookup, and it never raises.
create or replace function private.outbox_push_twin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.channel = 'whatsapp' and new.recipient_type = 'member' and new.status = 'pending' then
    begin
      if exists (select 1 from public.member_devices d where d.user_id = new.recipient_id and d.active) then
        insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload,
                                                 dedupe_key, send_after)
        values (new.kitchen_id, 'push', 'member', new.recipient_id, new.template, new.payload,
                'push:' || coalesce(new.dedupe_key, new.id::text), private.now())
        on conflict (dedupe_key) do nothing;
      end if;
    exception when others then
      raise warning 'push twin for outbox % failed: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;

create trigger notifications_outbox_push_twin after insert on public.notifications_outbox
  for each row execute function private.outbox_push_twin();

-- App-only alert to the kitchen's owners (shown in the app list; pushed to their devices).
create or replace function private.notify_owners_push(p_kitchen uuid, p_template text, p_payload jsonb, p_dedupe text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, send_after)
  select p_kitchen, 'push', 'member', m.user_id, p_template, coalesce(p_payload, '{}'::jsonb), p_dedupe || ':' || m.user_id, private.now()
  from public.members m where m.kitchen_id = p_kitchen and m.role = 'owner'
  on conflict (dedupe_key) do nothing;
$$;

-- ---------------------------------------------------------------------------
-- Member RPCs
-- ---------------------------------------------------------------------------

-- Saves this phone's push token for the caller (a token moves to whoever signed in last on it).
create or replace function public.register_device(p_token text, p_platform text, p_app_version text default null,
                                                  p_device_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$' then
    raise exception 'invalid_token' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('android', 'ios', 'web') then
    raise exception 'invalid_platform' using errcode = '22023';
  end if;
  insert into public.member_devices (user_id, token, platform, app_version, device_name, active, last_seen_at)
  values (auth.uid(), p_token, p_platform, left(nullif(trim(p_app_version), ''), 40), left(nullif(trim(p_device_name), ''), 80),
          true, now())
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform, app_version = excluded.app_version,
        device_name = excluded.device_name, active = true, last_seen_at = now()
  returning id into v_id;
  -- At most 10 active devices per person: the oldest stop receiving.
  update public.member_devices set active = false
  where user_id = auth.uid() and active and id in (
    select id from public.member_devices where user_id = auth.uid() and active order by last_seen_at desc offset 10);
  return v_id;
end;
$$;

-- On sign-out: this phone stops receiving the caller's alerts.
create or replace function public.unregister_device(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from public.member_devices where token = p_token and user_id = auth.uid();
end;
$$;

-- The caller's alerts (last 30 days, kitchens they still belong to), newest first, with texts.
-- Push twins are left out: each alert appears once.
create or replace function public.my_notifications(p_limit integer default 50, p_before timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc)
    from (
      select o.created_at,
             jsonb_build_object('id', o.id, 'kitchen_id', o.kitchen_id, 'template', o.template, 'created_at', o.created_at,
                                'channel', o.channel, 'status', o.status)
             || private.member_alert_text(o.template, o.payload, k.name) as j
      from public.notifications_outbox o
      left join public.kitchens k on k.id = o.kitchen_id
      where o.recipient_type = 'member' and o.recipient_id = auth.uid()
        and coalesce(o.dedupe_key, '') not like 'push:%'
        and o.created_at > now() - interval '30 days'
        and (p_before is null or o.created_at < p_before)
        and (o.kitchen_id is null or o.kitchen_id = any (private.kitchen_ids()))
      order by o.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) x), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker RPCs (service role only)
-- ---------------------------------------------------------------------------

-- Claims due push rows with their texts and the recipient's active tokens. Rows older than 12 hours
-- are dropped (a stale count is worse than none); rows stuck in 'sending' for 10 minutes (a worker
-- that died) are claimed again.
create or replace function public.push_claim_outbox(p_limit integer default 50)
returns table (id uuid, kitchen_id uuid, recipient_id uuid, template text, title text, body text, data jsonb,
               tokens text[], attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.notifications_outbox o set status = 'cancelled', last_error = 'expired'
  where o.channel = 'push' and o.status = 'pending' and o.created_at < now() - interval '12 hours';

  return query
  with due as (
    select o.id from public.notifications_outbox o
    where o.channel = 'push'
      and ((o.status = 'pending' and o.send_after <= private.now())
           or (o.status = 'sending' and o.send_after < private.now() - interval '10 minutes'))
    order by o.send_after
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    for update skip locked
  ),
  claimed as (
    update public.notifications_outbox o set status = 'sending', attempts = o.attempts + 1, send_after = private.now()
    from due where o.id = due.id
    returning o.*
  )
  select c.id, c.kitchen_id, c.recipient_id, c.template, t.txt ->> 'title', t.txt ->> 'body',
         jsonb_build_object('outbox_id', c.id, 'template', c.template, 'kitchen_id', c.kitchen_id, 'path', t.txt ->> 'path'),
         case when c.kitchen_id is null
                   or exists (select 1 from public.members m where m.user_id = c.recipient_id and m.kitchen_id = c.kitchen_id)
              then coalesce((select array_agg(d.token order by d.last_seen_at desc) from public.member_devices d
                             where d.user_id = c.recipient_id and d.active), '{}')
              else '{}'::text[] end,
         c.attempts
  from claimed c
  left join public.kitchens k on k.id = c.kitchen_id
  cross join lateral (select private.member_alert_text(c.template, c.payload, k.name) as txt) t;
end;
$$;

-- Records a send. p_dead_tokens (Expo DeviceNotRegistered) are switched off. Failures retry with
-- backoff, 5 attempts. p_skip (no device) cancels the row. p_mock: local mock mode, recorded as sent
-- with last_error 'mock' so it is never mistaken for a real delivery.
create or replace function public.push_complete_outbox(p_id uuid, p_ok boolean, p_error text default null,
                                                       p_dead_tokens text[] default null, p_skip boolean default false,
                                                       p_mock boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_dead_tokens), 0) > 0 then
    update public.member_devices set active = false where token = any (p_dead_tokens) and active;
  end if;
  if p_skip then
    update public.notifications_outbox set status = 'cancelled', last_error = left(p_error, 500)
    where id = p_id and channel = 'push';
    return;
  end if;
  update public.notifications_outbox
  set status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'pending' end,
      sent_at = case when p_ok then private.now() end,
      last_error = case when p_ok and p_mock then 'mock' when p_ok then null else left(p_error, 500) end,
      send_after = case when p_ok then send_after else private.now() + make_interval(mins => power(2, attempts)::integer) end
  where id = p_id and channel = 'push';
end;
$$;

-- Every minute: wake the push-outbox function when something is due (pg_net, fire-and-forget).
create or replace function private.kick_push()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.notifications_outbox
             where channel = 'push' and status = 'pending' and send_after <= private.now()) then
    perform private.kick_function('push-outbox');
  end if;
end;
$$;

select cron.schedule('tiffin-push', '* * * * *', 'select private.kick_push()');

-- ---------------------------------------------------------------------------
-- RLS and grants (fail-closed)
-- ---------------------------------------------------------------------------
alter table public.member_devices enable row level security;
create policy member_devices_select on public.member_devices for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.member_devices from anon, authenticated;
grant select on public.member_devices to authenticated;

revoke execute on function private.fmt_day(text), private.fmt_rupees(numeric), private.fmt_qty(text, text),
  private.member_alert_text(text, jsonb, text), private.outbox_push_twin(),
  private.notify_owners_push(uuid, text, jsonb, text), private.kick_push()
  from public, anon, authenticated;

revoke execute on function public.register_device, public.unregister_device, public.my_notifications,
  public.push_claim_outbox, public.push_complete_outbox from public, anon, authenticated;
grant execute on function public.register_device, public.unregister_device, public.my_notifications to authenticated;
grant execute on function public.push_claim_outbox, public.push_complete_outbox to service_role;
