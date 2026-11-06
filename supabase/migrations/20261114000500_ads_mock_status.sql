-- Phase 2 hardening, step 5: Google Ads conversions handled in mock mode are not "sent"
-- (docs/VENDOR_FIRST_AUDIT.md, Phase 2 step 1; D-131).
--
-- In mock mode (GOOGLE_ADS_MODE unset or mock) the ads-conversions function used to mark rows 'sent'
-- although nothing left the server, so they were never uploaded after going live and the admin page
-- showed them as sent. They now get the status 'mock' (no sent_at). In live mode the function also
-- claims 'mock' rows, so they are uploaded on its first live run; admin_requeue_mock_conversions()
-- puts them back to 'pending' at once (it also starts the next run sooner, as the 15-minute kick only
-- looks for pending rows).

alter table public.ad_conversions drop constraint ad_conversions_status_check;
alter table public.ad_conversions add constraint ad_conversions_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'mock'));
create index ad_conversions_mock_idx on public.ad_conversions (created_at) where status = 'mock';

drop function public.ads_claim_conversions(integer);
create function public.ads_claim_conversions(p_limit integer default 100, p_include_mock boolean default false)
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
    where (c.status = 'pending' and c.attempts < 5) or (coalesce(p_include_mock, false) and c.status = 'mock')
    order by c.created_at limit least(greatest(coalesce(p_limit, 100), 1), 2000)
    for update skip locked
  )
  -- A mock row starts its real attempts from zero.
  update public.ad_conversions c
  set status = 'sending', attempts = case when c.status = 'mock' then 1 else c.attempts + 1 end, last_error = null
  from due where c.id = due.id
  returning c.id, c.gclid, c.stage, c.value_paise, c.occurred_at, c.attempts;
end;
$$;

drop function public.ads_complete_conversion(uuid, boolean, text, boolean);
create function public.ads_complete_conversion(p_id uuid, p_ok boolean, p_error text default null, p_skip boolean default false,
                                               p_mock boolean default false)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ad_conversions
  set status = case when p_skip then 'skipped' when p_mock then 'mock' when p_ok then 'sent'
                    when attempts >= 5 then 'failed' else 'pending' end,
      attempts = case when p_mock then 0 else attempts end,
      last_error = case when p_mock then 'not sent: mock mode' else left(p_error, 500) end,
      sent_at = case when p_ok and not p_mock and not p_skip then private.now() end
  where id = p_id;
$$;

-- Admin: after switching Google Ads to live, queue every mock-handled conversion for upload.
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
  update public.ad_conversions set status = 'pending', attempts = 0, last_error = null where status = 'mock';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.ads_claim_conversions(integer, boolean), public.ads_complete_conversion(uuid, boolean, text, boolean, boolean),
  public.admin_requeue_mock_conversions() from public, anon, authenticated;
grant execute on function public.ads_claim_conversions(integer, boolean), public.ads_complete_conversion(uuid, boolean, text, boolean, boolean)
  to service_role;
grant execute on function public.admin_requeue_mock_conversions() to authenticated;
