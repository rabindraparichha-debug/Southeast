-- Vendor-first wave 3 (safety), audit items 39 and 27: public forms behind a CAPTCHA and rate
-- limits, and a lead flow that never tells a stranger whether a number is a kitchen's customer.
--
--   * submit_lead, lead_choose and submit_vendor_application are no longer callable by anon: the
--     web app reaches them only through the public-forms Edge Function, which checks a Cloudflare
--     Turnstile token (when TURNSTILE_SECRET_KEY is set; required outside a local stack) and passes
--     the caller's IP in the x-tiffin-client-ip header (trusted because only the service role can
--     call these functions).
--   * Rate limits (rate_limit_hits, fixed windows, subjects stored only as keyed hashes):
--       submit_lead                 10 per IP per hour, 30 per IP per day, 500 per hour in all;
--                                   5 per phone per day (M7, unchanged)
--       lead_choose                 20 per IP per hour; 5 per lead per hour; 3 confirmation
--                                   messages per lead per day
--       submit_vendor_application   5 per IP per hour, 20 per IP per day, 200 per hour in all;
--                                   3 per phone per day
--     IP and overall limits raise 'rate_limited', per-phone and per-lead limits 'too_many_requests'.
--   * Flags: submit_lead, lead_choose and lead_confirm need 'marketplace'; submit_vendor_application
--     needs 'growth' (feature_disabled).
--   * The website lead token expires after 24 hours (leads.token_expires_at).
--   * submit_lead needs a location the visitor gives (a shared pin or a known area); it is used for
--     matching even when an older enquiry on the same phone had a pin, so the shortlist and its
--     distances never come from someone else's location.
--   * lead_choose no longer converts the lead. It sends a confirmation link to the lead's phone on
--     WhatsApp (template lead_confirm) and answers the same way whatever the number is: whether that
--     phone is already the kitchen's customer is only shown to whoever holds the phone.
--     lead_confirm(token) (anon, token-protected) then makes them the kitchen's customer
--     (private.convert_lead, unchanged) and returns the trial and the customer-page link; opening
--     the link again within 24 hours returns a fresh page link for the same booking.
--   * lead_choose and lead_confirm re-check that the kitchen still takes platform customers.
--   * A phone whose open lead already picked a kitchen no longer gets that kitchen back from
--     submit_lead (anyone could type the number and learn which kitchen it chose): it gets an
--     ordinary shortlist for what was just submitted, and lead_choose answers 'confirm_sent' without
--     sending anything (the phone holder already has their booking link).

alter table public.leads add column token_expires_at timestamptz;

-- Rate-limit counters. No grants: only the SECURITY DEFINER functions below read or write them.
create table public.rate_limit_hits (
  bucket text not null,
  subject_hash text not null,
  window_start timestamptz not null,
  hits integer not null default 1,
  primary key (bucket, subject_hash, window_start)
);
create index rate_limit_hits_window_idx on public.rate_limit_hits (window_start);
alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from public, anon, authenticated;

