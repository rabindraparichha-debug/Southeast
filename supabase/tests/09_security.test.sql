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
  array['kitchen_directory', 'kitchen_profile', 'lead_choose', 'list_areas', 'portal_add_address', 'portal_change', 'portal_complaint',
        'portal_get', 'portal_payment_link_record', 'portal_review', 'portal_set_language', 'submit_lead', 'submit_vendor_application'],
  'anon can execute only the allowlisted public functions');
select is((select coalesce(array_agg(table_name || ':' || privilege_type order by table_name), '{}') from information_schema.role_table_grants
           where grantee = 'anon' and table_schema = 'public'), array['areas:SELECT'], 'anon can read only the areas list');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon cannot use the private schema');

-- Signed-in users: every SECURITY DEFINER RPC checks the caller (role, admin, token or run access),
-- except the deliberate self-service and public ones.
select is((select coalesce(array_agg(p.proname::text order by p.proname), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
             and p.prosrc !~ '(require_role|require_admin|require_run_access|portal_customer|private.lead_|token_hash|auth.uid\(\) is null|private.has_role|private.is_platform_admin)'),
  array['claim_invites', 'create_kitchen', 'kitchen_directory', 'kitchen_profile', 'list_areas', 'submit_vendor_application'],
  'every other RPC callable by signed-in users checks who is calling');
-- Service-role-only RPCs are not callable by users.
select is((select coalesce(array_agg(p.proname::text order by p.proname), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'wa\_%' or p.proname in ('razorpay_process_event', 'attach_payment_link',
             'mark_refund_submitted', 'lead_ingest'))
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
                                'customers', 'webhook_events', 'notifications_outbox', 'lead_events')),
  '{}'::text[], 'no direct inserts or updates on ledgers, money, orders, leads or customers (RPCs only)');

-- Append-only ledgers refuse updates and deletes even for the database owner.
select is((select coalesce(array_agg(t order by t), '{}') from unnest(array['audit_log', 'balance_entries', 'schedule_changes', 'count_snapshots',
            'stock_moves', 'supplier_payments', 'tiffin_ledger', 'lead_events']) t
           where not exists (select 1 from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
                             where c.relname = t and tr.tgfoid = 'private.forbid_mutation'::regproc)),
  '{}'::text[], 'every ledger has the append-only trigger');

-- Views run with the caller's rights (RLS applies).
select is((select coalesce(array_agg(c.relname::text order by c.relname), '{}') from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' and not coalesce(c.reloptions, '{}') @> array['security_invoker=on']),
  '{}'::text[], 'every public view is security_invoker');

-- Storage: everything private except public kitchen photos.
select is((select array_agg(id order by id) from storage.buckets where public), array['kitchen-photos'], 'only kitchen photos are public');

-- Phone numbers: encrypted columns only, never plain text on customer, lead or applicant tables.
select is((select coalesce(array_agg(table_name || '.' || column_name order by table_name), '{}') from information_schema.columns
           where table_schema = 'public' and table_name in ('customers', 'leads', 'vendor_applications', 'conversations')
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

select * from finish();
rollback;
