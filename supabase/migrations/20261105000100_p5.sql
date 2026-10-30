-- P5: parent pays (payer), Odisha food calendar (veg days, Kartika, festival specials), dispatch
-- photo + QR stickers, complaint scores + first-complaint credit, rain/heat alerts, churn alerts,
-- referrals, and the "prepared → delivered in 90 minutes" alert.
--
-- Rules kept from M1–M8
--   * Balances stay per eater; the payer only receives the money messages and pays from their page.
--   * Diet switches for veg days happen inside private.refresh_orders(), so frozen slots are never
--     touched and the lock stays the only path that posts 'meal' entries.
--   * Credits (complaint, referral) are 'credit' rows in balance_entries, idempotent on their ref.
--   * Nothing new hangs off count_snapshots; the lock path only gains one boolean per order.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Short random code from an unambiguous alphabet (no 0/O, 1/I): 5 bits of entropy per character.
create or replace function private.new_code(p_len integer)
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (get_byte(x.b, i) % 32) + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(p_len) as b) x, generate_series(0, p_len - 1) i;
$$;

-- Base URL + a fresh 7-day customer page link (used in messages to payers).
create or replace function private.portal_url(p_customer uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select private.public_web_url() || '/c/' || private.issue_magic_link(p_customer, 7);
$$;

-- ---------------------------------------------------------------------------
-- Kitchen settings (owner-editable through the existing column grants pattern)
-- ---------------------------------------------------------------------------
alter table public.kitchen_settings
  -- Veg days of the week (ISO 1 = Mon … 7 = Sun). Off until the kitchen enables them (Tue/Thu by default).
  add column veg_days smallint[] not null default '{2,4}'
    check (veg_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  add column veg_days_enabled boolean not null default false,
  -- Kartika month (platform calendar): customers who observe it are served veg.
  add column kartika_veg_mode boolean not null default false,
  add column auto_credit_first_complaint boolean not null default true,
  -- Meals credited to both referrer and referee after the referee's first paid recharge (0 = off).
  add column referral_reward_meals integer not null default 0 check (referral_reward_meals between 0 and 10),
  -- Minutes from "prepared" (dispatch photo or run start) to an owner alert for undelivered stops.
  add column late_alert_minutes integer not null default 90 check (late_alert_minutes between 30 and 600),
  add column weather_alerts boolean not null default true,
  add column weather_customer_notice boolean not null default false;
grant update (veg_days, veg_days_enabled, kartika_veg_mode, auto_credit_first_complaint, referral_reward_meals,
  late_alert_minutes, weather_alerts, weather_customer_notice) on public.kitchen_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Customers: veg-day opt-ins, referral code
-- ---------------------------------------------------------------------------
alter table public.customers
  add column observes_veg_days boolean not null default false,
  add column observes_kartika boolean not null default false,
  add column referral_code text default private.new_code(8) check (referral_code ~ '^[A-Z2-9]{8}$');
create unique index customers_referral_code_idx on public.customers (kitchen_id, referral_code);
grant select (observes_veg_days, observes_kartika, referral_code) on public.customers to authenticated;

-- ===========================================================================
-- 1. Parent pays, student eats
-- ===========================================================================

-- Invariants for every path (owner RPC, offices in P6): same kitchen (composite FK), not self,
-- no chains: a payer has no payer, and someone who pays for others can't get a payer.
create or replace function private.guard_payer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.payer_customer_id is null or new.payer_customer_id is not distinct from old.payer_customer_id then
    return new;
  end if;
  if new.payer_customer_id = new.id then
    raise exception 'payer_is_self' using errcode = '22023';
  end if;
  if not exists (select 1 from public.customers p where p.id = new.payer_customer_id and p.kitchen_id = new.kitchen_id
                 and p.deleted_at is null) then
    raise exception 'invalid_payer' using errcode = '22023';
  end if;
  if exists (select 1 from public.customers p where p.id = new.payer_customer_id and p.payer_customer_id is not null)
     or exists (select 1 from public.customers d where d.payer_customer_id = new.id and d.deleted_at is null) then
    raise exception 'payer_chain' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger customers_payer_guard before update of payer_customer_id on public.customers
  for each row execute function private.guard_payer();

-- An erased customer stops paying for others (their dependents keep their own balance).
create or replace function private.customer_erased_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.customers set payer_customer_id = null where payer_customer_id = new.id;
  end if;
  return null;
end;
$$;

create trigger customers_erased_cleanup after update of deleted_at on public.customers
  for each row execute function private.customer_erased_cleanup();

-- Money messages for an eater with a payer go to the payer (with the eater's name and a link to
-- the payer's page, where they can pay for their dependents).
create or replace function private.payer_templates()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['low_balance_reminder', 'dues_reminder', 'payment_receipt', 'refund_notice', 'refund_receipt'];
$$;

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
  if new.recipient_type <> 'customer' or not (new.template = any (private.payer_templates())) then
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

create trigger notifications_outbox_route_payer before insert on public.notifications_outbox
  for each row execute function private.route_outbox_to_payer();

-- Owner sets (or clears with null) who pays for a customer.
create or replace function public.set_payer(p_customer uuid, p_payer uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
begin
  select * into v_c from public.customers where id = p_customer and deleted_at is null;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}');
  if p_payer is not null and not exists (select 1 from public.customers where id = p_payer and kitchen_id = v_c.kitchen_id) then
    raise exception 'invalid_payer' using errcode = '22023';
  end if;
  update public.customers set payer_customer_id = p_payer where id = p_customer;
end;
$$;

-- Payment link record (owner / WhatsApp / customer page): for an eater with a payer, Razorpay's
-- contact is the payer. Same signature as M4.
create or replace function private.payment_link_record(p_customer uuid, p_meals integer, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_payer public.customers;
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
  select * into v_payer from public.customers where id = v_c.payer_customer_id and deleted_at is null;
  insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, description, created_by, created_at)
  values (v_c.kitchen_id, p_customer, 'razorpay_link', 'created', p_meals * v_price, p_meals,
          p_meals || ' meals' || case when v_payer.id is not null then ' for ' || v_c.name else '' end, p_actor, private.now())
  returning id into v_id;
  return jsonb_build_object(
    'payment_id', v_id, 'amount_paise', p_meals * v_price, 'meals', p_meals,
    'linked_account_id', v_account.razorpay_linked_account_id,
    'customer_name', coalesce(v_payer.name, v_c.name), 'eater_name', v_c.name,
    'customer_phone', private.decrypt_phone(coalesce(v_payer.phone_enc, v_c.phone_enc)),
    'paid_by_payer', v_payer.id is not null,
    'kitchen_name', (select name from public.kitchens where id = v_c.kitchen_id));
end;
$$;

-- The owner's payment-link RPC now shares the record builder (payer contact, P6 commission).
create or replace function public.create_payment_link_record(p_customer uuid, p_meals integer, p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
  v_rec jsonb;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer and deleted_at is null;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  v_rec := private.payment_link_record(p_customer, p_meals, auth.uid());
  if nullif(trim(p_description), '') is not null then
    update public.payments set description = trim(p_description) where id = (v_rec ->> 'payment_id')::uuid;
  end if;
  return v_rec;
end;
$$;

-- Customer page of a payer: pay for one of their dependents.
create or replace function public.portal_dependent_payment_link_record(p_token text, p_dependent uuid, p_meals integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
begin
  if not exists (select 1 from public.customers where id = p_dependent and payer_customer_id = v_cust.id and deleted_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.payment_link_record(p_dependent, p_meals, null);
end;
$$;

-- ===========================================================================
-- 2. Odisha food calendar, veg days, festival specials
-- ===========================================================================
create table public.food_calendar (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('kartika', 'festival')),
  name text not null check (length(trim(name)) between 2 and 80),
  starts_on date not null,
  ends_on date not null,
  -- Festivals marked veg_only count as veg days for customers who observe veg days.
  veg_only boolean not null default false,
  notes text check (length(notes) <= 300),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on and ends_on <= starts_on + 45),
  check (kind <> 'kartika' or veg_only)
);
create index food_calendar_dates_idx on public.food_calendar (starts_on, ends_on);

create trigger food_calendar_updated_at before update on public.food_calendar
  for each row execute function private.set_updated_at();
create trigger food_calendar_audit after insert or update or delete on public.food_calendar
  for each row execute function private.audit_row();

-- Seed 2026–2027 (approximate dates, Purnimanta Odia calendar; the platform team corrects them in
-- the admin console, D-095). Kartika runs from the day after Kumar Purnima to Rasa/Kartika Purnima.
insert into public.food_calendar (kind, name, starts_on, ends_on, veg_only, notes) values
  ('kartika', 'Kartika month 2026', '2026-10-27', '2026-11-24', true, 'Day after Kumar Purnima to Kartika Purnima (Boita Bandana)'),
  ('kartika', 'Kartika month 2027', '2027-10-16', '2027-11-14', true, 'Day after Kumar Purnima to Kartika Purnima (Boita Bandana)'),
  ('festival', 'Makar Sankranti', '2026-01-14', '2026-01-14', false, 'Makara chaula'),
  ('festival', 'Pana Sankranti (Odia New Year)', '2026-04-14', '2026-04-14', true, 'Pana'),
  ('festival', 'Raja', '2026-06-14', '2026-06-16', false, 'Poda pitha'),
  ('festival', 'Rath Yatra', '2026-07-16', '2026-07-16', true, null),
  ('festival', 'Ganesh Chaturthi', '2026-09-14', '2026-09-14', true, null),
  ('festival', 'Nuakhai', '2026-09-15', '2026-09-15', false, 'New rice'),
  ('festival', 'Durga Puja (Dussehra)', '2026-10-20', '2026-10-20', false, null),
  ('festival', 'Kumar Purnima', '2026-10-26', '2026-10-26', true, null),
  ('festival', 'Diwali', '2026-11-08', '2026-11-08', false, null),
  ('festival', 'Kartika Purnima (Boita Bandana)', '2026-11-24', '2026-11-24', true, null),
  ('festival', 'Manabasa Gurubar', '2026-11-26', '2026-11-26', true, 'Thursdays of Margasira: Lakshmi puja'),
  ('festival', 'Prathamastami', '2026-12-02', '2026-12-02', false, 'Enduri pitha for the eldest child'),
  ('festival', 'Manabasa Gurubar', '2026-12-03', '2026-12-03', true, 'Thursdays of Margasira: Lakshmi puja'),
  ('festival', 'Manabasa Gurubar', '2026-12-10', '2026-12-10', true, 'Thursdays of Margasira: Lakshmi puja'),
  ('festival', 'Manabasa Gurubar', '2026-12-17', '2026-12-17', true, 'Thursdays of Margasira: Lakshmi puja'),
  ('festival', 'Makar Sankranti', '2027-01-14', '2027-01-14', false, 'Makara chaula'),
  ('festival', 'Saraswati Puja', '2027-02-11', '2027-02-11', true, null),
  ('festival', 'Maha Shivaratri', '2027-03-06', '2027-03-06', true, null),
  ('festival', 'Dola Purnima (Holi)', '2027-03-22', '2027-03-22', false, null),
  ('festival', 'Pana Sankranti (Odia New Year)', '2027-04-14', '2027-04-14', true, 'Pana'),
  ('festival', 'Raja', '2027-06-14', '2027-06-16', false, 'Poda pitha'),
  ('festival', 'Rath Yatra', '2027-07-06', '2027-07-06', true, null),
  ('festival', 'Ganesh Chaturthi', '2027-09-04', '2027-09-04', true, null),
  ('festival', 'Nuakhai', '2027-09-05', '2027-09-05', false, 'New rice'),
  ('festival', 'Durga Puja (Dussehra)', '2027-10-09', '2027-10-09', false, null),
  ('festival', 'Kumar Purnima', '2027-10-15', '2027-10-15', true, null),
  ('festival', 'Diwali', '2027-10-29', '2027-10-29', false, null),
  ('festival', 'Kartika Purnima (Boita Bandana)', '2027-11-14', '2027-11-14', true, null);

-- Is p_date a veg day for this eater at this kitchen? (Only ever switches non-veg to veg.)
create or replace function private.is_veg_day(p_ks public.kitchen_settings, p_obs_veg_days boolean, p_obs_kartika boolean, p_date date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (p_obs_veg_days and p_ks.veg_days_enabled
     and (extract(isodow from p_date)::smallint = any (p_ks.veg_days)
          or exists (select 1 from public.food_calendar f
                     where f.kind = 'festival' and f.veg_only and p_date between f.starts_on and f.ends_on)))
    or (p_obs_kartika and p_ks.kartika_veg_mode
        and exists (select 1 from public.food_calendar f
                    where f.kind = 'kartika' and p_date between f.starts_on and f.ends_on)),
    false);
$$;

-- Orders packed as veg because of a veg day (counts, packing list and stickers show it).
alter table public.meal_orders add column veg_override boolean not null default false;
grant select (veg_override) on public.meal_orders to authenticated;

-- Reconcile meal_orders (M2) — now with the eater's veg days. Frozen slots are never touched.
create or replace function private.refresh_orders(
  p_kitchen uuid default null,
  p_subscription uuid default null,
  p_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_now timestamptz := private.now();
  v_total integer := 0;
  v_n integer;
begin
  drop table if exists pg_temp._desired;
  create temp table _desired on commit drop as
  select s.id as subscription_id, s.kitchen_id, s.customer_id, s.plan_id, d.d::date as service_date, sl.slot,
         s.qty,
         case when vo.veg then 'veg'::public.diet_type else p.diet end as diet,
         vo.veg as veg_override,
         coalesce(private.address_for(s.id, d.d::date, sl.slot), s.address_id) as address_id,
         h.reason as skip_reason, h.change_id
  from public.subscriptions s
  join public.plans p on p.id = s.plan_id
  join public.kitchens k on k.id = s.kitchen_id
  join public.customers cu on cu.id = s.customer_id
  left join public.kitchen_settings ks on ks.kitchen_id = s.kitchen_id
  cross join generate_series(v_today, v_today + p_days - 1, interval '1 day') as d(d)
  cross join unnest(p.slots) as sl(slot)
  cross join lateral (
    select p.diet = 'nonveg' and (cu.observes_veg_days or cu.observes_kartika)
           and private.is_veg_day(ks, cu.observes_veg_days, cu.observes_kartika, d.d::date) as veg
  ) vo
  left join lateral private.active_hold(s.id, d.d::date, sl.slot) h on true
  where s.status in ('active', 'low_balance', 'paused')
    and k.status <> 'suspended'
    and (p_kitchen is null or s.kitchen_id = p_kitchen)
    and (p_subscription is null or s.id = p_subscription)
    and d.d::date >= s.start_date
    and (s.end_date is null or d.d::date <= s.end_date)
    and extract(isodow from d.d)::smallint = any (p.days_of_week)
    and not (extract(isodow from d.d)::smallint = any (k.weekly_off))
    and v_now < private.cutoff_at(k, d.d::date, sl.slot)
    and not exists (select 1 from public.count_snapshots cs
                    where cs.kitchen_id = s.kitchen_id and cs.service_date = d.d::date and cs.slot = sl.slot);

  insert into public.meal_orders (kitchen_id, subscription_id, customer_id, plan_id, service_date, slot, qty, diet,
                                  veg_override, address_id, status, skip_reason, change_id)
  select kitchen_id, subscription_id, customer_id, plan_id, service_date, slot, qty, diet, coalesce(veg_override, false),
         address_id, case when skip_reason is null then 'scheduled' else 'skipped' end::public.order_status, skip_reason, change_id
  from _desired
  on conflict (subscription_id, service_date, slot) do update set
    plan_id = excluded.plan_id,
    qty = excluded.qty,
    diet = excluded.diet,
    veg_override = excluded.veg_override,
    address_id = excluded.address_id,
    status = excluded.status,
    skip_reason = excluded.skip_reason,
    change_id = coalesce(excluded.change_id, public.meal_orders.change_id),
    -- A late (charged) skip stays charged while the hold stands; un-holding clears it.
    charged = case when excluded.status = 'skipped' then public.meal_orders.charged else false end
  where public.meal_orders.locked_at is null
    and public.meal_orders.status in ('scheduled', 'skipped')
    and (public.meal_orders.plan_id, public.meal_orders.qty, public.meal_orders.diet, public.meal_orders.veg_override,
         public.meal_orders.address_id, public.meal_orders.status, public.meal_orders.skip_reason)
        is distinct from
        (excluded.plan_id, excluded.qty, excluded.diet, excluded.veg_override, excluded.address_id, excluded.status,
         excluded.skip_reason);
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  -- Remove unlocked, unfrozen orders that are no longer wanted (ended, cancelled, plan changed…).
  delete from public.meal_orders o
  using public.kitchens k
  where k.id = o.kitchen_id
    and (p_kitchen is null or o.kitchen_id = p_kitchen)
    and (p_subscription is null or o.subscription_id = p_subscription)
    and o.service_date between v_today and v_today + p_days - 1
    and o.locked_at is null
    and o.status in ('scheduled', 'skipped')
    and v_now < private.cutoff_at(k, o.service_date, o.slot)
    and not exists (select 1 from public.count_snapshots cs
                    where cs.kitchen_id = o.kitchen_id and cs.service_date = o.service_date and cs.slot = o.slot)
    and not exists (select 1 from _desired d
                    where d.subscription_id = o.subscription_id and d.service_date = o.service_date and d.slot = o.slot);
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  drop table if exists pg_temp._desired;
  return v_total;
end;
$$;

-- Counts for one slot (M2), plus how many meals were switched to veg for a veg day.
create or replace function private.slot_totals(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with o as (
    select mo.*, (mo.status <> 'skipped' or mo.charged) as counted, p.name as plan_name, a.area
    from public.meal_orders mo
    join public.plans p on p.id = mo.plan_id
    left join public.addresses a on a.id = mo.address_id
    where mo.kitchen_id = p_kitchen and mo.service_date = p_date and mo.slot = p_slot
  )
  select jsonb_build_object(
    'total_meals', coalesce((select sum(qty) from o where counted), 0),
    'orders', (select count(*) from o where counted),
    'to_deliver', coalesce((select sum(qty) from o where status <> 'skipped'), 0),
    'skipped', (select count(*) from o where status = 'skipped' and not charged),
    'late_skips', (select count(*) from o where status = 'skipped' and charged),
    'by_diet', jsonb_build_object(
      'veg', coalesce((select sum(qty) from o where counted and diet = 'veg'), 0),
      'nonveg', coalesce((select sum(qty) from o where counted and diet = 'nonveg'), 0),
      'jain', coalesce((select sum(qty) from o where counted and diet = 'jain'), 0)),
    'veg_switched', coalesce((select sum(qty) from o where counted and veg_override), 0),
    'by_plan', coalesce((select jsonb_agg(jsonb_build_object('plan', plan_name, 'meals', m) order by plan_name)
                         from (select plan_name, sum(qty) m from o where counted group by plan_name) x), '[]'::jsonb),
    'by_area', coalesce((select jsonb_agg(jsonb_build_object('area', area, 'meals', m) order by m desc, area)
                         from (select coalesce(area, 'No area') area, sum(qty) m from o where counted group by 1) x), '[]'::jsonb)
  );
$$;

-- Veg-day settings changed: re-plan the kitchen's open days.
create or replace function private.kitchen_settings_refresh_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_orders(new.kitchen_id, null, 7);
  return null;
end;
$$;

create trigger kitchen_settings_veg_refresh after update of veg_days, veg_days_enabled, kartika_veg_mode
  on public.kitchen_settings for each row
  when (old.veg_days is distinct from new.veg_days or old.veg_days_enabled is distinct from new.veg_days_enabled
        or old.kartika_veg_mode is distinct from new.kartika_veg_mode)
  execute function private.kitchen_settings_refresh_orders();

-- A customer's opt-ins changed: re-plan their open days.
create or replace function private.set_food_prefs(p_customer uuid, p_veg_days boolean, p_kartika boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_c public.customers;
begin
  update public.customers
  set observes_veg_days = coalesce(p_veg_days, observes_veg_days),
      observes_kartika = coalesce(p_kartika, observes_kartika)
  where id = p_customer
  returning * into v_c;
  for r in select id from public.subscriptions where customer_id = p_customer and status <> 'cancelled' loop
    perform private.refresh_orders(null, r.id, 7);
  end loop;
  return jsonb_build_object('observes_veg_days', v_c.observes_veg_days, 'observes_kartika', v_c.observes_kartika);
end;
$$;

create or replace function public.set_customer_food_prefs(p_customer uuid, p_veg_days boolean default null, p_kartika boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer and deleted_at is null;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  return private.set_food_prefs(p_customer, p_veg_days, p_kartika);
end;
$$;

create or replace function public.portal_set_food_prefs(p_token text, p_veg_days boolean default null, p_kartika boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
begin
  return private.set_food_prefs(v_cust.id, p_veg_days, p_kartika);
end;
$$;

-- Calendar edits re-plan kitchens that use veg days or Kartika mode.
create or replace function private.food_calendar_refresh()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select kitchen_id from public.kitchen_settings where veg_days_enabled or kartika_veg_mode loop
    perform private.refresh_orders(r.kitchen_id, null, 7);
  end loop;
end;
$$;

create or replace function public.admin_upsert_calendar_entry(
  p_id uuid default null,
  p_kind text default 'festival',
  p_name text default null,
  p_starts_on date default null,
  p_ends_on date default null,
  p_veg_only boolean default false,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_admin();
  if p_kind not in ('kartika', 'festival') or nullif(trim(p_name), '') is null or p_starts_on is null
     or coalesce(p_ends_on, p_starts_on) < p_starts_on or coalesce(p_ends_on, p_starts_on) > p_starts_on + 45 then
    raise exception 'invalid_calendar_entry' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.food_calendar (kind, name, starts_on, ends_on, veg_only, notes, updated_by)
    values (p_kind, trim(p_name), p_starts_on, coalesce(p_ends_on, p_starts_on), p_kind = 'kartika' or coalesce(p_veg_only, false),
            nullif(trim(p_notes), ''), auth.uid())
    returning id into v_id;
  else
    update public.food_calendar
    set kind = p_kind, name = trim(p_name), starts_on = p_starts_on, ends_on = coalesce(p_ends_on, p_starts_on),
        veg_only = p_kind = 'kartika' or coalesce(p_veg_only, false), notes = nullif(trim(p_notes), ''), updated_by = auth.uid()
    where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  perform private.food_calendar_refresh();
  return v_id;
end;
$$;

create or replace function public.admin_delete_calendar_entry(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  delete from public.food_calendar where id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.food_calendar_refresh();
end;
$$;

-- Festival specials: a kitchen's special dish for a date/slot, announced to its customers.
create table public.festival_specials (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  service_date date not null,
  slot public.meal_slot not null,
  name text not null check (length(trim(name)) between 2 and 80),
  description text check (length(description) <= 300),
  addon_price_paise integer check (addon_price_paise is null or addon_price_paise between 0 and 100000),
  calendar_id uuid references public.food_calendar (id) on delete set null,
  notified integer not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kitchen_id, service_date, slot, name)
);
create index festival_specials_kitchen_idx on public.festival_specials (kitchen_id, service_date);

create trigger festival_specials_updated_at before update on public.festival_specials
  for each row execute function private.set_updated_at();
create trigger festival_specials_audit after insert or update or delete on public.festival_specials
  for each row execute function private.audit_row();

-- Owner adds a special; opted-in customers with that meal in their plan are told (once).
create or replace function public.create_festival_special(
  p_kitchen uuid,
  p_date date,
  p_slot public.meal_slot,
  p_name text,
  p_addon_price_paise integer default null,
  p_description text default null,
  p_notify boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  perform private.require_role(p_kitchen, '{owner}');
  if p_date is null or p_date < private.ist_today() then
    raise exception 'date_in_past' using errcode = '22023';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if p_addon_price_paise is not null and p_addon_price_paise not between 0 and 100000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  insert into public.festival_specials (kitchen_id, service_date, slot, name, description, addon_price_paise, calendar_id, created_by)
  values (p_kitchen, p_date, p_slot, trim(p_name), nullif(trim(p_description), ''), p_addon_price_paise,
          (select f.id from public.food_calendar f where f.kind = 'festival' and p_date between f.starts_on and f.ends_on
           order by f.starts_on limit 1),
          auth.uid())
  returning id into v_id;

  if coalesce(p_notify, true) then
    insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
    select distinct p_kitchen, 'whatsapp', 'customer', c.id, 'festival_special',
           jsonb_build_object('special_id', v_id, 'name', trim(p_name), 'service_date', p_date, 'slot', p_slot,
                              'addon_price_paise', p_addon_price_paise),
           'festival_special:' || v_id || ':' || c.id
    from public.customers c
    join public.subscriptions s on s.customer_id = c.id and s.status in ('active', 'low_balance', 'paused', 'trial')
    join public.plans p on p.id = s.plan_id and p_slot = any (p.slots)
    where c.kitchen_id = p_kitchen and c.whatsapp_opt_in and c.deleted_at is null
    on conflict (dedupe_key) do nothing;
    get diagnostics v_n = row_count;
    update public.festival_specials set notified = v_n where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'notified', v_n);
exception when unique_violation then
  raise exception 'already_exists' using errcode = '23505';
end;
$$;

create or replace function public.delete_festival_special(p_special uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.festival_specials;
begin
  select * into v_s from public.festival_specials where id = p_special;
  if v_s.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_s.kitchen_id, '{owner}');
  delete from public.festival_specials where id = p_special;
end;
$$;

-- Specials for the kitchen (owner + staff; the add-on price is money: owner only).
create or replace function public.festival_specials_list(p_kitchen uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner boolean;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  v_owner := private.has_role(p_kitchen, '{owner}');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'service_date', s.service_date, 'slot', s.slot, 'name', s.name, 'description', s.description,
      'addon_price_paise', case when v_owner then s.addon_price_paise end, 'notified', s.notified,
      'festival', (select f.name from public.food_calendar f where f.id = s.calendar_id)) order by s.service_date, s.slot, s.name)
    from public.festival_specials s
    where s.kitchen_id = p_kitchen
      and s.service_date between coalesce(p_from, private.ist_today()) and coalesce(p_to, coalesce(p_from, private.ist_today()) + 30)),
    '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 3. Packed-meal photo before dispatch, QR stickers
-- ===========================================================================
create table public.dispatch_photos (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  service_date date not null,
  slot public.meal_slot not null,
  run_id uuid,                               -- null: one photo for the whole slot
  photo_path text not null,                  -- storage: dispatch/<kitchen_id>/...
  taken_at timestamptz not null,             -- "prepared" time for the 90-minute alert
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (kitchen_id, service_date, slot, run_id),
  foreign key (run_id, kitchen_id) references public.delivery_runs (id, kitchen_id) on delete cascade
);
create index dispatch_photos_run_idx on public.dispatch_photos (run_id);

create trigger dispatch_photos_updated_at before update on public.dispatch_photos
  for each row execute function private.set_updated_at();
create trigger dispatch_photos_audit after insert or update or delete on public.dispatch_photos
  for each row execute function private.audit_row();

-- Owner or staff records the packed-meals photo (path inside the private 'dispatch' bucket).
-- A retake replaces the photo but keeps the first "prepared" time.
create or replace function public.record_dispatch_photo(
  p_kitchen uuid,
  p_date date,
  p_slot public.meal_slot,
  p_photo_path text,
  p_run uuid default null,
  p_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_at timestamptz;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  if nullif(trim(p_photo_path), '') is null or split_part(p_photo_path, '/', 1) <> p_kitchen::text then
    raise exception 'invalid_photo' using errcode = '22023';
  end if;
  if p_run is not null and not exists (select 1 from public.delivery_runs where id = p_run and kitchen_id = p_kitchen
                                       and service_date = p_date and slot = p_slot) then
    raise exception 'invalid_run' using errcode = '22023';
  end if;
  v_at := private.client_time(p_at, p_date);
  insert into public.dispatch_photos (kitchen_id, service_date, slot, run_id, photo_path, taken_at, created_by)
  values (p_kitchen, p_date, p_slot, p_run, trim(p_photo_path), v_at, auth.uid())
  on conflict (kitchen_id, service_date, slot, run_id) do update
    set photo_path = excluded.photo_path, taken_at = least(public.dispatch_photos.taken_at, excluded.taken_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- Every stop gets an unguessable sticker code (50 bits), printed as a QR on the tiffin.
alter table public.delivery_stops add column qr_token text not null default private.new_code(10);
grant select (qr_token) on public.delivery_stops to authenticated;

-- "TFN:ABCD…", a URL ending in the code, or the bare code all read as the code.
create or replace function private.scan_token(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(upper(regexp_replace(regexp_replace(coalesce(p, ''), '^.*[:/=]', ''), '[^A-Za-z0-9]', '', 'g')), '');
$$;

-- Sticker sheet in route order (owner + staff; no phone numbers, no money).
create or replace function public.sticker_sheet(p_kitchen uuid, p_date date, p_slot public.meal_slot)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'stop_id', s.id, 'run_id', dr.id, 'route_name', rt.name, 'seq', s.seq, 'name', cu.name,
      'line1', a.line1, 'landmark', a.landmark, 'area', a.area, 'meal_count', s.meal_count,
      'diets', (select jsonb_object_agg(x.diet, x.n) from (
                  select o.diet, sum(o.qty)::integer as n from public.meal_orders o
                  where o.stop_id = s.id and o.status <> 'skipped' group by o.diet) x),
      'veg_day', exists (select 1 from public.meal_orders o where o.stop_id = s.id and o.veg_override),
      'notes', nullif(concat_ws(' · ', a.delivery_notes, cu.notes), ''),
      'qr_token', s.qr_token, 'status', s.status) order by rt.name, s.seq)
    from public.delivery_stops s
    join public.delivery_runs dr on dr.id = s.run_id
    join public.delivery_routes rt on rt.id = dr.route_id
    join public.customers cu on cu.id = s.customer_id
    left join public.addresses a on a.id = s.address_id
    where dr.kitchen_id = p_kitchen and dr.service_date = p_date and dr.slot = p_slot), '[]'::jsonb);
end;
$$;

-- complete_stop gains p_scan_token (optional, last): a scanned sticker that doesn't match the stop
-- is refused with wrong_tiffin. Existing callers (offline queue) keep working unchanged.
drop function public.complete_stop(uuid, public.proof_type, text, text, double precision, double precision, real,
  timestamptz, integer, integer, integer, uuid, boolean);
create function public.complete_stop(
  p_stop uuid,
  p_proof public.proof_type,
  p_otp text default null,
  p_photo_path text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_accuracy real default null,
  p_at timestamptz default null,
  p_tiffins_out integer default 0,
  p_tiffins_returned integer default 0,
  p_cash_paise integer default 0,
  p_client_op uuid default null,
  p_offline boolean default false,
  p_scan_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_token text;
begin
  select run_id, qr_token into v_run, v_token from public.delivery_stops where id = p_stop;
  if v_run is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_run_access(v_run);
  if private.scan_token(p_scan_token) is not null
     and not (p_client_op is not null and exists (select 1 from public.delivery_stops
                                                  where client_op_id = p_client_op and id = p_stop))
     and private.scan_token(p_scan_token) is distinct from v_token then
    raise exception 'wrong_tiffin' using errcode = '22023';
  end if;
  return private.do_complete_stop(p_stop, p_proof, p_otp, p_photo_path, p_lat, p_lng, p_accuracy, p_at,
                                  p_tiffins_out, p_tiffins_returned, p_cash_paise, p_client_op, p_offline, auth.uid());
end;
$$;

-- Rider app cache (M5) + the sticker code, so a scan can be checked offline too.
create or replace function public.rider_today()
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
    select jsonb_agg(jsonb_build_object(
      'id', dr.id, 'kitchen_id', dr.kitchen_id, 'kitchen_name', k.name, 'kitchen_lat', k.lat, 'kitchen_lng', k.lng,
      'route_name', rt.name, 'service_date', dr.service_date, 'slot', dr.slot, 'status', dr.status,
      'started_at', dr.started_at, 'finished_at', dr.finished_at, 'planned_km', dr.planned_km,
      'stops', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'seq', s.seq, 'customer_id', s.customer_id, 'name', cu.name,
          'phone_masked', 'XXXXXX' || coalesce(cu.phone_last4, '????'),
          'line1', a.line1, 'area', a.area, 'landmark', a.landmark, 'delivery_notes', a.delivery_notes,
          'lat', a.lat, 'lng', a.lng, 'meal_count', s.meal_count,
          'diets', (select jsonb_object_agg(x.diet, x.n) from (
                      select o.diet, sum(o.qty)::integer as n from public.meal_orders o
                      where o.stop_id = s.id group by o.diet) x),
          'status', s.status, 'proof_type', s.proof_type, 'otp_ok', s.otp_ok, 'done_at', s.done_at,
          'failed_reason', s.failed_reason, 'tiffins_out', s.tiffins_out, 'tiffins_returned', s.tiffins_returned,
          'tiffins_with_customer', coalesce((select sum(t.tiffins_out - t.tiffins_returned)::integer
                                             from public.tiffin_ledger t
                                             where t.kitchen_id = s.kitchen_id and t.customer_id = s.customer_id), 0),
          'otp_sent', exists (select 1 from public.notifications_outbox n
                              where n.dedupe_key like 'on_the_way:' || s.id || '%' and n.status in ('pending', 'sent', 'sending')),
          'qr_token', s.qr_token
        ) order by s.seq)
        from public.delivery_stops s
        join public.customers cu on cu.id = s.customer_id
        left join public.addresses a on a.id = s.address_id
        where s.run_id = dr.id), '[]'::jsonb)
    ) order by dr.slot, k.name, rt.name)
    from public.delivery_runs dr
    join public.kitchens k on k.id = dr.kitchen_id
    join public.delivery_routes rt on rt.id = dr.route_id
    where dr.rider_id = auth.uid() and dr.service_date = private.ist_today()
      and exists (select 1 from public.members m where m.kitchen_id = dr.kitchen_id and m.user_id = auth.uid())
  ), '[]'::jsonb);
end;
$$;

-- Dispatch photos: private bucket, one folder per kitchen (dispatch/<kitchen_id>/...).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dispatch', 'dispatch', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy dispatch_read on storage.objects for select to authenticated
  using (bucket_id = 'dispatch'
         and ((storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner,staff}'))::text[])
              or (select private.is_platform_admin())));
create policy dispatch_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'dispatch'
              and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner,staff}'))::text[]));

-- ===========================================================================
-- 4. Complaint scores, first complaint auto-credited
-- ===========================================================================
alter table public.complaints add column auto_credit_entry_id uuid references public.balance_entries (id);

create or replace function private.food_delivery_categories()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['late', 'quality', 'quantity', 'missing', 'hygiene', 'delivery'];
$$;

-- The customer's first food/delivery complaint at a kitchen: 1 free meal, once (ref = complaint).
create or replace function private.complaint_auto_credit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_on boolean;
  v_entry uuid;
begin
  if not (new.category = any (private.food_delivery_categories())) then
    return null;
  end if;
  select auto_credit_first_complaint into v_on from public.kitchen_settings where kitchen_id = new.kitchen_id;
  if not coalesce(v_on, false) then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('complaint_credit:' || new.customer_id, 0));
  if exists (select 1 from public.complaints c
             where c.kitchen_id = new.kitchen_id and c.customer_id = new.customer_id and c.id <> new.id
               and c.category = any (private.food_delivery_categories())) then
    return null;
  end if;
  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
  values (new.kitchen_id, new.customer_id, 'credit', 1, 0, 'complaint_auto', new.id,
          'First complaint (' || new.category || '): 1 free meal', auth.uid(), private.now())
  on conflict (type, ref_type, ref_id) where ref_id is not null do nothing
  returning id into v_entry;
  if v_entry is null then
    return null;
  end if;
  update public.complaints set auto_credit_entry_id = v_entry where id = new.id;
  perform private.sync_balance_status(new.kitchen_id, new.customer_id);
  perform private.notify_customer(new.kitchen_id, new.customer_id, 'complaint_credit',
    jsonb_build_object('complaint_id', new.id, 'category', new.category, 'meals', 1), 'complaint_credit:' || new.id);
  return null;
