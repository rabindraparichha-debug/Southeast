-- Vendor-first wave 3 (safety), audit item 40: confirm that Razorpay Route actually paid the kitchen.
--
-- Before: a captured payment was marked paid with whichever linked account was configured at that
-- moment, and Razorpay's transfer.* webhooks were ignored, so a failed transfer left the kitchen
-- unpaid with nobody told.
--
--   * payments.transfer_status: 'pending' once an online (Route) payment is captured, then
--     'processed', 'settled', 'failed' or 'reversed' from Razorpay's transfer.* events, with the
--     transfer id, the account it actually went to (transfer_account) and any error.
--   * razorpay_process_event handles transfer.processed / transfer.settled / transfer.failed /
--     transfer.reversed (private.apply_transfer_event). The transfer carries our payment id in its
--     notes (routeTransfer in _shared/razorpay.ts); else it is matched on its source: the Razorpay
--     order id (a payment link's transfers belong to its order, payments.razorpay_order_id, kept from
--     the paid event and backfilled from stored webhook events) or the Razorpay payment id.
--   * A late refund.failed from an earlier attempt of a refund (refund claims, 20261112000300) no
--     longer fails the attempt now in flight.
--   * A failed transfer alerts the kitchen's owners (template transfer_failed, Meta approval needed
--     before WhatsApp is live) and shows in admin_route_transfers() for the platform team, as do
--     transfers still pending a day after capture and transfers to another account than expected.

alter table public.payments
  add column transfer_status text check (transfer_status in ('pending', 'processed', 'settled', 'failed', 'reversed')),
  add column razorpay_transfer_id text,
  add column transfer_account text,
  add column transfer_error text,
  add column transfer_updated_at timestamptz;
-- payments.razorpay_order_id (M3) was never filled: the paid event now keeps it.
create index payments_razorpay_order_idx on public.payments (razorpay_order_id) where razorpay_order_id is not null;

-- Payments captured before this migration: the order id from the stored paid events (links created
-- before the transfer notes existed are then still matched).
update public.payments p
set razorpay_order_id = coalesce(e.payload -> 'payload' -> 'payment' -> 'entity' ->> 'order_id',
                                 e.payload -> 'payload' -> 'payment_link' -> 'entity' ->> 'order_id')
from public.webhook_events e
where e.provider = 'razorpay' and e.event_type in ('payment_link.paid', 'payment.captured')
  and p.razorpay_order_id is null and p.razorpay_payment_id is not null
  and e.payload -> 'payload' -> 'payment' -> 'entity' ->> 'id' = p.razorpay_payment_id
  and coalesce(e.payload -> 'payload' -> 'payment' -> 'entity' ->> 'order_id',
               e.payload -> 'payload' -> 'payment_link' -> 'entity' ->> 'order_id') is not null;
create index payments_transfer_attention_idx on public.payments (transfer_status, paid_at)
  where transfer_status in ('pending', 'failed', 'reversed');

-- An online payment's Route transfer is awaited from the moment it is captured.
create or replace function private.payment_transfer_pending()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' and new.method = 'razorpay_link'
     and new.transfer_status is null and coalesce(new.transfer_paise, new.amount_paise) > 0 then
    new.transfer_status := 'pending';
    new.transfer_updated_at := private.now();
  end if;
  return new;
end;
$$;

create trigger payments_transfer_pending before update of status on public.payments
  for each row execute function private.payment_transfer_pending();