-- A pending website pick waiting for the phone holder to confirm (one per lead). No grants.
create table public.lead_confirmations (
  lead_id uuid primary key references public.leads (id) on delete cascade,
  kitchen_id uuid not null references public.kitchens (id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.lead_confirmations enable row level security;
revoke all on public.lead_confirmations from public, anon, authenticated;

-- The caller's IP as passed by the public-forms Edge Function (service role only), or null.
create or replace function private.request_client_ip()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(trim(coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-tiffin-client-ip', '')), '');
$$;

-- Counts one hit for (bucket, subject) in the current window; raises p_error past the limit.
-- A null subject (e.g. no IP known) is not limited.
create or replace function private.rate_limit(p_bucket text, p_subject text, p_limit integer, p_window interval,
  p_error text default 'rate_limited')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz := date_bin(p_window, private.now(), timestamptz '2000-01-01 00:00:00+00');
  v_hits integer;
begin
  if p_subject is null or p_limit is null then
    return;
  end if;
  insert into public.rate_limit_hits (bucket, subject_hash, window_start)
  values (p_bucket, private.phone_hash(p_bucket || ':' || p_subject), v_start)
  on conflict (bucket, subject_hash, window_start) do update set hits = public.rate_limit_hits.hits + 1
  returning hits into v_hits;
  if v_hits > p_limit then
    raise exception '%', p_error using errcode = '22023';
  end if;
  -- Housekeeping: old windows are useless.
  if random() < 0.02 then
    delete from public.rate_limit_hits where window_start < private.now() - interval '2 days';
  end if;
end;
$$;

-- A lead that already picked a kitchen (or is past the trial): its pick is never shown again.
create or replace function private.lead_decided(p public.leads)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p.chosen_kitchen_id is not null or p.customer_id is not null or p.status in ('trial', 'converted', 'renewed', 'lost');
$$;

-- Shortlist for what a decided lead just submitted, computed without storing it (same shape as
-- private.lead_shortlist).
create or replace function private.lead_fresh_shortlist(p_lead uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'kitchen_id', k.id, 'name', k.name, 'slug', k.slug, 'area', k.area, 'distance_km', m.distance_km,
    'plan_id', m.plan_id, 'plan_name', m.plan_name, 'price_per_meal_paise', m.price_per_meal_paise, 'rating', m.rating,
    'reviews', m.reviews, 'trial_meals', k.trial_meals, 'fssai_no', k.fssai_no,
    'profile_url', private.public_web_url() || '/k/' || k.slug
  ) order by m.score desc, m.distance_km), '[]'::jsonb)
  from private.match_kitchens(p_lead, 3) m
  join public.kitchens k on k.id = m.kitchen_id;
$$;

-- Website "find a tiffin" form (M7 body, plus the gate, limits, location rule and token expiry).
create or replace function public.submit_lead(
  p_name text, p_phone text, p_area text default null, p_slots public.meal_slot[] default '{lunch}',
  p_diet public.diet_type default 'veg', p_budget_paise integer default null, p_start date default null,
  p_lat double precision default null, p_lng double precision default null, p_address text default null,
  p_source public.lead_source default 'website', p_campaign text default null, p_consent boolean default false,
  p_whatsapp_opt_in boolean default false, p_language public.language_code default 'en'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_token text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  v_phone text := private.normalize_phone(p_phone);
  v_ip text := private.request_client_ip();
  v_area public.areas;
  v_lat double precision := p_lat;
  v_lng double precision := p_lng;
  v_l public.leads;
  v_status text;
  v_kitchens jsonb;
begin
  perform private.require_feature('marketplace');
  perform private.rate_limit('submit_lead_ip_hour', v_ip, 10, interval '1 hour');
  perform private.rate_limit('submit_lead_ip_day', v_ip, 30, interval '1 day');
  perform private.rate_limit('submit_lead_all_hour', 'all', 500, interval '1 hour');
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if p_source not in ('website', 'instagram', 'google_ads', 'referral', 'other') then
    raise exception 'invalid_source' using errcode = '22023';
  end if;
  -- The visitor's own location: a shared pin, else a known area's centre.
  if v_lat is null or v_lng is null then
    v_area := private.find_area(p_area);
    v_lat := v_area.lat;
    v_lng := v_area.lng;
  end if;
  if v_lat is null or v_lng is null then
    raise exception 'location_required' using errcode = '22023';
  end if;
  -- Abuse guard: at most 5 website submissions per phone per day.
  if (select count(*) from public.lead_events e join public.leads l on l.id = e.lead_id
      where l.phone_hash = private.phone_hash(v_phone) and e.event in ('created', 'enquiry')
        and e.created_at > private.now() - interval '1 day') >= 5 then
    raise exception 'too_many_requests' using errcode = '22023';
  end if;
  v_id := private.upsert_lead(v_phone, p_source, p_campaign, null,
    jsonb_strip_nulls(jsonb_build_object('name', p_name, 'area', coalesce(v_area.name, p_area), 'address_text', p_address,
      'lat', v_lat, 'lng', v_lng, 'slots', to_jsonb(p_slots), 'diet', p_diet, 'budget_per_meal_paise', p_budget_paise,
      'start_date', p_start, 'language', p_language)),
    true, p_whatsapp_opt_in);
  update public.leads set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
                          token_expires_at = private.now() + interval '24 hours'
  where id = v_id
  returning * into v_l;
  if private.lead_decided(v_l) then
    v_kitchens := private.lead_fresh_shortlist(v_id);
    v_status := case when jsonb_array_length(v_kitchens) > 0 then 'matched' else 'waitlist' end;
  else
    v_kitchens := private.refresh_lead_matches(v_id);
    v_status := (select status::text from public.leads where id = v_id);
  end if;
  return jsonb_build_object('token', v_token, 'status', v_status, 'area', v_l.area, 'kitchens', v_kitchens);
end;
$$;

-- The website visitor picks one of their matched kitchens: a confirmation link goes to the phone.
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
        created_at = excluded.created_at;
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

-- The phone holder opened the confirmation link: they become the kitchen's customer.
create or replace function public.lead_confirm(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.lead_confirmations;
  v_l public.leads;
  v_k public.kitchens;
  v_s public.subscriptions;
  v_p public.plans;
  v_token text;
begin
  perform private.require_feature('marketplace');
  select * into v_c from public.lead_confirmations
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and expires_at > private.now();
  if v_c.lead_id is null then
    raise exception 'invalid_link' using errcode = '22023';
  end if;
  select * into v_l from public.leads where id = v_c.lead_id for update;
  select * into v_k from public.kitchens where id = v_c.kitchen_id;
  -- Opened again: the same booking, with a fresh customer-page link.
  if v_l.customer_id is not null then
    if v_l.chosen_kitchen_id is distinct from v_c.kitchen_id then
      raise exception 'already_converted' using errcode = '22023';
    end if;
    select * into v_s from public.subscriptions where customer_id = v_l.customer_id order by created_at limit 1;
    select * into v_p from public.plans where id = v_s.plan_id;
    v_token := private.issue_magic_link(v_l.customer_id, 14);
    return jsonb_build_object('customer_id', v_l.customer_id, 'kitchen_name', v_k.name, 'plan_name', v_p.name,
      'trial_meals', v_k.trial_meals, 'price_per_meal_paise', v_p.price_per_meal_paise,
      'trial_amount_paise', v_k.trial_meals * v_p.price_per_meal_paise, 'portal_token', v_token,
      'portal_url', private.public_web_url() || '/c/' || v_token);
  end if;
  if not coalesce(v_k.accepts_platform_leads, false) then
    raise exception 'kitchen_not_available' using errcode = '22023';
  end if;
  return private.convert_lead(v_c.lead_id, v_c.kitchen_id, null, 'web');
end;
$$;

-- "Run a tiffin service? Join free" form (M7 body, plus the gate and limits).
create or replace function public.submit_vendor_application(
  p_name text, p_phone text, p_kitchen_name text default null, p_area text default null,
  p_subscribers integer default null, p_fssai text default null, p_source public.lead_source default 'website',
  p_campaign text default null, p_consent boolean default false, p_whatsapp_opt_in boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
  v_area public.areas := private.find_area(p_area);
  v_ip text := private.request_client_ip();
  v_id uuid;
begin
  perform private.require_feature('growth');
  perform private.rate_limit('vendor_app_ip_hour', v_ip, 5, interval '1 hour');
  perform private.rate_limit('vendor_app_ip_day', v_ip, 20, interval '1 day');
  perform private.rate_limit('vendor_app_all_hour', 'all', 200, interval '1 hour');
  if not coalesce(p_consent, false) then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if nullif(trim(p_fssai), '') is not null and trim(p_fssai) !~ '^[0-9]{14}$' then
    raise exception 'invalid_fssai' using errcode = '22023';
  end if;
  perform private.rate_limit('vendor_app_phone_day', v_phone, 3, interval '1 day', 'too_many_requests');
  select id into v_id from public.vendor_applications
  where phone_hash = private.phone_hash(v_phone) and status in ('new', 'contacted', 'onboarding');
  if v_id is not null then
    update public.vendor_applications
    set kitchen_name = coalesce(nullif(trim(p_kitchen_name), ''), kitchen_name), area = coalesce(v_area.name, nullif(trim(p_area), ''), area),
        subscribers_estimate = coalesce(p_subscribers, subscribers_estimate), fssai_no = coalesce(nullif(trim(p_fssai), ''), fssai_no),
        whatsapp_opt_in = whatsapp_opt_in or coalesce(p_whatsapp_opt_in, false)
    where id = v_id;
    return v_id;
  end if;
  insert into public.vendor_applications (name, phone_enc, phone_hash, phone_last4, kitchen_name, area, lat, lng,
    subscribers_estimate, fssai_no, source, campaign, consent_at, whatsapp_opt_in, created_at)
  values (trim(p_name), private.encrypt_phone(v_phone), private.phone_hash(v_phone), right(v_phone, 4),
    nullif(trim(p_kitchen_name), ''), coalesce(v_area.name, nullif(trim(p_area), '')), v_area.lat, v_area.lng,
    p_subscribers, nullif(trim(p_fssai), ''), p_source, nullif(trim(p_campaign), ''), private.now(),
    coalesce(p_whatsapp_opt_in, false), private.now())
  returning id into v_id;
  -- Already signed up in the app with this number? Link straight away.
  update public.vendor_applications va set kitchen_id = k.id,
         status = case when k.status = 'active' then 'live'::public.vendor_app_status else 'onboarding'::public.vendor_app_status end
  from public.kitchens k join auth.users u on u.id = k.owner_id
  where va.id = v_id and private.phone_hash('+' || u.phone) = va.phone_hash;
  insert into public.notifications_outbox (channel, recipient_type, recipient_id, template, payload, dedupe_key)
  values ('whatsapp', 'vendor_application', v_id, 'vendor_welcome',
          jsonb_build_object('name', split_part(trim(p_name), ' ', 1), 'url', private.public_web_url() || '/login'),
          'vendor_welcome:' || v_id)
  on conflict (dedupe_key) do nothing;
  return v_id;
end;
$$;

revoke execute on function public.submit_lead, public.lead_choose, public.submit_vendor_application, public.lead_confirm
  from public, anon, authenticated;
grant execute on function public.submit_lead, public.lead_choose, public.submit_vendor_application to service_role;
-- The confirmation link is the proof (24 random bytes, only its hash is stored), like the customer page.
grant execute on function public.lead_confirm to anon, authenticated;
revoke execute on function private.rate_limit, private.request_client_ip, private.lead_decided, private.lead_fresh_shortlist
  from public, anon, authenticated;
