-- Vendor-first wave 2, item 23 (D-117): Manager and Accountant roles.
--
-- Model
--   * manager   = the owner's deputy. Every check written for '{owner}' also accepts a manager
--                 (private.expand_roles), EXCEPT the owner-only areas, which pass p_exact => true:
--                 inbox (D-060), settings (kitchens / kitchen_settings updates, listing photos),
--                 members and invites, payouts, commission statement, the audit log, broadcasts.
--                 So a manager can add customers, record changes, record and void payments, confirm
--                 rider cash, approve rider requests, run delivery and stock, and gets owner alerts.
--   * accountant = reads money only: payments, refunds, balances, dues, statements, reports,
--                 supplier dues and costs. No writes at all. Phones are masked (last 4 digits),
--                 like staff (decision in docs/DECISIONS.md D-136).
--   * staff and rider are unchanged (staff: no money, no phones; riders: their own stops).
--
-- Also: claim_invites now also requires that the caller's session was signed in with a one-time
-- code (JWT amr 'otp'). phone_confirmed_at alone is not proof: with phone confirmations off, a
-- phone + password sign-up is marked confirmed without any code (the audit's stranger-claims-invite hole).

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------
create or replace function private.expand_roles(p_roles public.member_role[])
returns public.member_role[]
language sql
immutable
set search_path = ''
as $$
  select case
           when p_roles is not null and 'owner' = any (p_roles) and not ('manager' = any (p_roles))
             then p_roles || 'manager'::public.member_role
           else p_roles
         end;
$$;

create or replace function private.kitchen_ids(p_roles public.member_role[] default null)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.kitchen_id), '{}')
  from public.members m
  where m.user_id = auth.uid()
    and (p_roles is null or m.role = any (private.expand_roles(p_roles)));
$$;

-- p_exact => true: exactly these roles (owner-only areas pass '{owner}', true).
create or replace function private.kitchen_ids(p_roles public.member_role[], p_exact boolean)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.kitchen_id), '{}')
  from public.members m
  where m.user_id = auth.uid()
    and m.role = any (case when p_exact then p_roles else private.expand_roles(p_roles) end);
$$;

create or replace function private.has_role(p_kitchen uuid, p_roles public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.kitchen_id = p_kitchen and m.user_id = auth.uid() and m.role = any (private.expand_roles(p_roles))
  );
$$;

create or replace function private.has_role(p_kitchen uuid, p_roles public.member_role[], p_exact boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.kitchen_id = p_kitchen and m.user_id = auth.uid()
      and m.role = any (case when p_exact then p_roles else private.expand_roles(p_roles) end)
  );
$$;

