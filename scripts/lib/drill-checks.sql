-- Row counts of every table in public and private, plus ledger totals. Written next to every
-- backup (<dump>.checks) and compared after a restore (scripts/restore-drill.sh).
select 'rows ' || n.nspname || '.' || c.relname || ' ' ||
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'private') and c.relkind = 'r'
union all select 'rows auth.users ' || count(*) from auth.users
union all select 'sum balance_entries.meals ' || coalesce(sum(meals), 0) || ' paise ' || coalesce(sum(amount_paise), 0) from public.balance_entries
union all select 'sum stock_moves.qty ' || coalesce(sum(qty), 0) from public.stock_moves
union all select 'sum payments.paid ' || coalesce(sum(amount_paise) filter (where status = 'paid'), 0) from public.payments
union all select 'locked meals ' || coalesce(sum(qty), 0) from public.meal_orders where locked_at is not null and (status <> 'skipped' or charged)
order by 1;
