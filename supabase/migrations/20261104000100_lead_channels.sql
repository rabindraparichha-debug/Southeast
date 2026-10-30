-- Lead channels (M9): Sulekha as a source, Google Ads click ids (gclid) on leads, and offline
-- conversions reported back to Google Ads (paid trial, plan, renewal) so bidding optimises for
-- paying customers. Lead emails (Sulekha / Justdial) and CSV imports reuse lead_ingest.

alter type public.lead_source add value if not exists 'sulekha';

alter table public.leads add column gclid text check (length(gclid) <= 200);
create index leads_gclid_idx on public.leads (gclid) where gclid is not null;

-- Conversions waiting to be uploaded to Google Ads (one per lead and stage).
create table public.ad_conversions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  gclid text not null,
  stage text not null check (stage in ('trial', 'plan', 'renewal')),
  value_paise integer not null default 0 check (value_paise >= 0),
  occurred_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lead_id, stage)
);
create index ad_conversions_pending_idx on public.ad_conversions (created_at) where status = 'pending';

alter table public.ad_conversions enable row level security;
create policy ad_conversions_select on public.ad_conversions for select to authenticated using ((select private.is_platform_admin()));
revoke all on public.ad_conversions from anon, authenticated;
grant select on public.ad_conversions to authenticated;

-- When a Google Ads lead reaches a paid stage, queue the conversion with the payment's value.
create or replace function private.queue_ad_conversion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage text;
  v_at timestamptz;
  v_value integer;
begin
  if new.gclid is null or new.status is not distinct from old.status then
    return null;
  end if;
  v_stage := case new.status when 'trial' then 'trial' when 'converted' then 'plan' when 'renewed' then 'renewal' end;
  if v_stage is null then
    return null;
  end if;
  v_at := coalesce(case v_stage when 'trial' then new.trial_at when 'plan' then new.converted_at else new.renewed_at end, private.now());
  select coalesce(b.amount_paise, 0) into v_value from public.balance_entries b
  where b.customer_id = new.customer_id and b.type = 'recharge' order by b.created_at desc, b.seq desc limit 1;
  insert into public.ad_conversions (lead_id, gclid, stage, value_paise, occurred_at)
  values (new.id, new.gclid, v_stage, coalesce(v_value, 0), v_at)
  on conflict (lead_id, stage) do nothing;
  -- A lead that converted straight from matching (no trial) also counts as a trial for bidding.
  if v_stage = 'plan' and new.trial_at is not null and old.status not in ('trial') then
    insert into public.ad_conversions (lead_id, gclid, stage, value_paise, occurred_at)
    values (new.id, new.gclid, 'trial', 0, new.trial_at)
    on conflict (lead_id, stage) do nothing;
  end if;
  return null;
end;
$$;

create trigger leads_ad_conversion after update of status on public.leads
  for each row execute function private.queue_ad_conversion();

-- The ads-conversions Edge Function (service role) claims and completes uploads.
create or replace function public.ads_claim_conversions(p_limit integer default 100)
returns table (id uuid, gclid text, stage text, value_paise integer, occurred_at timestamptz, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select c.id from public.ad_conversions c
    where c.status = 'pending' and c.attempts < 5
    order by c.created_at limit least(greatest(coalesce(p_limit, 100), 1), 2000)
    for update skip locked
  )
  update public.ad_conversions c set status = 'sending', attempts = c.attempts + 1
  from due where c.id = due.id
  returning c.id, c.gclid, c.stage, c.value_paise, c.occurred_at, c.attempts;
end;
$$;

create or replace function public.ads_complete_conversion(p_id uuid, p_ok boolean, p_error text default null, p_skip boolean default false)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ad_conversions
  set status = case when p_skip then 'skipped' when p_ok then 'sent' when attempts >= 5 then 'failed' else 'pending' end,
      last_error = left(p_error, 500), sent_at = case when p_ok then private.now() end
  where id = p_id;
$$;

