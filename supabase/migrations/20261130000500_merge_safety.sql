-- Merge of vendor-first wave 3 safety (wave3/safety-final, migrations 20261112000100 – 0700, decisions
-- D-180 – D-187; this merge's own choice is D-188) into m9-p5-p6 (wave 1, login, screens, held-back apps,
-- wave 4, wave 5, wave 2, held-back DB, wave 3 ops and riders, merge migrations 20261130000100 – 0400).
--
-- Migration timestamps decide which `create or replace` wins. Safety was written on fe982e4 (wave 1,
-- login, screens, held-back apps; before wave 2, 4 and 5). A scan of every function, policy, trigger,
-- cron job and view it defines against every other migration found that it redefines only base bodies
-- (guard_fssai, payment_link_record, portal_customer, kitchen_directory, kitchen_profile, lead_choose,
-- submit_lead, submit_vendor_application, mark_refund_submitted, razorpay_process_event); no wave 2, 4, 5,
-- held-back or ops/riders migration redefines any of them, and no later migration grants the three
-- form RPCs back to anon. Wave 2's portal_get starts with private.portal_customer, so it picks up
-- safety's customer_portal gate and revocable links unchanged. feature_flags() returns the phase-flag
-- allowlist only (never ops' retention row or wave 4's open_vendor_signup).
-- What this migration changes (both behaviours kept):
--   1. public.lead_choose (D-188): also requires customer_whatsapp. Safety's pick only sends a WhatsApp
--      confirmation link to the lead (lead_confirm turns it into a customer), and wave 2's outbox gate
--      cancels every lead message while customer_whatsapp is off: the visitor would be told "sent" and
--      nothing would arrive. With marketplace on and customer_whatsapp off it now answers feature_disabled.
--   2. private.member_alert_text (riders, 20261111000100): a push/in-app text for safety's member
--      template transfer_failed (it fell back to the generic text).

-- 1. Lead pick: safety's body (20261112000400) + the customer_whatsapp requirement.
create or replace function public.lead_choose(p_token text, p_kitchen uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.leads;
  v_k public.kitchens;
  v_confirm text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
begin
  perform private.require_feature('marketplace');
  -- Merge (D-188): the pick is confirmed only through a WhatsApp message to the lead. While customer
  -- WhatsApp is off, wave 2's outbox gate cancels that message, so refuse before saying "sent".
  perform private.require_feature('customer_whatsapp');
  perform private.rate_limit('lead_choose_ip_hour', private.request_client_ip(), 20, interval '1 hour');
  select * into v_l from public.leads
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and token_expires_at > private.now()
  for update;
  if v_l.id is null then
    raise exception 'invalid_link' using errcode = '22023';
  end if;
  perform private.rate_limit('lead_choose_lead_hour', v_l.id::text, 5, interval '1 hour', 'too_many_requests');
  select * into v_k from public.kitchens where id = p_kitchen;
  if v_k.id is null or v_k.status <> 'active' or not v_k.accepts_platform_leads
     or not (case when private.lead_decided(v_l)
                  then exists (select 1 from private.match_kitchens(v_l.id, 3) m where m.kitchen_id = p_kitchen)
                  else exists (select 1 from public.lead_matches where lead_id = v_l.id and kitchen_id = p_kitchen) end) then
    raise exception 'kitchen_not_available' using errcode = '22023';
  end if;
  perform private.rate_limit('lead_confirm_message_day', v_l.id::text, 3, interval '1 day', 'too_many_requests');
  -- Already decided: answer exactly as below, but send nothing (the phone holder has their link).
  if private.lead_decided(v_l) then
    return jsonb_build_object('status', 'confirm_sent', 'kitchen_name', v_k.name, 'phone_last4', v_l.phone_last4);
  end if;

  insert into public.lead_confirmations (lead_id, kitchen_id, token_hash, expires_at, created_at)
  values (v_l.id, p_kitchen, encode(extensions.digest(v_confirm, 'sha256'), 'hex'), private.now() + interval '24 hours', private.now())
  on conflict (lead_id) do update
    set kitchen_id = excluded.kitchen_id, token_hash = excluded.token_hash, expires_at = excluded.expires_at,
        created_at = excluded.created_at, used_at = null;
  insert into public.notifications_outbox (channel, recipient_type, recipient_id, template, payload, dedupe_key)
  values ('whatsapp', 'lead', v_l.id, 'lead_confirm',
          jsonb_build_object('name', split_part(coalesce(nullif(trim(v_l.name), ''), 'there'), ' ', 1), 'kitchen_name', v_k.name,
                             'trial_meals', v_k.trial_meals, 'url', private.public_web_url() || '/find/confirm/' || v_confirm),
          'lead_confirm:' || v_l.id || ':' || left(encode(extensions.digest(v_confirm, 'sha256'), 'hex'), 16))
  on conflict (dedupe_key) do nothing;
  perform private.lead_event(v_l.id, 'confirm_sent', jsonb_build_object('kitchen_id', p_kitchen));
  return jsonb_build_object('status', 'confirm_sent', 'kitchen_name', v_k.name, 'phone_last4', v_l.phone_last4);
end;
$$;

-- 2. Member alert texts: riders' body (20261111000100) + safety's transfer_failed.
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
    -- Wave 3 safety: Razorpay Route could not pay the kitchen its share (template transfer_failed).
    when 'transfer_failed' then jsonb_build_object(
      'title', 'Bank transfer failed',
      'body', format('%s from an online payment did not reach your bank (%s). Our team is looking into it.',
        case when p ? 'amount_paise' then private.fmt_rupees((p ->> 'amount_paise')::numeric) else 'A payment' end,
        left(coalesce(p ->> 'error', 'transfer failed'), 120)),
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
