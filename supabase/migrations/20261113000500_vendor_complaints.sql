-- Wave 4 (onboarding), step 5: complaints phoned in to the kitchen (audit Phase 1 step 7).
-- In Phase 1 customers call the vendor; the owner logs the complaint (channel 'vendor') so it shows
-- with the others (customer page, inbox, complaint scores, at-risk list) and can be resolved with
-- resolve_complaint as usual. The first-complaint credit stays governed by the kitchen setting
-- auto_credit_first_complaint (off by default since D-119): the existing insert trigger applies.
-- A logged complaint starts as 'responded' (the kitchen already heard it), so the 2-hour
-- escalation to the platform team never picks it up.

alter table public.complaints add column subscription_id uuid;
alter table public.complaints add constraint complaints_subscription_fk
  foreign key (subscription_id, kitchen_id) references public.subscriptions (id, kitchen_id);
alter table public.complaints add column logged_by uuid references auth.users (id);

create or replace function public.log_complaint(p_customer uuid, p_category text, p_note text default null,
                                                p_subscription uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cust public.customers;
  v_id uuid;
begin
  select * into v_cust from public.customers where id = p_customer;
  if v_cust.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_cust.kitchen_id, '{owner}');
  if v_cust.deleted_at is not null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_category is null or p_category not in ('late', 'quality', 'quantity', 'missing', 'hygiene', 'delivery', 'billing',
                                              'privacy', 'other') then
    raise exception 'invalid_category' using errcode = '22023';
  end if;
  if length(coalesce(p_note, '')) > 2000 then
    raise exception 'invalid_message' using errcode = '22023';
  end if;
  if p_subscription is not null and not exists (select 1 from public.subscriptions s
                                                where s.id = p_subscription and s.customer_id = p_customer) then
    raise exception 'invalid_subscription' using errcode = '22023';
  end if;
  insert into public.complaints (kitchen_id, customer_id, subscription_id, category, description, channel, status,
                                 responded_at, logged_by, created_at, conversation_id)
  values (v_cust.kitchen_id, v_cust.id, p_subscription, p_category, nullif(trim(p_note), ''), 'vendor', 'responded',
          private.now(), auth.uid(), private.now(),
          (select c.id from public.conversations c where c.customer_id = v_cust.id and c.kitchen_id = v_cust.kitchen_id limit 1))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.log_complaint from public, anon;
grant execute on function public.log_complaint to authenticated;
