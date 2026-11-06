-- Vendor-first wave 2, item 23 (D-117): change requests recorded by riders.
--
-- At the door a customer tells the rider "skip tomorrow" or "pause next week". The rider records a
-- request (channel 'rider') against one of their own stops; nothing changes until an owner or a
-- manager approves it. Approval applies it through the one existing path, private.apply_change
-- (channel 'rider', the slot cutoff decides late/charged at approval time, preview first with
-- p_dry_run). Rejection records a reason. Riders see only their own requests.

create table public.change_requests (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens (id),
  customer_id uuid not null,
  subscription_id uuid,                -- null when the stop's customer has several live subscriptions
  stop_id uuid,
  type public.change_type not null,
  from_date date not null,
  to_date date,
  slot public.meal_slot,
  note text check (note is null or length(note) <= 500),
  channel public.change_channel not null default 'rider',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default now(),
  client_op uuid unique,               -- idempotency key from the rider's offline queue
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_note text,
  change_id uuid references public.schedule_changes (id),
  result jsonb,
  unique (id, kitchen_id),
  check (to_date is null or to_date >= from_date),
  check ((status = 'pending') = (decided_at is null)),
  foreign key (customer_id, kitchen_id) references public.customers (id, kitchen_id),
  foreign key (subscription_id, kitchen_id) references public.subscriptions (id, kitchen_id),
  -- Runs are rebuilt while planned; a rebuilt stop just loses the link (the customer stays).
  foreign key (stop_id, kitchen_id) references public.delivery_stops (id, kitchen_id) on delete set null (stop_id)
);
create index change_requests_kitchen_idx on public.change_requests (kitchen_id, status, requested_at desc);
create index change_requests_requester_idx on public.change_requests (requested_by, requested_at desc);

create trigger change_requests_audit after insert or update or delete on public.change_requests
  for each row execute function private.audit_row();

alter table public.change_requests enable row level security;
-- Owner and manager (the owner check includes managers), the requesting rider, and the platform team.
create policy change_requests_select on public.change_requests for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[])
         or requested_by = (select auth.uid())
         or (select private.is_platform_admin()));
revoke all on public.change_requests from anon, authenticated;
grant select on public.change_requests to authenticated;

