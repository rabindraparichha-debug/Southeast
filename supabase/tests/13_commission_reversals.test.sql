-- P6 follow-up: a processed refund of a commissioned payment reverses the commission in proportion,
-- once per refund, never beyond the original commission; reports show the net. Owner/admin only.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select set_config('app.now', '2026-11-02 10:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
grant select on ids to authenticated;
insert into ids select 'cust', id from public.customers where kitchen_id = '10000000-0000-4000-a000-00000000000a' order by name limit 1;
insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, commission_bps, commission_paise, transfer_paise, created_at)
values ('10000000-0000-4000-a000-00000000000a', (select v from ids where k = 'cust'), 'razorpay_link', 'created', 70000, 10, 1000, 7000, 63000, now());
insert into ids select 'pay', id from public.payments where amount_paise = 70000 and commission_paise = 7000 order by created_at desc limit 1;
update public.payments set status = 'paid', paid_at = now(), razorpay_payment_id = 'pay_rev_1' where id = (select v from ids where k = 'pay');
select is((select commission_paise from public.platform_commissions where payment_id = (select v from ids where k = 'pay')), 7000,
  'the captured payment carries ₹70 commission');

-- Partial refund of ₹350 (half): ₹35 reversed.
insert into public.refunds (kitchen_id, customer_id, meals, amount_paise, status, payment_id, reason)
values ('10000000-0000-4000-a000-00000000000a', (select v from ids where k = 'cust'), 5, 35000, 'processing', (select v from ids where k = 'pay'), 'test');
select is((select count(*) from public.platform_commission_reversals), 0::bigint, 'nothing reversed before the refund is processed');
update public.refunds set status = 'processed', processed_at = now() where payment_id = (select v from ids where k = 'pay');
select is((select sum(reversed_paise)::integer from public.platform_commission_reversals), 3500, 'half the amount refunded: half the commission reversed');
update public.refunds set status = 'processed', note = 'touched' where payment_id = (select v from ids where k = 'pay');
select is((select count(*) from public.platform_commission_reversals), 1::bigint, 'one reversal per refund');

-- A refund larger than what is left only reverses what is left.
insert into public.refunds (kitchen_id, customer_id, meals, amount_paise, status, payment_id, reason, processed_at)
values ('10000000-0000-4000-a000-00000000000a', (select v from ids where k = 'cust'), 10, 70000, 'processed', (select v from ids where k = 'pay'), 'test', now());
select is((select sum(reversed_paise)::integer from public.platform_commission_reversals), 7000, 'never more than the original commission');
select throws_ok($$ delete from public.platform_commission_reversals $$, 'P0001', null, 'reversals are append-only');

-- Reports show the net.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select is((public.commission_statement('10000000-0000-4000-a000-00000000000a', '2026-10-01', '2026-12-31') ->> 'commission_paise')::integer, 0,
  'owner statement: net commission after reversals');
select is((select count(*) from public.platform_commission_reversals), 2::bigint, 'the owner sees their reversals');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.platform_commission_reversals), 0::bigint, 'staff see no commission data');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select is((select count(*) from public.platform_commission_reversals), 0::bigint, 'another kitchen sees nothing');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select is((public.admin_commission_report('2026-10-01', '2026-12-31') ->> 'reversed_paise')::integer, 7000, 'admin report shows reversals');
reset role;
set local role anon;
select throws_ok($$ select * from public.platform_commission_reversals $$, '42501', null, 'anon cannot read reversals');
reset role;

select * from finish();
rollback;
