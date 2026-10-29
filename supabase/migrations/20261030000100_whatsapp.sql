-- M4 WhatsApp: one platform number for all kitchens. Conversations, messages, complaints,
-- customer magic links, broadcasts; service-role RPCs for the whatsapp-webhook / whatsapp-outbox
-- Edge Functions; owner RPCs for the inbox; token-checked RPCs for the customer page (/c/<token>).
--
-- Rules
--   * Customers are recognised by phone hash; a phone that is a customer at several kitchens is
--     asked which kitchen. Unknown numbers get a polite reply (lead intake is M7).
--   * Free-form replies only inside Meta's 24-hour customer-service window; outside it the
--     worker sends an approved template, and only to customers who opted in.
--   * Customer requests by WhatsApp use channel 'whatsapp' (slot cutoff); the customer page uses 'web'.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
alter table public.kitchen_settings add column broadcast_cap_monthly integer not null default 4
  check (broadcast_cap_monthly between 0 and 30);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid references public.kitchens (id) on delete cascade,  -- null: unknown number / kitchen not chosen yet
  customer_id uuid,
  wa_phone_hash text not null,
  phone_enc bytea not null,          -- encrypted, to reply
  phone_last4 text not null,
  contact_name text,                 -- WhatsApp profile name
  language public.language_code not null default 'en',
  state jsonb not null default '{}', -- bot flow state
  handoff_open boolean not null default false,
  handoff_at timestamptz,
  last_inbound_at timestamptz,
  last_message_at timestamptz,
  unread_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, kitchen_id),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id)
);
create unique index conversations_kitchen_phone_idx on public.conversations (kitchen_id, wa_phone_hash) where kitchen_id is not null;
create unique index conversations_unrouted_phone_idx on public.conversations (wa_phone_hash) where kitchen_id is null;
create index conversations_inbox_idx on public.conversations (kitchen_id, last_message_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  kitchen_id uuid,
  direction text not null check (direction in ('in', 'out')),
  body text,
  payload jsonb not null default '{}',
  wa_message_id text unique,
  bot_intent text,
  handled_by text not null check (handled_by in ('customer', 'bot', 'ai', 'vendor', 'system')),
  status text not null default 'received' check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  sent_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);

create table public.complaints (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  customer_id uuid not null,
  conversation_id uuid references public.conversations (id),
  meal_order_id uuid,
  category text not null check (category in ('late', 'quality', 'quantity', 'missing', 'hygiene', 'delivery', 'billing', 'privacy', 'other')),
  description text,
  photo_url text,
  channel text not null check (channel in ('whatsapp', 'web', 'vendor')),
  status text not null default 'open' check (status in ('open', 'responded', 'resolved', 'escalated')),
  responded_at timestamptz,
  resolved_at timestamptz,
  escalated_at timestamptz,
  refund_entry_id uuid references public.balance_entries (id),
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (meal_order_id, kitchen_id) references public.meal_orders (id, kitchen_id)
);
create index complaints_kitchen_idx on public.complaints (kitchen_id, status, created_at desc);

create table public.customer_magic_links (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  customer_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id) on delete cascade
);

create table public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  body text not null check (length(trim(body)) between 3 and 700),
  recipients integer not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create trigger conversations_updated_at before update on public.conversations
  for each row execute function private.set_updated_at();
create trigger complaints_updated_at before update on public.complaints
  for each row execute function private.set_updated_at();
create trigger complaints_audit after insert or update or delete on public.complaints
  for each row execute function private.audit_row();
create trigger broadcasts_audit after insert on public.broadcasts
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create or replace function private.notify_owners(p_kitchen uuid, p_template text, p_payload jsonb, p_dedupe text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select p_kitchen, 'whatsapp', 'member', m.user_id, p_template, p_payload, p_dedupe || ':' || m.user_id
  from public.members m where m.kitchen_id = p_kitchen and m.role = 'owner'
  on conflict (dedupe_key) do nothing;
$$;

-- Bot context for one conversation: everything the bot may say, nothing more.
create or replace function private.conversation_context(p_conversation uuid)
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
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_c.kitchen_id is null or v_c.customer_id is null then
    return jsonb_build_object('conversation_id', v_c.id, 'matched', false, 'language', v_c.language, 'state', v_c.state);
  end if;
  select * into v_k from public.kitchens where id = v_c.kitchen_id;
  select * into v_cust from public.customers where id = v_c.customer_id;
  select * into v_ks from public.kitchen_settings where kitchen_id = v_c.kitchen_id;
  select * into v_value from private.unused_value(v_c.customer_id, null);

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
      'low_threshold', v_ks.low_balance_meals),
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

