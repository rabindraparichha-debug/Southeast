-- Merge of vendor-first wave 3 ops (wave3/ops-retry, migrations 20261110000100 – 0400, decisions
-- D-158 – D-166) into m9-p5-p6 (wave 1, login, screens, held-back apps, wave 4, wave 5, wave 2,
-- held-back DB and their merge migrations 20261130000100 – 0200).
--
-- Migration timestamps decide which `create or replace` wins. A scan of every function, policy,
-- trigger, cron job and view ops defines against every other migration found:
--   * private.audit_redacted_columns: ops (20261110000200) and wave 5 (20261114000100) define the same
--     list (wave 5 started from ops' body): nothing to merge.
--   * private.audit_row, private.customer_erased_cleanup, trigger audit_log_append_only: ops redefines
--     base / P5 / P6 bodies; no later migration touches them.
--   * Engine health already reads wave 1's engine_errors (last_seen_at, resolved_at) statically, and
--     freeze_slot already calls private.resolve_engine_errors after private.lock_slot (ops-retry was
--     rebased onto wave 1). Pinned by 19_merge_ops.
-- What this migration adds: tables and jobs later waves created that ops' lists predate (both kept):
--   1. private.engine_jobs / private.run_job: wave 4's tiffin-plan-prices runs through run_job
--      (heartbeat, non-critical), as wave 4 asked at merge; rescheduled with the same timing.
--   2. private.audit_personal_keys / private.customer_audit_tables: wave 2's change_requests (note,
--      decision_note) and held-back apps' rider_sync_rejects (summary, resolution_note) keep only
--      changed keys and are scrubbed on erasure.
--   3. private.customer_erased_cleanup: also blanks those notes for the erased customer (held-back apps
--      asked at merge: summary.note / summary.stop_label of rider_sync_rejects, matched on customer_id).

-- 1. Engine jobs: ops' list + wave 4's tiffin-plan-prices.
create or replace function private.engine_jobs()
returns table (job text, critical boolean, max_age interval)
language sql
immutable
set search_path = ''
as $$
  values ('tiffin-lock-due-slots', true, interval '5 minutes'),
         ('tiffin-nightly', true, interval '26 hours'),
         ('tiffin-owner-summary', true, interval '26 hours'),
         ('tiffin-purge', false, interval '26 hours'),
         ('tiffin-storage-retention', false, interval '26 hours'),
         -- Wave 4: moves plans.price_per_meal_paise when a scheduled price starts (00:05 IST). Not
         -- critical: charging reads plan_prices directly (private.charge_orders).
         ('tiffin-plan-prices', false, interval '26 hours');
$$;

insert into public.engine_heartbeats (job) values ('tiffin-plan-prices') on conflict do nothing;

