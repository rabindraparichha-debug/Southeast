-- Phase 2 hardening, step 4: a payment link that Razorpay never created leaves no live row behind
-- (docs/VENDOR_FIRST_AUDIT.md, Phase 2 step 5, "If the Razorpay call fails, a 'created' payment row
-- with no link is left behind"; D-129).
--
-- Every path (owner, customer page, payer for a dependent, WhatsApp bot) creates our 'created' row
-- first, then calls Razorpay, then attaches the link. When the Razorpay call (or attaching the link)
-- fails, the Edge Function now calls cancel_payment_link_record: the row becomes 'failed' with the
-- reason in its note, so it no longer shows as an unpaid link on the customer page or the owner's
-- payments list. Only a 'created' row without a link is touched, so a link that did reach Razorpay
-- (and may still be paid) is never cancelled; calling it twice changes nothing.

create or replace function public.cancel_payment_link_record(p_payment uuid, p_error text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.payments
  set status = 'failed',
      note = left(concat_ws(' · ', nullif(note, ''), 'Payment link not created: ' || coalesce(nullif(left(trim(p_error), 120), ''), 'gateway error')), 500)
  where id = p_payment and status = 'created' and razorpay_payment_link_id is null and method = 'razorpay_link';
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke execute on function public.cancel_payment_link_record(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_payment_link_record(uuid, text) to service_role;
