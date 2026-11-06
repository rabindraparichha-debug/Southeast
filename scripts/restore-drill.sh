#!/usr/bin/env bash
# Restore drill: prove a backup can be restored and still adds up. Exits non-zero on any difference.
#
# 1. Local (M8, default): back up the local stack, restore into a scratch database on the same server
#    and compare every table's row count and the ledger totals.
#      scripts/restore-drill.sh [existing.dump]
#      DB_CONTAINER=supabase_db_<project_id> ...      # if your local project_id is not "tiffin"
#
# 2. Into a staging copy (vendor-first wave 3, item 32): restore production (or any source) into a
#    hosted staging project and check it the way production will be checked after a real restore.
#      DB_URL=<staging direct connection>  CONFIRM_WIPE=<host:port/db of DB_URL> \
#        SOURCE_DB_URL=<source direct connection>  scripts/restore-drill.sh
#      DB_URL=... CONFIRM_WIPE=... scripts/restore-drill.sh backups/tiffin-....dump   # a dump + its .checks
#    The staging project must already have every migration (scripts/deploy.sh) and the SAME Vault
#    phone_encryption_key and phone_hash_key as the source (from the password manager). Its data in
#    public, private and auth is REPLACED: CONFIRM_WIPE must repeat the target exactly. Its tiffin-*
#    pg_cron jobs are paused during the drill. Copied outbox messages still waiting to go are cancelled
#    in the load transaction, and afterwards only the jobs that cannot contact anyone are switched back
#    on (RESUME_SAFE_JOBS); every job that sends WhatsApp/SMS/push or calls an outside service stays
#    paused, because the copy holds production's real phone numbers and keys that decrypt them.
#    RESUME_JOBS=yes switches every paused job back on (only for a staging copy with test data).
#    Checks: row counts and ledger totals equal the source's, every tiffin-* cron job exists, and
#    stored phone numbers decrypt and re-hash to their stored hash with the target's Vault keys
#    (decrypt_phone works). No phone number is printed.
# Client tools older than the server? Set PG_TOOLS_IMAGE (scripts/lib/pg.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/pg.sh
dump="${1:-}"
[[ -n "$dump" && "$dump" != /* ]] && dump="$PWD/$dump"

# ---------------------------------------------------------------------------------------------
# 1. Local scratch-database drill
# ---------------------------------------------------------------------------------------------
if [[ -z "${DB_URL:-}" ]]; then
  C="${DB_CONTAINER:-supabase_db_tiffin}"
  DRILL=restore_drill
  psqlc() { docker exec -i "$C" psql -U supabase_admin -v ON_ERROR_STOP=1 -qAt "$@"; }

  if [[ -z "$dump" ]]; then
    dump="$PWD/$(DB_CONTAINER="$C" scripts/backup.sh | sed -n 's/^backup written: \([^ ]*\).*/\1/p')"
  fi
  echo "restoring ${dump#"$PWD/"} into database $DRILL"

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

  checks=$(cat scripts/lib/drill-checks.sql)
  # Compare with the checks taken in the dump's own snapshot (scripts/backup.sh); the live database
  # may have moved on since. Older dumps without .checks fall back to the live counts.
  if [[ -f "$dump.checks" ]]; then live=$(cat "$dump.checks"); else live=$(psqlc -d postgres -c "$checks"); fi
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
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# 2. Restore into a staging copy (DB_URL)
# ---------------------------------------------------------------------------------------------
target=$(pg_url_target "$DB_URL")
if [[ "${CONFIRM_WIPE:-}" != "$target" ]]; then
  echo "refusing: this REPLACES all data in $target. Re-run with CONFIRM_WIPE=$target if that is a staging copy." >&2
  exit 2
fi
if [[ -n "${SOURCE_DB_URL:-}" ]]; then
  if [[ "$(pg_url_target "$SOURCE_DB_URL")" == "$target" ]]; then
    echo "refusing: the source and the target are the same database" >&2
    exit 2
  fi
  [[ -n "$dump" ]] && { echo "refusing: give either SOURCE_DB_URL or a dump, not both" >&2; exit 2; }
  dump="$PWD/$(DB_URL="$SOURCE_DB_URL" scripts/backup.sh | sed -n 's/^backup written: \([^ ]*\).*/\1/p')"
fi
if [[ -z "$dump" || ! -f "$dump" || ! -f "$dump.checks" ]]; then
  echo "refusing: need SOURCE_DB_URL, or a dump written by scripts/backup.sh with its .checks file next to it" >&2
  exit 2
fi
pg_check_versions "$DB_URL" pg_restore
tq() { pgtool psql "$DB_URL" -XAtq -v ON_ERROR_STOP=1 "$@"; }

echo "restore drill: ${dump#"$PWD/"} -> $target"
# The target must be a migrated project with Vault keys (the dump holds data for that schema).
[[ "$(tq -c "select to_regclass('public.kitchens') is not null and to_regclass('cron.job') is not null")" == "t" ]] ||
  { echo "refusing: $target has no migrated schema (run scripts/deploy.sh against it first)" >&2; exit 2; }
[[ "$(tq -c "select count(*) from vault.decrypted_secrets where name in ('phone_encryption_key', 'phone_hash_key')")" == "2" ]] ||
  { echo "refusing: $target needs the Vault secrets phone_encryption_key and phone_hash_key (the source's values)" >&2; exit 2; }

PG_TMP=$(mktemp -d)
export PG_TMP
# Jobs that only touch this database (locks, nightly orders, purges): safe to run on a copy. Any other
# tiffin-* job (outbox, nudges, summaries, growth, late delivery, weather, ad conversions, push, ...)
# stays paused after the drill unless RESUME_JOBS=yes.
RESUME_SAFE_JOBS="tiffin-lock-due-slots tiffin-nightly tiffin-churn tiffin-purge tiffin-storage-retention"
paused=$(tq -c "select coalesce(string_agg(jobid || ':' || jobname, ' '), '') from cron.job where jobname like 'tiffin-%' and active")
resume() {
  local item id name kept=""
  for item in $paused; do
    id=${item%%:*} name=${item#*:}
    if [[ "${RESUME_JOBS:-}" == "yes" || " $RESUME_SAFE_JOBS " == *" $name "* ]]; then
      tq -c "select cron.alter_job($id, active := true)" >/dev/null || echo "WARNING: could not resume cron job $name" >&2
    else
      kept="$kept $name"
    fi
  done
  [[ -n "$kept" ]] && echo "left PAUSED on the target (they would contact real people from this copy):$kept" \
    && echo "  switch one on only after its credentials point at test numbers: select cron.alter_job(jobid, active := true) from cron.job where jobname = '<job>';"
  rm -rf "$PG_TMP"
}
trap resume EXIT
for item in $paused; do tq -c "select cron.alter_job(${item%%:*}, active := false)" >/dev/null; done
echo "paused $(wc -w <<<"$paused") tiffin-* cron jobs on the target"

# One transaction: wipe the target's data and load the dump's, with triggers off (the ledgers'
# append-only and no-truncate guards would refuse, and rows arrive in any order). If anything fails,
# the target is left as it was. GoTrue's own migration list stays the target's. Outbox messages the
# source had not sent yet are cancelled in the same transaction, so the copy never sends them again.
cat > "$PG_TMP/wipe.sql" <<'SQL'
set session_replication_role = replica;
do $$
declare
  v text;
begin
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ') into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and (n.nspname in ('public', 'private') or (n.nspname = 'auth' and c.relname <> 'schema_migrations'));
  if v is not null then
    execute 'truncate ' || v || ' cascade';
  end if;
end $$;
SQL
pgtool pg_restore -l "$dump" | grep -v 'TABLE DATA auth schema_migrations' > "$PG_TMP/restore.list"
{ cat "$PG_TMP/wipe.sql"; pgtool pg_restore --data-only --no-owner --no-privileges -L "$PG_TMP/restore.list" -f - "$dump"
  echo "update public.notifications_outbox set status = 'cancelled', last_error = 'restore drill: copied from the source, not sent'"
  echo "  where status in ('pending', 'sending');"; } |
  tq --single-transaction >/dev/null
echo "  copied outbox messages not yet sent: cancelled ($(tq -c "select count(*) from public.notifications_outbox where last_error = 'restore drill: copied from the source, not sent'"))"

source_checks=$(cat "$dump.checks")
target_checks=$(tq < scripts/lib/drill-checks.sql)
failed=0
if diff <(echo "$source_checks") <(echo "$target_checks") >/dev/null; then
  echo "  rows and ledger totals match ($(grep -c '^rows ' <<<"$source_checks") tables)"
else
  echo "  rows or ledger totals differ (source < > restored):"
  diff <(echo "$source_checks") <(echo "$target_checks") || true
  failed=1
fi

expected_jobs="tiffin-lock-due-slots tiffin-nightly tiffin-owner-summary tiffin-purge tiffin-storage-retention tiffin-outbox"
missing=$(tq -c "select coalesce(string_agg(j, ' '), '') from unnest(string_to_array('$expected_jobs', ' ')) j
                 where not exists (select 1 from cron.job where jobname = j)")
if [[ -z "$missing" ]]; then
  echo "  cron: $(tq -c "select count(*) from cron.job where jobname like 'tiffin-%'") tiffin-* jobs scheduled"
else
  echo "  cron: missing jobs: $missing"
  failed=1
fi

if phones=$(tq -c "select count(*) || ' ' || count(*) filter (where private.phone_hash(private.decrypt_phone(phone_enc)) = phone_hash)
                   from (select phone_enc, phone_hash from public.customers where phone_enc is not null order by id limit 200) s" 2>/dev/null); then
  read -r sample ok <<<"$phones"
  if [[ "$sample" == "$ok" ]]; then
    echo "  phones: $ok of $sample sampled customers decrypt and match their hash (Vault keys are the source's)"
  else
    echo "  phones: only $ok of $sample decrypt to their stored hash: the target's phone_hash_key is not the source's"
    failed=1
  fi
else
  echo "  phones: decrypt_phone failed: the target's phone_encryption_key is not the source's"
  failed=1
fi

if (( failed )); then
  echo "RESTORE DRILL FAILED ($target)"
  exit 1
fi
echo "RESTORE DRILL PASSED: ${dump#"$PWD/"} restored into $target"
