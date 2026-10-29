#!/usr/bin/env bash
# Logical backup of the app data (schemas public, private, auth) in pg_dump custom format.
#
#   scripts/backup.sh                      # local stack (Docker container supabase_db_tiffin)
#   DB_URL=postgres://... scripts/backup.sh  # any database you can reach (e.g. a hosted project's direct connection)
#
# Writes backups/tiffin-<UTC timestamp>.dump. Encryption keys are NOT in the dump: Vault secrets
# (phone_encryption_key, phone_hash_key) must be kept in a password manager (see CLAUDE.md > Secrets).
# Hosted projects also have Supabase's own daily backups / PITR; this is the portable copy.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
out="backups/tiffin-$(date -u +%Y%m%dT%H%M%SZ).dump"
args=(-Fc --no-comments -n public -n private -n auth)
if [[ -n "${DB_URL:-}" ]]; then
  pg_dump "${args[@]}" -d "$DB_URL" -f "$out"
else
  docker exec supabase_db_tiffin pg_dump -U supabase_admin -d postgres "${args[@]}" > "$out"
fi
echo "backup written: $out ($(du -h "$out" | cut -f1))"