-- lead_ingest gains the Google click id (Google Ads lead form webhook field gcl_id). The old
-- signature is replaced, so callers that don't pass it keep working.
drop function public.lead_ingest(public.lead_source, text, text, text, text, text, boolean, jsonb);
create or replace function public.lead_ingest(p_source public.lead_source, p_external_id text, p_name text, p_phone text,
                                              p_area text default null, p_campaign text default null,
                                              p_whatsapp_opt_in boolean default false, p_extra jsonb default '{}',
                                              p_gclid text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_id uuid;
begin
  select id into v_existing from public.leads where source = p_source and external_id = p_external_id;
  if v_existing is not null then
    return jsonb_build_object('lead_id', v_existing, 'duplicate', true);
  end if;
  v_id := private.upsert_lead(p_phone, p_source, p_campaign, p_external_id,
    jsonb_strip_nulls(jsonb_build_object('name', p_name, 'area', p_area, 'notes', nullif(p_extra ->> 'notes', ''))) ||
      coalesce(p_extra - 'notes', '{}'),
    true, p_whatsapp_opt_in);
  if nullif(trim(p_gclid), '') is not null then
    update public.leads set gclid = coalesce(gclid, trim(p_gclid)) where id = v_id;
  end if;
  perform private.refresh_lead_matches(v_id);
  if p_whatsapp_opt_in then
    insert into public.notifications_outbox (channel, recipient_type, recipient_id, template, payload, dedupe_key)
    values ('whatsapp', 'lead', v_id, 'lead_welcome',
            jsonb_build_object('name', split_part(coalesce(nullif(trim(p_name), ''), 'there'), ' ', 1), 'source', p_source),
            'lead_welcome:' || v_id)
    on conflict (dedupe_key) do nothing;
  end if;
  return jsonb_build_object('lead_id', v_id, 'duplicate', false);
end;
$$;

-- Website: keep the Google click id from the landing URL (?gclid=…).
create or replace function public.lead_attach_gclid(p_token text, p_gclid text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.leads set gclid = coalesce(gclid, left(trim(p_gclid), 200))
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and nullif(trim(p_gclid), '') is not null;
$$;

-- Admin: import leads exported from a directory dashboard (Sulekha, Justdial, …) as rows of
-- {external_id?, name, phone, area?, campaign?, slots?, diet?, notes?}. Idempotent per row.
create or replace function public.admin_import_leads(p_source public.lead_source, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_res jsonb;
  v_new integer := 0;
  v_dup integer := 0;
  v_bad jsonb := '[]';
  i integer := 0;
begin
  perform private.require_admin();
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'invalid_rows' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_res := public.lead_ingest(p_source,
        coalesce(nullif(trim(r ->> 'external_id'), ''), 'import:' || encode(extensions.digest(coalesce(r ->> 'phone', '') || coalesce(r ->> 'name', ''), 'sha256'), 'hex')),
        r ->> 'name', r ->> 'phone', r ->> 'area', r ->> 'campaign', false,
        jsonb_strip_nulls(jsonb_build_object('notes', r ->> 'notes', 'diet', r ->> 'diet',
          'slots', case when jsonb_typeof(r -> 'slots') = 'array' then r -> 'slots' end)));
      if (v_res ->> 'duplicate')::boolean then v_dup := v_dup + 1; else v_new := v_new + 1; end if;
    exception when others then
      v_bad := v_bad || jsonb_build_object('row', i, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('created', v_new, 'duplicates', v_dup, 'errors', v_bad);
end;
$$;

-- Admin view of conversions sent back to Google Ads.
create or replace function public.admin_ad_conversions(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'lead', l.name, 'campaign', l.campaign, 'stage', c.stage,
                                                       'value_paise', c.value_paise, 'occurred_at', c.occurred_at, 'status', c.status,
                                                       'attempts', c.attempts, 'last_error', c.last_error, 'sent_at', c.sent_at)
                                    order by c.created_at desc)
                   from (select * from public.ad_conversions order by created_at desc limit least(coalesce(p_limit, 100), 500)) c
                   join public.leads l on l.id = c.lead_id), '[]'::jsonb);
end;
$$;

-- Every 15 minutes: start the ads-conversions function when uploads are waiting.
create or replace function private.kick_ad_conversions()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url' limit 1);
  v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1);
begin
  if v_url is null or v_key is null or not exists (select 1 from public.ad_conversions where status = 'pending') then
    return;
  end if;
  perform net.http_post(url := v_url || '/ads-conversions', headers := jsonb_build_object('Authorization', 'Bearer ' || v_key,
                        'Content-Type', 'application/json'), body := '{}'::jsonb);
end;
$$;
select cron.schedule('tiffin-ad-conversions', '*/15 * * * *', $$select private.kick_ad_conversions()$$);

revoke execute on function public.ads_claim_conversions, public.ads_complete_conversion, public.lead_ingest,
  public.lead_attach_gclid, public.admin_import_leads, public.admin_ad_conversions from public, anon, authenticated;
grant execute on function public.ads_claim_conversions, public.ads_complete_conversion, public.lead_ingest to service_role;
grant execute on function public.lead_attach_gclid to anon, authenticated;
grant execute on function public.admin_import_leads, public.admin_ad_conversions to authenticated;
