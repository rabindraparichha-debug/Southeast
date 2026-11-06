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
  pgtool pg_dump "${args[@]}" -d "$DB_URL" > "$out"
  pgtool psql "$DB_URL" -XAtq -v ON_ERROR_STOP=1 < scripts/lib/drill-checks.sql > "$out.checks"
else
  docker exec "$C" pg_dump -U supabase_admin -d postgres "${args[@]}" > "$out"
  docker exec -i "$C" psql -U supabase_admin -d postgres -XAtq -v ON_ERROR_STOP=1 < scripts/lib/drill-checks.sql > "$out.checks"
fi
echo "backup written: ${out#"$PWD/"} ($(du -h "$out" | cut -f1)), checks: ${out#"$PWD/"}.checks"
