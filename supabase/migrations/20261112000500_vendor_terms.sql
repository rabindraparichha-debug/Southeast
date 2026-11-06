-- Vendor-first wave 3 (safety), audit item 33: vendor terms and the data processing agreement are
-- accepted by the kitchen owner and recorded in the existing consents table.
--
--   * consents rows can now belong to a kitchen instead of a customer: purposes 'vendor_terms' and
--     'data_processing', basis 'kitchen_owner', customer_id null, recorded_by = the owner who
--     accepted, notice_version = the document version. Channel 'app' is added for the mobile app.
--   * private.vendor_terms_versions(): the current versions (both drafts until a lawyer reviews
--     them). Bump them in a migration together with the web pages (/legal/vendor-terms, /legal/dpa);
--     owners are then asked to accept again.
--   * accept_vendor_terms(kitchen, terms_version, dpa_version, channel) (the owner only, not a
--     deputy): refuses a stale version ('terms_outdated'), idempotent per version.
--   * vendor_terms_status(kitchen) (owner): current versions and whether this kitchen accepted them.

alter table public.consents alter column customer_id drop not null;
alter table public.consents add constraint consents_kitchen_fk
  foreign key (kitchen_id) references public.kitchens (id) on delete cascade;

alter table public.consents drop constraint consents_purpose_check;
alter table public.consents add constraint consents_purpose_check
  check (purpose in ('service_contact', 'whatsapp', 'marketing', 'health_data', 'vendor_terms', 'data_processing'));
alter table public.consents drop constraint consents_basis_check;
alter table public.consents add constraint consents_basis_check
  check (basis in ('customer', 'vendor_attested', 'kitchen_owner'));
alter table public.consents drop constraint consents_channel_check;
alter table public.consents add constraint consents_channel_check
  check (channel in ('vendor', 'import', 'whatsapp', 'web', 'app'));
-- A kitchen agreement has no customer and names who accepted it; a customer consent has a customer.
alter table public.consents add constraint consents_subject_check
  check (case when purpose in ('vendor_terms', 'data_processing')
              then customer_id is null and basis = 'kitchen_owner' and recorded_by is not null
              else customer_id is not null and basis <> 'kitchen_owner' end);
create unique index consents_kitchen_agreement_idx on public.consents (kitchen_id, purpose, notice_version)
  where customer_id is null and withdrawn_at is null;

create or replace function private.vendor_terms_versions()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('vendor_terms', '2026-11-draft-1', 'data_processing', '2026-11-draft-1');
$$;

create or replace function public.vendor_terms_status(p_kitchen uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_versions jsonb := private.vendor_terms_versions();
  v_terms public.consents;
  v_dpa public.consents;
begin
  perform private.require_role(p_kitchen, '{owner}');
  select * into v_terms from public.consents
  where kitchen_id = p_kitchen and customer_id is null and purpose = 'vendor_terms' and withdrawn_at is null
    and notice_version = v_versions ->> 'vendor_terms';
  select * into v_dpa from public.consents
  where kitchen_id = p_kitchen and customer_id is null and purpose = 'data_processing' and withdrawn_at is null
    and notice_version = v_versions ->> 'data_processing';
  return jsonb_build_object(
    'terms_version', v_versions ->> 'vendor_terms', 'dpa_version', v_versions ->> 'data_processing',
    'accepted', v_terms.id is not null and v_dpa.id is not null,
    'accepted_at', greatest(v_terms.created_at, v_dpa.created_at));
end;
$$;

create or replace function public.accept_vendor_terms(p_kitchen uuid, p_terms_version text, p_dpa_version text,
  p_channel text default 'web')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_versions jsonb := private.vendor_terms_versions();
begin
  perform private.require_role(p_kitchen, '{owner}');
  -- The kitchen's owner signs its contract, not a deputy.
  if not exists (select 1 from public.members where kitchen_id = p_kitchen and user_id = auth.uid() and role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_terms_version is distinct from v_versions ->> 'vendor_terms' or p_dpa_version is distinct from v_versions ->> 'data_processing' then
    raise exception 'terms_outdated' using errcode = '22023';
  end if;
  if coalesce(p_channel, '') not in ('web', 'app') then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;
  insert into public.consents (kitchen_id, customer_id, purpose, basis, channel, notice_version, recorded_by, created_at)
  values (p_kitchen, null, 'vendor_terms', 'kitchen_owner', p_channel, p_terms_version, auth.uid(), private.now()),
         (p_kitchen, null, 'data_processing', 'kitchen_owner', p_channel, p_dpa_version, auth.uid(), private.now())
  on conflict (kitchen_id, purpose, notice_version) where customer_id is null and withdrawn_at is null do nothing;
  return public.vendor_terms_status(p_kitchen);
end;
$$;

revoke execute on function public.vendor_terms_status, public.accept_vendor_terms from public, anon;
grant execute on function public.vendor_terms_status, public.accept_vendor_terms to authenticated;
revoke execute on function private.vendor_terms_versions from public, anon, authenticated;
