-- M8 security review, automated: schema-wide invariants that every future migration must keep.
-- RLS everywhere, fail-closed grants, SECURITY DEFINER hygiene, anon allowlist, append-only
-- ledgers, private buckets, and the FSSAI guard on live kitchens.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Every table in public has row-level security.
select is((select coalesce(array_agg(c.relname::text order by c.relname), '{}') from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), '{}'::text[],
  'every public table has RLS enabled');

-- Every SECURITY DEFINER function pins search_path = ''.
select is((select coalesce(array_agg(n.nspname || '.' || p.proname order by p.proname), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prosecdef and not coalesce(p.proconfig, '{}') @> array['search_path=""']),
  '{}'::text[], 'every SECURITY DEFINER function sets search_path to empty');

-- Anon (no login) can run only the public website and customer-page functions.
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')),
  -- P5/P6 added the customer-page functions for payers, food prefs, referrals, health tags and kitchen switching;
  -- Phase 2 hardening added the kitchen-scoped referral join page (referral_invite, referral_join; D-147).
  array['kitchen_directory', 'kitchen_profile', 'lead_attach_gclid', 'lead_choose', 'list_areas', 'portal_add_address', 'portal_apply_referral',
        'portal_cancel_switch', 'portal_change', 'portal_complaint', 'portal_dependent_payment_link_record', 'portal_get',
        'portal_payment_link_record', 'portal_request_switch', 'portal_review', 'portal_set_food_prefs', 'portal_set_health_tags',
        'portal_set_language', 'portal_switch_options', 'referral_invite', 'referral_join', 'submit_lead', 'submit_vendor_application'],
  'anon can execute only the allowlisted public functions');
select is((select coalesce(array_agg(table_name || ':' || privilege_type order by table_name), '{}') from information_schema.role_table_grants
           where grantee = 'anon' and table_schema = 'public'), array['areas:SELECT'], 'anon can read only the areas list');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon cannot use the private schema');

-- Signed-in users: every SECURITY DEFINER RPC checks the caller (role, admin, token or run access),
-- except the deliberate self-service and public ones.
select is((select coalesce(array_agg(p.proname::text order by p.proname), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
             and p.prosrc !~ '(require_role|require_admin|require_run_access|portal_customer|private.lead_|token_hash|auth.uid\(\) is null|private.has_role|private.is_platform_admin)'),
  array['claim_invites', 'create_kitchen', 'kitchen_directory', 'kitchen_profile', 'list_areas', 'referral_invite', 'referral_join',
        'submit_vendor_application'],
  'every other RPC callable by signed-in users checks who is calling');
-- Service-role-only RPCs are not callable by users (wave 3: ops_* for the ops-health and
-- storage-retention Edge Functions).
select is((select coalesce(array_agg(p.proname::text order by p.proname), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'wa\_%' or p.proname like 'ops\_%' or p.proname in ('razorpay_process_event', 'attach_payment_link',
             'mark_refund_submitted', 'lead_ingest', 'weather_kitchens', 'weather_record_alert', 'cancel_payment_link_record',
             'ads_claim_conversions', 'ads_complete_conversion'))
             and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  '{}'::text[], 'webhook/service functions are not callable by users');

-- No direct deletes except own addresses, and no direct writes at all to ledgers or money tables.
select is((select coalesce(array_agg(table_name::text order by table_name), '{}') from information_schema.role_table_grants
           where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'DELETE'), array['addresses'],
  'the only table users may delete from is addresses (RLS limits it to their kitchen)');
select is((select coalesce(array_agg(distinct table_name::text), '{}') from information_schema.column_privileges
           where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('INSERT', 'UPDATE')
             and table_name in ('balance_entries', 'payments', 'refunds', 'stock_moves', 'supplier_payments', 'audit_log',
                                'schedule_changes', 'count_snapshots', 'meal_orders', 'delivery_stops', 'tiffin_ledger', 'leads',
                                'customers', 'webhook_events', 'notifications_outbox', 'lead_events', 'platform_commissions',
                                'customer_health', 'referrals', 'kitchen_switch_requests', 'offices', 'platform_settings',
                                'food_calendar', 'churn_risks', 'dispatch_photos', 'festival_specials', 'weather_alerts',
                                'engine_errors', 'kitchen_closures', 'change_requests', 'engine_heartbeats', 'storage_purge_queue')),
  '{}'::text[], 'no direct inserts or updates on ledgers, money, orders, leads or customers (RPCs only)');

-- Append-only ledgers refuse updates and deletes even for the database owner.
select is((select coalesce(array_agg(t order by t), '{}') from unnest(array['audit_log', 'balance_entries', 'schedule_changes', 'count_snapshots',
            'stock_moves', 'supplier_payments', 'tiffin_ledger', 'lead_events', 'platform_commissions', 'admin_actions']) t
           where not exists (select 1 from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
                             where c.relname = t and tr.tgfoid = 'private.forbid_mutation'::regproc)),
  '{}'::text[], 'every ledger has the append-only trigger');

-- Wave 2's exact-owner policies call the role helper overloads: any later blanket revoke on schema private
-- must grant them again (merge plan §E).
select ok(has_function_privilege('authenticated', 'private.kitchen_ids(public.member_role[], boolean)', 'execute')
          and has_function_privilege('authenticated', 'private.has_role(uuid, public.member_role[], boolean)', 'execute'),
  'the role helper overloads (roles, exact) stay executable for the RLS policies');
-- Wave 3: the ops RPCs exist and are granted to the service role (ops-health, storage-retention).
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'ops\_%' and has_function_privilege('service_role', p.oid, 'execute')),
  array['ops_expired_objects', 'ops_health', 'ops_heartbeat', 'ops_mark_purged'], 'the service role can run the ops RPCs');
