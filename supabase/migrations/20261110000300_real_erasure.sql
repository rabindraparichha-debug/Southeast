-- Vendor-first wave 3 (ops), item 31 (part 2): erasing a customer really erases them.
--
-- erase_customer (and anything else that sets customers.deleted_at) fires
-- private.customer_erased_cleanup, which now also:
--   * scrubs their delivery GPS, failure notes and proof-photo paths, complaint text, review comment
--     and switch-request reasons (the rows stay: counts and money do not change);
--   * queues their proof photos for deletion (the storage-retention Edge Function removes them
--     through the Storage API; SQL cannot delete storage objects);
--   * blanks the import rows that created them;
--   * forgets the WhatsApp conversation with their number (deleted with its messages), unless
--     another live customer of the kitchen shares the number (D-118): then it is only unlinked;
--   * deletes their queued and past outbox messages;
--   * last, replaces every personal value in their audit_log rows with "[erased]"
--     (private.scrub_customer_audit; the only path allowed to touch audit_log, see lean_audit).

-- Objects to delete through the Storage API (erasure). Processed by storage-retention.
create table public.storage_purge_queue (
  bucket text not null,
  name text not null,
  reason text not null check (reason in ('erasure')),
  kitchen_id uuid,
  queued_at timestamptz not null default now(),
  primary key (bucket, name)
);
alter table public.storage_purge_queue enable row level security;
revoke all on public.storage_purge_queue from anon, authenticated;

-- Tables whose audit rows carry a customer's personal data, matched by customer_id (and by row_id
-- for customers itself, new_customer_id for switch requests).
create or replace function private.customer_audit_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['customers', 'addresses', 'customer_health', 'complaints', 'delivery_stops', 'kitchen_reviews',
               'kitchen_switch_requests'];
$$;

create or replace function private.scrub_customer_audit(p_kitchen uuid, p_customer uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := p_customer::text;
  v_n integer;
  v_m integer;
begin
  perform set_config('tiffin.audit_scrub', 'on', true);

  update public.audit_log a
  set before = private.audit_scrub(a.before, private.audit_personal_keys(a.table_name)),
      after = private.audit_scrub(a.after, private.audit_personal_keys(a.table_name))
  where a.kitchen_id = p_kitchen
    and a.table_name = any (private.customer_audit_tables())
    and ((a.table_name = 'customers' and a.row_id = v_id)
         or a.before ->> 'customer_id' = v_id or a.after ->> 'customer_id' = v_id)
    and (a.before is distinct from private.audit_scrub(a.before, private.audit_personal_keys(a.table_name))
         or a.after is distinct from private.audit_scrub(a.after, private.audit_personal_keys(a.table_name)));
  get diagnostics v_n = row_count;

  -- Switch requests have no kitchen_id column (their audit rows have none either).
  update public.audit_log a
  set before = private.audit_scrub(a.before, private.audit_personal_keys(a.table_name)),
      after = private.audit_scrub(a.after, private.audit_personal_keys(a.table_name))
  where a.table_name = 'kitchen_switch_requests'
    and (a.before ->> 'customer_id' = v_id or a.after ->> 'customer_id' = v_id
         or a.before ->> 'new_customer_id' = v_id or a.after ->> 'new_customer_id' = v_id)
    and (a.before is distinct from private.audit_scrub(a.before, private.audit_personal_keys(a.table_name))
         or a.after is distinct from private.audit_scrub(a.after, private.audit_personal_keys(a.table_name)));
  get diagnostics v_m = row_count;

  perform set_config('tiffin.audit_scrub', '', true);
  return v_n + v_m;
end;
$$;

-- Erasure (P5 trigger, extended in P6): now a full scrub.
create or replace function private.customer_erased_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    -- P5/P6: stops paying for others, health data deleted, leaves its office.
    update public.customers set payer_customer_id = null where payer_customer_id = new.id;
    delete from public.customer_health where customer_id = new.id;
    update public.customers set office_id = null where id = new.id and office_id is not null;

    -- Delivery records keep their status and counts, not where or what was seen.
    insert into public.storage_purge_queue (bucket, name, reason, kitchen_id)
    select 'proofs', s.photo_path, 'erasure', s.kitchen_id
    from public.delivery_stops s
    where s.customer_id = new.id and s.photo_path is not null
    on conflict do nothing;
    update public.delivery_stops
    set gps_lat = null, gps_lng = null, gps_accuracy_m = null, gps_distance_m = null, failed_note = null, photo_path = null
    where customer_id = new.id
      and (gps_lat is not null or gps_lng is not null or gps_accuracy_m is not null or gps_distance_m is not null
           or failed_note is not null or photo_path is not null);

    update public.complaints set description = null, photo_url = null, resolution_note = null
    where customer_id = new.id and (description is not null or photo_url is not null or resolution_note is not null);
    update public.kitchen_reviews set comment = null where customer_id = new.id and comment is not null;
    update public.kitchen_switch_requests set reason = null, decision_note = null
    where (customer_id = new.id or new_customer_id = new.id) and (reason is not null or decision_note is not null);

    -- The import row that created them (the phone was never stored there, only its last 4 digits).
    update public.import_rows set raw = jsonb_build_object('erased', true)
    where customer_id = new.id and raw <> jsonb_build_object('erased', true);

    -- WhatsApp: forget the chat with their number, unless another live customer here shares it.
    for r in
      select c.id, c.customer_id,
             exists (select 1 from public.customers o
                     where o.kitchen_id = c.kitchen_id and o.id <> new.id and o.deleted_at is null
                       and o.phone_hash = c.wa_phone_hash) as shared
      from public.conversations c
      where c.kitchen_id = new.kitchen_id
        and (c.customer_id = new.id or (old.phone_hash is not null and c.wa_phone_hash = old.phone_hash))
    loop
      if r.shared then
        update public.conversations
        set customer_id = case when customer_id = new.id then null else customer_id end,
            contact_name = case when customer_id = new.id then null else contact_name end,
            state = case when customer_id = new.id then '{}'::jsonb else state end
        where id = r.id;
      else
        update public.complaints set conversation_id = null where conversation_id = r.id;
        delete from public.conversations where id = r.id;  -- messages go with it (on delete cascade)
      end if;
    end loop;

    -- Messages to them (queued or already sent) carry their name and details.
    delete from public.notifications_outbox
    where recipient_type = 'customer' and recipient_id = new.id and status <> 'sending';

    -- Last, so the audit rows written by the scrubs above are covered too.
    perform private.scrub_customer_audit(new.kitchen_id, new.id);
  end if;
  return null;
end;
$$;

revoke execute on function private.customer_audit_tables, private.scrub_customer_audit from public, anon, authenticated;