-- Rider (or owner/manager on a stop) records a request. Returns { request_id, status, duplicate }.
create or replace function public.rider_request_change(
  p_stop uuid,
  p_type public.change_type,
  p_from date,
  p_to date default null,
  p_slot public.meal_slot default null,
  p_note text default null,
  p_client_op uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.delivery_stops;
  v_today date := private.ist_today();
  v_sub uuid;
  v_subs uuid[];
  v_to date := p_to;
  v_existing public.change_requests;
  v_id uuid;
begin
  select * into v_s from public.delivery_stops where id = p_stop;
  if v_s.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- The stop's run must be the caller's (today or yesterday), or the caller an owner/manager.
  perform private.require_run_access(v_s.run_id);
  if p_client_op is not null then
    select * into v_existing from public.change_requests where client_op = p_client_op;
    if v_existing.id is not null then
      if v_existing.stop_id is distinct from p_stop or v_existing.requested_by <> auth.uid() then
        raise exception 'invalid_client_op' using errcode = '22023';
      end if;
      return jsonb_build_object('request_id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
    end if;
  end if;
  if p_type is null then
    raise exception 'invalid_type' using errcode = '22023';
  end if;
  if p_from is null then
    raise exception 'date_required' using errcode = '22023';
  end if;
  if p_from < v_today then
    raise exception 'date_in_past' using errcode = '22023';
  end if;
  if p_type = 'skip' then
    v_to := coalesce(p_to, p_from);
  elsif p_type = 'cancel' then
    v_to := null;
  end if;
  if v_to is not null and v_to < p_from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_to is not null and v_to > p_from + 90 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;
  if p_type = 'address' and nullif(trim(p_note), '') is null then
    raise exception 'note_required' using errcode = '22023';  -- the new address, in words
  end if;

  -- Which subscription: the customer's only live one, else the one on this stop, else the approver picks.
  select array_agg(s.id order by s.created_at) into v_subs
  from public.subscriptions s where s.customer_id = v_s.customer_id and s.status <> 'cancelled';
  if cardinality(v_subs) = 1 then
    v_sub := v_subs[1];
  else
    select array_agg(distinct o.subscription_id) into v_subs from public.meal_orders o where o.stop_id = p_stop;
    if cardinality(v_subs) = 1 then
      v_sub := v_subs[1];
    end if;
  end if;

  insert into public.change_requests (kitchen_id, customer_id, subscription_id, stop_id, type, from_date, to_date, slot, note,
                                      channel, requested_by, requested_at, client_op)
  values (v_s.kitchen_id, v_s.customer_id, v_sub, p_stop, p_type, p_from, v_to,
          case when p_type <> 'cancel' then p_slot end, nullif(trim(p_note), ''), 'rider', auth.uid(), private.now(), p_client_op)
  on conflict (client_op) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.change_requests where client_op = p_client_op;
    return jsonb_build_object('request_id', v_id, 'status', 'pending', 'duplicate', true);
  end if;
  return jsonb_build_object('request_id', v_id, 'status', 'pending', 'duplicate', false);
end;
$$;

-- Owner or manager approves. Applies the change through private.apply_change (channel 'rider').
-- p_dry_run previews (nothing is stored). p_subscription / p_address fill what the rider could not.
create or replace function public.approve_change_request(
  p_request uuid,
  p_waive_late boolean default false,
  p_dry_run boolean default false,
  p_subscription uuid default null,
  p_address uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.change_requests;
  v_sub uuid;
  v_result jsonb;
begin
  select * into v_r from public.change_requests where id = p_request for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner}');
  if v_r.status = 'approved' then
    return v_r.result || jsonb_build_object('request_id', v_r.id, 'already', true);
  end if;
  if v_r.status <> 'pending' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  v_sub := coalesce(p_subscription, v_r.subscription_id);
  if v_sub is null then
    raise exception 'subscription_required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.subscriptions where id = v_sub and customer_id = v_r.customer_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_r.type = 'address' and p_address is null then
    raise exception 'invalid_address' using errcode = '22023';
  end if;

  v_result := private.apply_change(v_sub, v_r.type, v_r.from_date, v_r.to_date, v_r.slot,
                                   case when v_r.type = 'address' then p_address end, 'rider',
                                   coalesce(p_waive_late, false),
                                   concat_ws(' · ', 'Rider request', v_r.note), coalesce(p_dry_run, false), v_r.requested_by);
  if coalesce(p_dry_run, false) then
    return v_result || jsonb_build_object('request_id', v_r.id);
  end if;
  update public.change_requests
  set status = 'approved', decided_by = auth.uid(), decided_at = private.now(), subscription_id = v_sub,
      change_id = (v_result ->> 'change_id')::uuid, result = v_result
  where id = p_request;
  return v_result || jsonb_build_object('request_id', v_r.id, 'already', false);
end;
$$;

create or replace function public.reject_change_request(p_request uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.change_requests;
begin
  select * into v_r from public.change_requests where id = p_request for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner}');
  if v_r.status <> 'pending' then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  update public.change_requests
  set status = 'rejected', decided_by = auth.uid(), decided_at = private.now(), decision_note = nullif(trim(p_reason), '')
  where id = p_request;
end;
$$;

-- Requests for the owner/manager screen (pending first), with names. Riders: only their own.
create or replace function public.change_requests_list(p_kitchen uuid, p_status text default 'pending', p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lead boolean;
begin
  perform private.require_role(p_kitchen, '{owner,rider}');
  v_lead := private.has_role(p_kitchen, '{owner}');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'type', r.type, 'from_date', r.from_date, 'to_date', r.to_date, 'slot', r.slot, 'note', r.note,
      'status', r.status, 'requested_at', r.requested_at, 'decided_at', r.decided_at, 'decision_note', r.decision_note,
      'customer_id', r.customer_id, 'customer_name', c.name, 'subscription_id', r.subscription_id,
      'plan_name', (select p.name from public.subscriptions s join public.plans p on p.id = s.plan_id where s.id = r.subscription_id),
      'stop_id', r.stop_id, 'change_id', r.change_id,
      'requested_by', r.requested_by,
      'requested_by_name', (select m.display_name from public.members m where m.kitchen_id = r.kitchen_id and m.user_id = r.requested_by))
      order by (r.status = 'pending') desc, r.requested_at desc)
    from (select * from public.change_requests r
          where r.kitchen_id = p_kitchen
            and (p_status is null or r.status = p_status)
            and (v_lead or r.requested_by = auth.uid())
          order by (r.status = 'pending') desc, r.requested_at desc
          limit least(greatest(coalesce(p_limit, 50), 1), 200)) r
    join public.customers c on c.id = r.customer_id), '[]'::jsonb);
end;
$$;

revoke execute on function public.rider_request_change(uuid, public.change_type, date, date, public.meal_slot, text, uuid),
  public.approve_change_request(uuid, boolean, boolean, uuid, uuid), public.reject_change_request(uuid, text),
  public.change_requests_list(uuid, text, integer)
  from public, anon;
grant execute on function public.rider_request_change(uuid, public.change_type, date, date, public.meal_slot, text, uuid),
  public.approve_change_request(uuid, boolean, boolean, uuid, uuid), public.reject_change_request(uuid, text),
  public.change_requests_list(uuid, text, integer)
  to authenticated;