-- audit_log: deletes refused by forbid_mutation; updates only through the scrub-only guard.
select is((select array_agg(tr.tgname::text || ':' || tr.tgfoid::regproc::text order by tr.tgname) from pg_trigger tr
           where tr.tgrelid = 'public.audit_log'::regclass and not tr.tgisinternal),
  array['audit_log_append_only:private.forbid_mutation', 'audit_log_no_truncate:private.forbid_mutation', 'audit_log_scrub_only:private.audit_log_guard'],
  'the audit log is append-only except the erasure scrub');

-- Views run with the caller's rights (RLS applies).
select is((select coalesce(array_agg(c.relname::text order by c.relname), '{}') from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' and not coalesce(c.reloptions, '{}') @> array['security_invoker=on']),
  '{}'::text[], 'every public view is security_invoker');

-- Storage: everything private except public kitchen photos.
select is((select array_agg(id order by id) from storage.buckets where public), array['kitchen-photos'], 'only kitchen photos are public');

-- Phone numbers: encrypted columns only, never plain text on customer, lead or applicant tables.
select is((select coalesce(array_agg(table_name || '.' || column_name order by table_name), '{}') from information_schema.columns
           where table_schema = 'public' and table_name in ('customers', 'leads', 'vendor_applications', 'conversations', 'offices')
             and column_name ~ 'phone' and column_name !~ '(_enc|_hash|_last4)$'), '{}'::text[],
  'customer, lead and applicant phones are stored encrypted (plus hash and last 4)');

-- FSSAI: an owner cannot change the number of a live kitchen (the platform verified it).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok($$ update public.kitchens set fssai_no = '99999999999999' where id = '10000000-0000-4000-a000-00000000000a' $$,
  '42501', 'fssai_locked', 'a live kitchen''s FSSAI number cannot be changed by its owner');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
select lives_ok($$ update public.kitchens set fssai_no = '12026001000999' where id = '10000000-0000-4000-a000-00000000000b' $$,
  'a draft kitchen''s owner can add or change it');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
select lives_ok($$ select public.admin_set_fssai('10000000-0000-4000-a000-00000000000a', '12026001000124') $$,
  'the platform team can correct it');
reset role;

-- Audit log paging: rows written in one transaction share a timestamp; the (at, id) cursor keeps them all.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000099","role":"authenticated"}', true);
create temp table pages (n integer, ids bigint[]);
grant all on pages to authenticated;
insert into pages select 1, array(select (x ->> 'id')::bigint from jsonb_array_elements(public.admin_audit_log(p_table => 'delivery_stops', p_limit => 50)) x);
insert into pages select 2, array(select (x ->> 'id')::bigint from jsonb_array_elements(public.admin_audit_log(
  p_table => 'delivery_stops', p_limit => 50,
  p_before => (select created_at from public.audit_log where id = (select ids[50] from pages where n = 1)),
  p_before_id => (select ids[50] from pages where n = 1))) x);
select is((select cardinality(ids) from pages where n = 2), 50, 'the second page is full even when page 1 ended inside one transaction');
select is((select ids[1] from pages where n = 2), (select max(id) from public.audit_log where table_name = 'delivery_stops' and id < (select ids[50] from pages where n = 1)),
  'and continues exactly after the last row shown');
reset role;

select * from finish();
rollback;