create or replace function private.apply_transfer_event(p_type text, p_transfer jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := case p_type when 'transfer.processed' then 'processed' when 'transfer.settled' then 'settled'
                               when 'transfer.failed' then 'failed' when 'transfer.reversed' then 'reversed' end;
  v_p public.payments;
  v_error text;
  v_note_id uuid;
begin
  if v_status is null or p_transfer is null then
    return 'ignored';
  end if;
  if p_transfer -> 'notes' ->> 'payment_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    v_note_id := (p_transfer -> 'notes' ->> 'payment_id')::uuid;
  end if;
  select * into v_p from public.payments p
  where (v_note_id is not null and p.id = v_note_id)
     or (p_transfer ->> 'source' is not null and p.razorpay_payment_id = p_transfer ->> 'source')
     or (p_transfer ->> 'source' is not null and p.razorpay_order_id = p_transfer ->> 'source')
     or (p_transfer ->> 'id' is not null and p.razorpay_transfer_id = p_transfer ->> 'id')
  order by p.created_at desc
  limit 1
  for update;
  if v_p.id is null then
    return 'unmatched';
  end if;
  -- Never step back from settled to processed (events can arrive out of order).
  if v_p.transfer_status = 'settled' and v_status = 'processed' then
    return 'transfer_settled';
  end if;
  v_error := case when v_status in ('failed', 'reversed')
                  then left(coalesce(p_transfer -> 'error' ->> 'description', p_transfer -> 'error' ->> 'reason',
                                     p_transfer -> 'error' ->> 'code', v_status), 500) end;
  update public.payments
  set transfer_status = v_status, razorpay_transfer_id = coalesce(p_transfer ->> 'id', razorpay_transfer_id),
      transfer_account = coalesce(p_transfer ->> 'recipient', transfer_account), transfer_error = v_error,
      transfer_updated_at = private.now()
  where id = v_p.id;

  if v_status = 'failed' then
    insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key)
    select v_p.kitchen_id, 'whatsapp', 'member', m.user_id, 'transfer_failed',
           jsonb_build_object('payment_id', v_p.id, 'amount_paise', coalesce(v_p.transfer_paise, v_p.amount_paise),
                              'paid_at', v_p.paid_at, 'error', v_error),
           'transfer_failed:' || v_p.id || ':' || m.user_id
    from public.members m where m.kitchen_id = v_p.kitchen_id and m.role = 'owner'
    on conflict (dedupe_key) do nothing;
  end if;
  if p_transfer ->> 'recipient' is not null and v_p.settled_to_account is not null
     and p_transfer ->> 'recipient' <> v_p.settled_to_account then
    return 'transfer_account_mismatch';
  end if;
  return 'transfer_' || v_status;
end;
$$;