end;
$$;

create trigger complaints_auto_credit after insert on public.complaints
  for each row execute function private.complaint_auto_credit();

-- Meals that reached (or were on their way to) customers: locked, not skipped, not failed.
create or replace function private.served_meals(p_kitchen uuid, p_customer uuid, p_from date, p_to date)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(o.qty), 0)::integer from public.meal_orders o
  where o.kitchen_id = p_kitchen and (p_customer is null or o.customer_id = p_customer)
    and o.service_date between p_from and p_to and o.locked_at is not null
    and o.status not in ('skipped', 'failed');
$$;

create or replace function private.vendor_score(p_kitchen uuid, p_days integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select * from public.complaints
    where kitchen_id = p_kitchen and created_at >= private.now() - make_interval(days => p_days)
  ), m as (
    select private.served_meals(p_kitchen, null, private.ist_today() - p_days + 1, private.ist_today()) as meals
  )
  select jsonb_build_object(
    'kitchen_id', p_kitchen,
    'days', p_days,
    'complaints', (select count(*) from c),
    'delivered_meals', m.meals,
    'complaints_per_100_meals', case when m.meals > 0 then round(100.0 * (select count(*) from c) / m.meals, 2) end,
    'median_first_response_minutes', (select round((percentile_cont(0.5) within group (
                                         order by extract(epoch from (c.responded_at - c.created_at)) / 60))::numeric, 1)
                                      from c where c.responded_at is not null),
    'unanswered', (select count(*) from c where c.responded_at is null),
    'escalated', (select count(*) from c where c.escalated_at is not null),
    'by_category', coalesce((select jsonb_object_agg(category, n) from (select category, count(*) n from c group by 1) x), '{}'::jsonb))
  from m;