create or replace function private.require_role(p_kitchen uuid, p_roles public.member_role[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not private.has_role(p_kitchen, p_roles) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.require_role(p_kitchen uuid, p_roles public.member_role[], p_exact boolean)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not private.has_role(p_kitchen, p_roles, p_exact) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Members and invites: owner only (exact). Managers and accountants can be invited.
-- ---------------------------------------------------------------------------
create or replace function public.invite_member(
  p_kitchen uuid,
  p_phone text,
  p_role public.member_role,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := private.normalize_phone(p_phone);
  v_user uuid;
  v_id uuid;
begin
  perform private.require_role(p_kitchen, '{owner}', true);
  if p_role = 'owner' then
    raise exception 'cannot_invite_owner' using errcode = '22023';
  end if;
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  select id into v_user from auth.users where phone = substr(v_phone, 2) limit 1;

  if v_user is not null then
    if exists (select 1 from public.members where kitchen_id = p_kitchen and user_id = v_user) then
      raise exception 'already_member' using errcode = '23505';
    end if;
    insert into public.members (kitchen_id, user_id, role, display_name)
    values (p_kitchen, v_user, p_role, p_display_name)
    returning id into v_id;
    return jsonb_build_object('status', 'added', 'member_id', v_id);
  end if;

  insert into public.member_invites (kitchen_id, phone_e164, role, display_name, invited_by)
  values (p_kitchen, v_phone, p_role, p_display_name, auth.uid())
  on conflict (kitchen_id, phone_e164) where accepted_at is null and revoked_at is null
  do update set role = excluded.role, display_name = excluded.display_name
  returning id into v_id;
  return jsonb_build_object('status', 'invited', 'invite_id', v_id);
end;
$$;

create or replace function public.revoke_invite(p_invite uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kitchen uuid;
begin
  select kitchen_id into v_kitchen from public.member_invites where id = p_invite;
  if v_kitchen is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_kitchen, '{owner}', true);
  update public.member_invites set revoked_at = now()
  where id = p_invite and accepted_at is null and revoked_at is null;
end;
$$;

create or replace function public.set_member_role(p_member uuid, p_role public.member_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members;
begin
  select * into v_member from public.members where id = p_member;
  if v_member.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_member.kitchen_id, '{owner}', true);
  if v_member.role = 'owner' or p_role = 'owner' then
    raise exception 'owner_role_locked' using errcode = '22023';
  end if;
  update public.members set role = p_role where id = p_member;
end;
$$;

create or replace function public.remove_member(p_member uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members;
begin
  select * into v_member from public.members where id = p_member;
  if v_member.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_member.kitchen_id, '{owner}', true);
  if v_member.role = 'owner' then
    raise exception 'owner_role_locked' using errcode = '22023';
  end if;
  delete from public.members where id = p_member;
end;
$$;

create or replace function public.claim_invites()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_phone text;
  v_count integer := 0;
  r record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select '+' || phone into v_phone
  from auth.users where id = v_uid and phone_confirmed_at is not null;
  if v_phone is null then
    return 0;
  end if;
  -- The phone must be proven in this session with a one-time code. A phone + password sign-up is
  -- marked confirmed without any code when phone confirmations are off, so phone_confirmed_at alone
  -- would let a stranger who types an invited number join the kitchen.
  if not exists (select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
                 where a ->> 'method' = 'otp') then
    return 0;
  end if;

  for r in
    select * from public.member_invites
    where phone_e164 = v_phone and accepted_at is null and revoked_at is null
    for update
  loop
    insert into public.members (kitchen_id, user_id, role, display_name)
    values (r.kitchen_id, v_uid, r.role, r.display_name)
    on conflict (kitchen_id, user_id) do nothing;
    update public.member_invites set accepted_at = private.now(), accepted_user_id = v_uid where id = r.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner-only areas: inbox (D-060), broadcasts, commission statement.
-- ---------------------------------------------------------------------------
create or replace function public.send_vendor_message(p_conversation uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
  v_id uuid;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null or v_c.kitchen_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}', true);
  if nullif(trim(p_body), '') is null or length(p_body) > 1000 then
    raise exception 'invalid_message' using errcode = '22023';
  end if;
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  values (v_c.kitchen_id, 'whatsapp', 'customer', v_c.customer_id, 'vendor_message',
          jsonb_build_object('text', trim(p_body), 'sent_by', auth.uid()), 'vendor_message:' || gen_random_uuid())
  returning id into v_id;
  update public.conversations set unread_count = 0 where id = p_conversation;
  update public.complaints set status = 'responded', responded_at = coalesce(responded_at, private.now())
  where conversation_id = p_conversation and status in ('open', 'escalated');
  return v_id;
end;
$$;

create or replace function public.close_conversation(p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null or v_c.kitchen_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}', true);
  update public.conversations
  set handoff_open = false, handoff_at = null, unread_count = 0,
      state = case when state ? 'optin_asked' then jsonb_build_object('optin_asked', state -> 'optin_asked') else '{}'::jsonb end
  where id = p_conversation;
end;
$$;

create or replace function public.mark_conversation_read(p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null or v_c.kitchen_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_c.kitchen_id, '{owner}', true);
  update public.conversations set unread_count = 0 where id = p_conversation;
end;
$$;

create or replace function public.send_broadcast(p_kitchen uuid, p_body text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap integer;
  v_used integer;
  v_id uuid;
  v_n integer;
begin
  perform private.require_role(p_kitchen, '{owner}', true);
  select broadcast_cap_monthly into v_cap from public.kitchen_settings where kitchen_id = p_kitchen;
  select count(*) into v_used from public.broadcasts
  where kitchen_id = p_kitchen and date_trunc('month', created_at at time zone 'Asia/Kolkata') = date_trunc('month', private.now() at time zone 'Asia/Kolkata');
  if v_used >= v_cap then
    raise exception 'broadcast_cap_reached' using errcode = '22023';
  end if;
  insert into public.broadcasts (kitchen_id, body, recipients, created_by, created_at)
  values (p_kitchen, trim(p_body), 0, auth.uid(), private.now()) returning id into v_id;
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select distinct p_kitchen, 'whatsapp', 'customer', c.id, 'broadcast', jsonb_build_object('text', trim(p_body)),
         'broadcast:' || v_id || ':' || c.id
  from public.customers c join public.subscriptions s on s.customer_id = c.id and s.status <> 'cancelled'
  where c.kitchen_id = p_kitchen and c.whatsapp_opt_in and c.deleted_at is null;
  get diagnostics v_n = row_count;
  update public.broadcasts set recipients = v_n where id = v_id;
  return v_n;
end;
$$;

create or replace function public.commission_statement(p_kitchen uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_gross bigint;
  v_rev bigint;
begin
  perform private.require_role(p_kitchen, '{owner}', true);
  select coalesce(sum(commission_paise), 0) into v_gross from public.platform_commissions
   where kitchen_id = p_kitchen and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to;
  select coalesce(sum(reversed_paise), 0) into v_rev from public.platform_commission_reversals
   where kitchen_id = p_kitchen and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to;
  return jsonb_build_object(
    'commission_bps', (select commission_bps from public.kitchen_payout_accounts where kitchen_id = p_kitchen),
    'gross_commission_paise', v_gross, 'reversed_paise', v_rev,
    'commission_paise', v_gross - v_rev,
    'rows', coalesce((select jsonb_agg(jsonb_build_object('payment_id', c.payment_id, 'customer_name', cu.name,
         'amount_paise', c.amount_paise, 'commission_paise', c.commission_paise, 'transfer_paise', c.transfer_paise,
         'reversed_paise', (select coalesce(sum(r.reversed_paise), 0) from public.platform_commission_reversals r where r.commission_id = c.id),
         'created_at', c.created_at) order by c.created_at desc)
       from public.platform_commissions c join public.customers cu on cu.id = c.customer_id
       where c.kitchen_id = p_kitchen and (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to), '[]'::jsonb));
end;
$$;

-- Settings, members/invites, payouts, audit log, inbox, broadcasts, commissions, listing photos:
-- policies switch to the exact owner list (no manager).
drop policy kitchens_update on public.kitchens;
create policy kitchens_update on public.kitchens for update to authenticated
  using (id = any ((select private.kitchen_ids('{owner}', true))::uuid[]))
  with check (id = any ((select private.kitchen_ids('{owner}', true))::uuid[]));
drop policy kitchen_settings_update on public.kitchen_settings;
create policy kitchen_settings_update on public.kitchen_settings for update to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]))
  with check (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]));
drop policy member_invites_select on public.member_invites;
create policy member_invites_select on public.member_invites for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]) or (select private.is_platform_admin()));
drop policy kitchen_payout_accounts_select on public.kitchen_payout_accounts;
create policy kitchen_payout_accounts_select on public.kitchen_payout_accounts for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]) or (select private.is_platform_admin()));
drop policy audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]) or (select private.is_platform_admin()));
drop policy conversations_select on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]) or (select private.is_platform_admin()));
drop policy messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]) or (select private.is_platform_admin()));
drop policy broadcasts_select on public.broadcasts;
create policy broadcasts_select on public.broadcasts for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]) or (select private.is_platform_admin()));
drop policy platform_commissions_select on public.platform_commissions;
create policy platform_commissions_select on public.platform_commissions for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]) or (select private.is_platform_admin()));
drop policy platform_commission_reversals_select on public.platform_commission_reversals;
create policy platform_commission_reversals_select on public.platform_commission_reversals for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}', true))::uuid[]) or (select private.is_platform_admin()));
drop policy kitchen_photos_upload on storage.objects;
create policy kitchen_photos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'kitchen-photos'
              and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}', true))::text[]));
