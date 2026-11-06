-- Merge of vendor-first wave 3 riders (D-167 – D-179) into m9-p5-p6: 20261130000400_merge_riders.sql and
-- the cross-wave behaviour it must keep.
--   * wave 1 + riders: push claim and the in-app list run on the engine clock (private.now());
--   * wave 2 + riders: a push past wave 2's expires_at is never sent; riders' 12-hour staleness stays;
--     stop-credit alerts and the alert list reach managers; voided payments stay out of the cash handover;
--   * held-back DB + riders: a mock push is 'mock', never 'sent';
--   * ops + riders: stop notes are diff-only in the audit log.
-- Calendar: the engine clock is set to 2027-05-10, months after the rows' real created_at.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.src(p_schema text, p_name text) returns text language sql as
  $$ select string_agg(p.prosrc, E'\n') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = p_schema and p.proname = p_name $$;

select ok(pg_temp.src('public', 'push_claim_outbox') !~ '([^.]|^)now\(\)' and pg_temp.src('public', 'my_notifications') !~ '([^.]|^)now\(\)',
  'push claim and alert list use private.now() only');
select ok(pg_temp.src('public', 'assign_routes_by_area') ~ 'rebuild_locked_runs' and pg_temp.src('private', 'rebuild_locked_runs') ~ 'resync_runs',
  'routes by area rebuild locked slots through wave 1''s resync_runs');
select ok(pg_temp.src('private', 'is_alert_role') ~ 'manager' and pg_temp.src('private', 'notify_owners_push') ~ 'is_alert_role',
  'stop-credit push alerts reach managers');

-- ===========================================================================
-- Setup: kitchen R (owner, manager, staff, rider), one customer.
-- ===========================================================================
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(), now(), now()
from (values
  ('e2000000-0000-4000-e000-000000000001'::uuid, '919320000001'),   -- owner
  ('e2000000-0000-4000-e000-000000000002'::uuid, '919320000002'),   -- manager
  ('e2000000-0000-4000-e000-000000000003'::uuid, '919320000003'),   -- staff
  ('e2000000-0000-4000-e000-000000000004'::uuid, '919320000004')    -- rider
) as u(id, phone);
insert into public.kitchens (id, name, slug, owner_id, weekly_off) values
  ('e2000000-0000-4000-e000-00000000000a', 'Merge Riders Kitchen', 'merge-riders-kitchen', 'e2000000-0000-4000-e000-000000000001', '{}');
insert into public.kitchen_settings (kitchen_id) values ('e2000000-0000-4000-e000-00000000000a');
insert into public.members (kitchen_id, user_id, role, display_name) values
  ('e2000000-0000-4000-e000-00000000000a', 'e2000000-0000-4000-e000-000000000001', 'owner', 'Owner'),
  ('e2000000-0000-4000-e000-00000000000a', 'e2000000-0000-4000-e000-000000000002', 'manager', 'Manager'),
  ('e2000000-0000-4000-e000-00000000000a', 'e2000000-0000-4000-e000-000000000003', 'staff', 'Staff'),
  ('e2000000-0000-4000-e000-00000000000a', 'e2000000-0000-4000-e000-000000000004', 'rider', 'Rider');
select set_config('app.now', '2027-05-10 10:00:00+05:30', true);
create temp table ids (k text primary key, v uuid);
grant select on ids to authenticated;
insert into ids values ('c1', private.insert_customer('e2000000-0000-4000-e000-00000000000a', 'Rina Rider Test', '+919320100001', 'veg', 'en',
  null, '{"line1":"Flat 1","area":"Patia"}', 'vendor', 'vendor'));

-- ===========================================================================
-- Push claim: engine clock, expires_at, 12-hour staleness, mock status
-- ===========================================================================
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, send_after, expires_at)
values
  ('e2000000-0000-4000-e000-00000000000a', 'push', 'member', 'e2000000-0000-4000-e000-000000000002', 'stop_credit_request', '{}',
   'm20-fresh', private.now() - interval '1 minute', null),
  ('e2000000-0000-4000-e000-00000000000a', 'push', 'member', 'e2000000-0000-4000-e000-000000000002', 'stop_credit_request', '{}',
   'm20-stale', private.now() - interval '13 hours', null),
  ('e2000000-0000-4000-e000-00000000000a', 'push', 'member', 'e2000000-0000-4000-e000-000000000002', 'stop_credit_request', '{}',
   'm20-expired', private.now() - interval '1 hour', private.now() - interval '1 minute');
