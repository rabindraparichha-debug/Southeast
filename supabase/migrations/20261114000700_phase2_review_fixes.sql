-- Phase 2 hardening, review fixes (D-135).
--
--   (1) Delivery codes: a resent wrong-code submit (same p_client_op, e.g. the answer was lost on a
--       flaky network) gets the same 'pending' answer and is not counted again. The op id of the
--       last wrong code is kept on the stop (delivery_stops.otp_last_op).
--   (2) Referral join (D-127):
--       * every accepted join attempt is counted (referral_join_attempts) BEFORE we look at whether
--         the number is already a customer, and the 5-per-code / 30-per-kitchen limits apply to all
--         of them. Over the limit every number gets too_many_requests, so the limit no longer tells
--         an existing customer's number from a new one;
--       * a number already on the kitchen's books still gets the same answer, but the owners are told
--         (template referral_existing: the name, plan and start the person typed, and which customer
--         that number belongs to), so a lapsed customer or a family member is called back;
--       * the page cannot prove who holds the phone, so it no longer records WhatsApp opt-in or a
--         'whatsapp' consent. The wish goes to the owner (notes and message); the customer turns
--         updates on by sending "updates" to the platform number (the bot's opt-in, from that phone).
--   (3) Google Ads (D-131): rows earlier stored 'skipped' (no conversion action id set, usual before
--       go-live) or 'sent' by the old mock become 'mock', so the first live run uploads them;
--       admin_requeue_mock_conversions() also requeues 'skipped' rows (after adding an action id).
--   (4) complaint_admin_events (D-132): erasing a customer (customers.deleted_at set) blanks the team's
--       notes on that customer's complaints. The log stays append-only otherwise: the only update
--       allowed is that scrub (note to null, nothing else), with tiffin.audit_scrub on.

-- ---------------------------------------------------------------------------
-- (1) Delivery codes
-- ---------------------------------------------------------------------------
alter table public.delivery_stops add column otp_last_op uuid;

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
  -- The same wrong-code submit sent again (its answer was lost): same answer, not another attempt.
  if p_client_op is not null and v_s.otp_last_op = p_client_op then
    return jsonb_build_object('stop_id', p_stop, 'status', 'pending', 'otp_ok', false, 'conflict', false,
                              'otp_attempts_left', greatest(0, 5 - v_s.otp_attempts),
                              'locked', v_s.otp_attempts >= 5);
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
      update public.delivery_stops set otp_attempts = otp_attempts + 1, otp_last_op = p_client_op where id = p_stop;
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
-- (2) Referral join
-- ---------------------------------------------------------------------------
-- One row per accepted join attempt (valid code and plan), whatever the number. No phone, no name.
create table public.referral_join_attempts (
  id bigint generated always as identity primary key,
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  referrer_customer_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (referrer_customer_id, kitchen_id) references public.customers (id, kitchen_id) on delete cascade
);
create index referral_join_attempts_kitchen_idx on public.referral_join_attempts (kitchen_id, created_at);
create index referral_join_attempts_referrer_idx on public.referral_join_attempts (referrer_customer_id, created_at);
create index referral_join_attempts_created_idx on public.referral_join_attempts (created_at);

alter table public.referral_join_attempts enable row level security;
create policy referral_join_attempts_select on public.referral_join_attempts for select to authenticated
  using ((select private.is_platform_admin()));
revoke all on public.referral_join_attempts from anon, authenticated;
grant select on public.referral_join_attempts to authenticated;

create or replace function public.referral_join(
  p_slug text,
  p_code text,
  p_name text,
  p_phone text,
  p_plan uuid,
  p_address text,
  p_area text default null,
  p_landmark text default null,
  p_start_date date default null,
  p_consent boolean default false,
  p_whatsapp_opt_in boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_phone text := private.normalize_phone(p_phone);
  v_p public.plans;
  v_start date;
  v_customer uuid;
  v_existing public.customers;
  v_address uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_wa boolean := coalesce(p_whatsapp_opt_in, false);
  v_answer jsonb;
begin
  perform private.require_feature('customer_portal');
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if length(v_name) not between 1 and 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_address, ''))) not between 3 and 200 or length(coalesce(p_area, '')) > 80
     or length(coalesce(p_landmark, '')) > 120 then
    raise exception 'invalid_address' using errcode = '22023';
  end if;
  if length(coalesce(p_slug, '')) > 80 or length(coalesce(p_code, '')) > 40 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select * into v_t from private.referral_target(p_slug, p_code);
  if v_t.code_status = 'other_kitchen' then
    raise exception 'referral_other_kitchen' using errcode = '22023';
  elsif v_t.code_status <> 'ok' then
    raise exception 'invalid_referral_code' using errcode = '22023';
  end if;
  select * into v_p from public.plans where id = p_plan and kitchen_id = (v_t.kitchen).id and active;
  if v_p.id is null then
    raise exception 'no_plan' using errcode = '22023';
  end if;
  v_start := coalesce(p_start_date, private.ist_today() + 1);
  if v_start < private.ist_today() + 1 or v_start > private.ist_today() + 30 then
    raise exception 'invalid_date' using errcode = '22023';
  end if;

  -- A shared link cannot fill a kitchen's books or test numbers: 5 attempts per code, 30 per kitchen,
  -- per 24 hours, counted before (and whatever) we know about the number.
  delete from public.referral_join_attempts where created_at < private.now() - interval '2 days';
  if (select count(*) from public.referral_join_attempts a where a.referrer_customer_id = (v_t.referrer).id
        and a.created_at > private.now() - interval '24 hours') >= 5
     or (select count(*) from public.referral_join_attempts a where a.kitchen_id = (v_t.kitchen).id
           and a.created_at > private.now() - interval '24 hours') >= 30 then
    raise exception 'too_many_requests' using errcode = '22023';
  end if;
  insert into public.referral_join_attempts (kitchen_id, referrer_customer_id, created_at)
  values ((v_t.kitchen).id, (v_t.referrer).id, private.now());

  v_answer := jsonb_build_object('ok', true, 'kitchen_name', (v_t.kitchen).name, 'trial_meals', (v_t.kitchen).trial_meals);

  -- Already this kitchen's customer (a lapsed customer coming back, or a family member on a shared
  -- number): nothing changes and the answer is the same, but the owners are told, to call back.
  select * into v_existing from public.customers
  where kitchen_id = (v_t.kitchen).id and phone_hash = private.phone_hash(v_phone) and deleted_at is null
  order by created_at limit 1;
  if v_existing.id is not null then
    perform private.notify_owners((v_t.kitchen).id, 'referral_existing',
      jsonb_build_object('customer_name', v_name, 'existing_name', v_existing.name, 'existing_customer_id', v_existing.id,
                         'referrer_name', (v_t.referrer).name, 'plan_name', v_p.name, 'start_date', v_start,
                         'whatsapp_requested', v_wa),
      'referral_existing:' || v_existing.id || ':' || private.ist_today());
    return v_answer;
  end if;

  -- WhatsApp opt-in is not recorded from this page: it cannot prove who holds the phone.
  insert into public.customers (kitchen_id, name, phone_enc, phone_hash, phone_last4, source, platform_sourced,
    whatsapp_opt_in, preferred_language, diet, notes, consent_at, consent_basis)
  values ((v_t.kitchen).id, v_name, private.encrypt_phone(v_phone), private.phone_hash(v_phone), right(v_phone, 4), 'web', false,
    false, 'en', v_p.diet,
    'Joined with ' || split_part((v_t.referrer).name, ' ', 1) || '''s invite (' || (v_t.referrer).referral_code || ')'
      || case when v_wa then '. Asked for WhatsApp updates: they turn them on by sending "updates" to the platform number.' else '' end,
    private.now(), 'customer')
  returning id into v_customer;
  insert into public.consents (kitchen_id, customer_id, purpose, basis, channel)
  values ((v_t.kitchen).id, v_customer, 'service_contact', 'customer', 'web');
  insert into public.addresses (kitchen_id, customer_id, label, line1, area, landmark)
  values ((v_t.kitchen).id, v_customer, 'Home', trim(p_address), nullif(trim(p_area), ''), nullif(trim(p_landmark), ''))
  returning id into v_address;
  insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
  values ((v_t.kitchen).id, v_customer, v_p.id, v_address, v_start, 'trial');
  perform private.link_referral(v_customer, (v_t.referrer).referral_code, 'link');

  perform private.notify_owners((v_t.kitchen).id, 'referral_customer',
    jsonb_build_object('customer_name', v_name, 'area', nullif(trim(p_area), ''), 'referrer_name', (v_t.referrer).name,
                       'plan_name', v_p.name, 'trial_meals', (v_t.kitchen).trial_meals, 'start_date', v_start,
                       'whatsapp_requested', v_wa),
    'referral_customer:' || v_customer);
  return v_answer;
end;
$$;

-- ---------------------------------------------------------------------------
-- (3) Google Ads: nothing handled before go-live is lost
-- ---------------------------------------------------------------------------
update public.ad_conversions
set status = 'mock', attempts = 0, sent_at = null, last_error = 'not sent: mock mode'
where status = 'skipped' or (status = 'sent' and last_error = 'mock');

create or replace function public.admin_requeue_mock_conversions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform private.require_admin();
  update public.ad_conversions set status = 'pending', attempts = 0, last_error = null where status in ('mock', 'skipped');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- (4) The team's complaint notes go with an erased customer
-- ---------------------------------------------------------------------------
create or replace function private.complaint_admin_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('tiffin.audit_scrub', true) = 'on' and new.note is null
     and (new.id, new.complaint_id, new.kitchen_id, new.admin_id, new.action, new.detail, new.created_at)
         is not distinct from (old.id, old.complaint_id, old.kitchen_id, old.admin_id, old.action, old.detail, old.created_at) then
    return new;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end;
$$;

drop trigger complaint_admin_events_no_update on public.complaint_admin_events;
create trigger complaint_admin_events_no_update before update on public.complaint_admin_events
  for each row execute function private.complaint_admin_events_guard();

create or replace function private.complaint_notes_erase()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform set_config('tiffin.audit_scrub', 'on', true);
    update public.complaint_admin_events e set note = null
    where e.note is not null and e.complaint_id in (select c.id from public.complaints c where c.customer_id = new.id);
    perform set_config('tiffin.audit_scrub', '', true);
  end if;
  return null;
end;
$$;

create trigger customers_erased_complaint_notes after update of deleted_at on public.customers
  for each row execute function private.complaint_notes_erase();

revoke execute on function private.complaint_admin_events_guard(), private.complaint_notes_erase() from public, anon, authenticated;
