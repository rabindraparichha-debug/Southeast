-- Phase 2 hardening, step 1: delivery codes (docs/VENDOR_FIRST_AUDIT.md, Phase 2 step 5, "the
-- delivery OTP is weak"; D-126).
--
--   (a) The wrong-code lockout sticks. A raised exception rolled back the attempt counter, so the 5th
--       wrong code never locked anything. A wrong code now RETURNS (status 'pending', otp_ok false,
--       otp_attempts_left, locked) instead of raising, so the counter is saved. Once a stop has 5 wrong
--       codes, OTP proof is refused with otp_locked (nothing is written then, so raising is fine); the
--       rider delivers with a photo or "Delivered" instead.
--   (b) An offline submit with a wrong code is no longer recorded as delivered. It counts as an attempt
--       and gets the same 'pending' answer, which the rider queue already parks in "needs attention"
--       (reason otp_wrong) with its photo and cash amount kept (judgeResult in rider-queue.ts).
--   (c) Codes do not stay readable: 'otp' is a redacted audit column (private.audit_redacted_columns,
--       column-level; private.audit_row is unchanged) and existing audit rows have it replaced with
--       "[erased]"; an outbox row loses payload.otp as soon as it is no longer pending/sending; the
--       logged copy of a sent "on the way" message has the code masked.

-- ---------------------------------------------------------------------------
-- (a) + (b)
-- ---------------------------------------------------------------------------
create or replace function private.do_complete_stop(
  p_stop uuid, p_proof public.proof_type, p_otp text, p_photo_path text,
  p_lat double precision, p_lng double precision, p_accuracy real, p_at timestamptz,
  p_tiffins_out integer, p_tiffins_returned integer, p_cash_paise integer, p_client_op uuid,
  p_offline boolean, p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op_stop uuid;
  v_s public.delivery_stops;
  v_run public.delivery_runs;
  v_a public.addresses;
  v_at timestamptz;
  v_otp_ok boolean;
  v_dist integer;
  v_order uuid;
  v_payment uuid;
  v_price integer;
begin
  -- Idempotency is per stop: a retried op returns its own stop's result; an op id that already
  -- belongs to another stop is refused (it would otherwise answer with someone else's result).
  if p_client_op is not null then
    select id into v_op_stop from public.delivery_stops where client_op_id = p_client_op;
    if v_op_stop is not null then
      if v_op_stop <> p_stop then
        raise exception 'invalid_client_op' using errcode = '22023';
      end if;
      return private.stop_result(v_op_stop);
    end if;
  end if;
  select * into v_s from public.delivery_stops where id = p_stop for update;
  select * into v_run from public.delivery_runs where id = v_s.run_id for update;
  if v_s.status <> 'pending' then
    return private.stop_result(p_stop, true); -- first write wins
  end if;
  if p_proof is null then
    raise exception 'proof_required' using errcode = '22023';
  end if;
  if p_proof = 'photo' and nullif(trim(p_photo_path), '') is null then
    raise exception 'photo_required' using errcode = '22023';
  end if;
  if p_photo_path is not null and split_part(p_photo_path, '/', 1) <> v_s.kitchen_id::text then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;
  if coalesce(p_cash_paise, 0) < 0 or coalesce(p_tiffins_out, 0) < 0 or coalesce(p_tiffins_returned, 0) < 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  if p_proof = 'otp' then
    -- 5 wrong codes lock OTP proof for this stop (even a right code: 10,000 codes, 5 tries).
    if v_s.otp_attempts >= 5 then
      raise exception 'otp_locked' using errcode = '22023';
    end if;
    v_otp_ok := v_s.otp is not null and trim(coalesce(p_otp, '')) = v_s.otp;
    if not v_otp_ok then
      -- Online or offline, a wrong code never delivers. Returned, not raised, so the attempt is saved.
      update public.delivery_stops set otp_attempts = otp_attempts + 1 where id = p_stop;
      return jsonb_build_object('stop_id', p_stop, 'status', 'pending', 'otp_ok', false, 'conflict', false,
                                'otp_attempts_left', greatest(0, 4 - v_s.otp_attempts),
                                'locked', v_s.otp_attempts + 1 >= 5);
    end if;
  end if;

  v_at := private.client_time(p_at, v_run.service_date);
  select * into v_a from public.addresses where id = v_s.address_id;
  if p_lat is not null and v_a.lat is not null then
    v_dist := round(private.km_between(p_lat, p_lng, v_a.lat, v_a.lng) * 1000);
  end if;

  if v_run.status = 'planned' then
    perform private.do_start_run(v_run.id, v_at, p_actor);
  end if;

  if coalesce(p_cash_paise, 0) > 0 then
    select id into v_order from public.meal_orders where stop_id = p_stop order by created_at limit 1;
    v_price := private.customer_unit_price(v_s.customer_id);
    insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, note, collected_by,
                                 meal_order_id, created_by, created_at)
    values (v_s.kitchen_id, v_s.customer_id, 'cash', 'pending', p_cash_paise,
            greatest(1, coalesce(p_cash_paise / nullif(v_price, 0), 1)), 'Collected at the door', p_actor, v_order,
            p_actor, v_at)
    returning id into v_payment;
  end if;

  update public.delivery_stops
  set status = 'delivered', proof_type = p_proof, otp_ok = v_otp_ok, photo_path = nullif(trim(p_photo_path), ''),
      gps_lat = p_lat, gps_lng = p_lng, gps_accuracy_m = p_accuracy, gps_distance_m = v_dist,
      done_at = v_at, device_at = case when p_at is distinct from v_at then p_at end, synced_at = private.now(),
      offline = coalesce(p_offline, false), tiffins_out = coalesce(p_tiffins_out, 0),
      tiffins_returned = coalesce(p_tiffins_returned, 0), cash_payment_id = v_payment, client_op_id = p_client_op,
      done_by = p_actor
  where id = p_stop;

  update public.meal_orders set status = 'delivered' where stop_id = p_stop and status <> 'skipped';

  if coalesce(p_tiffins_out, 0) > 0 or coalesce(p_tiffins_returned, 0) > 0 then
    insert into public.tiffin_ledger (kitchen_id, customer_id, stop_id, tiffins_out, tiffins_returned, created_by, created_at)
    values (v_s.kitchen_id, v_s.customer_id, p_stop, coalesce(p_tiffins_out, 0), coalesce(p_tiffins_returned, 0), p_actor, v_at)
    on conflict (stop_id) where stop_id is not null do nothing;
  end if;

  return private.stop_result(p_stop);
end;
$$;

-- ---------------------------------------------------------------------------
-- (c) Audit log: 'otp' is never copied. The list is the union of every redaction any change needs
-- (the wave 3 lean-audit list included), so applying either migration last keeps all of them.
-- ---------------------------------------------------------------------------
create or replace function private.audit_redacted_columns()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['phone_enc', 'phone_hash', 'token_hash', 'contact_phone_enc', 'otp', 'phone_e164'];
$$;

-- One-time: codes already in the log become "[erased]" (same keys, values replaced: the shape the
-- scrub-only audit guard accepts, if it exists, with tiffin.audit_scrub on).
do $$
begin
  perform set_config('tiffin.audit_scrub', 'on', true);
  alter table public.audit_log disable trigger audit_log_append_only;
  update public.audit_log
  set before = case when before ->> 'otp' is not null and before ->> 'otp' <> '[erased]'
                    then jsonb_set(before, '{otp}', '"[erased]"') else before end,
      after = case when after ->> 'otp' is not null and after ->> 'otp' <> '[erased]'
                   then jsonb_set(after, '{otp}', '"[erased]"') else after end
  where table_name = 'delivery_stops'
    and ((before ->> 'otp' is not null and before ->> 'otp' <> '[erased]')
         or (after ->> 'otp' is not null and after ->> 'otp' <> '[erased]'));
  alter table public.audit_log enable trigger audit_log_append_only;
  perform set_config('tiffin.audit_scrub', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- (c) Outbox: the code is needed only to send. Once a row is sent, failed, cancelled (also when it is
-- stored cancelled at insert, e.g. a customer who has not opted in) or expired, payload.otp goes.
-- Named so it runs after the other BEFORE triggers (they fire in name order) and sees the final status.
-- ---------------------------------------------------------------------------
create or replace function private.outbox_scrub_codes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status not in ('pending', 'sending') and new.payload ? 'otp' then
    new.payload := new.payload - 'otp';
  end if;
  return new;
end;
$$;

create trigger notifications_outbox_scrub_codes before insert or update on public.notifications_outbox
  for each row execute function private.outbox_scrub_codes();

update public.notifications_outbox set payload = payload - 'otp'
where payload ? 'otp' and status not in ('pending', 'sending');

-- ---------------------------------------------------------------------------
-- (c) Conversation log: the copy of a sent "on the way" message keeps everything but the code.
-- The code follows ": " in every language of on_the_way_v1 ("Delivery code: 1234.").
-- ---------------------------------------------------------------------------
create or replace function private.message_mask_codes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.direction = 'out' and new.body is not null
     and (new.bot_intent = 'on_the_way' or new.payload ->> 'template' = 'on_the_way') then
    new.body := regexp_replace(new.body, ': [0-9]{4}(?![0-9])', ': ••••', 'g');
  end if;
  return new;
end;
$$;

create trigger messages_mask_codes before insert on public.messages
  for each row execute function private.message_mask_codes();

update public.messages set body = regexp_replace(body, ': [0-9]{4}(?![0-9])', ': ••••', 'g')
where direction = 'out' and (bot_intent = 'on_the_way' or payload ->> 'template' = 'on_the_way')
  and body ~ ': [0-9]{4}(?![0-9])';

revoke execute on function private.outbox_scrub_codes(), private.message_mask_codes() from public, anon, authenticated;