-- Webhook events (M3 body; transfer.* events added).
create or replace function public.razorpay_process_event(p_event_id text, p_payload jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := p_payload ->> 'event';
  v_pay jsonb := p_payload -> 'payload' -> 'payment' -> 'entity';
  v_link jsonb := p_payload -> 'payload' -> 'payment_link' -> 'entity';
  v_ref jsonb := p_payload -> 'payload' -> 'refund' -> 'entity';
  v_tr jsonb := p_payload -> 'payload' -> 'transfer' -> 'entity';
  v_payment uuid;
  v_refund uuid;
  v_result text;
begin
  if nullif(p_event_id, '') is null then
    raise exception 'event_id_required' using errcode = '22023';
  end if;
  insert into public.webhook_events (provider, event_id, event_type, payload)
  values ('razorpay', p_event_id, v_type, p_payload)
  on conflict (provider, event_id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  -- Find our payment: link reference_id/notes, payment notes, or a known Razorpay id.
  select p.id into v_payment from public.payments p
  where p.id::text = coalesce(v_link ->> 'reference_id', v_link -> 'notes' ->> 'payment_id', v_pay -> 'notes' ->> 'payment_id')
     or (v_link ->> 'id' is not null and p.razorpay_payment_link_id = v_link ->> 'id')
     or (v_pay ->> 'id' is not null and p.razorpay_payment_id = v_pay ->> 'id')
  limit 1;

  v_result := case
    when v_type in ('payment_link.paid', 'payment.captured') then
      case when v_payment is null then 'unmatched'
           else private.mark_payment_paid(v_payment, v_pay ->> 'id', (v_pay ->> 'amount')::integer, v_pay ->> 'currency') end
    when v_type = 'payment.failed' then
      case when v_payment is null then 'unmatched' else 'noted' end
    when v_type in ('payment_link.expired', 'payment_link.cancelled') then
      case when v_payment is null then 'unmatched' else 'link_closed' end
    when v_type in ('refund.processed', 'refund.failed') then 'refund'
    when v_type in ('transfer.processed', 'transfer.settled', 'transfer.failed', 'transfer.reversed') then
      private.apply_transfer_event(v_type, v_tr)
    else 'ignored'
  end;

  -- Keep the Razorpay order id: a payment link's Route transfer names it as its source.
  if v_type in ('payment_link.paid', 'payment.captured') and v_payment is not null
     and coalesce(v_pay ->> 'order_id', v_link ->> 'order_id') is not null then
    update public.payments set razorpay_order_id = coalesce(v_pay ->> 'order_id', v_link ->> 'order_id')
    where id = v_payment and razorpay_order_id is null;
  end if;

  if v_type in ('payment_link.expired', 'payment_link.cancelled') and v_payment is not null then
    update public.payments set status = case when v_type = 'payment_link.expired' then 'expired' else 'cancelled' end::public.payment_status
    where id = v_payment and status = 'created';
  end if;

  if v_type in ('refund.processed', 'refund.failed') then
    select r.id into v_refund from public.refunds r
    where r.razorpay_refund_id = v_ref ->> 'id' or r.id::text = v_ref -> 'notes' ->> 'refund_id'
    limit 1;
    if v_refund is null then
      v_result := 'unmatched';
    elsif v_type = 'refund.failed' and exists (
            select 1 from public.refunds r where r.id = v_refund
              and ((r.razorpay_refund_id is not null and r.razorpay_refund_id <> v_ref ->> 'id')
                   or (v_ref -> 'notes' ->> 'attempt' ~ '^[0-9]+$'
                       and (v_ref -> 'notes' ->> 'attempt')::integer <> r.gateway_attempt))) then
      -- A late failure of an earlier attempt: the attempt now in flight is not failed by it.
      v_result := 'refund_stale_attempt';
    else
      update public.refunds
      set status = case when v_type = 'refund.processed' then 'processed' else 'failed' end::public.refund_status,
          razorpay_refund_id = coalesce(razorpay_refund_id, v_ref ->> 'id'),
          processed_at = case when v_type = 'refund.processed' then private.now() end
      where id = v_refund and status in ('pending', 'processing');
      v_result := case when v_type = 'refund.processed' then 'refund_processed' else 'refund_failed' end;
    end if;
  end if;

  update public.webhook_events set processed_at = private.now(), result = v_result
  where provider = 'razorpay' and event_id = p_event_id;
  return v_result;
end;
$$;

-- Platform team: Route transfers that need a look (failed, reversed, still pending a day after
-- capture, or paid to another account than the kitchen's).
create or replace function public.admin_route_transfers(p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((select jsonb_agg(x order by x ->> 'paid_at' desc) from (
    select jsonb_build_object(
      'payment_id', p.id, 'kitchen_id', p.kitchen_id, 'kitchen_name', k.name, 'amount_paise', p.amount_paise,
      'transfer_paise', coalesce(p.transfer_paise, p.amount_paise), 'paid_at', p.paid_at,
      'transfer_status', p.transfer_status, 'transfer_error', p.transfer_error, 'transfer_updated_at', p.transfer_updated_at,
      'expected_account', p.settled_to_account, 'transfer_account', p.transfer_account,
      'razorpay_payment_id', p.razorpay_payment_id, 'razorpay_transfer_id', p.razorpay_transfer_id,
      'reason', case when p.transfer_status in ('failed', 'reversed') then p.transfer_status
                     when p.transfer_account is not null and p.settled_to_account is not null
                          and p.transfer_account <> p.settled_to_account then 'account_mismatch'
                     else 'overdue' end) as x
    from public.payments p join public.kitchens k on k.id = p.kitchen_id
    where p.method = 'razorpay_link' and p.status = 'paid'
      and (p.transfer_status in ('failed', 'reversed')
           or (p.transfer_status = 'pending' and p.paid_at < private.now() - interval '24 hours')
           or (p.transfer_account is not null and p.settled_to_account is not null and p.transfer_account <> p.settled_to_account))
    order by p.paid_at desc
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)) s), '[]'::jsonb);
end;
$$;

revoke execute on function public.admin_route_transfers from public, anon;
grant execute on function public.admin_route_transfers to authenticated;
revoke execute on function public.razorpay_process_event from public, anon, authenticated;
grant execute on function public.razorpay_process_event to service_role;
revoke execute on function private.apply_transfer_event, private.payment_transfer_pending from public, anon, authenticated;