insert into public.member_devices (user_id, token, platform, active)
values ('e2000000-0000-4000-e000-000000000002', 'ExponentPushToken[m20-manager]', 'android', true);
create temp table claimed as select * from public.push_claim_outbox(100);
select is((select status || '/' || last_error from public.notifications_outbox where dedupe_key = 'm20-expired'), 'cancelled/expired',
  'a push past wave 2''s expires_at is cancelled, not sent');
select is((select status || '/' || last_error from public.notifications_outbox where dedupe_key = 'm20-stale'), 'cancelled/expired',
  'a push due over 12 hours ago (engine clock) is stale (riders)');
select is((select tokens from claimed c join public.notifications_outbox o on o.id = c.id where o.dedupe_key = 'm20-fresh'),
  array['ExponentPushToken[m20-manager]'], 'a fresh one is claimed for the manager''s phone (managers get alerts)');
select public.push_complete_outbox((select o.id from public.notifications_outbox o where o.dedupe_key = 'm20-fresh'), true, null, null, false, true);
select is((select status || '/' || coalesce(last_error, '-') from public.notifications_outbox where dedupe_key = 'm20-fresh'), 'mock/-',
  'a mock push is recorded as mock, never sent (held-back DB)');

-- ===========================================================================
-- In-app alerts on the engine clock
-- ===========================================================================
insert into public.notifications_outbox (kitchen_id, channel, recipient_type, recipient_id, template, payload, dedupe_key, status)
values ('e2000000-0000-4000-e000-00000000000a', 'whatsapp', 'member', 'e2000000-0000-4000-e000-000000000002', 'production_sheet',
        '{"service_date":"2027-05-11","slot":"lunch","totals":{"total_meals":3}}', 'm20-sheet', 'sent');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e2000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select ok((select count(*) from jsonb_array_elements(public.my_notifications()) x where x ->> 'template' = 'production_sheet') >= 1,
  'the manager''s alert list shows today''s alert although its real created_at is months before the engine clock');
select set_config('request.jwt.claims', '{"sub":"e2000000-0000-4000-e000-000000000003","role":"authenticated"}', true);
select is(public.my_notifications(), '[]'::jsonb, 'staff get no member alerts');
reset role;
select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Cash handover leaves out voided payments (wave 2)
-- ===========================================================================
insert into public.payments (kitchen_id, customer_id, method, status, amount_paise, meals, collected_by, confirmed_at, voided_at, void_reason, updated_at)
values
  ('e2000000-0000-4000-e000-00000000000a', (select v from ids where k = 'c1'), 'cash', 'paid', 50000, 5,
   'e2000000-0000-4000-e000-000000000004', private.now(), null, null, private.now()),
  ('e2000000-0000-4000-e000-00000000000a', (select v from ids where k = 'c1'), 'cash', 'voided', 70000, 7,
   'e2000000-0000-4000-e000-000000000004', private.now(), private.now(), 'entered twice', private.now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e2000000-0000-4000-e000-000000000002","role":"authenticated"}', true);
select is((select (x ->> 'confirmed_paise')::int || '/' || (x ->> 'pending_paise')::int || '/' || (x ->> 'rejected_paise')::int
           from jsonb_array_elements(public.cash_handover('e2000000-0000-4000-e000-00000000000a') -> 'collectors') x),
  '50000/0/0', 'a manager sees the rider''s confirmed cash; the voided payment counts nowhere');
reset role;
select set_config('request.jwt.claims', '', true);

-- ===========================================================================
-- Stop notes in the lean audit (ops)
-- ===========================================================================
select ok(private.audit_personal_keys('delivery_stops') @> array['credit_note', 'correction_note', 'failed_note'],
  'stop-credit and correction notes are personal keys (diff-only, scrubbed on erasure)');
select ok(private.audit_personal_keys('change_requests') @> array['note'] and private.audit_personal_keys('rider_sync_rejects') @> array['summary'],
  'and the ops merge''s additions stay');

select * from finish();
rollback;