$$;

create or replace function public.vendor_complaint_score(p_kitchen uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    perform private.require_role(p_kitchen, '{owner}');
  end if;
  return private.vendor_score(p_kitchen, least(greatest(coalesce(p_days, 30), 1), 365));
end;
$$;

create or replace function public.customer_complaint_score(p_customer uuid, p_days integer default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.customers;
  v_days integer := least(greatest(coalesce(p_days, 90), 1), 365);
  v_n integer;
  v_meals integer;
begin
  select * into v_c from public.customers where id = p_customer;
  if v_c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.is_platform_admin() then
    perform private.require_role(v_c.kitchen_id, '{owner}');
  end if;
  select count(*) into v_n from public.complaints
  where customer_id = p_customer and created_at >= private.now() - make_interval(days => v_days);
  v_meals := private.served_meals(v_c.kitchen_id, p_customer, private.ist_today() - v_days + 1, private.ist_today());
  return jsonb_build_object('customer_id', p_customer, 'days', v_days, 'complaints', v_n, 'meals', v_meals,
    'complaints_per_100_meals', case when v_meals > 0 then round(100.0 * v_n / v_meals, 2) end,
    'first_complaint_credited', exists (select 1 from public.complaints where customer_id = p_customer and auto_credit_entry_id is not null));
end;
$$;

create or replace function public.admin_complaint_scores(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((select jsonb_agg(private.vendor_score(k.id, least(greatest(coalesce(p_days, 30), 1), 365))
                                    || jsonb_build_object('kitchen_name', k.name, 'status', k.status) order by k.name)
                   from public.kitchens k), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 5. Rain and heat alerts (weather-alerts Edge Function, service role)
-- ===========================================================================
create table public.weather_alerts (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id) on delete cascade,
  service_date date not null,
  slot public.meal_slot not null,
  kind text not null check (kind in ('rain', 'heat', 'rain_heat')),
  detail jsonb not null default '{}',
  customers_notified integer not null default 0,
  created_at timestamptz not null default now(),
  unique (kitchen_id, service_date, slot)
);

-- Kitchens to check (with location), for the Edge Function.
create or replace function public.weather_kitchens()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('kitchen_id', k.id, 'name', k.name, 'lat', k.lat, 'lng', k.lng,
                                               'owner_alerts', ks.weather_alerts, 'customer_notice', ks.weather_customer_notice)
                            order by k.name), '[]'::jsonb)
  from public.kitchens k join public.kitchen_settings ks on ks.kitchen_id = k.id
  where k.status <> 'suspended' and k.lat is not null and k.lng is not null
    and (ks.weather_alerts or ks.weather_customer_notice);
$$;

-- Records one alert (at most once per kitchen/date/slot) and queues the messages.
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
  if coalesce(v_ks.weather_customer_notice, false) then
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

-- Owner's recent alerts (or the admin's view of a kitchen).
create or replace function public.weather_alerts_list(p_kitchen uuid, p_days integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    perform private.require_role(p_kitchen, '{owner}');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('service_date', w.service_date, 'slot', w.slot, 'kind', w.kind,
                                                       'detail', w.detail, 'customers_notified', w.customers_notified,
                                                       'created_at', w.created_at) order by w.service_date desc, w.slot)
                   from public.weather_alerts w
                   where w.kitchen_id = p_kitchen and w.service_date >= private.ist_today() - least(greatest(coalesce(p_days, 14), 1), 90)),
                  '[]'::jsonb);