drop policy kitchen_photos_delete on storage.objects;
create policy kitchen_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'kitchen-photos'
         and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}', true))::text[]));
drop policy kitchen_photos_owner_read on storage.objects;
create policy kitchen_photos_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'kitchen-photos'
         and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner}', true))::text[]));

-- ---------------------------------------------------------------------------
-- Accountant: read money (and the customer names, plans and subscriptions it belongs to).
-- Owner checks already include the manager.
-- ---------------------------------------------------------------------------
drop policy customers_select on public.customers;
create policy customers_select on public.customers for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff,accountant}'))::uuid[])
         or (select private.is_platform_admin()));
drop policy plans_select on public.plans;
create policy plans_select on public.plans for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,accountant}'))::uuid[]) or (select private.is_platform_admin()));
drop policy subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,accountant}'))::uuid[]) or (select private.is_platform_admin()));
drop policy balance_entries_select on public.balance_entries;
create policy balance_entries_select on public.balance_entries for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,accountant}'))::uuid[]) or (select private.is_platform_admin()));
drop policy payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,accountant}'))::uuid[])
         or collected_by = (select auth.uid())
         or (select private.is_platform_admin()));
drop policy refunds_select on public.refunds;
create policy refunds_select on public.refunds for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,accountant}'))::uuid[]) or (select private.is_platform_admin()));
drop policy supplier_payments_select on public.supplier_payments;
create policy supplier_payments_select on public.supplier_payments for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,accountant}'))::uuid[]) or (select private.is_platform_admin()));
drop policy suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff,accountant}'))::uuid[]) or (select private.is_platform_admin()));
drop policy purchases_select on public.purchases;
create policy purchases_select on public.purchases for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff,accountant}'))::uuid[]) or (select private.is_platform_admin()));
drop policy purchase_lines_select on public.purchase_lines;
create policy purchase_lines_select on public.purchase_lines for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff,accountant}'))::uuid[]) or (select private.is_platform_admin()));
drop policy items_select on public.items;
create policy items_select on public.items for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner,staff,accountant}'))::uuid[]) or (select private.is_platform_admin()));
drop policy receipts_read on storage.objects;
create policy receipts_read on storage.objects for select to authenticated
  using (bucket_id = 'receipts'
         and (storage.foldername(name))[1] = any ((select private.kitchen_ids('{owner,accountant}'))::text[]));

