-- Vendor-first wave 2, item 13: outbox expiry, a gate for customer messages, phase-flag keys.
--
--   * notifications_outbox.expires_at: set at insert (default: 48 hours after the row is due, or after
--     it was queued if that is later). The outbox worker never claims an expired row; it marks it
--     cancelled ('expired') instead.
--   * Phase flags (platform_settings, all OFF): customer_whatsapp, customer_portal, online_payments,
--     marketplace, growth, extras. While customer_whatsapp is off, every message to a customer,
--     lead or vendor applicant is stored as cancelled ('customer_messages_off'); member alerts
--     (owners, managers, staff, riders) are unaffected. Phase 1 customers stay offline.
--   * Growth and customer crons check their flag before doing anything:
--       tiffin-growth, tiffin-ad-conversions          → growth
--       tiffin-tomorrow-nudge                         → customer_whatsapp
--       tiffin-escalate-complaints                    → customer_whatsapp or customer_portal
--       tiffin-weather (customer notices only)        → customer_whatsapp (owner alerts unchanged)

insert into public.platform_settings (key, enabled) values
  ('customer_whatsapp', false), ('customer_portal', false), ('online_payments', false),
  ('marketplace', false), ('growth', false), ('extras', false)
on conflict (key) do nothing;

alter table public.notifications_outbox add column expires_at timestamptz;
create index notifications_outbox_expiry_idx on public.notifications_outbox (expires_at) where status = 'pending';

-- BEFORE INSERT, runs before notifications_outbox_route_payer (triggers fire in name order).
create or replace function private.outbox_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 48 hours after it is due (or after it was queued, if that is later).
  new.expires_at := coalesce(new.expires_at, greatest(new.send_after, private.now()) + interval '48 hours');
  if new.recipient_type in ('customer', 'lead', 'vendor_application') and new.status = 'pending'
     and not private.feature_enabled('customer_whatsapp') then
    new.status := 'cancelled';
    new.last_error := 'customer_messages_off';
  end if;
  return new;
end;
$$;

create trigger notifications_outbox_gate before insert on public.notifications_outbox
  for each row execute function private.outbox_gate();

create or replace function private.route_outbox_to_payer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eater public.customers;
  v_payer public.customers;
begin
  -- A message cancelled by the gate is never sent: don't reroute it or mint a payer link for it.
  if new.recipient_type <> 'customer' or new.status = 'cancelled' or not (new.template = any (private.payer_templates())) then
    return new;
  end if;
  select * into v_eater from public.customers where id = new.recipient_id;
  if v_eater.payer_customer_id is null then
    return new;
  end if;
  select * into v_payer from public.customers where id = v_eater.payer_customer_id and deleted_at is null;
  if v_payer.id is null then
    return new;
  end if;
  -- A duplicate is dropped by ON CONFLICT anyway; don't mint a link for it.
  if new.dedupe_key is not null and exists (select 1 from public.notifications_outbox where dedupe_key = new.dedupe_key) then
    return new;
  end if;
  new.recipient_id := v_payer.id;
  new.template := new.template || '_payer';
  new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object(
    'eater_customer_id', v_eater.id, 'eater_name', v_eater.name, 'url', private.portal_url(v_payer.id));
  return new;
end;
$$;

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
    update public.notifications_outbox o set status = 'sending', attempts = o.attempts + 1
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

create or replace function public.weather_kitchens()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('kitchen_id', k.id, 'name', k.name, 'lat', k.lat, 'lng', k.lng,
                                               'owner_alerts', ks.weather_alerts,
                                               'customer_notice', ks.weather_customer_notice and private.feature_enabled('customer_whatsapp'))
                            order by k.name), '[]'::jsonb)
  from public.kitchens k join public.kitchen_settings ks on ks.kitchen_id = k.id
  where k.status <> 'suspended' and k.lat is not null and k.lng is not null
    and (ks.weather_alerts or ks.weather_customer_notice);
$$;

create or replace function public.weather_record_alert(p_kitchen uuid, p_date date, p_slot public.meal_slot, p_kind text, p_detail jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_ks public.kitchen_settings;
  v_n integer := 0;
begin
  if p_kind not in ('rain', 'heat', 'rain_heat') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  insert into public.weather_alerts (kitchen_id, service_date, slot, kind, detail, created_at)
  values (p_kitchen, p_date, p_slot, p_kind, coalesce(p_detail, '{}'), private.now())
  on conflict (kitchen_id, service_date, slot) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('created', false);
  end if;
  select * into v_ks from public.kitchen_settings where kitchen_id = p_kitchen;
  if coalesce(v_ks.weather_alerts, true) then
    perform private.notify_owners(p_kitchen, 'weather_alert',
      jsonb_build_object('service_date', p_date, 'slot', p_slot, 'kind', p_kind, 'detail', p_detail),
      'weather_alert:' || p_kitchen || ':' || p_date || ':' || p_slot);
  end if;
  if coalesce(v_ks.weather_customer_notice, false) and private.feature_enabled('customer_whatsapp') then
    insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
    select distinct p_kitchen, 'whatsapp', 'customer', o.customer_id, 'weather_delay_notice',
           jsonb_build_object('service_date', p_date, 'slot', p_slot, 'kind', p_kind),
           'weather_delay_notice:' || o.customer_id || ':' || p_date || ':' || p_slot
    from public.meal_orders o
    join public.customers c on c.id = o.customer_id and c.whatsapp_opt_in and c.deleted_at is null
    where o.kitchen_id = p_kitchen and o.service_date = p_date and o.slot = p_slot and o.status <> 'skipped'
    on conflict (dedupe_key) do nothing;
    get diagnostics v_n = row_count;
    update public.weather_alerts set customers_notified = v_n where id = v_id;
  end if;
  return jsonb_build_object('created', true, 'alert_id', v_id, 'customers_notified', v_n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Flag-checked cron entry points (the jobs keep their names and schedules).
-- ---------------------------------------------------------------------------
create or replace function private.cron_growth_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.feature_enabled('growth') then
    return jsonb_build_object('skipped', 'growth_off');
  end if;
  return private.growth_tick();
end;
$$;

create or replace function private.cron_ad_conversions()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.feature_enabled('growth') then
    perform private.kick_ad_conversions();
  end if;
end;
$$;

create or replace function private.cron_tomorrow_nudges()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.feature_enabled('customer_whatsapp') then
    return 0;
  end if;
  return private.queue_tomorrow_nudges();
end;
$$;

create or replace function private.cron_escalate_complaints()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (private.feature_enabled('customer_whatsapp') or private.feature_enabled('customer_portal')) then
    return 0;
  end if;
  return private.escalate_complaints();
end;
$$;

select cron.schedule('tiffin-growth', '7 * * * *', $$select private.cron_growth_tick()$$);
select cron.schedule('tiffin-ad-conversions', '*/15 * * * *', $$select private.cron_ad_conversions()$$);
select cron.schedule('tiffin-tomorrow-nudge', '30 13 * * *', $$select private.cron_tomorrow_nudges()$$); -- 19:00 IST
select cron.schedule('tiffin-escalate-complaints', '*/15 * * * *', $$select private.cron_escalate_complaints()$$);

revoke execute on function private.outbox_gate(), private.cron_growth_tick(), private.cron_ad_conversions(),
  private.cron_tomorrow_nudges(), private.cron_escalate_complaints()
  from public, anon, authenticated;
