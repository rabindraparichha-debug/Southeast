# Shared helpers for scripts/backup.sh, scripts/restore-drill.sh and scripts/deploy.sh (sourced, not run).
#
# Postgres client tools must be at least the server's major version (hosted Supabase is Postgres 17).
# If yours are older, set PG_TOOLS_IMAGE to a Postgres 17 image and the tools run in Docker with host
# networking, e.g. PG_TOOLS_IMAGE=postgres:17 (or the local stack's supabase/postgres image).

# pgtool <psql|pg_dump|pg_restore> args... : the host binary, or the same tool inside PG_TOOLS_IMAGE.
# Paths passed as arguments must be absolute (the repo's backups/ and $TMPDIR are mounted at the same path).
pgtool() {
  local tool="$1"; shift
  if [[ -n "${PG_TOOLS_IMAGE:-}" ]]; then
    local mounts=(-v "$PWD/backups:$PWD/backups")
    [[ -n "${PG_TMP:-}" ]] && mounts+=(-v "$PG_TMP:$PG_TMP")
    local envs=()
    for v in PGOPTIONS PGPASSWORD PGSSLMODE; do [[ -n "${!v:-}" ]] && envs+=(-e "$v"); done
    docker run --rm -i --network host "${mounts[@]}" "${envs[@]}" --entrypoint "$tool" "$PG_TOOLS_IMAGE" "$@"
  else
    command -v "$tool" >/dev/null || { echo "error: $tool not found (install Postgres 17 client tools or set PG_TOOLS_IMAGE)" >&2; return 127; }
    "$tool" "$@"
  fi
}

# Major version of a client tool ("17").
pgtool_major() {
  pgtool "$1" --version | sed -E 's/[^0-9]*([0-9]+).*/\1/' | head -1
}

# Refuses when the client tool is older than the server behind $1 (a connection URL).
pg_check_versions() {
  local url="$1" tool="${2:-pg_dump}" server client
  server=$(pgtool psql "$url" -XAtqc "show server_version_num" | cut -c1-2)
  client=$(pgtool_major "$tool")
  if [[ -z "$server" || -z "$client" ]]; then
    echo "error: could not read Postgres versions (is the connection string right?)" >&2
    return 1
  fi
  if (( client < server )); then
    echo "error: $tool $client is older than the server ($server). Install Postgres $server client tools or set PG_TOOLS_IMAGE=postgres:$server" >&2
    return 1
  fi
}

# "host:port/db" of a connection URL, for confirmations and refusals (never prints the password).
pg_url_target() {
  node -e 'const u = new URL(process.argv[1]); console.log(`${u.hostname}:${u.port || 5432}${u.pathname}`)' "$1"
}