-- Full number for the owner and manager; masked for staff and accountants.
create or replace function public.customer_phone(p_customer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when private.has_role(c.kitchen_id, '{owner}') then private.decrypt_phone(c.phone_enc)
           else private.mask_phone(c.phone_last4)
         end
  from public.customers c
  where c.id = p_customer
    and (private.has_role(c.kitchen_id, '{owner,staff,accountant}') or private.is_platform_admin());
$$;

create or replace function public.search_customers(p_kitchen uuid, p_q text, p_limit integer default 50)
returns setof public.customers_v
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := trim(coalesce(p_q, ''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
  v_phone text;
begin
  perform private.require_role(p_kitchen, '{owner,staff,accountant}');
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  if v_q = '' then
    return query select * from public.customers_v v where v.kitchen_id = p_kitchen
      order by v.name limit p_limit;
  elsif length(v_digits) >= 10 and v_digits = regexp_replace(v_q, '[\s+\-]', '', 'g') then
    v_phone := private.normalize_phone(v_q);
    if v_phone is null or not private.has_role(p_kitchen, '{owner}') then
      return;
    end if;
    -- D-118: several customers may share a phone; return all of them.
    return query select v.* from public.customers_v v
      join public.customers c on c.id = v.id
      where c.kitchen_id = p_kitchen and c.phone_hash = private.phone_hash(v_phone)
      order by v.name, v.id;
  elsif v_q ~ '^[0-9]{4}$' then
    return query select * from public.customers_v v
      where v.kitchen_id = p_kitchen and v.phone_last4 = v_q order by v.name limit p_limit;
  else
    return query select * from public.customers_v v
      where v.kitchen_id = p_kitchen
        and (v.name ilike '%' || v_q || '%' or v.area ilike '%' || v_q || '%' or v.landmark ilike '%' || v_q || '%')
      order by v.name limit p_limit;
  end if;
end;
$$;

create or replace function public.office_statement(p_office uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_o public.offices;
  v_from timestamptz;
  v_to timestamptz;
begin
  select * into v_o from public.offices where id = p_office;
  if v_o.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_o.kitchen_id, '{owner,accountant}');
  v_from := date_trunc('month', p_month)::date::timestamp at time zone 'Asia/Kolkata';
  v_to := (date_trunc('month', p_month) + interval '1 month')::date::timestamp at time zone 'Asia/Kolkata';
  return (
    with m as (
      select c.id, c.name,
             coalesce(-sum(b.meals) filter (where b.type = 'meal'), 0)::integer as meals,
             coalesce(-sum(b.amount_paise) filter (where b.type = 'meal'), 0)::integer as amount_paise,
             coalesce(sum(b.meals) filter (where b.type = 'credit'), 0)::integer as credit_meals,
             (select coalesce(sum(p.amount_paise), 0) from public.payments p where p.customer_id = c.id and p.status = 'paid'
                and p.paid_at >= v_from and p.paid_at < v_to)::integer as paid_paise,
             (select coalesce(sum(x.meals), 0) from public.balance_entries x where x.customer_id = c.id)::integer as balance_meals
      from public.customers c
      left join public.balance_entries b on b.customer_id = c.id and b.created_at >= v_from and b.created_at < v_to
      where c.office_id = v_o.id
      group by c.id, c.name
    )
    select jsonb_build_object(
      'office', jsonb_build_object('id', v_o.id, 'name', v_o.name, 'billing_customer_id', v_o.billing_customer_id,
                                   'billing_customer_name', (select name from public.customers where id = v_o.billing_customer_id)),
      'month', to_char(date_trunc('month', p_month), 'YYYY-MM'),
      'members', coalesce((select jsonb_agg(jsonb_build_object('customer_id', id, 'name', name, 'meals', meals,
                            'amount_paise', amount_paise, 'credit_meals', credit_meals, 'paid_paise', paid_paise,
                            'balance_meals', balance_meals) order by name) from m), '[]'::jsonb),
      'totals', jsonb_build_object('meals', coalesce((select sum(meals) from m), 0),
                                   'amount_paise', coalesce((select sum(amount_paise) from m), 0),
                                   'paid_paise', coalesce((select sum(paid_paise) from m), 0),
                                   'balance_meals', coalesce((select sum(balance_meals) from m), 0))));
end;
$$;

create or replace function public.supplier_dues(p_kitchen uuid)
returns table (supplier_id uuid, name text, phone text, purchased_paise integer, paid_paise integer, due_paise integer,
               last_bill_date date)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
  return query
  select s.id, s.name, s.phone,
         coalesce((select sum(total_paise) from public.purchases p where p.supplier_id = s.id), 0)::integer,
         coalesce((select sum(amount_paise) from public.supplier_payments sp where sp.supplier_id = s.id), 0)::integer,
         (coalesce((select sum(total_paise) from public.purchases p where p.supplier_id = s.id), 0)
          - coalesce((select sum(amount_paise) from public.supplier_payments sp where sp.supplier_id = s.id), 0))::integer,
         (select max(bill_date) from public.purchases p where p.supplier_id = s.id)
  from public.suppliers s
  where s.kitchen_id = p_kitchen
  order by 6 desc, 2;
end;
$$;

create or replace function public.cost_report(p_kitchen uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_meals integer;
  v_revenue bigint;
  v_ingredients bigint;
  v_waste bigint;
  v_shrink bigint;
  v_gas integer;
  v_pack integer;
  v_cost bigint;
begin
  perform private.require_role(p_kitchen, '{owner,accountant}');
  select coalesce(sum(o.qty), 0), coalesce(sum(o.qty * coalesce(o.price_per_meal_paise, 0)), 0)
  into v_meals, v_revenue
  from public.meal_orders o
  where o.kitchen_id = p_kitchen and o.service_date between p_from and p_to and o.locked_at is not null
    and (o.status <> 'skipped' or o.charged);
  select coalesce(round(sum(-sm.qty * coalesce(sm.unit_cost_paise, 0))), 0) into v_ingredients
  from public.stock_moves sm join public.count_snapshots cs on cs.id = sm.ref_id
  where sm.ref_type = 'count_snapshot' and sm.type = 'consume' and cs.kitchen_id = p_kitchen and cs.service_date between p_from and p_to;
  select coalesce(round(sum(-sm.qty * coalesce(sm.unit_cost_paise, 0))), 0) into v_waste
  from public.stock_moves sm
  where sm.kitchen_id = p_kitchen and sm.type = 'waste'
    and sm.created_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and sm.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata');
  select coalesce(round(sum(-sm.qty * coalesce(sm.unit_cost_paise, 0))), 0) into v_shrink
  from public.stock_moves sm
  where sm.kitchen_id = p_kitchen and sm.type = 'count'
    and sm.created_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and sm.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata');
  select gas_paise_per_meal, packaging_paise_per_meal into v_gas, v_pack from public.kitchen_settings where kitchen_id = p_kitchen;
  v_cost := v_ingredients + v_waste + greatest(v_shrink, 0) + v_meals * (coalesce(v_gas, 0) + coalesce(v_pack, 0));
  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'meals', v_meals, 'revenue_paise', v_revenue,
    'ingredients_paise', v_ingredients, 'waste_paise', v_waste, 'stock_loss_paise', v_shrink,
    'gas_paise', v_meals * coalesce(v_gas, 0), 'packaging_paise', v_meals * coalesce(v_pack, 0),
    'total_cost_paise', v_cost,
    'cost_per_meal_paise', case when v_meals > 0 then round(v_cost::numeric / v_meals) end,
    'revenue_per_meal_paise', case when v_meals > 0 then round(v_revenue::numeric / v_meals) end,
    'margin_per_meal_paise', case when v_meals > 0 then round((v_revenue - v_cost)::numeric / v_meals) end,
    'margin_pct', case when v_revenue > 0 then round((v_revenue - v_cost) * 100.0 / v_revenue, 1) end,
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.service_date, 'meals', d.meals,
                         'ingredients_paise', coalesce((select round(sum(-sm.qty * coalesce(sm.unit_cost_paise, 0)))
                                                        from public.stock_moves sm join public.count_snapshots cs on cs.id = sm.ref_id
                                                        where sm.ref_type = 'count_snapshot' and sm.type = 'consume'
                                                          and cs.kitchen_id = p_kitchen and cs.service_date = d.service_date), 0))
                       order by d.service_date)
      from (select o.service_date, sum(o.qty) as meals from public.meal_orders o
            where o.kitchen_id = p_kitchen and o.service_date between p_from and p_to and o.locked_at is not null
              and (o.status <> 'skipped' or o.charged)
            group by o.service_date) d), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner alerts also go to managers (D-117).
-- ---------------------------------------------------------------------------
create or replace function private.notify_owners(p_kitchen uuid, p_template text, p_payload jsonb, p_dedupe text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select p_kitchen, 'whatsapp', 'member', m.user_id, p_template, p_payload, p_dedupe || ':' || m.user_id
  from public.members m where m.kitchen_id = p_kitchen and m.role in ('owner', 'manager')
  on conflict (dedupe_key) do nothing;
$$;

create or replace function private.notify_owners_stock(p_kitchen uuid, p_item uuid, p_kind text, p_payload jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
  select p_kitchen, 'whatsapp', 'member', m.user_id, 'stock_alert',
         p_payload || jsonb_build_object('kind', p_kind),
         'stock_alert:' || p_kind || ':' || p_item || ':' || private.ist_today() || ':' || m.user_id
  from public.members m where m.kitchen_id = p_kitchen and m.role in ('owner', 'manager')
  on conflict (dedupe_key) do nothing;
$$;

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
  join public.members m on m.kitchen_id = k.id and m.role in ('owner', 'manager')
  where k.status <> 'suspended'
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (fail closed)
-- ---------------------------------------------------------------------------
revoke execute on function private.expand_roles(public.member_role[]),
  private.kitchen_ids(public.member_role[], boolean), private.has_role(uuid, public.member_role[], boolean),
  private.require_role(uuid, public.member_role[], boolean)
  from public, anon, authenticated;
-- RLS policies evaluate these as the calling user.
grant execute on function private.kitchen_ids(public.member_role[], boolean) to authenticated;
grant execute on function private.has_role(uuid, public.member_role[], boolean) to authenticated;
