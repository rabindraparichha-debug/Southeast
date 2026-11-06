-- Phase 2 hardening, step 6: the platform team can act on escalated complaints
-- (docs/VENDOR_FIRST_AUDIT.md, Phase 2 step 6, "Escalated complaints go to a read-only admin list";
-- the Terms promise "if they don't reply within 2 hours, our team steps in"; D-152).
--
--   * admin_escalations(status): the queue (escalated, or every open one, or recently resolved) with
--     kitchen and customer context, masked phones, who on the team has it, and the team's members.
--   * admin_complaint_detail(id): the complaint, the customer's plans, balance and complaint history,
--     the last 20 messages of the conversation and the team's log.
--   * admin_reveal_complaint_phone(id, 'customer'|'owner'): the number to call, logged in audit_log
--     and in the complaint's team log.
--   * admin_assign_complaint(id, admin): take it, or hand it to another team member (reassign).
--   * admin_note_complaint(id, note): a team note.
--   * admin_resolve_complaint(id, note): close it with a note (shown on the customer page like a
--     kitchen's resolution). The team never credits meals: that is the kitchen's money (resolve_complaint).
-- complaint_admin_events is the team's log: no updates; rows go only with their complaint.

alter table public.complaints
  add column assigned_admin_id uuid references auth.users (id),
  add column assigned_at timestamptz,
  add column resolved_by uuid references auth.users (id);
create index complaints_escalated_idx on public.complaints (escalated_at) where status = 'escalated';

create table public.complaint_admin_events (
  id bigint generated always as identity primary key,
  complaint_id uuid not null references public.complaints (id) on delete cascade,
  kitchen_id uuid not null references public.kitchens (id),
  -- No foreign key to auth.users: the record outlives a removed admin account.
  admin_id uuid not null,
  action text not null check (action in ('assign', 'note', 'reveal_customer_phone', 'reveal_owner_phone', 'resolve')),
  note text check (length(note) <= 1000),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index complaint_admin_events_complaint_idx on public.complaint_admin_events (complaint_id, created_at);
create trigger complaint_admin_events_no_update before update on public.complaint_admin_events
  for each row execute function private.forbid_mutation();

alter table public.complaint_admin_events enable row level security;
create policy complaint_admin_events_select on public.complaint_admin_events for select to authenticated
  using ((select private.is_platform_admin()));
revoke all on public.complaint_admin_events from anon, authenticated;
grant select on public.complaint_admin_events to authenticated;

create or replace function private.complaint_admin_event(p_complaint public.complaints, p_action text, p_note text,
                                                         p_detail jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.complaint_admin_events (complaint_id, kitchen_id, admin_id, action, note, detail, created_at)
  values (p_complaint.id, p_complaint.kitchen_id, auth.uid(), p_action, nullif(trim(p_note), ''), coalesce(p_detail, '{}'), private.now());
$$;

-- A team member's display name: their profile name, else the last 4 digits of their phone.
create or replace function private.admin_label(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(trim(u.raw_user_meta_data ->> 'name'), ''), 'Admin ' || right(coalesce(u.phone, ''), 4))
  from auth.users u where u.id = p_user;
$$;

create or replace function private.complaint_for_admin(p_complaint uuid, p_lock boolean default false)
returns public.complaints
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cp public.complaints;
begin
  perform private.require_admin();
  if p_lock then
    select * into v_cp from public.complaints where id = p_complaint for update;
  else
    select * into v_cp from public.complaints where id = p_complaint;
  end if;
  if v_cp.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return v_cp;
end;
$$;

-- The queue. p_status: 'escalated' (default), 'open' (open, responded or escalated) or 'resolved'
-- (resolved in the last 30 days).
create or replace function public.admin_escalations(p_status text default 'escalated', p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if coalesce(p_status, 'escalated') not in ('escalated', 'open', 'resolved') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'complaints', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'category', c.category, 'description', c.description, 'photo_url', c.photo_url, 'channel', c.channel,
        'status', c.status, 'created_at', c.created_at, 'escalated_at', c.escalated_at, 'responded_at', c.responded_at,
        'resolved_at', c.resolved_at, 'resolution_note', c.resolution_note,
        'hours_open', round(extract(epoch from (coalesce(c.resolved_at, private.now()) - c.created_at)) / 3600.0, 1),
        'meal', case when o.id is not null then jsonb_build_object('date', o.service_date, 'slot', o.slot) end,
        'kitchen', jsonb_build_object('id', k.id, 'name', k.name, 'area', k.area, 'status', k.status,
                                      'owner_name', private.admin_label(k.owner_id),
                                      'owner_phone_masked', private.mask_phone(right(ou.phone, 4))),
        'customer', jsonb_build_object('id', cu.id, 'name', cu.name, 'phone_masked', private.mask_phone(cu.phone_last4),
                                       'platform_sourced', cu.platform_sourced),
        'assigned_to', case when c.assigned_admin_id is not null then jsonb_build_object(
                         'id', c.assigned_admin_id, 'name', private.admin_label(c.assigned_admin_id), 'at', c.assigned_at) end,
        'resolved_by', case when c.resolved_by is not null then private.admin_label(c.resolved_by) end)
        order by coalesce(c.escalated_at, c.created_at))
      from (select * from public.complaints c0
            where case coalesce(p_status, 'escalated')
                    when 'escalated' then c0.status = 'escalated'
                    when 'open' then c0.status in ('open', 'responded', 'escalated')
                    else c0.status = 'resolved' and c0.resolved_at > private.now() - interval '30 days' end
            order by coalesce(c0.escalated_at, c0.created_at) limit least(greatest(coalesce(p_limit, 100), 1), 500)) c
      join public.kitchens k on k.id = c.kitchen_id
      left join auth.users ou on ou.id = k.owner_id
      join public.customers cu on cu.id = c.customer_id
      left join public.meal_orders o on o.id = c.meal_order_id), '[]'::jsonb),
    'team', coalesce((select jsonb_agg(jsonb_build_object('id', a.user_id, 'name', private.admin_label(a.user_id),
                                                          'me', a.user_id = auth.uid()) order by private.admin_label(a.user_id))
                      from public.platform_admins a), '[]'::jsonb));
