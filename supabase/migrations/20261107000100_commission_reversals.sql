-- P6 follow-up: refunds of an online payment that carried a platform commission reverse that
-- commission in proportion (the Razorpay refund uses reverse_all, so the platform pays back its
-- share). Append-only, one row per refund; reports show gross, reversed and net commission.

create table public.platform_commission_reversals (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null,
  commission_id uuid not null references public.platform_commissions (id),
  refund_id uuid not null unique,
  refund_paise integer not null check (refund_paise > 0),
  reversed_paise integer not null check (reversed_paise > 0),
  created_at timestamptz not null default now(),
  foreign key (refund_id, kitchen_id) references public.refunds (id, kitchen_id)
);
create index platform_commission_reversals_kitchen_idx on public.platform_commission_reversals (kitchen_id, created_at desc);
create trigger platform_commission_reversals_append_only before update or delete on public.platform_commission_reversals
  for each row execute function private.forbid_mutation();
create trigger platform_commission_reversals_no_truncate before truncate on public.platform_commission_reversals
  for each statement execute function private.forbid_mutation();

alter table public.platform_commission_reversals enable row level security;
create policy platform_commission_reversals_select on public.platform_commission_reversals for select to authenticated
  using (kitchen_id = any ((select private.kitchen_ids('{owner}'))::uuid[]) or (select private.is_platform_admin()));
revoke all on public.platform_commission_reversals from anon, authenticated;
grant select on public.platform_commission_reversals to authenticated;

-- Processed refund of a commissioned payment: reverse commission × refund / amount (rounded down,
-- like the commission itself), never more than what is left of that commission.
create or replace function private.reverse_commission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.platform_commissions;
  v_left integer;
  v_rev integer;
begin
  select * into v_c from public.platform_commissions where payment_id = new.payment_id;
  if not found or new.amount_paise <= 0 then return null; end if;
  v_left := v_c.commission_paise - coalesce((select sum(reversed_paise) from public.platform_commission_reversals
                                             where commission_id = v_c.id), 0);
  v_rev := least(v_left, (v_c.commission_paise::bigint * least(new.amount_paise, v_c.amount_paise) / v_c.amount_paise)::integer);
  if v_rev > 0 then
    insert into public.platform_commission_reversals (kitchen_id, commission_id, refund_id, refund_paise, reversed_paise, created_at)
    values (new.kitchen_id, v_c.id, new.id, new.amount_paise, v_rev, coalesce(new.processed_at, private.now()))
    on conflict (refund_id) do nothing;
  end if;
  return null;
end;
$$;
revoke execute on function private.reverse_commission() from public, anon, authenticated;

create trigger refunds_reverse_commission after insert or update of status on public.refunds
  for each row when (new.status = 'processed' and new.payment_id is not null)
  execute function private.reverse_commission();

-- Reports: gross commission, reversals in the period, and net.
create or replace function public.admin_commission_report(p_from date, p_to date)
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
  perform private.require_admin();
  select coalesce(sum(c.commission_paise), 0) into v_gross from public.platform_commissions c
   where (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to;
  select coalesce(sum(r.reversed_paise), 0) into v_rev from public.platform_commission_reversals r
   where (r.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'gross_commission_paise', v_gross, 'reversed_paise', v_rev,
    'total_commission_paise', v_gross - v_rev,
    'kitchens', coalesce((select jsonb_agg(x order by x ->> 'kitchen_name') from (
       select jsonb_build_object('kitchen_id', k.id, 'kitchen_name', k.name, 'commission_bps', pa.commission_bps,
         'payments', count(c.id), 'gross_paise', coalesce(sum(c.amount_paise), 0),
         'commission_paise', coalesce(sum(c.commission_paise), 0) - coalesce(max(rv.reversed), 0),
         'reversed_paise', coalesce(max(rv.reversed), 0),
         'transferred_paise', coalesce(sum(c.transfer_paise), 0)) x
       from public.kitchens k
       join public.kitchen_payout_accounts pa on pa.kitchen_id = k.id
       left join public.platform_commissions c on c.kitchen_id = k.id
         and (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
       left join lateral (select sum(r.reversed_paise) as reversed from public.platform_commission_reversals r
                          where r.kitchen_id = k.id and (r.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to) rv on true
       where pa.commission_bps > 0 or c.id is not null or rv.reversed is not null
       group by k.id, k.name, pa.commission_bps) y), '[]'::jsonb));
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
  perform private.require_role(p_kitchen, '{owner}');
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
