-- Held-back vendor-first item (audit Phase 2 step 6, item 41; mock half of item 10): a reliable,
-- honest WhatsApp outbox.
--
--   * Stuck rows: a row left in 'sending' for more than 10 minutes (the worker crashed between claim
--     and completion) goes back to 'pending' (it counts as an attempt; after 5 it is 'failed'), by the
--     new cron job tiffin-outbox-stuck (every 5 minutes). claimed_at records when it was claimed.
--   * Never sent twice:
--       - wa_complete_outbox records the provider's message id in the same statement that marks the
--         row sent; once a row is sent (or has a provider id), a later failure report, a retry or a
--         duplicate completion changes nothing. Logging into the conversation can no longer undo it.
--       - the worker passes the row id to Meta as biz_opaque_callback_data ('outbox:<id>'), the
--         per-row idempotency key: Meta echoes it on every status webhook, and wa_message_status then
--         marks the row sent even if the worker never recorded it. The stuck sweep only re-queues rows
--         with no provider id.
--       - the worker never reports a failure after the provider accepted a message (it retries the
--         completion instead).
--   * Mock sends are 'mock', not 'sent': wa_complete_outbox(..., p_mock => true) from whatsapp-outbox in
--     WHATSAPP_MODE=mock; the conversation shows them as 'mock' (messages.status), rider_today.otp_sent
--     counts only real sends, and the admin metrics separate real and mock sends.
--   * Admin: 'outbox_failed' now includes stuck rows (and 'outbox_stuck' shows them alone).

alter table public.notifications_outbox drop constraint notifications_outbox_status_check;
alter table public.notifications_outbox add constraint notifications_outbox_status_check
  check (status in ('pending', 'sending', 'sent', 'mock', 'failed', 'cancelled'));
alter table public.notifications_outbox add column claimed_at timestamptz;
alter table public.notifications_outbox add column provider_message_id text;
create index notifications_outbox_sending_idx on public.notifications_outbox (claimed_at) where status = 'sending';

alter table public.messages drop constraint messages_status_check;
alter table public.messages add constraint messages_status_check
  check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'mock'));

-- A row is stuck when it has been 'sending' for longer than this.
create or replace function private.outbox_stuck_after()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '10 minutes';
$$;

create or replace function private.release_stuck_outbox()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
  v_rows integer;
begin
  -- The provider took it (its id is recorded) but the row was never completed: it was sent.
  update public.notifications_outbox
  set status = 'sent', sent_at = coalesce(sent_at, private.now()), last_error = null
  where channel = 'whatsapp' and status = 'sending' and provider_message_id is not null
    and coalesce(claimed_at, created_at) < private.now() - private.outbox_stuck_after();
  get diagnostics v_n = row_count;
  -- Crashed before or during the send: try again (the claim counted as an attempt).
  update public.notifications_outbox
  set status = case when attempts >= 5 then 'failed' else 'pending' end,
      last_error = 'stuck_sending', send_after = private.now()
  where channel = 'whatsapp' and status = 'sending' and provider_message_id is null
    and coalesce(claimed_at, created_at) < private.now() - private.outbox_stuck_after();
  get diagnostics v_rows = row_count;
  return v_n + v_rows;
end;
$$;

select cron.schedule('tiffin-outbox-stuck', '*/5 * * * *', $$select private.release_stuck_outbox()$$);

-- wave 2's claim (expiry, per-phone conversation), now stamping claimed_at.
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

