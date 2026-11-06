-- Vendor-first wave 2, step 1: new enum values ONLY.
-- Postgres cannot use a value added by ALTER TYPE ... ADD VALUE inside the same transaction, and
-- every migration file runs in its own transaction, so the values live in this file alone and the
-- later wave-2 migrations use them.
--
--   member_role: manager (D-117: customer changes, new customers, cash and payments, confirming rider
--                cash, approving rider requests, owner alerts) and accountant (reads money, no writes).
--   payment_status: voided (a recorded cash/UPI/bank payment reversed with a reason, item 22).

alter type public.member_role add value if not exists 'manager';
alter type public.member_role add value if not exists 'accountant';
alter type public.payment_status add value if not exists 'voided';