create or replace function private.run_job(p_job text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t0 timestamptz := clock_timestamp();
  v_result jsonb;
begin
  case p_job
    when 'tiffin-lock-due-slots' then perform private.run_due_locks();
    when 'tiffin-nightly' then perform private.nightly();
    when 'tiffin-owner-summary' then perform private.queue_owner_summaries();
    when 'tiffin-purge' then v_result := private.purge_old_data();   -- defined by the retention migration
    when 'tiffin-plan-prices' then v_result := jsonb_build_object('plans_updated', private.apply_plan_prices());
    else raise exception 'unknown_job' using errcode = '22023';
  end case;
  perform private.record_heartbeat(p_job, v_t0, v_result);
end;
$$;

select cron.schedule('tiffin-plan-prices', '35 18 * * *', $$select private.run_job('tiffin-plan-prices')$$); -- 00:05 IST

-- 2. Lean audit and erasure scrub: ops' lists + wave 2's change_requests + held-back apps' rider_sync_rejects.
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
    when 'delivery_stops' then array['gps_lat', 'gps_lng', 'gps_accuracy_m', 'gps_distance_m', 'failed_note', 'photo_path']
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

create or replace function private.customer_audit_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['customers', 'addresses', 'customer_health', 'complaints', 'delivery_stops', 'kitchen_reviews',
               'kitchen_switch_requests', 'change_requests', 'rider_sync_rejects'];
$$;

-- 3. Erasure: ops' body (20261110000300) + change request notes + refused rider action notes.
create or replace function private.customer_erased_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    -- P5/P6: stops paying for others, health data deleted, leaves its office.
    update public.customers set payer_customer_id = null where payer_customer_id = new.id;
    delete from public.customer_health where customer_id = new.id;
    update public.customers set office_id = null where id = new.id and office_id is not null;

    -- Delivery records keep their status and counts, not where or what was seen.
    insert into public.storage_purge_queue (bucket, name, reason, kitchen_id)
    select 'proofs', s.photo_path, 'erasure', s.kitchen_id
    from public.delivery_stops s
    where s.customer_id = new.id and s.photo_path is not null
    on conflict do nothing;
    update public.delivery_stops
    set gps_lat = null, gps_lng = null, gps_accuracy_m = null, gps_distance_m = null, failed_note = null, photo_path = null
    where customer_id = new.id
      and (gps_lat is not null or gps_lng is not null or gps_accuracy_m is not null or gps_distance_m is not null
           or failed_note is not null or photo_path is not null);

    update public.complaints set description = null, photo_url = null, resolution_note = null
    where customer_id = new.id and (description is not null or photo_url is not null or resolution_note is not null);
    update public.kitchen_reviews set comment = null where customer_id = new.id and comment is not null;
    update public.kitchen_switch_requests set reason = null, decision_note = null
    where (customer_id = new.id or new_customer_id = new.id) and (reason is not null or decision_note is not null);

    -- Wave 2: rider change requests about them (notes, an address request's text).
    update public.change_requests set note = null, decision_note = null
    where customer_id = new.id and (note is not null or decision_note is not null);
    -- Held-back apps: refused rider actions at their stops keep code, cash and times, not the stop
    -- label or the rider's note (D-128 of that track, renumbered; see its review fixes).
    update public.rider_sync_rejects set summary = summary - 'note' - 'stop_label', resolution_note = null
    where customer_id = new.id and (summary ? 'note' or summary ? 'stop_label' or resolution_note is not null);

    -- The import row that created them (the phone was never stored there, only its last 4 digits).
    update public.import_rows set raw = jsonb_build_object('erased', true)
    where customer_id = new.id and raw <> jsonb_build_object('erased', true);

    -- WhatsApp: forget the chat with their number, unless another live customer here shares it.
    for r in
      select c.id, c.customer_id,
             exists (select 1 from public.customers o
                     where o.kitchen_id = c.kitchen_id and o.id <> new.id and o.deleted_at is null
                       and o.phone_hash = c.wa_phone_hash) as shared
      from public.conversations c
      where c.kitchen_id = new.kitchen_id
        and (c.customer_id = new.id or (old.phone_hash is not null and c.wa_phone_hash = old.phone_hash))
    loop
      if r.shared then
        update public.conversations
        set customer_id = case when customer_id = new.id then null else customer_id end,
            contact_name = case when customer_id = new.id then null else contact_name end,
            state = case when customer_id = new.id then '{}'::jsonb else state end
        where id = r.id;
      else
        update public.complaints set conversation_id = null where conversation_id = r.id;
        delete from public.conversations where id = r.id;  -- messages go with it (on delete cascade)
      end if;
    end loop;

    -- Messages to them (queued or already sent) carry their name and details. So do money messages
    -- about them rerouted to their payer (P5: payload.eater_customer_id / eater_name).
    delete from public.notifications_outbox
    where status <> 'sending'
      and ((recipient_type = 'customer' and recipient_id = new.id)
           or (kitchen_id = new.kitchen_id and payload ->> 'eater_customer_id' = new.id::text));
    -- Owner alerts name them (complaint, inbox hand-off, switched out: payload.customer_name). The alert
    -- itself stays (the owner may still need to act); the name becomes "[erased]".
    if old.name is not null and old.name <> '' then
      update public.notifications_outbox
      set payload = private.audit_scrub(payload, array['customer_name', 'customer_phone', 'eater_name'])
      where kitchen_id = new.kitchen_id and recipient_type = 'member' and status <> 'sending'
        and (payload ->> 'customer_name' = old.name or payload ->> 'eater_name' = old.name);
    end if;

    -- The platform lead that became this customer (M7): forget who they were, keep the funnel
    -- (source, campaign, stage timestamps, chosen kitchen) for reporting and commission.
    for r in select l.id from public.leads l where l.customer_id = new.id loop
      update public.leads
      set name = null, phone_enc = null, phone_hash = null, phone_last4 = null, address_text = null,
          lat = null, lng = null, notes = null, lost_reason = null, token_hash = null, bot_step = null
      where id = r.id;
      perform private.scrub_lead_audit(r.id);
    end loop;

    -- Last, so the audit rows written by the scrubs above are covered too.
    perform private.scrub_customer_audit(new.kitchen_id, new.id);
  end if;
  return null;
end;
$$;
