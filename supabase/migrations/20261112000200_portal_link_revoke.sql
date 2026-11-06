-- Vendor-first wave 3 (safety), audit item 37: customer-page links (magic links) can be revoked.
--
--   * revoke_customer_page_links(customer): the owner stops every live link of a customer at once
--     (a forwarded link, a lost phone). The page then answers invalid_link.
--   * rotate_customer_page_link(customer): revokes them all and returns one new 7-day link.
--   * There is no automatic cap on live links: links already queued in the outbox or sent in a recent
--     message (payer reminders mint one per eater) must keep working. Links still expire (7 or 14
--     days, unchanged private.issue_magic_link), and the owner revokes or rotates when one leaks.
--   * customer_page_links(customer): how many links are live and when the newest was used (owner).

create index if not exists customer_magic_links_live_idx on public.customer_magic_links (customer_id, created_at desc)
  where revoked_at is null;

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
