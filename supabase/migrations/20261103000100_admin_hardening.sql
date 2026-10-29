-- M8: admin console data and hardening.
-- Platform metrics, a kitchen overview, the audit log viewer, review moderation support, and a
-- guard so a live kitchen's FSSAI number (verified by the platform) can't be changed by its owner.

-- ---------------------------------------------------------------------------
-- FSSAI guard (security review finding): owners keep editing their profile, but the number that
-- made the kitchen eligible for listing changes only through the platform team.
-- ---------------------------------------------------------------------------
create or replace function private.guard_fssai()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'active' and new.fssai_no is distinct from old.fssai_no
     and auth.uid() is not null and auth.role() <> 'service_role' and not private.is_platform_admin() then
    raise exception 'fssai_locked' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger kitchens_fssai_guard before update of fssai_no on public.kitchens
  for each row execute function private.guard_fssai();

create or replace function public.admin_set_fssai(p_kitchen uuid, p_fssai text default null)  -- null clears it
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_fssai is not null and p_fssai !~ '^[0-9]{14}$' then
    raise exception 'invalid_fssai' using errcode = '22023';
  end if;
  update public.kitchens set fssai_no = p_fssai where id = p_kitchen;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform metrics (admin): the P4 goal is "30 vendors live and first platform-sourced customers paid".
-- ---------------------------------------------------------------------------
create or replace function public.platform_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := private.now() - interval '7 days';
begin
  perform private.require_admin();
  return jsonb_build_object(
    'kitchens', (select jsonb_build_object('total', count(*), 'active', count(*) filter (where status = 'active'),
                                           'draft', count(*) filter (where status = 'draft'),
                                           'suspended', count(*) filter (where status = 'suspended'),
                                           'goal_live', 30) from public.kitchens),
    'customers', (select jsonb_build_object(
                    'total', count(*), 'on_whatsapp', count(*) filter (where whatsapp_opt_in),
                    'whatsapp_pct', round(100.0 * count(*) filter (where whatsapp_opt_in) / nullif(count(*), 0), 1),
                    'platform_sourced', count(*) filter (where platform_sourced),
                    'platform_paid', (select count(distinct b.customer_id) from public.balance_entries b
                                      join public.customers c2 on c2.id = b.customer_id
                                      where b.type = 'recharge' and c2.platform_sourced))
                  from public.customers where deleted_at is null),
    'subscriptions', (select jsonb_build_object(
                        'live', count(*) filter (where status in ('active', 'low_balance', 'paused')),
                        'trial', count(*) filter (where status = 'trial'),
                        'autopay', count(*) filter (where autopay_mandate_id is not null and status <> 'cancelled'))
                      from public.subscriptions),
    'last_7_days', jsonb_build_object(
      'meals', (select coalesce(sum(o.qty), 0) from public.meal_orders o
                where o.locked_at >= v_from and (o.status <> 'skipped' or o.charged)),
      'collections_paise', (select coalesce(sum(amount_paise), 0) from public.payments where status = 'paid' and paid_at >= v_from),
      'whatsapp_changes', (select count(*) from public.schedule_changes where channel in ('whatsapp', 'web') and requested_at >= v_from),
      'all_changes', (select count(*) from public.schedule_changes where requested_at >= v_from),
      'stops', (select count(*) from public.delivery_stops where done_at >= v_from),
      'stops_proved', (select count(*) from public.delivery_stops where done_at >= v_from and status = 'delivered'
                         and (otp_ok or photo_path is not null)),
      'leads', (select count(*) from public.leads where created_at >= v_from),
      'vendor_applications', (select count(*) from public.vendor_applications where created_at >= v_from)),
    'open', jsonb_build_object(
      'escalated_complaints', (select count(*) from public.complaints where status = 'escalated'),
      'vendor_applications', (select count(*) from public.vendor_applications where status in ('new', 'contacted', 'onboarding')),
      'waitlisted_leads', (select count(*) from public.leads where status = 'waitlist'),
      'outbox_failed', (select count(*) from public.notifications_outbox where status = 'failed' and created_at >= v_from))
  );
end;
$$;

-- One row per kitchen for the admin list.
create or replace function public.admin_kitchens()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', k.id, 'name', k.name, 'slug', k.slug, 'area', k.area, 'status', k.status, 'fssai_no', k.fssai_no,
      'kyc_status', a.kyc_status, 'linked_account', a.razorpay_linked_account_id is not null,
      'razorpay_linked_account_id', a.razorpay_linked_account_id,
      'customers', (select count(*) from public.customers c where c.kitchen_id = k.id and c.deleted_at is null),
      'whatsapp_pct', (select round(100.0 * count(*) filter (where whatsapp_opt_in) / nullif(count(*), 0), 0)
                       from public.customers c where c.kitchen_id = k.id and c.deleted_at is null),
      'platform_customers', (select count(*) from public.customers c where c.kitchen_id = k.id and c.platform_sourced),
      'live_subscriptions', (select count(*) from public.subscriptions s where s.kitchen_id = k.id
                               and s.status in ('active', 'low_balance', 'paused')),
      'meals_7d', (select coalesce(sum(o.qty), 0) from public.meal_orders o where o.kitchen_id = k.id
                     and o.locked_at >= private.now() - interval '7 days' and (o.status <> 'skipped' or o.charged)),
      'last_lock', (select max(locked_at) from public.count_snapshots cs where cs.kitchen_id = k.id),
      'checklist_done', (select count(*) from jsonb_array_elements(private.kitchen_checklist(k.id)) x where (x ->> 'done')::boolean),
      'checklist_total', 9,
      'open_complaints', (select count(*) from public.complaints cp where cp.kitchen_id = k.id and cp.status in ('open', 'escalated')),
      'created_at', k.created_at
    ) order by k.status = 'active' desc, k.name)
    from public.kitchens k left join public.kitchen_payout_accounts a on a.kitchen_id = k.id), '[]'::jsonb);
end;
$$;

-- Audit log viewer (admin). Rows are already redacted (no encrypted phones or tokens).
-- Paging: pass the last row's (at, id) as (p_before, p_before_id); rows written in one transaction
-- share a timestamp, so the id breaks ties.
create or replace function public.admin_audit_log(p_kitchen uuid default null, p_table text default null,
  p_action text default null, p_before timestamptz default null, p_limit integer default 100, p_before_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.created_at, 'kitchen', k.name, 'actor_id', a.actor_id,
                                        'actor_phone_last4', right(u.phone, 4), 'actor_role', a.actor_role, 'table', a.table_name,
                                        'row_id', a.row_id, 'action', a.action, 'before', a.before, 'after', a.after)
                     order by a.created_at desc, a.id desc)
    from (select * from public.audit_log a0
          where (p_kitchen is null or a0.kitchen_id = p_kitchen) and (p_table is null or a0.table_name = p_table)
            and (p_action is null or a0.action = p_action)
            and (p_before is null or (a0.created_at, a0.id) < (p_before, coalesce(p_before_id, 9223372036854775807)))
          order by a0.created_at desc, a0.id desc limit least(coalesce(p_limit, 100), 500)) a
    left join public.kitchens k on k.id = a.kitchen_id
    left join auth.users u on u.id = a.actor_id), '[]'::jsonb);
end;
$$;

revoke execute on function public.admin_set_fssai, public.platform_metrics, public.admin_kitchens, public.admin_audit_log
  from public, anon;
grant execute on function public.admin_set_fssai, public.platform_metrics, public.admin_kitchens, public.admin_audit_log
  to authenticated;