end;
$$;

create or replace function public.admin_complaint_detail(p_complaint uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cp public.complaints;
  v_conv uuid;
begin
  perform private.require_admin();
  v_cp := private.complaint_for_admin(p_complaint);
  v_conv := coalesce(v_cp.conversation_id,
                     (select id from public.conversations where customer_id = v_cp.customer_id and kitchen_id = v_cp.kitchen_id
                      order by last_message_at desc nulls last limit 1));
  return jsonb_build_object(
    'complaint', to_jsonb(v_cp) - 'refund_entry_id' - 'auto_credit_entry_id',
    'kitchen', (select jsonb_build_object('id', k.id, 'name', k.name, 'area', k.area, 'status', k.status,
                                          'owner_name', private.admin_label(k.owner_id),
                                          'owner_phone_masked', private.mask_phone(right(u.phone, 4)))
                from public.kitchens k left join auth.users u on u.id = k.owner_id where k.id = v_cp.kitchen_id),
    'customer', (select jsonb_build_object('id', c.id, 'name', c.name, 'phone_masked', private.mask_phone(c.phone_last4),
        'platform_sourced', c.platform_sourced, 'since', c.created_at,
        'balance_meals', coalesce((select sum(b.meals) from public.balance_entries b where b.customer_id = c.id), 0),
        'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('plan', p.name, 'status', s.status, 'slots', p.slots,
                                                                      'price_per_meal_paise', p.price_per_meal_paise) order by s.created_at)
                                   from public.subscriptions s join public.plans p on p.id = s.plan_id
                                   where s.customer_id = c.id and s.status <> 'cancelled'), '[]'::jsonb),
        'complaints_90d', (select count(*) from public.complaints x where x.customer_id = c.id
                             and x.created_at > private.now() - interval '90 days'))
      from public.customers c where c.id = v_cp.customer_id),
    'meal', (select jsonb_build_object('date', o.service_date, 'slot', o.slot, 'status', o.status)
             from public.meal_orders o where o.id = v_cp.meal_order_id),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('at', m.created_at, 'direction', m.direction, 'body', left(m.body, 500),
                                                              'handled_by', m.handled_by) order by m.created_at)
                          from (select * from public.messages m0 where m0.conversation_id = v_conv
                                order by m0.created_at desc limit 20) m), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'action', e.action, 'note', e.note,
                                                            'admin', private.admin_label(e.admin_id)) order by e.created_at, e.id)
                        from public.complaint_admin_events e where e.complaint_id = v_cp.id), '[]'::jsonb));
end;
$$;