end;
$$;

-- Ask an Edge Function to run (pg_net, fire-and-forget). Needs the Vault secrets of kick_outbox.
create or replace function private.kick_function(p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'functions_base_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    return;
  end if;
  perform net.http_post(url := v_url || '/' || p_name, body := '{}'::jsonb,
                        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'));
end;
$$;

-- ===========================================================================
-- 6. Churn alerts (nightly snapshot of at-risk customers)
-- ===========================================================================
create table public.churn_risks (
  kitchen_id uuid not null,
  customer_id uuid not null,
  reasons text[] not null check (cardinality(reasons) > 0),
  detail jsonb not null default '{}',
  computed_on date not null,
  computed_at timestamptz not null default now(),
  primary key (kitchen_id, customer_id),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id) on delete cascade
);

-- Reasons: balance_out (≤ 0 meals, no recharge for 3 days), skips (3+ skipped days in the last 7),
-- open_complaint, paused_long (paused for more than 7 days), trial_not_converted (platform customer).
create or replace function private.compute_churn(p_kitchen uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_now timestamptz := private.now();
  v_n integer;
begin
  delete from public.churn_risks where p_kitchen is null or kitchen_id = p_kitchen;
  insert into public.churn_risks (kitchen_id, customer_id, reasons, detail, computed_on, computed_at)
  select x.kitchen_id, x.customer_id, x.reasons, x.detail, v_today, v_now
  from (
    select c.kitchen_id, c.id as customer_id,
           array_remove(array[
             case when b.meals <= 0 and coalesce(rc.last_at, '-infinity') < v_now - interval '3 days' then 'balance_out' end,
             case when sk.n >= 3 then 'skips' end,
             case when cp.n > 0 then 'open_complaint' end,
             case when ps.since < v_now - interval '7 days' then 'paused_long' end,
             case when c.platform_sourced and (tr.stuck or ld.stuck) then 'trial_not_converted' end
           ], null) as reasons,
           jsonb_strip_nulls(jsonb_build_object('balance_meals', b.meals, 'last_recharge_at', rc.last_at, 'skips_7d', sk.n,
             'open_complaints', cp.n, 'paused_since', ps.since)) as detail
    from public.customers c
    left join lateral (select coalesce(sum(be.meals), 0)::integer as meals from public.balance_entries be where be.customer_id = c.id) b on true
    left join lateral (select max(be.created_at) as last_at from public.balance_entries be
                       where be.customer_id = c.id and be.type = 'recharge') rc on true
    left join lateral (select count(*)::integer as n from public.meal_orders o
                       where o.customer_id = c.id and o.status = 'skipped' and o.skip_reason = 'skip'
                         and o.service_date between v_today - 6 and v_today) sk on true
    left join lateral (select count(*)::integer as n from public.complaints cm
                       where cm.customer_id = c.id and cm.status in ('open', 'responded', 'escalated')) cp on true
    left join lateral (select min(s.status_changed_at) as since from public.subscriptions s
                       where s.customer_id = c.id and s.status = 'paused') ps on true
    left join lateral (select exists (select 1 from public.subscriptions s where s.customer_id = c.id and s.status = 'trial'
                                      and s.created_at < v_now - interval '3 days') as stuck) tr on true
    left join lateral (select exists (select 1 from public.leads l where l.customer_id = c.id and l.status = 'trial'
                                      and l.trial_at < v_now - interval '3 days') as stuck) ld on true
    where c.deleted_at is null
      and (p_kitchen is null or c.kitchen_id = p_kitchen)
      and exists (select 1 from public.subscriptions s where s.customer_id = c.id and s.status <> 'cancelled')
  ) x
  where cardinality(x.reasons) > 0;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Owner: at-risk customers with reasons (p_refresh recomputes now instead of using last night's run).
create or replace function public.at_risk_customers(p_kitchen uuid, p_refresh boolean default false)
returns table (customer_id uuid, customer_name text, reasons text[], detail jsonb, computed_on date)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  if coalesce(p_refresh, false) then
    perform private.compute_churn(p_kitchen);
  end if;
  return query
  select r.customer_id, c.name, r.reasons, r.detail, r.computed_on
  from public.churn_risks r join public.customers c on c.id = r.customer_id
  where r.kitchen_id = p_kitchen
  order by cardinality(r.reasons) desc, c.name;
end;
$$;

-- 22:00 owner summary (M6) + the number of at-risk customers (payload only; template unchanged).
create or replace function private.queue_owner_summaries()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_tomorrow date := private.ist_today() + 1;
  v_n integer;
begin
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select k.id, 'whatsapp', 'member', m.user_id, 'owner_daily_summary',
         jsonb_build_object(
           'service_date', v_tomorrow,
           'lunch', private.slot_totals(k.id, v_tomorrow, 'lunch'),
           'dinner', private.slot_totals(k.id, v_tomorrow, 'dinner'),
           'collections_paise', (select coalesce(sum(p.amount_paise), 0) from public.payments p
                                 where p.kitchen_id = k.id and p.status = 'paid'
                                   and p.paid_at >= (v_today::timestamp at time zone 'Asia/Kolkata')
                                   and p.paid_at < (v_tomorrow::timestamp at time zone 'Asia/Kolkata')),
           'low_stock', coalesce((select jsonb_agg(i.name order by i.name) from public.items i
                                  where i.kitchen_id = k.id and i.active and i.min_qty > 0
                                    and private.item_stock(i.id) <= i.min_qty), '[]'::jsonb),
           'at_risk_customers', (select count(*) from public.churn_risks r where r.kitchen_id = k.id)),
         'owner_daily_summary:' || k.id || ':' || v_tomorrow || ':' || m.user_id
  from public.kitchens k
  join public.members m on m.kitchen_id = k.id and m.role = 'owner'
  where k.status <> 'suspended'
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ===========================================================================
-- 7. Referrals
-- ===========================================================================
create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  referrer_customer_id uuid not null,
  referee_customer_id uuid not null unique,
  code text not null,
  source text not null check (source in ('vendor', 'lead', 'portal')),
  status text not null default 'pending' check (status in ('pending', 'rewarded', 'no_reward')),
  reward_meals integer not null default 0,
  referee_entry_id uuid references public.balance_entries (id),
  referrer_entry_id uuid references public.balance_entries (id),
  rewarded_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (referrer_customer_id <> referee_customer_id),
  foreign key (referrer_customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (referee_customer_id, kitchen_id) references public.customers (id, kitchen_id)
);
create index referrals_referrer_idx on public.referrals (referrer_customer_id);

create trigger referrals_audit after insert or update or delete on public.referrals
  for each row execute function private.audit_row();

-- Links a new customer to the customer whose code they joined with (same kitchen only).
create or replace function private.link_referral(p_referee uuid, p_code text, p_source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref public.customers;
  v_code text := private.scan_token(p_code);
  v_referrer uuid;
  v_id uuid;
begin
  select * into v_ref from public.customers where id = p_referee and deleted_at is null;
  if v_ref.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select id into v_referrer from public.customers
  where kitchen_id = v_ref.kitchen_id and referral_code = v_code and deleted_at is null;
  if v_referrer is null then
    raise exception 'invalid_referral_code' using errcode = '22023';
  end if;
  if v_referrer = p_referee then
    raise exception 'self_referral' using errcode = '22023';
  end if;
  if exists (select 1 from public.referrals where referee_customer_id = p_referee) then
    raise exception 'already_referred' using errcode = '23505';
  end if;
  -- Only new customers: the reward follows the first paid recharge.
  if exists (select 1 from public.balance_entries where customer_id = p_referee and type = 'recharge') then
    raise exception 'referral_too_late' using errcode = '22023';
  end if;
  insert into public.referrals (kitchen_id, referrer_customer_id, referee_customer_id, code, source, created_by, created_at)
  values (v_ref.kitchen_id, v_referrer, p_referee, v_code, p_source, auth.uid(), private.now())
  returning id into v_id;
  return v_id;
end;
$$;

-- Owner: the new customer joined with a referral code (right after create_customer, or later
-- until their first recharge).
create or replace function public.apply_referral_code(p_customer uuid, p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer and deleted_at is null;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  return private.link_referral(p_customer, p_code, 'vendor');
end;
$$;

-- Customer page: a new customer (before their first recharge) enters a friend's code.
create or replace function public.portal_apply_referral(p_token text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers := private.portal_customer(p_token);
begin
  perform private.link_referral(v_cust.id, p_code, 'portal');
  return jsonb_build_object('ok', true);
end;
$$;

-- Leads: a campaign "ref-<CODE>" (website ?ref= link or WhatsApp "Hi TIFFIN ref-CODE") carries the code.
alter table public.leads add column referral_code text check (referral_code ~ '^[A-Z2-9]{8}$');

create or replace function private.lead_referral_code()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.referral_code is null and new.campaign ~* '^ref-[A-Z2-9]{8}$' then
    new.referral_code := upper(substr(new.campaign, 5));
  end if;
  return new;
end;
$$;

create trigger leads_referral_code before insert or update of campaign on public.leads
  for each row execute function private.lead_referral_code();

-- When the lead becomes a customer of the kitchen the code belongs to, link them.
create or replace function private.lead_link_referral()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.link_referral(new.customer_id, new.referral_code, 'lead');
  exception when others then
    null; -- a code from another kitchen, or no longer valid: the customer is simply not referred
  end;
  return null;
end;
$$;

create trigger leads_link_referral after update of customer_id on public.leads
  for each row when (new.customer_id is not null and old.customer_id is null and new.referral_code is not null)
  execute function private.lead_link_referral();

-- After the referee's first paid recharge: N meals each (kitchen setting, 0 = off). Once.
create or replace function private.referral_reward()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.referrals;
  v_meals integer;
  v_e1 uuid;
  v_e2 uuid;
begin
  select * into v_r from public.referrals where referee_customer_id = new.customer_id and status = 'pending' for update;
  if v_r.id is null then
    return null;
  end if;
  select referral_reward_meals into v_meals from public.kitchen_settings where kitchen_id = new.kitchen_id;
  if coalesce(v_meals, 0) <= 0 then
    update public.referrals set status = 'no_reward', rewarded_at = private.now() where id = v_r.id;
    return null;
  end if;
  insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_at)
  values (v_r.kitchen_id, v_r.referee_customer_id, 'credit', v_meals, 0, 'referral_referee', v_r.id,
          'Referral welcome: ' || v_meals || ' free meal(s)', private.now())
  on conflict (type, ref_type, ref_id) where ref_id is not null do nothing
  returning id into v_e1;
  if exists (select 1 from public.customers where id = v_r.referrer_customer_id and deleted_at is null) then
    insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_at)
    values (v_r.kitchen_id, v_r.referrer_customer_id, 'credit', v_meals, 0, 'referral_referrer', v_r.id,
            'Referral thank-you: ' || v_meals || ' free meal(s)', private.now())
    on conflict (type, ref_type, ref_id) where ref_id is not null do nothing
    returning id into v_e2;
  end if;
  update public.referrals
  set status = 'rewarded', reward_meals = v_meals, referee_entry_id = v_e1, referrer_entry_id = v_e2, rewarded_at = private.now()
  where id = v_r.id;
  perform private.sync_balance_status(v_r.kitchen_id, v_r.referee_customer_id);
  perform private.sync_balance_status(v_r.kitchen_id, v_r.referrer_customer_id);
  perform private.notify_customer(v_r.kitchen_id, v_r.referee_customer_id, 'referral_reward',
    jsonb_build_object('meals', v_meals, 'role', 'referee'), 'referral_reward:' || v_r.id || ':referee');
  if v_e2 is not null then
    perform private.notify_customer(v_r.kitchen_id, v_r.referrer_customer_id, 'referral_reward',
      jsonb_build_object('meals', v_meals, 'role', 'referrer',
                         'friend_name', split_part((select name from public.customers where id = v_r.referee_customer_id), ' ', 1)),
      'referral_reward:' || v_r.id || ':referrer');
  end if;
  return null;
end;
$$;

create trigger balance_entries_referral_reward after insert on public.balance_entries
  for each row when (new.type = 'recharge') execute function private.referral_reward();

-- Owner: referrals in the kitchen.
create or replace function public.referrals_list(p_kitchen uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_kitchen, '{owner}');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'referrer_customer_id', r.referrer_customer_id, 'referrer_name', a.name,
      'referee_customer_id', r.referee_customer_id, 'referee_name', b.name, 'code', r.code, 'source', r.source,
      'status', r.status, 'reward_meals', r.reward_meals, 'rewarded_at', r.rewarded_at, 'created_at', r.created_at)
      order by r.created_at desc)
    from public.referrals r
    join public.customers a on a.id = r.referrer_customer_id
    join public.customers b on b.id = r.referee_customer_id
    where r.kitchen_id = p_kitchen), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 8. "Prepared → delivered" alert (every 5 minutes)
-- ===========================================================================
-- A run is prepared at its dispatch photo (run photo, else the slot photo), else at its start.
create or replace function private.queue_late_delivery_alerts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.now();
  v_today date := private.ist_today();
  v_n integer := 0;
  r record;
begin
  for r in
    select dr.id, dr.kitchen_id, dr.service_date, dr.slot, rt.name as route_name, x.prepared_at, ks.late_alert_minutes,
           (select count(*) from public.delivery_stops s where s.run_id = dr.id and s.status = 'pending') as pending,
           (select m.display_name from public.members m where m.kitchen_id = dr.kitchen_id and m.user_id = dr.rider_id) as rider_name
    from public.delivery_runs dr
    join public.delivery_routes rt on rt.id = dr.route_id
    join public.kitchen_settings ks on ks.kitchen_id = dr.kitchen_id
    cross join lateral (
      select coalesce(
        (select min(p.taken_at) from public.dispatch_photos p where p.run_id = dr.id),
        (select min(p.taken_at) from public.dispatch_photos p
         where p.kitchen_id = dr.kitchen_id and p.service_date = dr.service_date and p.slot = dr.slot and p.run_id is null),
        dr.started_at) as prepared_at
    ) x
    where dr.service_date between v_today - 1 and v_today
      and dr.status in ('planned', 'out')
      and x.prepared_at is not null
      and x.prepared_at + make_interval(mins => ks.late_alert_minutes) <= v_now
      and exists (select 1 from public.delivery_stops s where s.run_id = dr.id and s.status = 'pending')
  loop
    perform private.notify_owners(r.kitchen_id, 'late_delivery_alert',
      jsonb_build_object('run_id', r.id, 'route_name', r.route_name, 'rider_name', r.rider_name, 'service_date', r.service_date,
                         'slot', r.slot, 'pending_stops', r.pending, 'minutes', r.late_alert_minutes,
                         'prepared_at', r.prepared_at),
      'late_delivery:' || r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- Customer page extras (payer, dependents, food prefs, referral, specials)
-- ===========================================================================
create or replace function private.portal_extras(p_cust public.customers)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ks public.kitchen_settings;
begin
  select * into v_ks from public.kitchen_settings where kitchen_id = p_cust.kitchen_id;
  return jsonb_build_object(
    'payer', (select jsonb_build_object('name', p.name) from public.customers p
              where p.id = p_cust.payer_customer_id and p.deleted_at is null),
    'dependents', coalesce((select jsonb_agg(jsonb_build_object(
        'customer_id', d.id, 'name', d.name,
        'balance_meals', coalesce((select sum(b.meals) from public.balance_entries b where b.customer_id = d.id), 0),
        'low_threshold', v_ks.low_balance_meals,
        'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'plan', pl.name,
                                     'price_paise', pl.price_per_meal_paise, 'slots', pl.slots) order by s.created_at)
                                   from public.subscriptions s join public.plans pl on pl.id = s.plan_id
                                   where s.customer_id = d.id and s.status <> 'cancelled'), '[]'::jsonb)) order by d.name)
      from public.customers d where d.payer_customer_id = p_cust.id and d.deleted_at is null), '[]'::jsonb),
    'food_prefs', jsonb_build_object(
      'observes_veg_days', p_cust.observes_veg_days, 'observes_kartika', p_cust.observes_kartika,
      'kitchen_veg_days', case when v_ks.veg_days_enabled then to_jsonb(v_ks.veg_days) else '[]'::jsonb end,
      'kitchen_kartika_mode', v_ks.kartika_veg_mode,
      'kartika_now', exists (select 1 from public.food_calendar f where f.kind = 'kartika'
                             and private.ist_today() between f.starts_on and f.ends_on)),
    'referral', jsonb_build_object(
      'code', p_cust.referral_code,
      'url', private.public_web_url() || '/find?ref=' || p_cust.referral_code,
      'reward_meals', v_ks.referral_reward_meals,
      'referred', exists (select 1 from public.referrals r where r.referee_customer_id = p_cust.id),
      'can_apply', not exists (select 1 from public.referrals r where r.referee_customer_id = p_cust.id)
                   and not exists (select 1 from public.balance_entries b where b.customer_id = p_cust.id and b.type = 'recharge')),
    'specials', coalesce((select jsonb_agg(jsonb_build_object('service_date', s.service_date, 'slot', s.slot, 'name', s.name,
                                             'description', s.description, 'addon_price_paise', s.addon_price_paise)
                                           order by s.service_date, s.slot)
                          from public.festival_specials s
                          where s.kitchen_id = p_cust.kitchen_id and s.service_date between private.ist_today() and private.ist_today() + 14),
                         '[]'::jsonb),
    'festivals', coalesce((select jsonb_agg(jsonb_build_object('name', f.name, 'starts_on', f.starts_on, 'ends_on', f.ends_on,
                                              'kind', f.kind, 'veg_only', f.veg_only) order by f.starts_on)
                           from public.food_calendar f
                           where f.ends_on >= private.ist_today() and f.starts_on <= private.ist_today() + 30), '[]'::jsonb));
