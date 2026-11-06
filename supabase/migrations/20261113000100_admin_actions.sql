-- Wave 4 (onboarding and founder support), step 1: the admin actions log.
-- Every founder support action (approving a vendor, allowing a number, changing a phone, moving a
-- kitchen's ownership, adding or removing a platform admin, revealing a phone, closing a request)
-- writes one row here with the admin, the kitchen, the reason and a before/after picture.
-- Append-only, like audit_log. It is separate from audit_log on purpose: audit_log records row
-- changes (whoever made them); this table records who on the platform team did what and why.

create table public.admin_actions (
  id bigint generated always as identity primary key,
  -- No foreign key to auth.users: the record must outlive a removed admin account.
  admin_id uuid not null,
  kitchen_id uuid references public.kitchens (id),
  action text not null check (action ~ '^[a-z_]{3,40}$'),
  target text,
  reason text check (reason is null or length(reason) <= 500),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index admin_actions_kitchen_idx on public.admin_actions (kitchen_id, created_at desc);
create index admin_actions_created_idx on public.admin_actions (created_at desc);

create trigger admin_actions_append_only before update or delete on public.admin_actions
  for each row execute function private.forbid_mutation();
create trigger admin_actions_no_truncate before truncate on public.admin_actions
  for each statement execute function private.forbid_mutation();

alter table public.admin_actions enable row level security;
-- Admins read everything; a kitchen's owner can see what the platform team did to their kitchen.
create policy admin_actions_select on public.admin_actions for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));

revoke all on public.admin_actions from anon, authenticated;
grant select on public.admin_actions to authenticated;

-- Writes one admin action as the signed-in admin. Callers have already checked require_admin().
create or replace function private.log_admin_action(p_kitchen uuid, p_action text, p_target text, p_reason text,
                                                    p_before jsonb default null, p_after jsonb default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.admin_actions (admin_id, kitchen_id, action, target, reason, before, after, created_at)
  values (auth.uid(), p_kitchen, p_action, p_target, nullif(trim(p_reason), ''), p_before, p_after, private.now())
  returning id into v_id;
  return v_id;
end;
$$;

-- Support actions that change someone's access need a reason.
create or replace function private.require_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(trim(p_reason)) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  return trim(p_reason);
end;
$$;

-- Admin view of the log (newest first), optionally for one kitchen.
create or replace function public.admin_actions_list(p_kitchen uuid default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.created_at, 'admin_id', a.admin_id,
                                        'admin_phone_last4', right(u.phone, 4), 'kitchen_id', a.kitchen_id, 'kitchen', k.name,
                                        'action', a.action, 'target', a.target, 'reason', a.reason,
                                        'before', a.before, 'after', a.after) order by a.created_at desc, a.id desc)
    from (select * from public.admin_actions a0 where p_kitchen is null or a0.kitchen_id = p_kitchen
          order by a0.created_at desc, a0.id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) a
    left join public.kitchens k on k.id = a.kitchen_id
    left join auth.users u on u.id = a.admin_id), '[]'::jsonb);
end;
$$;

revoke execute on function private.log_admin_action, private.require_reason from public, anon, authenticated;
revoke execute on function public.admin_actions_list from public, anon;
grant execute on function public.admin_actions_list to authenticated;
