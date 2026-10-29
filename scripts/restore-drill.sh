#!/usr/bin/env bash
# Restore drill (M8): back up the local database, restore it into a scratch database on the same
# server, and check that every table's row count and the ledger totals match. Exits non-zero on
# any difference. Usage: scripts/restore-drill.sh [existing.dump]
set -euo pipefail
cd "$(dirname "$0")/.."
C=supabase_db_tiffin
DRILL=restore_drill
psqlc() { docker exec -i "$C" psql -U supabase_admin -v ON_ERROR_STOP=1 -qAt "$@"; }

dump="${1:-}"
if [[ -z "$dump" ]]; then
  dump=$(scripts/backup.sh | sed -n 's/^backup written: \([^ ]*\).*/\1/p')
fi
echo "restoring $dump into database $DRILL"

psqlc -d postgres -c "drop database if exists $DRILL" >/dev/null
psqlc -d postgres -c "create database $DRILL" >/dev/null
# The extensions the schemas depend on live in their own schema, as in Supabase.
exts=$(psqlc -d postgres -c "select string_agg(format('create extension if not exists %I with schema extensions;', extname), ' ')
                              from pg_extension where extnamespace = 'extensions'::regnamespace")
psqlc -d "$DRILL" >/dev/null <<SQL
drop schema public cascade;  -- the dump recreates it
create schema if not exists extensions;
$exts
SQL
docker exec -i "$C" pg_restore -U supabase_admin -d "$DRILL" --no-comments --exit-on-error < "$dump"

# Same checks on both databases.
checks=$(cat <<'SQL'
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
SQL
)
live=$(psqlc -d postgres -c "$checks")
restored=$(psqlc -d "$DRILL" -c "$checks")
psqlc -d postgres -c "drop database $DRILL" >/dev/null

tables=$(grep -c '^rows ' <<<"$live")
if diff <(echo "$live") <(echo "$restored") >/dev/null; then
  echo "RESTORE DRILL PASSED: $tables tables and the ledger totals match"
  grep -E '^(sum|locked)' <<<"$live" | sed 's/^/  /'
else
  echo "RESTORE DRILL FAILED: differences (live < > restored):"
  diff <(echo "$live") <(echo "$restored") || true
  exit 1
fi