create or replace function private.issue_magic_link(p_customer uuid, p_days integer default 7)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer and deleted_at is null;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.customer_magic_links (kitchen_id, customer_id, token_hash, expires_at)
  values (v_kitchen, p_customer, encode(extensions.digest(v_token, 'sha256'), 'hex'), private.now() + make_interval(days => p_days));
  return v_token;
end;
$$;

-- Resolves a magic-link token to its customer (or raises invalid_link).
create or replace function private.portal_customer(p_token text)
returns public.customers
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cust public.customers;
begin
  select c.* into v_cust
  from public.customer_magic_links l join public.customers c on c.id = l.customer_id
  where l.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and l.revoked_at is null and l.expires_at > private.now() and c.deleted_at is null;
  if v_cust.id is null then
    raise exception 'invalid_link' using errcode = '28000';
  end if;
  return v_cust;
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role RPCs (whatsapp-webhook / whatsapp-outbox Edge Functions)
-- ---------------------------------------------------------------------------

-- Stores one inbound message (deduplicated on the WhatsApp message id) and routes it to a
-- kitchen conversation. Returns { duplicate, status: matched|choose_kitchen|unknown, conversation_id, kitchens }.
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

  select coalesce(jsonb_agg(jsonb_build_object('kitchen_id', k.id, 'kitchen_name', k.name, 'slug', k.slug, 'customer_id', c.id)
                            order by k.name), '[]'::jsonb), count(*)
  into v_matches, v_count
  from public.customers c join public.kitchens k on k.id = c.kitchen_id
  where c.phone_hash = v_hash and c.deleted_at is null and k.status <> 'suspended';

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

-- The customer picked a kitchen (multi-kitchen phone): route to that kitchen's conversation.
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
  select id into v_customer from public.customers
  where kitchen_id = p_kitchen and phone_hash = v_c.wa_phone_hash and deleted_at is null;
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