-- The number to call: the customer's or the kitchen owner's. Always logged.
create or replace function public.admin_reveal_complaint_phone(p_complaint uuid, p_who text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cp public.complaints;
  v_phone text;
begin
  perform private.require_admin();
  v_cp := private.complaint_for_admin(p_complaint);
  if p_who = 'customer' then
    select private.decrypt_phone(phone_enc) into v_phone from public.customers where id = v_cp.customer_id;
    perform private.audit_access(v_cp.kitchen_id, 'customers', v_cp.customer_id::text,
      jsonb_build_object('field', 'phone', 'reason', 'admin_complaint', 'complaint_id', v_cp.id));
    perform private.complaint_admin_event(v_cp, 'reveal_customer_phone', null);
  elsif p_who = 'owner' then
    select '+' || u.phone into v_phone from public.kitchens k join auth.users u on u.id = k.owner_id where k.id = v_cp.kitchen_id;
    perform private.audit_access(v_cp.kitchen_id, 'kitchens', v_cp.kitchen_id::text,
      jsonb_build_object('field', 'owner_phone', 'reason', 'admin_complaint', 'complaint_id', v_cp.id));
    perform private.complaint_admin_event(v_cp, 'reveal_owner_phone', null);
  else
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_phone is null or v_phone = '+' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return v_phone;
end;
$$;

-- Take a complaint (p_admin null = me) or hand it to another team member.
create or replace function public.admin_assign_complaint(p_complaint uuid, p_admin uuid default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cp public.complaints;
  v_to uuid := coalesce(p_admin, auth.uid());
begin
  perform private.require_admin();
  v_cp := private.complaint_for_admin(p_complaint, true);
  if v_cp.status = 'resolved' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  if not exists (select 1 from public.platform_admins where user_id = v_to) then
    raise exception 'invalid_admin' using errcode = '22023';
  end if;
  if length(coalesce(p_note, '')) > 1000 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  update public.complaints set assigned_admin_id = v_to, assigned_at = private.now() where id = v_cp.id;
  perform private.complaint_admin_event(v_cp, 'assign', p_note,
    jsonb_build_object('from', v_cp.assigned_admin_id, 'to', v_to));
  return jsonb_build_object('complaint_id', v_cp.id, 'assigned_to', v_to, 'name', private.admin_label(v_to));
end;
$$;

create or replace function public.admin_note_complaint(p_complaint uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cp public.complaints;
begin
  perform private.require_admin();
  v_cp := private.complaint_for_admin(p_complaint);
  if nullif(trim(p_note), '') is null then
    raise exception 'note_required' using errcode = '22023';
  end if;
  if length(p_note) > 1000 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  perform private.complaint_admin_event(v_cp, 'note', p_note);
end;
$$;

-- Close it on the kitchen's behalf, with a note the customer sees on their page.
create or replace function public.admin_resolve_complaint(p_complaint uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cp public.complaints;
begin
  perform private.require_admin();
  v_cp := private.complaint_for_admin(p_complaint, true);
  if v_cp.status = 'resolved' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  if nullif(trim(p_note), '') is null then
    raise exception 'note_required' using errcode = '22023';
  end if;
  if length(p_note) > 1000 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  update public.complaints
  set status = 'resolved', resolved_at = private.now(), responded_at = coalesce(responded_at, private.now()),
      resolution_note = trim(p_note), resolved_by = auth.uid(),
      assigned_admin_id = coalesce(assigned_admin_id, auth.uid()), assigned_at = coalesce(assigned_at, private.now())
  where id = v_cp.id;
  perform private.complaint_admin_event(v_cp, 'resolve', p_note);
end;
$$;

revoke execute on function private.complaint_admin_event(public.complaints, text, text, jsonb), private.admin_label(uuid),
  private.complaint_for_admin(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.admin_escalations(text, integer), public.admin_complaint_detail(uuid),
  public.admin_reveal_complaint_phone(uuid, text), public.admin_assign_complaint(uuid, uuid, text),
  public.admin_note_complaint(uuid, text), public.admin_resolve_complaint(uuid, text) from public, anon;
grant execute on function public.admin_escalations(text, integer), public.admin_complaint_detail(uuid),
  public.admin_reveal_complaint_phone(uuid, text), public.admin_assign_complaint(uuid, uuid, text),
  public.admin_note_complaint(uuid, text), public.admin_resolve_complaint(uuid, text) to authenticated;