end;
$$;

-- Customer page (M4) + P5 extras. Same signature.
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
      from public.complaints c where c.customer_id = v_cust.id), '[]'::jsonb))
    || private.portal_extras(v_cust);
end;
$$;


-- ===========================================================================
-- Fixes found in review
-- ===========================================================================
-- (a) Rider idempotency keys are scoped to their stop (M5 looked the op id up across all stops).
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
    v_otp_ok := v_s.otp is not null and trim(coalesce(p_otp, '')) = v_s.otp;
    if not v_otp_ok and not coalesce(p_offline, false) then
      -- Online: let the rider retry, up to 5 wrong codes per stop.
      update public.delivery_stops set otp_attempts = otp_attempts + 1 where id = p_stop;
      if v_s.otp_attempts + 1 >= 5 then
        raise exception 'otp_locked' using errcode = '22023';
      end if;
      return jsonb_build_object('stop_id', p_stop, 'status', 'pending', 'otp_ok', false, 'conflict', false);
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

create or replace function private.do_fail_stop(
  p_stop uuid, p_reason public.fail_reason, p_note text, p_lat double precision, p_lng double precision,
  p_at timestamptz, p_tiffins_returned integer, p_client_op uuid, p_offline boolean, p_actor uuid
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
  v_at timestamptz;
  v_fault boolean;
  v_meals integer;
  v_amount integer;
  v_entry uuid;
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
    return private.stop_result(p_stop, true);
  end if;
  if p_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_reason = 'other' and nullif(trim(p_note), '') is null then
    raise exception 'note_required' using errcode = '22023';
  end if;
  v_at := private.client_time(p_at, v_run.service_date);
  v_fault := private.is_kitchen_fault(p_reason);

  if v_run.status = 'planned' then
    perform private.do_start_run(v_run.id, v_at, p_actor);
  end if;

  -- Kitchen fault: the meals were charged at lock; give them back at the price they were charged.
  if v_fault then
    select coalesce(sum(o.qty), 0), coalesce(sum(o.qty * coalesce(o.price_per_meal_paise, 0)), 0)
    into v_meals, v_amount
    from public.meal_orders o where o.stop_id = p_stop and (o.status <> 'skipped' or o.charged)
      and exists (select 1 from public.balance_entries b where b.type = 'meal' and b.ref_type = 'meal_order' and b.ref_id = o.id);
    if v_meals > 0 then
      insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, ref_type, ref_id, note, created_by, created_at)
      values (v_s.kitchen_id, v_s.customer_id, 'credit', v_meals, v_amount, 'delivery_stop', p_stop,
              'Missed delivery: ' || p_reason, p_actor, v_at)
      on conflict (type, ref_type, ref_id) where ref_id is not null do nothing
      returning id into v_entry;
      if v_entry is not null then
        perform private.sync_balance_status(v_s.kitchen_id, v_s.customer_id);
        perform private.notify_customer(v_s.kitchen_id, v_s.customer_id, 'delivery_credit',
          jsonb_build_object('meals', v_meals, 'service_date', v_run.service_date, 'slot', v_run.slot),
          'delivery_credit:' || p_stop);
      end if;
    end if;
  end if;

  update public.delivery_stops
  set status = 'failed', failed_reason = p_reason, failed_note = nullif(trim(p_note), ''), kitchen_fault = v_fault,
      credit_entry_id = v_entry, gps_lat = p_lat, gps_lng = p_lng, done_at = v_at,
      device_at = case when p_at is distinct from v_at then p_at end, synced_at = private.now(),
      offline = coalesce(p_offline, false), tiffins_returned = coalesce(p_tiffins_returned, 0),
      client_op_id = p_client_op, done_by = p_actor
  where id = p_stop;

  update public.meal_orders set status = 'failed' where stop_id = p_stop and status <> 'skipped';

  if coalesce(p_tiffins_returned, 0) > 0 then
    insert into public.tiffin_ledger (kitchen_id, customer_id, stop_id, tiffins_returned, created_by, created_at)
    values (v_s.kitchen_id, v_s.customer_id, p_stop, p_tiffins_returned, p_actor, v_at)
    on conflict (stop_id) where stop_id is not null do nothing;
  end if;

  return private.stop_result(p_stop);