create or replace function public.wa_context(p_conversation uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.conversation_context(p_conversation);
$$;

create or replace function public.wa_update_conversation(p_conversation uuid, p_state jsonb default null,
  p_language public.language_code default null, p_opt_in boolean default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = p_conversation;
  update public.conversations
  set state = coalesce(p_state, state), language = coalesce(p_language, language)
  where id = p_conversation;
  if v_c.customer_id is not null and p_language is not null then
    update public.customers set preferred_language = p_language where id = v_c.customer_id;
  end if;
  if v_c.customer_id is not null and p_opt_in is not null then
    update public.customers set whatsapp_opt_in = p_opt_in where id = v_c.customer_id;
    insert into public.consents (kitchen_id, customer_id, purpose, basis, channel, withdrawn_at)
    values (v_c.kitchen_id, v_c.customer_id, 'whatsapp', 'customer', 'whatsapp', case when p_opt_in then null else private.now() end);
  end if;
end;
$$;

-- Skip / pause / resume / address by WhatsApp (slot cutoff applies; late = charged, previewed first).
create or replace function public.wa_apply_change(p_conversation uuid, p_subscription uuid, p_type public.change_type,
  p_from date, p_to date default null, p_slot public.meal_slot default null, p_address uuid default null, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.customer_id is null or not exists (select 1 from public.subscriptions where id = p_subscription and customer_id = v_c.customer_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_type = 'cancel' then
    raise exception 'cancel_via_kitchen' using errcode = '22023'; -- cancellations go to the kitchen (refund terms)
  end if;
  return private.apply_change(p_subscription, p_type, p_from, p_to, p_slot, p_address, 'whatsapp', false, null, p_dry_run, null);
end;
$$;

create or replace function public.wa_handoff(p_conversation uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.kitchen_id is null then
    return;
  end if;
  update public.conversations set handoff_open = true, handoff_at = coalesce(handoff_at, private.now()) where id = p_conversation;
  if not v_c.handoff_open then
    perform private.notify_owners(v_c.kitchen_id, 'inbox_alert',
      jsonb_build_object('conversation_id', v_c.id, 'reason', p_reason,
                         'customer_name', (select name from public.customers where id = v_c.customer_id)),
      'inbox_alert:' || v_c.id || ':' || to_char(private.now(), 'YYYYMMDDHH24'));
  end if;
end;
$$;

create or replace function public.wa_create_complaint(p_conversation uuid, p_category text, p_description text, p_photo_url text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
  v_id uuid;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.customer_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.complaints (kitchen_id, customer_id, conversation_id, meal_order_id, category, description, photo_url, channel, created_at)
  values (v_c.kitchen_id, v_c.customer_id, v_c.id,
          (select o.id from public.meal_orders o where o.customer_id = v_c.customer_id and o.locked_at is not null
           order by o.service_date desc, o.slot desc limit 1),
          p_category, nullif(trim(p_description), ''), p_photo_url, 'whatsapp', private.now())
  returning id into v_id;
  update public.conversations set handoff_open = true, handoff_at = coalesce(handoff_at, private.now()) where id = v_c.id;
  perform private.notify_owners(v_c.kitchen_id, 'inbox_alert',
    jsonb_build_object('conversation_id', v_c.id, 'complaint_id', v_id, 'category', p_category,
                       'customer_name', (select name from public.customers where id = v_c.customer_id)),
    'complaint:' || v_id);
  return v_id;
end;
$$;

-- Customer shared a location pin: new default address used from now on.
create or replace function public.wa_add_location_address(p_conversation uuid, p_lat double precision, p_lng double precision, p_label text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
  v_addr uuid;
  r record;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.customer_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.addresses (kitchen_id, customer_id, label, line1, lat, lng, is_default, delivery_notes)
  values (v_c.kitchen_id, v_c.customer_id, coalesce(nullif(trim(p_label), ''), 'Shared on WhatsApp'), p_label, p_lat, p_lng, true,
          'Location shared on WhatsApp')
  returning id into v_addr;
  for r in select id from public.subscriptions where customer_id = v_c.customer_id and status <> 'cancelled' loop
    perform private.apply_change(r.id, 'address', private.ist_today(), null, null, v_addr, 'whatsapp', false, null, false, null);
  end loop;
  return v_addr;
end;
$$;

create or replace function public.wa_magic_link(p_conversation uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.customer_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.issue_magic_link(v_c.customer_id, 7);
end;
$$;

-- Payment link row for the conversation's customer (the Edge Function then calls Razorpay).
create or replace function public.wa_payment_link_record(p_conversation uuid, p_meals integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.customer_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.payment_link_record(v_c.customer_id, p_meals, null);
end;
$$;

create or replace function public.wa_log_outbound(p_conversation uuid, p_body text, p_payload jsonb, p_wa_message_id text,
  p_handled_by text, p_status text, p_intent text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.messages (conversation_id, kitchen_id, direction, body, payload, wa_message_id, handled_by, status, bot_intent, created_at)
  select p_conversation, c.kitchen_id, 'out', p_body, coalesce(p_payload, '{}'), p_wa_message_id, p_handled_by, p_status, p_intent, private.now()
  from public.conversations c where c.id = p_conversation
  returning id into v_id;
  update public.conversations set last_message_at = private.now() where id = p_conversation;
  return v_id;
end;
$$;

create or replace function public.wa_message_status(p_wa_message_id text, p_status text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.messages set status = p_status
  where wa_message_id = p_wa_message_id and p_status in ('sent', 'delivered', 'read', 'failed')
    and (case status when 'queued' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 4 end)
        < (case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 4 end);
$$;

-- Outbox worker: claim due WhatsApp rows (skip-locked) with everything needed to render them.
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
  return query
  with due as (
    select o.id from public.notifications_outbox o
    where o.channel = 'whatsapp' and o.status = 'pending' and o.send_after <= private.now()
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
         case when c.recipient_type = 'customer' then private.decrypt_phone(cu.phone_enc)
              else '+' || u.phone end,
         coalesce(cu.preferred_language, 'en'::public.language_code),
         k.name, conv.id,
         coalesce(conv.last_inbound_at > private.now() - interval '24 hours', false),
         case when c.recipient_type = 'customer' then coalesce(cu.whatsapp_opt_in, false) else true end,
         c.attempts
  from claimed c
  left join public.kitchens k on k.id = c.kitchen_id
  left join public.customers cu on c.recipient_type = 'customer' and cu.id = c.recipient_id
  left join auth.users u on c.recipient_type = 'member' and u.id = c.recipient_id
  left join public.conversations conv on c.recipient_type = 'customer' and conv.customer_id = c.recipient_id and conv.kitchen_id = c.kitchen_id;
end;
$$;

-- Outbox worker: record the outcome. Failures retry with backoff (5 attempts).
create or replace function public.wa_complete_outbox(p_id uuid, p_ok boolean, p_wa_message_id text, p_error text,
  p_rendered text, p_skip boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.notifications_outbox;
  v_conv uuid;
begin
  select * into v_o from public.notifications_outbox where id = p_id;
  if v_o.id is null then
    return;
  end if;
  if p_skip then
    update public.notifications_outbox set status = 'cancelled', last_error = p_error where id = p_id;
    return;
  end if;
  update public.notifications_outbox
  set status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'pending' end,
      sent_at = case when p_ok then private.now() end,
      last_error = case when p_ok then null else p_error end,
      send_after = case when p_ok then send_after else private.now() + make_interval(mins => power(2, attempts)::integer) end
  where id = p_id;
  if p_ok and v_o.recipient_type = 'customer' then
    select id into v_conv from public.conversations where customer_id = v_o.recipient_id and kitchen_id = v_o.kitchen_id;
    if v_conv is not null then
      perform public.wa_log_outbound(v_conv, p_rendered, jsonb_build_object('template', v_o.template), p_wa_message_id,
        case when v_o.template in ('vendor_message', 'broadcast') then 'vendor' else 'system' end, 'sent', v_o.template);
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment link record shared by owner / WhatsApp / customer page (refactor of M3's owner RPC).
-- ---------------------------------------------------------------------------
create or replace function private.payment_link_record(p_customer uuid, p_meals integer, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_price integer;
  v_account public.kitchen_payout_accounts;
  v_id uuid;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if coalesce(p_meals, 0) not between 1 and 200 then
    raise exception 'invalid_meals' using errcode = '22023';
  end if;
  select * into v_account from public.kitchen_payout_accounts where kitchen_id = v_c.kitchen_id;
  if v_account.razorpay_linked_account_id is null or v_account.kyc_status <> 'verified' then
    raise exception 'payout_account_not_verified' using errcode = '22023';
  end if;
  v_price := private.customer_unit_price(p_customer);
  if v_price is null then
    raise exception 'no_plan' using errcode = '22023';
  end if;
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, description, created_by, created_at)
  values (v_c.kitchen_id, p_customer, 'razorpay_link', 'created', p_meals * v_price, p_meals, p_meals || ' meals', p_actor, private.now())
  returning id into v_id;
  return jsonb_build_object(
    'payment_id', v_id, 'amount_paise', p_meals * v_price, 'meals', p_meals,
    'linked_account_id', v_account.razorpay_linked_account_id,
    'customer_name', v_c.name, 'customer_phone', private.decrypt_phone(v_c.phone_enc),
    'kitchen_name', (select name from public.kitchens where id = v_c.kitchen_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer page RPCs (anon allowed; every call is checked against the magic-link token)
-- ---------------------------------------------------------------------------
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
  -- Reuse the bot context builder through a conversation-less path.
  select id into v_conv from public.conversations where customer_id = v_cust.id and kitchen_id = v_cust.kitchen_id;
  if v_conv is null then
    insert into public.conversations (kitchen_id, customer_id, wa_phone_hash, phone_enc, phone_last4, language)
    values (v_cust.kitchen_id, v_cust.id, v_cust.phone_hash, v_cust.phone_enc, v_cust.phone_last4, v_cust.preferred_language)
    returning id into v_conv;
  end if;
  v_ctx := private.conversation_context(v_conv);
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
      from public.complaints c where c.customer_id = v_cust.id), '[]'::jsonb));
end;
$$;

create or replace function public.portal_change(p_token text, p_subscription uuid, p_type public.change_type, p_from date,
  p_to date default null, p_slot public.meal_slot default null, p_address uuid default null, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
begin
  if not exists (select 1 from public.subscriptions where id = p_subscription and customer_id = v_cust.id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_type = 'cancel' then
    raise exception 'cancel_via_kitchen' using errcode = '22023';
  end if;
  if p_type = 'address' and not exists (select 1 from public.addresses where id = p_address and customer_id = v_cust.id) then
    raise exception 'invalid_address' using errcode = '22023';
  end if;
  return private.apply_change(p_subscription, p_type, p_from, p_to, p_slot, p_address, 'web', false, null, coalesce(p_dry_run, true), null);
end;
$$;

create or replace function public.portal_add_address(p_token text, p_line1 text, p_area text, p_landmark text,
  p_delivery_notes text, p_lat double precision default null, p_lng double precision default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
  v_id uuid;
begin
  if nullif(trim(p_line1), '') is null then
    raise exception 'address_required' using errcode = '22023';
  end if;
  insert into public.addresses (kitchen_id, customer_id, line1, area, landmark, delivery_notes, lat, lng, is_default)
  values (v_cust.kitchen_id, v_cust.id, trim(p_line1), nullif(trim(p_area), ''), nullif(trim(p_landmark), ''),
          nullif(trim(p_delivery_notes), ''), p_lat, p_lng, false)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.portal_complaint(p_token text, p_category text, p_description text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
  v_id uuid;
begin
  insert into public.complaints (kitchen_id, customer_id, category, description, channel, created_at,
                                 conversation_id)
  values (v_cust.kitchen_id, v_cust.id, p_category, nullif(trim(p_description), ''), 'web', private.now(),
          (select id from public.conversations where customer_id = v_cust.id and kitchen_id = v_cust.kitchen_id))
  returning id into v_id;
  perform private.notify_owners(v_cust.kitchen_id, 'inbox_alert',
    jsonb_build_object('complaint_id', v_id, 'category', p_category, 'customer_name', v_cust.name), 'complaint:' || v_id);
  return v_id;
end;
$$;

create or replace function public.portal_set_language(p_token text, p_language public.language_code)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
begin
  update public.customers set preferred_language = p_language where id = v_cust.id;
  update public.conversations set language = p_language where customer_id = v_cust.id;
end;
$$;

create or replace function public.portal_payment_link_record(p_token text, p_meals integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
begin
  return private.payment_link_record(v_cust.id, p_meals, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner RPCs: inbox, complaints, broadcasts, invites
-- ---------------------------------------------------------------------------
create or replace function public.send_vendor_message(p_conversation uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
  v_id uuid;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null or v_c.kitchen_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  if nullif(trim(p_body), '') is null or length(p_body) > 1000 then
    raise exception 'invalid_message' using errcode = '22023';
  end if;
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  values (v_c.kitchen_id, 'whatsapp', 'customer', v_c.customer_id, 'vendor_message',
          jsonb_build_object('text', trim(p_body), 'sent_by', auth.uid()), 'vendor_message:' || gen_random_uuid())
  returning id into v_id;
  update public.conversations set unread_count = 0 where id = p_conversation;
  update public.complaints set status = 'responded', responded_at = coalesce(responded_at, private.now())
  where conversation_id = p_conversation and status in ('open', 'escalated');
  return v_id;
end;
$$;

create or replace function public.close_conversation(p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null or v_c.kitchen_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  update public.conversations
  set handoff_open = false, handoff_at = null, unread_count = 0,
      state = case when state ? 'optin_asked' then jsonb_build_object('optin_asked', state -> 'optin_asked') else '{}'::jsonb end
  where id = p_conversation;
end;
$$;

create or replace function public.mark_conversation_read(p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null or v_c.kitchen_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  update public.conversations set unread_count = 0 where id = p_conversation;
end;
$$;

-- Resolve a complaint, optionally crediting free meals (linked to the complaint).
create or replace function public.resolve_complaint(p_complaint uuid, p_note text, p_credit_meals integer default 0)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cp public.complaints;
  v_entry uuid;
begin
  select * into v_cp from public.complaints where id = p_complaint for update;
  if v_cp.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_cp.kitchen_id, '{owner}');
  if v_cp.status = 'resolved' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  if coalesce(p_credit_meals, 0) < 0 or p_credit_meals > 30 then
    raise exception 'invalid_meals' using errcode = '22023';
  end if;
  if p_credit_meals > 0 then
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
    values (v_cp.kitchen_id, v_cp.customer_id, 'credit', p_credit_meals, 0, 'complaint', v_cp.id,
            'Complaint: ' || v_cp.category, auth.uid(), private.now())
    returning id into v_entry;
    perform private.sync_balance_status(v_cp.kitchen_id, v_cp.customer_id);
  end if;
  update public.complaints
  set status = 'resolved', resolved_at = private.now(), responded_at = coalesce(responded_at, private.now()),
      resolution_note = nullif(trim(p_note), ''), refund_entry_id = v_entry
  where id = p_complaint;
  if nullif(trim(p_note), '') is not null then
    insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
    values (v_cp.kitchen_id, 'whatsapp', 'customer', v_cp.customer_id, 'vendor_message',
            jsonb_build_object('text', trim(p_note) || case when p_credit_meals > 0 then ' (+' || p_credit_meals || ' free meal' ||
              case when p_credit_meals > 1 then 's' else '' end || ' added)' else '' end), 'complaint_resolved:' || v_cp.id);
  end if;
end;
$$;

-- Vendor broadcast to opted-in customers with a live subscription, capped per calendar month.
create or replace function public.send_broadcast(p_kitchen uuid, p_body text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap integer;
  v_used integer;
  v_id uuid;
  v_n integer;
begin
  perform private.require_role(p_kitchen, '{owner}');
  select broadcast_cap_monthly into v_cap from public.kitchen_settings where kitchen_id = p_kitchen;
  select count(*) into v_used from public.broadcasts
  where kitchen_id = p_kitchen and date_trunc('month', created_at at time zone 'Asia/Kolkata') = date_trunc('month', private.now() at time zone 'Asia/Kolkata');
  if v_used >= v_cap then
    raise exception 'broadcast_cap_reached' using errcode = '22023';
  end if;
  insert into public.broadcasts (kitchen_id, body, recipients, created_by, created_at)
  values (p_kitchen, trim(p_body), 0, auth.uid(), private.now()) returning id into v_id;
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select distinct p_kitchen, 'whatsapp', 'customer', c.id, 'broadcast', jsonb_build_object('text', trim(p_body)),
         'broadcast:' || v_id || ':' || c.id
  from public.customers c join public.subscriptions s on s.customer_id = c.id and s.status <> 'cancelled'
  where c.kitchen_id = p_kitchen and c.whatsapp_opt_in and c.deleted_at is null;
  get diagnostics v_n = row_count;
  update public.broadcasts set recipients = v_n where id = v_id;
  return v_n;
end;
$$;

-- Owner: a 7-day page link for a customer (e.g. to share by SMS for customers without the bot yet).
create or replace function public.customer_page_link(p_customer uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  return private.issue_magic_link(p_customer, 7);
end;
$$;

-- ---------------------------------------------------------------------------
-- Scheduled jobs
-- ---------------------------------------------------------------------------

-- 19:00 IST: "Tomorrow's menu - skip?" to opted-in customers with a meal tomorrow still open.
create or replace function private.queue_tomorrow_nudges()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tomorrow date := private.ist_today() + 1;
  v_n integer;
begin
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select o.kitchen_id, 'whatsapp', 'customer', o.customer_id, 'tomorrow_menu',
         jsonb_build_object('date', v_tomorrow,
           'slots', jsonb_agg(distinct o.slot),
           'dishes', coalesce((select jsonb_agg(d) from public.menus m, unnest(m.dishes) d
                               where m.kitchen_id = o.kitchen_id and m.service_date = v_tomorrow and m.published), '[]'::jsonb)),
         'tomorrow_menu:' || o.customer_id || ':' || v_tomorrow
  from public.meal_orders o
  join public.customers c on c.id = o.customer_id and c.whatsapp_opt_in and c.deleted_at is null
  join public.kitchens k on k.id = o.kitchen_id
  where o.service_date = v_tomorrow and o.status = 'scheduled' and o.locked_at is null
    and private.now() < private.cutoff_at(k, o.service_date, o.slot)
  group by o.kitchen_id, o.customer_id
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Every 15 minutes: complaints without a kitchen response after 2 hours escalate to the platform team.
create or replace function private.escalate_complaints()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.complaints set status = 'escalated', escalated_at = private.now()
  where status = 'open' and created_at < private.now() - interval '2 hours';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Every minute: ask the whatsapp-outbox Edge Function to drain the queue (pg_net, fire-and-forget).
-- Needs Vault secrets 'functions_base_url' and 'service_role_key'; does nothing without them.
create extension if not exists pg_net with schema extensions;

create or replace function private.kick_outbox()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from public.notifications_outbox where channel = 'whatsapp' and status = 'pending' and send_after <= now()) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'functions_base_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    return;
  end if;
  perform net.http_post(url := v_url || '/whatsapp-outbox', body := '{}'::jsonb,
                        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'));
end;
$$;

select cron.schedule('tiffin-tomorrow-nudge', '30 13 * * *', 'select private.queue_tomorrow_nudges()'); -- 19:00 IST
select cron.schedule('tiffin-escalate-complaints', '*/15 * * * *', 'select private.escalate_complaints()');
select cron.schedule('tiffin-outbox', '* * * * *', 'select private.kick_outbox()');

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.complaints enable row level security;
alter table public.customer_magic_links enable row level security;
alter table public.broadcasts enable row level security;

-- The inbox carries balances and payment talk: owner only (D-060). Admins see escalations.
create policy conversations_select on public.conversations for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy messages_select on public.messages for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy complaints_select on public.complaints for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy broadcasts_select on public.broadcasts for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

revoke all on public.conversations, public.messages, public.complaints, public.customer_magic_links, public.broadcasts
  from anon, authenticated;
grant select (id, kitchen_id, customer_id, phone_last4, contact_name, language, handoff_open, handoff_at, last_inbound_at,
  last_message_at, unread_count, created_at, updated_at) on public.conversations to authenticated;
grant select on public.messages, public.complaints, public.broadcasts to authenticated;
grant update (broadcast_cap_monthly) on public.kitchen_settings to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.kitchen_ids(public.member_role[]) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;

revoke execute on function public.wa_receive, public.wa_select_kitchen, public.wa_context, public.wa_update_conversation,
  public.wa_apply_change, public.wa_handoff, public.wa_create_complaint, public.wa_add_location_address, public.wa_magic_link,
  public.wa_payment_link_record, public.wa_log_outbound, public.wa_message_status, public.wa_claim_outbox,
  public.wa_complete_outbox, public.portal_get, public.portal_change, public.portal_add_address, public.portal_complaint,
  public.portal_set_language, public.portal_payment_link_record, public.send_vendor_message, public.close_conversation,
  public.mark_conversation_read, public.resolve_complaint, public.send_broadcast, public.customer_page_link
  from public, anon, authenticated;
grant execute on function public.wa_receive, public.wa_select_kitchen, public.wa_context, public.wa_update_conversation,
  public.wa_apply_change, public.wa_handoff, public.wa_create_complaint, public.wa_add_location_address, public.wa_magic_link,
  public.wa_payment_link_record, public.wa_log_outbound, public.wa_message_status, public.wa_claim_outbox,
  public.wa_complete_outbox to service_role;
-- The customer page works without a login; every function checks the token itself.
grant execute on function public.portal_get, public.portal_change, public.portal_add_address, public.portal_complaint,
  public.portal_set_language, public.portal_payment_link_record to anon, authenticated;
grant execute on function public.send_vendor_message, public.close_conversation, public.mark_conversation_read,
  public.resolve_complaint, public.send_broadcast, public.customer_page_link to authenticated;
