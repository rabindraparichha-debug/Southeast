-- M1 / 1.1 Foundation: extensions, private schema, enums, fail-closed grants,
-- audit log, phone encryption helpers.
--
-- Conventions (see CLAUDE.md):
--   * All timestamps are timestamptz (UTC). Cutoffs are local IST `time` values.
--   * Money is integer paise. Never floats.
--   * Internal helpers live in schema `private`, which PostgREST does not expose.
--   * Tables and functions get NO grants by default; every grant is explicit.

create extension if not exists postgis with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_cron; -- scheduled jobs from M2 (cutoff lock, nightly generation)

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Fail closed: objects created by migrations get no grants for API roles unless granted explicitly.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('owner', 'staff', 'rider');
create type public.meal_slot as enum ('lunch', 'dinner');
create type public.diet_type as enum ('veg', 'nonveg', 'jain');
-- draft: kitchen uses the OS privately. active: publicly listed (needs FSSAI). suspended: blocked by admin.
create type public.kitchen_status as enum ('draft', 'active', 'suspended');
create type public.subscription_status as enum
  ('trial', 'active', 'paused', 'low_balance', 'suspended', 'cancelled');
create type public.customer_source as enum ('vendor', 'import', 'whatsapp', 'web', 'platform');
create type public.language_code as enum ('en', 'or', 'hi');

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit log (append-only). Every money/count/membership change lands here.
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  kitchen_id uuid,
  actor_id uuid,
  actor_role text,
  table_name text not null,
  row_id text,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE', 'ACCESS')),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_kitchen_idx on public.audit_log (kitchen_id, created_at desc);
create index audit_log_row_idx on public.audit_log (table_name, row_id);

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function private.forbid_mutation();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function private.forbid_mutation();

-- Columns never copied into the audit log.
create or replace function private.audit_redacted_columns()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['phone_enc', 'phone_hash', 'token_hash'];
$$;

create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
begin
  if tg_op = 'UPDATE' and v_old = v_new then
    return new;
  end if;

  insert into public.audit_log (kitchen_id, actor_id, actor_role, table_name, row_id, action, before, after)
  values (
    case when tg_table_name = 'kitchens' then (v_row ->> 'id')::uuid
         else (v_row ->> 'kitchen_id')::uuid end,
    auth.uid(),
    coalesce(auth.role(), current_user),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'kitchen_id', v_row ->> 'user_id'),
    tg_op,
    v_old - private.audit_redacted_columns(),
    v_new - private.audit_redacted_columns()
  );
  return coalesce(new, old);
end;
$$;

-- Explicit access events (e.g. an admin revealing a phone number).
create or replace function private.audit_access(p_kitchen uuid, p_table text, p_row text, p_detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (kitchen_id, actor_id, actor_role, table_name, row_id, action, after)
  values (p_kitchen, auth.uid(), coalesce(auth.role(), current_user), p_table, p_row, 'ACCESS', p_detail);
$$;

-- ---------------------------------------------------------------------------
-- Phone numbers: normalised to +91XXXXXXXXXX, stored encrypted (pgcrypto with a
-- key held in Supabase Vault), looked up by HMAC, displayed by last 4 digits.
-- Keep normalize_phone in sync with packages/core/src/phone.ts (shared test vectors).
-- ---------------------------------------------------------------------------
create or replace function private.normalize_phone(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if length(d) = 12 and left(d, 2) = '91' then
    d := right(d, 10);
  elsif length(d) = 11 and left(d, 1) = '0' then
    d := right(d, 10);
  end if;
  if d ~ '^[6-9][0-9]{9}$' then
    return '+91' || d;
  end if;
  return null;
end;
$$;

create or replace function private.secret(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = p_name;
  if v is null then
    raise exception 'Vault secret "%" is not configured (see CLAUDE.md > Secrets)', p_name;
  end if;
  return v;
end;
$$;

create or replace function private.encrypt_phone(p_e164 text)
returns bytea
language sql
stable
security definer
set search_path = ''
as $$
  select extensions.pgp_sym_encrypt(p_e164, private.secret('phone_encryption_key'));
$$;

create or replace function private.decrypt_phone(p_enc bytea)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_enc is null then null
              else extensions.pgp_sym_decrypt(p_enc, private.secret('phone_encryption_key')) end;
$$;

create or replace function private.phone_hash(p_e164 text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(extensions.hmac(p_e164, private.secret('phone_hash_key'), 'sha256'), 'hex');
$$;

create or replace function private.mask_phone(p_last4 text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_last4 is null then null else '+91 ••••••' || p_last4 end;
$$;

create or replace function private.slugify(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '-', 'g'));
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on table public.audit_log from anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
