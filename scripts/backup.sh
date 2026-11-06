#!/usr/bin/env bash
# Logical backup of the app data (schemas public, private, auth) in pg_dump custom format.
#
#   scripts/backup.sh                        # local stack (Docker container $DB_CONTAINER, default supabase_db_tiffin)
#   DB_URL=postgres://... scripts/backup.sh  # any database you can reach (e.g. a hosted project's direct connection)
#
# Writes backups/tiffin-<UTC timestamp>.dump and, next to it, <dump>.checks (row counts and ledger
# totals, compared by scripts/restore-drill.sh). Encryption keys are NOT in the dump: Vault secrets
# (phone_encryption_key, phone_hash_key) must be kept in a password manager (see CLAUDE.md > Secrets).
# Storage files (photos) are not in it either (docs/OPERATIONS.md > Backups).
# Hosted projects also have Supabase's own daily backups / PITR; this is the portable copy.
# The .checks are taken in the dump's own snapshot (pg_export_snapshot + pg_dump --snapshot), so a
# source that keeps writing during the dump (production in service hours) still matches its checks.
# Client tools older than the server? Set PG_TOOLS_IMAGE (scripts/lib/pg.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/pg.sh
mkdir -p backups
out="$PWD/backups/tiffin-$(date -u +%Y%m%dT%H%M%SZ).dump"
args=(-Fc --no-comments -n public -n private -n auth)
C="${DB_CONTAINER:-supabase_db_tiffin}"
if [[ -n "${DB_URL:-}" ]]; then
  pg_check_versions "$DB_URL" pg_dump
  q() { pgtool psql "$DB_URL" -XAtq -v ON_ERROR_STOP=1; }
  dumpc() { pgtool pg_dump "$@" -d "$DB_URL"; }
else
  q() { docker exec -i "$C" psql -U supabase_admin -d postgres -XAtq -v ON_ERROR_STOP=1; }
  dumpc() { docker exec "$C" pg_dump -U supabase_admin -d postgres "$@"; }
fi

# A session that holds a repeatable-read snapshot open until both the dump and the checks have used it
# (named pipes rather than coproc, so this also runs on macOS's bash 3.2).
snapdir=$(mktemp -d)
mkfifo "$snapdir/in" "$snapdir/out"
q < "$snapdir/in" > "$snapdir/out" &
qpid=$!
exec 3>"$snapdir/in" 4<"$snapdir/out"
finish() {
  { echo 'commit;' >&3; } 2>/dev/null || true
  exec 3>&- 2>/dev/null || true
  wait "$qpid" 2>/dev/null || true
  exec 4<&- 2>/dev/null || true
  rm -rf "$snapdir"
}
trap finish EXIT
echo "begin isolation level repeatable read read only; select pg_export_snapshot();" >&3
snap=""
read -r -t 60 snap <&4 || true
[[ "$snap" =~ ^[0-9A-F-]+$ ]] || { echo "error: could not export a snapshot from the source" >&2; exit 1; }

dumpc "${args[@]}" --snapshot="$snap" > "$out"
{ echo "begin isolation level repeatable read read only; set transaction snapshot '$snap';"
  cat scripts/lib/drill-checks.sql
  echo "commit;"; } | q > "$out.checks"
finish
trap - EXIT
echo "backup written: ${out#"$PWD/"} ($(du -h "$out" | cut -f1)), checks: ${out#"$PWD/"}.checks"