end;
$$;

-- (b) Inventory alerts (M6): the variance alert's date is the IST day the stock-take closed.
create or replace function public.inventory_alerts(p_kitchen uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner boolean;
begin
  perform private.require_role(p_kitchen, '{owner,staff}');
  v_owner := private.has_role(p_kitchen, '{owner}');
  return
    coalesce((select jsonb_agg(jsonb_build_object('type', 'low_stock', 'item_id', i.id, 'item', i.name, 'unit', i.unit,
                                                  'stock', private.item_stock(i.id), 'min_qty', i.min_qty))
              from public.items i where i.kitchen_id = p_kitchen and i.active and i.min_qty > 0
                and private.item_stock(i.id) <= i.min_qty), '[]'::jsonb)
    || coalesce((select jsonb_agg(jsonb_build_object('type', 'price_jump', 'item_id', i.id, 'item', i.name, 'unit', i.unit,
                                                     'pct', pl.price_jump_pct, 'bill_date', p.bill_date,
                                                     'unit_price_paise', case when v_owner then pl.unit_price_paise end)
                                  order by p.bill_date desc)
                 from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id join public.items i on i.id = pl.item_id
                 where pl.kitchen_id = p_kitchen and pl.price_jump_pct is not null and p.bill_date >= private.ist_today() - 7), '[]'::jsonb)
    || coalesce((select jsonb_agg(jsonb_build_object('type', 'variance', 'item_id', i.id, 'item', i.name, 'unit', i.unit,
                                                     'variance', l.variance, 'pct', round(l.variance * 100 / l.expected_qty, 1),
                                                     'reason', l.reason, 'date', (t.closed_at at time zone 'Asia/Kolkata')::date))
                 from public.stock_take_lines l join public.stock_takes t on t.id = l.stock_take_id join public.items i on i.id = l.item_id
                 where l.kitchen_id = p_kitchen and t.status = 'closed' and t.closed_at >= private.now() - interval '7 days'
                   and l.expected_qty <> 0 and abs(l.variance) > abs(l.expected_qty) * 0.10), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- Schedules (UTC). IST = UTC + 05:30.
-- ===========================================================================
select cron.schedule('tiffin-weather', '30 0,10 * * *', $$select private.kick_function('weather-alerts')$$); -- 06:00 and 16:00 IST
select cron.schedule('tiffin-churn', '30 19 * * *', $$select private.compute_churn(null)$$);               -- 01:00 IST
select cron.schedule('tiffin-late-delivery', '*/5 * * * *', $$select private.queue_late_delivery_alerts()$$);

-- ===========================================================================
-- RLS and grants
-- ===========================================================================
alter table public.food_calendar enable row level security;
alter table public.festival_specials enable row level security;
alter table public.dispatch_photos enable row level security;
alter table public.weather_alerts enable row level security;
alter table public.churn_risks enable row level security;
alter table public.referrals enable row level security;

-- The calendar is platform reference data every signed-in user may read.
create policy food_calendar_select on public.food_calendar for select to authenticated using (true);
create policy festival_specials_select on public.festival_specials for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy dispatch_photos_select on public.dispatch_photos for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff}'))::uuid[]) or (select private.is_platform_admin()));
create policy weather_alerts_select on public.weather_alerts for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy churn_risks_select on public.churn_risks for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
create policy referrals_select on public.referrals for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

revoke all on public.food_calendar, public.festival_specials, public.dispatch_photos, public.weather_alerts,
  public.churn_risks, public.referrals from anon, authenticated;
grant select on public.food_calendar, public.festival_specials, public.dispatch_photos, public.weather_alerts,
  public.churn_risks, public.referrals to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.kitchen_ids(public.member_role[]) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;
grant execute on function private.my_run_ids() to authenticated;

revoke execute on function public.set_payer, public.create_payment_link_record, public.portal_dependent_payment_link_record,
  public.set_customer_food_prefs, public.portal_set_food_prefs, public.admin_upsert_calendar_entry,
  public.admin_delete_calendar_entry, public.create_festival_special, public.delete_festival_special,
  public.festival_specials_list, public.record_dispatch_photo, public.sticker_sheet, public.complete_stop, public.rider_today,
  public.vendor_complaint_score, public.customer_complaint_score, public.admin_complaint_scores, public.weather_kitchens,
  public.weather_record_alert, public.weather_alerts_list, public.at_risk_customers, public.apply_referral_code,
  public.portal_apply_referral, public.referrals_list, public.portal_get, public.inventory_alerts
  from public, anon, authenticated;
grant execute on function public.set_payer, public.create_payment_link_record, public.set_customer_food_prefs,
  public.admin_upsert_calendar_entry, public.admin_delete_calendar_entry, public.create_festival_special,
  public.delete_festival_special, public.festival_specials_list, public.record_dispatch_photo, public.sticker_sheet,
  public.complete_stop, public.rider_today, public.vendor_complaint_score, public.customer_complaint_score,
  public.admin_complaint_scores, public.weather_alerts_list, public.at_risk_customers, public.apply_referral_code,
  public.referrals_list, public.inventory_alerts
  to authenticated;
-- Customer page (token checked inside every function).
grant execute on function public.portal_get, public.portal_dependent_payment_link_record, public.portal_set_food_prefs,
  public.portal_apply_referral to anon, authenticated;
-- weather-alerts Edge Function only.
grant execute on function public.weather_kitchens, public.weather_record_alert to service_role;
