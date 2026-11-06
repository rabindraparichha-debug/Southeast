-- Merge of vendor-first wave 3 riders (wave3/riders-final-2, migrations 20261111000100 – 0400, decisions
-- D-167 – D-179) into m9-p5-p6 (wave 1, login, screens, held-back apps, wave 4, wave 5, wave 2, held-back
-- DB, wave 3 ops and their merge migrations 20261130000100 – 0300).
--
-- Migration timestamps decide which `create or replace` wins. Riders was written on 4e04f88 (before
-- wave 1 and wave 2). A scan of every function, policy, trigger, cron job and view it defines against
-- every other migration found:
--   * private.route_for_address, private.do_fail_stop: riders redefines base / P5 / P6 bodies; no other
--     wave changed them (wave 1's build_runs calls route_for_address with a null address, which riders'
--     version handles). public.rider_today is not redefined by riders (wave 1's body stays).
--   * public.assign_routes_by_area already rebuilds locked slots through private.resync_runs (wave 1:
--     engine_errors recorded and resolved) via private.rebuild_locked_runs; private.notify_owners_push,
--     my_notifications and push_claim_outbox already reach managers (private.is_alert_role). Nothing to merge.
--   * Payments: cash_handover / confirm_rider_cash filter on pending / paid / cancelled, so wave 2's voided
--     payments are already left out (pinned in 20_merge_riders).
-- What this migration changes (both behaviours kept):
--   1. public.push_claim_outbox: the engine clock (private.now(), never now()) and wave 2's expires_at, on
--      top of riders' 12-hour staleness (now measured from send_after, which is on the engine clock).
--   2. public.my_notifications: the 30-day window on the engine clock.
--   3. public.push_complete_outbox: a mock push is recorded as 'mock' (held-back DB, D-157), not 'sent'.
--   4. private.audit_personal_keys (last body 20261130000300): + delivery_stops credit_note and
--      correction_note (riders), so stop notes are diff-only and scrubbed on erasure.

-- 1. Push claim: riders' body (20261111000400) on the engine clock + wave 2's expires_at.
create or replace function public.push_claim_outbox(p_limit integer default 50)
returns table (id uuid, kitchen_id uuid, recipient_id uuid, template text, title text, body text, data jsonb,
               tokens text[], attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- A push is stale 12 hours after it was due (riders), or earlier at wave 2's expires_at; both on the
  -- engine clock (private.now(), so tests and app.now agree).
  update public.notifications_outbox o set status = 'cancelled', last_error = 'expired'
  where o.channel = 'push' and o.status = 'pending'
    and least(coalesce(o.expires_at, 'infinity'::timestamptz), o.send_after + interval '12 hours') <= private.now();

  return query
  with due as (
    select o.id from public.notifications_outbox o
    where o.channel = 'push'
      and ((o.status = 'pending' and o.send_after <= private.now()
            and (o.expires_at is null or o.expires_at > private.now()))
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
                   or exists (select 1 from public.members m where m.user_id = c.recipient_id and m.kitchen_id = c.kitchen_id
                              and private.is_alert_role(m.role::text))
              then coalesce((select array_agg(d.token order by d.last_seen_at desc) from public.member_devices d
                             where d.user_id = c.recipient_id and d.active), '{}')
              else '{}'::text[] end,
         c.attempts
  from claimed c
  left join public.kitchens k on k.id = c.kitchen_id
  cross join lateral (select private.member_alert_text(c.template, c.payload, k.name) as txt) t;
end;
$$;

-- 2. In-app alerts: riders' body (20261111000400) on the engine clock.
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
        -- Last 30 days on the engine clock (send_after defaults to private.now(), wave 1).
        and coalesce(o.send_after, o.created_at) > private.now() - interval '30 days'
        and (p_before is null or o.created_at < p_before)
        -- Member alerts are owner alerts (money, customer names): a member who is no longer an
        -- owner of that kitchen stops seeing them.
        and (o.kitchen_id is null or exists (select 1 from public.members m where m.user_id = auth.uid()
                                             and m.kitchen_id = o.kitchen_id and private.is_alert_role(m.role::text)))
      order by o.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) x), '[]'::jsonb);
end;
$$;

-- 3. Push completion: riders' body (20261111000100) + held-back DB's 'mock' status.
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
  -- Held-back DB (D-157): a mock send is 'mock', never 'sent'.
  set status = case when p_ok and coalesce(p_mock, false) then 'mock' when p_ok then 'sent'
                    when attempts >= 5 then 'failed' else 'pending' end,
      sent_at = case when p_ok then private.now() end,
      last_error = case when p_ok then null else left(p_error, 500) end,
      send_after = case when p_ok then send_after else private.now() + make_interval(mins => power(2, attempts)::integer) end
  where id = p_id and channel = 'push';
end;
$$;

-- 4. Lean audit keys: 20261130000300's body + riders' stop notes.
create or replace function private.audit_personal_keys(p_table text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_table
    when 'customers' then array['name', 'notes', 'phone_last4']
    when 'addresses' then array['label', 'line1', 'landmark', 'delivery_notes', 'lat', 'lng', 'geo_point']
    when 'customer_health' then array['tags']
    when 'complaints' then array['description', 'photo_url', 'resolution_note']
    -- + wave 3 riders' stop-credit and correction notes.
    when 'delivery_stops' then array['gps_lat', 'gps_lng', 'gps_accuracy_m', 'gps_distance_m', 'failed_note', 'photo_path',
                                     'credit_note', 'correction_note']
    when 'delivery_runs' then array['last_lat', 'last_lng']
    when 'kitchen_reviews' then array['comment']
    when 'kitchen_switch_requests' then array['reason', 'decision_note']
    when 'leads' then array['name', 'phone_last4', 'address_text', 'lat', 'lng', 'geo_point', 'notes']
    when 'vendor_applications' then array['name', 'phone_last4', 'lat', 'lng', 'notes']
    when 'member_invites' then array['display_name']
    when 'members' then array['display_name']
    when 'offices' then array['contact_name', 'contact_phone_last4']
    -- Wave 2: rider change requests (the rider's and the approver's notes, an address request's text).
    when 'change_requests' then array['note', 'decision_note']
    -- Held-back apps: refused rider actions (summary carries the stop label and the rider's note).
    when 'rider_sync_rejects' then array['summary', 'resolution_note']
  end;
$$;