-- Outbox worker: record the outcome. p_mock: the worker runs in WHATSAPP_MODE=mock (nothing left
-- the server). Failures retry with backoff (5 attempts). A sent row is final.
drop function public.wa_complete_outbox(uuid, boolean, text, text, text, boolean);
create function public.wa_complete_outbox(p_id uuid, p_ok boolean, p_wa_message_id text, p_error text,
  p_rendered text, p_skip boolean default false, p_mock boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.notifications_outbox;
  v_conv uuid;
  v_status text := case when coalesce(p_mock, false) then 'mock' else 'sent' end;
  v_wa_id text := nullif(p_wa_message_id, '');
begin
  select * into v_o from public.notifications_outbox where id = p_id for update;
  if v_o.id is null then
    return;
  end if;
  -- Already sent (or recorded as mock): a repeated completion, a late failure report or a retry
  -- after a lost response changes nothing, so the message can never be queued and sent again.
  if v_o.status in ('sent', 'mock') or v_o.provider_message_id is not null then
    -- One exception: Meta's status webhook can mark the row sent before the worker records it. The
    -- worker's (late) success report for that same message still adds the conversation copy, once
    -- (idempotent on the message id), so the owner sees what was sent and later statuses land on it.
    if coalesce(p_ok, false) and not coalesce(p_skip, false) and v_wa_id is not null
       and v_o.provider_message_id = v_wa_id
       and not exists (select 1 from public.messages m where m.wa_message_id = v_wa_id) then
      v_status := v_o.status;
    else
      return;
    end if;
  elsif p_skip then
    update public.notifications_outbox set status = 'cancelled', last_error = p_error where id = p_id;
    return;
  elsif not coalesce(p_ok, false) then
    -- Only the claim that is still out can fail (a row the stuck sweep re-queued is left alone).
    update public.notifications_outbox
    set status = case when attempts >= 5 then 'failed' else 'pending' end,
        last_error = p_error,
        send_after = private.now() + make_interval(mins => power(2, attempts)::integer)
    where id = p_id and status = 'sending';
    return;
  else
    -- The provider id is stored in the same statement that marks the row sent.
    update public.notifications_outbox
    set status = v_status, sent_at = private.now(), last_error = null, provider_message_id = v_wa_id
    where id = p_id;
  end if;

  if v_o.recipient_type = 'customer' then
    -- The conversation log is a copy for the inbox: a failure here must not undo the send record.
    begin
      select conv.id into v_conv
      from public.customers cu
      join public.conversations conv on conv.kitchen_id = v_o.kitchen_id and conv.wa_phone_hash = cu.phone_hash
      where cu.id = v_o.recipient_id
      order by conv.created_at
      limit 1;
      if v_conv is not null then
        perform public.wa_log_outbound(v_conv, p_rendered, jsonb_build_object('template', v_o.template, 'outbox_id', v_o.id),
          nullif(p_wa_message_id, ''), case when v_o.template in ('vendor_message', 'broadcast') then 'vendor' else 'system' end,
          v_status, v_o.template);
      end if;
    exception when others then
      raise warning 'wa_complete_outbox: conversation log failed for %: %', p_id, sqlerrm;
    end;
  end if;
end;
$$;

-- Delivery statuses from Meta. p_callback is the message's biz_opaque_callback_data: 'outbox:<id>'
-- proves an outbox row was sent even if the worker never recorded it (so it is never sent again).
drop function public.wa_message_status(text, text);
create function public.wa_message_status(p_wa_message_id text, p_status text, p_callback text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.messages set status = p_status
  where wa_message_id = p_wa_message_id and p_status in ('sent', 'delivered', 'read', 'failed')
    and (case status when 'queued' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 4 end)
        < (case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 4 end);
  if p_callback ~ '^outbox:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and p_status in ('sent', 'delivered', 'read') and nullif(p_wa_message_id, '') is not null then
    update public.notifications_outbox
    set status = 'sent', provider_message_id = p_wa_message_id, sent_at = coalesce(sent_at, private.now()), last_error = null
    where id = substr(p_callback, 8)::uuid and status in ('pending', 'sending', 'failed') and provider_message_id is null;
  end if;
end;
$$;

-- Riders: "the customer got a code" only when the 'on the way' message really went out (not
-- pending, not stuck, not mock). Only otp_sent changes, and rider_today is NOT re-created here:
-- wave 1 (20261107000500_vendor_first_engine, item 8) redefines rider_today with the same
-- otp_sent rule plus 'changed'/'changed_at' and skipped meals left out of 'diets'. Re-creating it
-- from an older body would silently revert that on merge. So this patches the definition that is
-- live (whichever migration made it): the older "pending/sent/sending" test becomes "sent". When
-- the live body already counts only 'sent' (wave 1), nothing changes. Any other body fails loudly.
do $$
declare
  v_def text := pg_get_functiondef('public.rider_today()'::regprocedure);
  v_old text := 'n.status in (''pending'', ''sent'', ''sending'')';
  v_new text := 'n.status = ''sent''';
begin
  if position(v_old in v_def) > 0 then
    execute replace(v_def, v_old, v_new);
  elsif position(v_new in v_def) = 0 then
    raise exception 'rider_today: otp_sent rule not found; update 20261115000300 for the new body';
  end if;
end;
$$;

-- Admin metrics: failures include stuck rows; real and mock WhatsApp sends are counted apart.
create or replace function public.platform_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := private.now() - interval '7 days';
  v_stuck bigint;
begin
  perform private.require_admin();
  -- WhatsApp only, like release_stuck_outbox (other channels have their own claim and recovery).
  select count(*) into v_stuck from public.notifications_outbox
  where channel = 'whatsapp' and status = 'sending'
    and coalesce(claimed_at, created_at) < private.now() - private.outbox_stuck_after();
  return jsonb_build_object(
    'kitchens', (select jsonb_build_object('total', count(*), 'active', count(*) filter (where status = 'active'),
                                           'draft', count(*) filter (where status = 'draft'),
                                           'suspended', count(*) filter (where status = 'suspended'),
                                           'goal_live', 30) from public.kitchens),
    'customers', (select jsonb_build_object(
                    'total', count(*), 'on_whatsapp', count(*) filter (where whatsapp_opt_in),
                    'whatsapp_pct', round(100.0 * count(*) filter (where whatsapp_opt_in) / nullif(count(*), 0), 1),
                    'platform_sourced', count(*) filter (where platform_sourced),
                    'platform_paid', (select count(distinct b.customer_id) from public.balance_entries b
                                      join public.customers c2 on c2.id = b.customer_id
                                      where b.type = 'recharge' and c2.platform_sourced))
                  from public.customers where deleted_at is null),
    'subscriptions', (select jsonb_build_object(
                        'live', count(*) filter (where status in ('active', 'low_balance', 'paused')),
                        'trial', count(*) filter (where status = 'trial'),
                        'autopay', count(*) filter (where autopay_mandate_id is not null and status <> 'cancelled'))
                      from public.subscriptions),
    'last_7_days', jsonb_build_object(
      'meals', (select coalesce(sum(o.qty), 0) from public.meal_orders o
                where o.locked_at >= v_from and (o.status <> 'skipped' or o.charged)),
      'collections_paise', (select coalesce(sum(amount_paise), 0) from public.payments where status = 'paid' and paid_at >= v_from),
      'whatsapp_changes', (select count(*) from public.schedule_changes where channel in ('whatsapp', 'web') and requested_at >= v_from),
      'all_changes', (select count(*) from public.schedule_changes where requested_at >= v_from),
      'stops', (select count(*) from public.delivery_stops where done_at >= v_from),
      'stops_proved', (select count(*) from public.delivery_stops where done_at >= v_from and status = 'delivered'
                         and (otp_ok or photo_path is not null)),
      'leads', (select count(*) from public.leads where created_at >= v_from),
      'vendor_applications', (select count(*) from public.vendor_applications where created_at >= v_from),
      -- Real WhatsApp sends only; mock sends (WHATSAPP_MODE=mock) never count as delivered.
      'whatsapp_sent', (select count(*) from public.notifications_outbox where channel = 'whatsapp' and status = 'sent' and sent_at >= v_from),
      'whatsapp_mock', (select count(*) from public.notifications_outbox where channel = 'whatsapp' and status = 'mock' and sent_at >= v_from)),
    'open', jsonb_build_object(
      'escalated_complaints', (select count(*) from public.complaints where status = 'escalated'),
      'vendor_applications', (select count(*) from public.vendor_applications where status in ('new', 'contacted', 'onboarding')),
      'waitlisted_leads', (select count(*) from public.leads where status = 'waitlist'),
      'outbox_failed', (select count(*) from public.notifications_outbox
                        where channel = 'whatsapp' and status = 'failed' and created_at >= v_from) + v_stuck,
      'outbox_stuck', v_stuck)
  );
end;
$$;

-- Grants (fail closed). wa_* stay service-role only; platform_metrics keeps its admin grant.
revoke execute on function private.outbox_stuck_after(), private.release_stuck_outbox() from public, anon, authenticated;
revoke execute on function public.wa_complete_outbox(uuid, boolean, text, text, text, boolean, boolean),
  public.wa_message_status(text, text, text)
  from public, anon, authenticated;
grant execute on function public.wa_complete_outbox(uuid, boolean, text, text, text, boolean, boolean),
  public.wa_message_status(text, text, text)
  to service_role;
