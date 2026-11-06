-- Vendor-first wave 3 (safety), audit item 38: a refund row is claimed before Razorpay is called.
--
-- Before: the razorpay-refund function read the row (refund_for_gateway), called Razorpay, then marked
-- it submitted; two clicks at once both reached Razorpay (each refund pulls money back from the
-- kitchen with reverse_all) and the second mark silently did nothing.
--
-- Now:
--   * claim_refund_for_gateway(refund) (owner): the same checks, then moves the row to 'processing'
--     in the same statement (row lock). A second call gets 'refund_in_progress' and never reaches
--     Razorpay. A claim with no Razorpay refund id after 15 minutes is stale (the function died
--     between the claim and Razorpay's answer) and can be claimed again with the same attempt.
--   * Attempts: claiming a 'pending' or 'failed' row starts a new attempt (gateway_attempt + 1) and
--     clears the Razorpay refund id of an earlier, failed attempt (the audit log keeps it). Razorpay's
--     idempotency key is '<refund id>-<attempt>': a retry after an unclear answer (stale claim) reuses
--     the key, so it is not refunded twice; a deliberate retry after a definite failure is a new
--     Razorpay request.
--   * release_refund_claim(refund, error) (service role): Razorpay definitely refused the current
--     attempt; the row goes to 'failed' (and can be retried or paid in cash).
--   * mark_refund_submitted now also completes a claimed ('processing') row, and reports whether it did.

alter table public.refunds
  add column gateway_claimed_at timestamptz,
  add column gateway_claimed_by uuid references auth.users (id),
  add column gateway_error text,
  add column gateway_attempt integer not null default 0;

create or replace function public.claim_refund_for_gateway(p_refund uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.refunds;
  v_p public.payments;
begin
  select * into v_r from public.refunds where id = p_refund for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_role(v_r.kitchen_id, '{owner}');
  if v_r.status = 'processing' and (v_r.razorpay_refund_id is not null
                                     or v_r.gateway_claimed_at > private.now() - interval '15 minutes') then
    raise exception 'refund_in_progress' using errcode = '55P03';
  end if;
  if v_r.status not in ('pending', 'failed', 'processing') then
    raise exception 'not_pending' using errcode = '22023';
  end if;
  select * into v_p from public.payments where id = v_r.payment_id;
  if v_p.id is null or v_p.method <> 'razorpay_link' or v_p.status <> 'paid' or v_p.razorpay_payment_id is null then
    raise exception 'no_online_payment' using errcode = '22023';
  end if;
  if v_r.amount_paise > v_p.amount_paise - coalesce((select sum(r.amount_paise) from public.refunds r
                                                    where r.payment_id = v_p.id and r.id <> v_r.id and r.status <> 'failed'), 0) then
    raise exception 'refund_exceeds_payment' using errcode = '22023';
  end if;
  -- A stale claim ('processing', no Razorpay id) keeps its attempt and key; anything else starts a new one.
  update public.refunds
  set status = 'processing', method = 'razorpay', gateway_claimed_at = private.now(), gateway_claimed_by = auth.uid(),
      gateway_error = null,
      razorpay_refund_id = case when v_r.status = 'processing' then razorpay_refund_id end,
      gateway_attempt = case when v_r.status = 'processing' then greatest(gateway_attempt, 1) else gateway_attempt + 1 end
  where id = p_refund
  returning * into v_r;
  return jsonb_build_object('refund_id', v_r.id, 'amount_paise', v_r.amount_paise, 'razorpay_payment_id', v_p.razorpay_payment_id,
    'attempt', v_r.gateway_attempt, 'idempotency_key', v_r.id::text || '-' || v_r.gateway_attempt);
end;
$$;

-- Razorpay definitely refused the current attempt (an error answer, not a timeout). Only a claimed
-- row that Razorpay has not accepted (no refund id for this attempt) is released.
create or replace function public.release_refund_claim(p_refund uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.refunds
  set status = 'failed', gateway_claimed_at = null, gateway_error = left(coalesce(p_error, 'gateway_error'), 500)
  where id = p_refund and status = 'processing' and gateway_claimed_at is not null and razorpay_refund_id is null;
  return found;
end;
$$;

-- Razorpay accepted the refund: keep its id. A claimed row is 'processing' already; the webhook may
-- even have marked it processed first (then nothing changes).
drop function public.mark_refund_submitted(uuid, text);
create function public.mark_refund_submitted(p_refund uuid, p_razorpay_refund_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.refunds
  set status = case when status = 'processed' then status else 'processing'::public.refund_status end,
      method = 'razorpay', razorpay_refund_id = coalesce(razorpay_refund_id, p_razorpay_refund_id), gateway_error = null
  where id = p_refund and status in ('pending', 'failed', 'processing', 'processed')
    and (razorpay_refund_id is null or razorpay_refund_id = p_razorpay_refund_id);
  return found;
end;
$$;

revoke execute on function public.claim_refund_for_gateway, public.release_refund_claim, public.mark_refund_submitted
  from public, anon, authenticated;
grant execute on function public.claim_refund_for_gateway to authenticated;
grant execute on function public.release_refund_claim, public.mark_refund_submitted to service_role;
