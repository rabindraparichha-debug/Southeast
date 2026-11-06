-- Vendor-first wave 3 (safety), audit item 37: customer-page links (magic links) can be revoked.
--
--   * revoke_customer_page_links(customer): the owner stops every live link of a customer at once
--     (a forwarded link, a lost phone). The page then answers invalid_link.
--   * rotate_customer_page_link(customer): revokes them all and returns one new 7-day link.
--   * A customer has at most 3 live links: issuing a new one revokes the oldest beyond that, so the
--     bot's "my page", payer messages and trial follow-ups no longer pile up live tokens.
--   * customer_page_links(customer): how many links are live and when the newest was used (owner).

create index if not exists customer_magic_links_live_idx on public.customer_magic_links (customer_id, created_at desc)
  where revoked_at is null;

create or replace function private.issue_magic_link(p_customer uuid, p_days integer default 7)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer and deleted_at is null;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.customer_magic_links (kitchen_id, customer_id, token_hash, expires_at, created_at)
  values (v_kitchen, p_customer, encode(extensions.digest(v_token, 'sha256'), 'hex'), private.now() + make_interval(days => p_days),
          clock_timestamp());
  -- Keep the 3 newest live links; older ones stop working.
  update public.customer_magic_links set revoked_at = private.now()
  where id in (select l.id from public.customer_magic_links l
               where l.customer_id = p_customer and l.revoked_at is null and l.expires_at > private.now()
               order by l.created_at desc offset 3);
  return v_token;
end;
$$;

create or replace function public.revoke_customer_page_links(p_customer uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
  v_n integer;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  update public.customer_magic_links set revoked_at = private.now()
  where customer_id = p_customer and revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.rotate_customer_page_link(p_customer uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  update public.customer_magic_links set revoked_at = private.now()
  where customer_id = p_customer and revoked_at is null;
  return private.issue_magic_link(p_customer, 7);
end;
$$;

create or replace function public.customer_page_links(p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.customers where id = p_customer;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}');
  return (select jsonb_build_object(
    'live', count(*) filter (where revoked_at is null and expires_at > private.now()),
    'last_used_at', max(last_used_at) filter (where revoked_at is null and expires_at > private.now()),
    'expires_at', max(expires_at) filter (where revoked_at is null and expires_at > private.now()))
    from public.customer_magic_links where customer_id = p_customer);
end;
$$;

revoke execute on function public.revoke_customer_page_links, public.rotate_customer_page_link, public.customer_page_links
  from public, anon;
grant execute on function public.revoke_customer_page_links, public.rotate_customer_page_link, public.customer_page_links
  to authenticated;
