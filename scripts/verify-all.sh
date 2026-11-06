#!/usr/bin/env bash
# One command that verifies a branch end to end, in any checkout or git worktree:
#   node version, pnpm install, local Supabase stack, db reset, pgTAP, generated types up to date,
#   db reset again, integration tests, the 5,000-subscription lock load test, typecheck, lint,
#   core unit tests, the web build and the Android JS export.
# Prints a PASS/FAIL table with timings and exits non-zero if any step fails.
#
# Usage:
#   scripts/verify-all.sh [--skip-mobile-export] [--skip-build] [--keep-stack]
#   PROJECT_ID=tiffinmv PORT_BASE=6132 INSPECTOR_PORT=8783 scripts/verify-all.sh
#
# Options:
#   --skip-mobile-export  skip `expo export --platform android`
#   --skip-build          skip the web production build (`next build`)
#   --keep-stack          leave the Supabase stack running at the end (default: stop it)
#
# Environment:
#   PROJECT_ID      Supabase project id, also the Docker container suffix (default tiffin). Any other
#                   value runs an isolated stack: for the duration of the run, supabase/config.toml
#                   (project_id, ports), supabase/seed.sql (the kong host in functions_base_url) and
#                   supabase/functions/.env (PUBLIC_FUNCTIONS_URL) are edited, then restored on exit,
#                   so the edits are never committed.
#   PORT_BASE       Required when PROJECT_ID is not tiffin. 6132 gives shadow 61320, api 61321,
#                   db 61322, studio 61323, smtp 61324, analytics 61327, pooler 61329.
#   INSPECTOR_PORT  Edge runtime inspector port for an isolated stack (optional).
#   LOG_DIR         Directory for the step logs (default: a new temporary directory).
#   VERBOSE=1       Stream every step's output, not only the summaries.
#
# Safety: never runs `supabase stop --all` and never prunes Docker. It only ever stops its own
# project (`supabase stop --project-id $PROJECT_ID`), and refuses to touch a stack with the same
# project id that was started from a different checkout.
set -euo pipefail

usage() { sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

SKIP_MOBILE=0
SKIP_BUILD=0
KEEP_STACK=0
for arg in "$@"; do
  case $arg in
    --skip-mobile-export) SKIP_MOBILE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --keep-stack) KEEP_STACK=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "verify-all: unknown option '$arg'" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$ROOT"

PROJECT_ID=${PROJECT_ID:-tiffin}
PORT_BASE=${PORT_BASE:-}
INSPECTOR_PORT=${INSPECTOR_PORT:-}
VERBOSE=${VERBOSE:-0}
ISOLATED=0
[[ $PROJECT_ID != tiffin ]] && ISOLATED=1

die() { echo "verify-all: $*" >&2; exit 2; }

[[ $PROJECT_ID =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || die "PROJECT_ID must be letters, digits, '_' or '-' (got '$PROJECT_ID')"
if (( ISOLATED )); then
  [[ -n $PORT_BASE ]] || die "PORT_BASE is required when PROJECT_ID is not tiffin (e.g. PORT_BASE=6132 for ports 61320-61329)"
  [[ $PORT_BASE =~ ^[0-9]+$ ]] && (( PORT_BASE >= 103 && PORT_BASE <= 6552 )) || die "PORT_BASE must be a number from 103 to 6552 (got '$PORT_BASE')"
  if [[ -n $INSPECTOR_PORT ]]; then
    [[ $INSPECTOR_PORT =~ ^[0-9]+$ ]] && (( INSPECTOR_PORT >= 1024 && INSPECTOR_PORT <= 65535 )) || die "INSPECTOR_PORT must be a port number (got '$INSPECTOR_PORT')"
  fi
else
  [[ -z $PORT_BASE && -z $INSPECTOR_PORT ]] || echo "verify-all: PORT_BASE/INSPECTOR_PORT are ignored for PROJECT_ID=tiffin (the ports in supabase/config.toml are used)" >&2
fi
if [[ -n ${SUPABASE_PROJECT_ID:-} && ${SUPABASE_PROJECT_ID} != "$PROJECT_ID" ]]; then
  die "SUPABASE_PROJECT_ID=$SUPABASE_PROJECT_ID is set in the environment and would override supabase/config.toml; unset it or use PROJECT_ID=$SUPABASE_PROJECT_ID"
fi

# Per-checkout state (backups, lock) lives in this worktree's git dir: never committed, never shared.
GIT_DIR=$(git rev-parse --absolute-git-dir 2>/dev/null || true)
STATE=${GIT_DIR:+$GIT_DIR/verify-all}
STATE=${STATE:-$ROOT/supabase/.temp/verify-all}
mkdir -p "$STATE"

if [[ -n ${LOG_DIR:-} ]]; then
  mkdir -p "$LOG_DIR"
  LOG_DIR=$(cd "$LOG_DIR" && pwd -P)
else
  LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/verify-all-${PROJECT_ID}-XXXXXX")
fi

export NEXT_TELEMETRY_DISABLED=1 EXPO_NO_TELEMETRY=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1

SB=(pnpm exec supabase)
DB_CONTAINER="supabase_db_${PROJECT_ID}"

# ---------------------------------------------------------------------------------------------
# Lock (one run per checkout) and recovery from an interrupted run
# ---------------------------------------------------------------------------------------------
LOCK_HELD=0
acquire_lock() {
  if ! mkdir "$STATE/lock" 2>/dev/null; then
    local pid
    pid=$(cat "$STATE/lock/pid" 2>/dev/null || true)
    if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
      die "another verify-all run (pid $pid) is active in this checkout"
    fi
    rm -rf "$STATE/lock"
    mkdir "$STATE/lock"
  fi
  echo $$ >"$STATE/lock/pid"
  LOCK_HELD=1
}
release_lock() { if (( LOCK_HELD )); then rm -rf "$STATE/lock"; LOCK_HELD=0; fi; }

# A run killed with SIGKILL cannot restore its edits. The next run restores them, but only when the
# file still holds exactly what that run wrote; anything else is left for a human to sort out.
recover_interrupted_run() {
  [[ -d $STATE/edited ]] || return 0
  local f p conflict=0
  while IFS= read -r -d '' f; do
    p=${f#"$STATE/edited/"}
    if [[ -e $p ]] && cmp -s "$f" "$p"; then
      if [[ -e $STATE/orig/$p ]]; then cp -p "$STATE/orig/$p" "$p"; else rm -f "$p"; fi
      echo "verify-all: restored $p left edited by an interrupted run"
    elif [[ -e $p || -e $STATE/orig/$p ]]; then
      echo "verify-all: $p changed since an interrupted run edited it; the original is in $STATE/orig/$p" >&2
      conflict=1
    fi
  done < <(find "$STATE/edited" -type f -print0)
  if (( conflict )); then
    echo "verify-all: restore or keep those files by hand, then delete $STATE/orig and $STATE/edited" >&2
    exit 2
  fi
  rm -rf "$STATE/orig" "$STATE/edited"
}

# ---------------------------------------------------------------------------------------------
# Reversible edits (stack isolation)
# ---------------------------------------------------------------------------------------------
TOUCHED=()
begin_edit() { # path: back up the original (or remember that it did not exist)
  local p=$1
  mkdir -p "$STATE/orig/$(dirname "$p")" "$STATE/edited/$(dirname "$p")"
  if [[ -e $p ]]; then cp -p "$p" "$STATE/orig/$p"; fi
  TOUCHED+=("$p")
}
end_edit() { cp -p "$1" "$STATE/edited/$1"; }

restore_files() {
  local p
  for p in ${TOUCHED[@]+"${TOUCHED[@]}"}; do
    if [[ -e $STATE/orig/$p ]]; then
      cp -p "$STATE/orig/$p" "$p"
      cmp -s "$STATE/orig/$p" "$p" || { echo "verify-all: FAILED to restore $p (original in $STATE/orig/$p)" >&2; return 1; }
    else
      rm -f "$p"
    fi
    echo "verify-all: restored $p"
  done
  TOUCHED=()
  rm -rf "$STATE/orig" "$STATE/edited"
}

port() { echo $((PORT_BASE * 10 + $1)); }

isolate_stack() {
  local tmp="$STATE/config.toml.tmp"
  begin_edit supabase/config.toml
  awk -v id="$PROJECT_ID" -v api="$(port 1)" -v db="$(port 2)" -v shadow="$(port 0)" \
      -v studio="$(port 3)" -v smtp="$(port 4)" -v analytics="$(port 7)" -v pooler="$(port 9)" \
      -v inspector="$INSPECTOR_PORT" '
    /^[[:space:]]*\[/ { s = $0; sub(/^[[:space:]]*\[/, "", s); sub(/\].*$/, "", s); sect = s }
    sect == "" && /^project_id[[:space:]]*=/ { print "project_id = \"" id "\""; n["project_id"]++; next }
    sect == "api" && /^port[[:space:]]*=/ { print "port = " api; n["api"]++; next }
    sect == "db" && /^port[[:space:]]*=/ { print "port = " db; n["db"]++; next }
    sect == "db" && /^shadow_port[[:space:]]*=/ { print "shadow_port = " shadow; n["shadow"]++; next }
    sect == "db.pooler" && /^port[[:space:]]*=/ { print "port = " pooler; next }
    sect == "studio" && /^port[[:space:]]*=/ { print "port = " studio; next }
    (sect == "local_smtp" || sect == "inbucket") && /^port[[:space:]]*=/ { print "port = " smtp; next }
    sect == "analytics" && /^port[[:space:]]*=/ { print "port = " analytics; next }
    sect == "edge_runtime" && inspector != "" && /^inspector_port[[:space:]]*=/ { print "inspector_port = " inspector; next }
    { print }
    END { if (n["project_id"] != 1 || n["api"] != 1 || n["db"] != 1 || n["shadow"] != 1) exit 3 }
  ' supabase/config.toml >"$tmp" || { rm -f "$tmp"; echo "verify-all: could not find project_id/[api] port/[db] port/shadow_port in supabase/config.toml" >&2; return 1; }
  cat "$tmp" >supabase/config.toml
  rm -f "$tmp"
  end_edit supabase/config.toml

  if grep -qE 'supabase_kong_[A-Za-z0-9_-]+:8000' supabase/seed.sql; then
    begin_edit supabase/seed.sql
    sed -E "s#supabase_kong_[A-Za-z0-9_-]+:8000#supabase_kong_${PROJECT_ID}:8000#g" supabase/seed.sql >"$STATE/seed.sql.tmp"
    cat "$STATE/seed.sql.tmp" >supabase/seed.sql
    rm -f "$STATE/seed.sql.tmp"
    end_edit supabase/seed.sql
  else
    echo "verify-all: warning: no supabase_kong_<id>:8000 host in supabase/seed.sql; functions_base_url left as is" >&2
  fi
  echo "verify-all: isolated stack $PROJECT_ID (api $(port 1), db $(port 2), shadow $(port 0), pooler $(port 9)${INSPECTOR_PORT:+, inspector $INSPECTOR_PORT})"
}

# Edge Functions read supabase/functions/.env at `supabase start` (as CI does: mock modes, local
# placeholder secrets). Create it from .env.example when missing; on an isolated stack, point
# PUBLIC_FUNCTIONS_URL (mock payment links) at this stack's API port. Restored on exit.
prepare_functions_env() {
  local f=supabase/functions/.env src
  if [[ -e $f ]]; then
    (( ISOLATED )) || return 0
    src=$f
  else
    src=supabase/functions/.env.example
    [[ -e $src ]] || return 0
  fi
  begin_edit "$f"
  if (( ISOLATED )); then
    sed -E "s#^PUBLIC_FUNCTIONS_URL=.*#PUBLIC_FUNCTIONS_URL=http://127.0.0.1:$(port 1)/functions/v1#" "$src" >"$STATE/functions.env.tmp"
  else
    cp "$src" "$STATE/functions.env.tmp"
  fi
  cat "$STATE/functions.env.tmp" >"$f"
  rm -f "$STATE/functions.env.tmp"
  end_edit "$f"
  echo "verify-all: prepared $f for this run"
}

# ---------------------------------------------------------------------------------------------
# Stack lifecycle
# ---------------------------------------------------------------------------------------------
STOP_ON_EXIT=0
STACK_REUSED=0
CLEANED=0
RESTORE_FAILED=0
API_URL=''
ANON_KEY=''
SERVICE_ROLE_KEY=''

cleanup() {
  (( CLEANED )) && return 0
  CLEANED=1
  if (( STOP_ON_EXIT )); then
    if (( KEEP_STACK )); then
      echo "verify-all: stack $PROJECT_ID left running (--keep-stack). API ${API_URL:-?}. Stop it with: pnpm exec supabase stop --project-id $PROJECT_ID"
    else
      local args=(--project-id "$PROJECT_ID")
      (( ISOLATED )) && args+=(--no-backup)
      echo "verify-all: stopping Supabase project $PROJECT_ID"
      "${SB[@]}" stop "${args[@]}" >>"$LOG_DIR/stop.log" 2>&1 || echo "verify-all: warning: 'supabase stop ${args[*]}' failed (see $LOG_DIR/stop.log)" >&2
    fi
  fi
  restore_files || RESTORE_FAILED=1
  release_lock
}
STEP_PID=''
kill_tree() { # TERM a process and all its descendants, children first
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}
on_exit() {
  local rc=$?
  if [[ -n $STEP_PID ]] && kill -0 "$STEP_PID" 2>/dev/null; then
    echo "verify-all: interrupted; stopping the running step"
    kill_tree "$STEP_PID"
    wait "$STEP_PID" 2>/dev/null || true
  fi
  cleanup
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A running stack with this project id must come from this checkout; never take over another one.
check_stack_owner() {
  local wd
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER" || return 0
  wd=$(docker inspect -f '{{index .Config.Labels "com.supabase.cli.workdir"}}' "$DB_CONTAINER" 2>/dev/null || true)
  if [[ -n $wd && $wd != "<no value>" ]]; then
    wd=$(cd "$wd" 2>/dev/null && pwd -P || echo "$wd")
    if [[ $wd != "$ROOT" ]]; then
      echo "verify-all: Supabase project '$PROJECT_ID' is already running from $wd." >&2
      echo "verify-all: pick another PROJECT_ID and PORT_BASE for this checkout (it is not touched)." >&2
      return 1
    fi
  fi
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
    STACK_REUSED=1
    echo "verify-all: reusing the running stack for project $PROJECT_ID"
  fi
}

# A running stack of this project must use the ports this run expects (it may have been started
# from this checkout with other settings).
check_stack_ports() {
  local expected running
  expected=$(config_api_port)
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "supabase_kong_${PROJECT_ID}" || return 0
  running=$(docker port "supabase_kong_${PROJECT_ID}" 8000/tcp 2>/dev/null | head -n1 | sed -E 's/.*:([0-9]+)$/\1/')
  if [[ -n $running && $running != "$expected" ]]; then
    echo "verify-all: project $PROJECT_ID is running on API port $running, but this run expects $expected." >&2
    echo "verify-all: stop it first (pnpm exec supabase stop --project-id $PROJECT_ID) or use its PORT_BASE." >&2
    return 1
  fi
}

config_api_port() {
  awk '/^[[:space:]]*\[/ { s = $0; sub(/^[[:space:]]*\[/, "", s); sub(/\].*$/, "", s); sect = s }
       sect == "api" && /^port[[:space:]]*=/ { gsub(/[^0-9]/, "", $0); print; exit }' supabase/config.toml
}

compute_excludes() {
  local help avail w out=()
  help=$("${SB[@]}" start --help 2>&1 || true)
  avail=$(grep -E -- '--exclude' <<<"$help" | grep -oE '\[[a-z0-9_,-]+\]' | tr -d '[]' | tr ',' ' ' || true)
  if [[ -z $avail ]]; then echo "studio,imgproxy,mailpit,logflare,vector,supavisor"; return; fi
  for w in studio imgproxy mailpit inbucket logflare vector supavisor; do
    [[ " $avail " == *" $w "* ]] && out+=("$w")
  done
  local IFS=,
  echo "${out[*]}"
}

read_stack_env() {
  local json
  json=$("${SB[@]}" status -o json 2>/dev/null) || return 1
  printf '%s' "$json" >"$LOG_DIR/status.json"
  local vals
  vals=$(node -e '
    const s = require("fs").readFileSync(process.argv[1], "utf8");
    const j = JSON.parse(s.slice(s.indexOf("{")));
    const anon = j.ANON_KEY || j.PUBLISHABLE_KEY || "";
    process.stdout.write([j.API_URL || "", anon, j.SERVICE_ROLE_KEY || j.SECRET_KEY || ""].join("\n"));
  ' "$LOG_DIR/status.json") || return 1
  { read -r API_URL; read -r ANON_KEY; read -r SERVICE_ROLE_KEY; } <<<"$vals" || true
  [[ -n $API_URL && -n $ANON_KEY ]]
}

wait_for_api() { # gotrue and postgrest answer after a start or reset
  local i
  for i in $(seq 1 90); do
    if curl -fsS -o /dev/null -H "apikey: $ANON_KEY" "$API_URL/auth/v1/health" 2>/dev/null &&
       curl -fsS -o /dev/null -H "apikey: $ANON_KEY" "$API_URL/rest/v1/" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "API at $API_URL did not become healthy" >&2
  return 1
}

# ---------------------------------------------------------------------------------------------
# Steps (each runs in a subshell with `set -euo pipefail`; output goes to its log)
# ---------------------------------------------------------------------------------------------
step_node() {
  local v maj min
  v=$(node -p 'process.versions.node')
  IFS=. read -r maj min _ <<<"$v"
  echo "node $v (required >= 22.13, see .nvmrc)"
  (( maj > 22 || (maj == 22 && min >= 13) ))
  echo "pnpm $(pnpm --version) (package.json pins $(node -p 'require("./package.json").packageManager'))"
}

step_install() { pnpm install --frozen-lockfile; }

step_stack() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not reachable (in a cloud sandbox, start it with: dockerd &)"
    return 1
  fi
  local excludes
  excludes=$(compute_excludes)
  echo "supabase start -x $excludes"
  "${SB[@]}" start -x "$excludes"
}

step_db_reset() {
  "${SB[@]}" db reset
  wait_for_api
}

step_pgtap() { "${SB[@]}" test db; }

step_types() {
  local gen="$LOG_DIR/types.generated.ts" fmt="$LOG_DIR/types.formatted.ts" target=packages/db/src/types.ts
  # Same as `pnpm db:types`: gen types, then prettier with the repo config for that path.
  "${SB[@]}" gen types typescript --local --schema public >"$gen"
  pnpm exec prettier --stdin-filepath "$target" <"$gen" >"$fmt"
  if cmp -s "$fmt" "$target"; then
    echo "packages/db/src/types.ts is up to date"
    return 0
  fi
  cp -p "$target" "$LOG_DIR/types.before.ts"
  echo "packages/db/src/types.ts is OUT OF DATE (regenerated from the migrations):"
  echo " $target | $(git diff --no-index --numstat -- "$LOG_DIR/types.before.ts" "$fmt" | awk '{ print "+" $1 " -" $2 }')"
  git diff --no-index --shortstat -- "$LOG_DIR/types.before.ts" "$fmt" || true
  cat "$fmt" >"$target"
  echo "The regenerated file is now in your working tree (previous copy: $LOG_DIR/types.before.ts)."
  echo "Review it with 'git diff $target' and commit it."
  return 1
}

step_integration() {
  SUPABASE_URL=$API_URL SUPABASE_ANON_KEY=$ANON_KEY SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY pnpm test:integration
}

step_loadtest() {
  local out rc=0 first second
  out=$(docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <supabase/perf/lock_load.sql 2>&1) || rc=$?
  printf '%s\n' "$out"
  (( rc == 0 )) || return "$rc"
  first=$(grep -oE 'LOAD TEST PASSED: 5,000-subscription lock in [0-9.]+ s' <<<"$out" | grep -oE '[0-9.]+ s$' | tr -d ' s' || true)
  second=$(grep -oE 'second day \(routes already saved\): 5,000-subscription lock in [0-9.]+ s' <<<"$out" | grep -oE '[0-9.]+ s$' | tr -d ' s' || true)
  if [[ -z $first ]]; then
    echo "verify-all: could not read the first lock time from the load test output"
    return 1
  fi
  echo "verify-all: first lock ${first} s, second day ${second:-?} s (limit 60 s)"
  awk -v t="$first" 'BEGIN { exit !(t + 0 <= 60) }'
}

# TURBO_FORCE: never replay a cached result (turbo.json declares no global inputs such as
# tsconfig.base.json, so a cache hit could hide a break).
step_typecheck() { TURBO_FORCE=true pnpm typecheck; }
step_lint() { TURBO_FORCE=true pnpm lint; }
step_core() { pnpm --filter @tiffin/core test; }

step_web_build() {
  NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY pnpm --filter @tiffin/web build
}

step_mobile_export() {
  local out
  out=$(mktemp -d "$LOG_DIR/expo-export-XXXXXX")
  local env_args=(EXPO_OFFLINE=1 CI=1)
  [[ -n $API_URL ]] && env_args+=("EXPO_PUBLIC_SUPABASE_URL=$API_URL" "EXPO_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY")
  local rc=0
  (cd apps/mobile && env "${env_args[@]}" npx expo export --platform android --output-dir "$out") || rc=$?
  if (( rc == 0 )); then echo "verify-all: export size $(du -sh "$out" | cut -f1)"; fi
  rm -rf "$out"
  return "$rc"
}

# ---------------------------------------------------------------------------------------------
# Summaries printed under each step
# ---------------------------------------------------------------------------------------------
strip_ansi() { sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$1"; }

pgtap_results() { # "<file> <status>" for each test file pg_prove reported, in order
  strip_ansi "$1" | awk '
    match($0, /[A-Za-z0-9_.-]+\.sql \.+/) {
      f = substr($0, RSTART, RLENGTH); sub(/ \.+$/, "", f)
      rest = substr($0, RSTART + RLENGTH); sub(/^ +/, "", rest); sub(/ +$/, "", rest)
      if (!(f in st)) { order[++n] = f; st[f] = "" }
      if (rest != "") st[f] = rest
      pending = (st[f] == "") ? f : ""
      next
    }
    # A test that prints diag() lines gets its result on a later line of its own ("ok", "Failed …").
    pending != "" && /^(ok|Failed|Dubious|skipped)/ { st[pending] = $0; pending = "" }
    END { for (i = 1; i <= n; i++) print order[i] " " (st[order[i]] == "" ? "no result" : st[order[i]]) }'
}

summary_pgtap() {
  local log=$1 results reported name status f
  results=$(pgtap_results "$log")
  reported=$(cut -d' ' -f1 <<<"$results")
  while read -r name status; do
    [[ -n $name ]] || continue
    if [[ $status == ok* ]]; then echo "    ok      $name"; else echo "    FAIL    $name  ($status)"; fi
  done <<<"$results"
  # Test files with no result line at all (pg_prove stopped before reaching them).
  for f in supabase/tests/*.sql; do
    [[ -e $f ]] || continue
    grep -qxF "$(basename "$f")" <<<"$reported" || echo "    MISSING $(basename "$f") (no result in the output)"
  done
  grep -E '^Files=[0-9]+, Tests=[0-9]+|^Result: ' "$log" | sed -E 's/,  *[0-9.]+ wallclock.*$//; s/^/    /' || true
  grep -E '^# Failed test' "$log" | head -n 25 | sed 's/^/    /' || true
}

note_pgtap() {
  local log=$1 failed total tests
  total=$({ pgtap_results "$log" | cut -d' ' -f1; for f in supabase/tests/*.sql; do [[ -e $f ]] && basename "$f"; done; } | sort -u | grep -c . || true)
  failed=$(summary_pgtap "$log" | grep -cE '^    (FAIL|MISSING)' || true)
  tests=$(grep -oE '^Files=[0-9]+, Tests=[0-9]+' "$log" | grep -oE 'Tests=[0-9]+' | head -n1 || true)
  if (( failed )); then echo "$failed of $total files failed${tests:+ ($tests)}"; else echo "$total files ok${tests:+ ($tests)}"; fi
}

summary_integration() {
  strip_ansi "$1" | grep -E '^[[:space:]]*(Test Files|Tests|Duration)[[:space:]]' | sed -E 's/^[[:space:]]*/    /' || true
  strip_ansi "$1" | grep -E '^[[:space:]]*(FAIL|×|✗) ' | sort -u | head -n 25 | sed -E 's/^[[:space:]]*/    /' || true
}
note_integration() {
  strip_ansi "$1" | grep -E '^[[:space:]]*Tests[[:space:]]' | tail -n1 | sed -E 's/^[[:space:]]*Tests[[:space:]]+//; s/[[:space:]]+$//' || true
}
summary_core() { summary_integration "$1"; }
note_core() { note_integration "$1"; }

summary_types() { grep -E 'up to date|OUT OF DATE|\||files? changed|working tree|Review it' "$1" | sed 's/^/    /' || true; }
note_types() { if grep -q 'up to date' "$1"; then echo "up to date"; elif grep -q 'OUT OF DATE' "$1"; then grep -E 'files? changed' "$1" | tail -n1 | sed -E 's/^[[:space:]]*//'; fi; }

summary_loadtest() { grep -E '^verify-all: (first lock|could not)|LOAD TEST FAILED' "$1" | sed -E 's/^(verify-all: )?/    /' || true; }
note_loadtest() { grep -oE 'first lock [0-9.]+ s, second day [0-9.?]+ s' "$1" | head -n1 || true; }

summary_typecheck() { strip_ansi "$1" | grep -E '^[[:space:]]*Tasks:|error TS[0-9]+' | head -n 30 | sed -E 's/^[[:space:]]*/    /' || true; }
summary_lint() { strip_ansi "$1" | grep -E '^[[:space:]]*Tasks:|[0-9]+ problems?|✖' | head -n 30 | sed -E 's/^[[:space:]]*/    /' || true; }
note_typecheck() { strip_ansi "$1" | grep -E '^[[:space:]]*Tasks:' | tail -n1 | sed -E 's/^[[:space:]]*Tasks:[[:space:]]*//' || true; }
note_lint() { note_typecheck "$1"; }
note_node() { head -n1 "$1"; }
note_mobile_export() { grep -oE 'export size [^ ]+' "$1" | tail -n1 || true; }
note_web_build() { strip_ansi "$1" | grep -oE 'Compiled successfully( in [0-9.]+m?s)?' | head -n1 || true; }

# ---------------------------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------------------------
STEP_NAMES=()
STEP_RESULTS=()
STEP_TIMES=()
STEP_NOTES=()
declare -A RESULT=()
TOTAL_START=$SECONDS

fmt_time() {
  local s=$1
  if (( s >= 60 )); then printf '%dm%02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi
}

record() { # name result seconds note
  STEP_NAMES+=("$1"); STEP_RESULTS+=("$2"); STEP_TIMES+=("$3"); STEP_NOTES+=("$4")
  RESULT[$1]=$2
}

# run_step NAME REQUIRES FUNCTION   (REQUIRES: comma-separated step names that must have passed, or -)
run_step() {
  local name=$1 req=$2 fn=$3 r
  local idx=$(( ${#STEP_NAMES[@]} + 1 ))
  local log
  log="$LOG_DIR/$(printf '%02d' "$idx")-$name.log"
  if [[ $req != - ]]; then
    for r in ${req//,/ }; do
      if [[ ${RESULT[$r]:-} != PASS ]]; then
        echo "==> $name: SKIP (needs $r)"
        record "$name" SKIP 0 "needs $r"
        return 0
      fi
    done
  fi
  echo "==> $name"
  local t0=$SECONDS rc
  # In the background + wait, so a signal reaches the traps at once (they stop the step's processes,
  # then stop the stack and restore the edited files).
  set +e
  if [[ $VERBOSE == 1 ]]; then
    ( set -euo pipefail; "$fn" ) </dev/null > >(tee "$log") 2>&1 &
  else
    ( set -euo pipefail; "$fn" ) </dev/null >"$log" 2>&1 &
  fi
  STEP_PID=$!
  wait "$STEP_PID"
  rc=$?
  STEP_PID=''
  set -e
  local dt=$(( SECONDS - t0 )) result=PASS note=''
  (( rc == 0 )) || result=FAIL
  if declare -F "note_$name" >/dev/null; then note=$("note_$name" "$log" 2>/dev/null || true); fi
  echo "    $result in $(fmt_time "$dt")${note:+ - $note}"
  if declare -F "summary_$name" >/dev/null; then "summary_$name" "$log" 2>/dev/null || true; fi
  if [[ $result == FAIL ]]; then
    echo "    --- last 40 lines of $log ---"
    strip_ansi "$log" | tail -n 40 | sed 's/^/    | /'
  fi
  record "$name" "$result" "$dt" "$note"
}

skip_step() { echo "==> $1: SKIP ($2)"; record "$1" SKIP 0 "$2"; }

print_table() {
  local i failed=() total=$(( SECONDS - TOTAL_START ))
  echo
  echo "verify-all results ($(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?') @ $(git rev-parse --short HEAD 2>/dev/null || echo '?'), project $PROJECT_ID)"
  printf '%-16s %-6s %8s  %s\n' STEP RESULT TIME NOTES
  printf '%-16s %-6s %8s  %s\n' ---------------- ------ -------- -----
  for i in "${!STEP_NAMES[@]}"; do
    printf '%-16s %-6s %8s  %s\n' "${STEP_NAMES[$i]}" "${STEP_RESULTS[$i]}" "$(fmt_time "${STEP_TIMES[$i]}")" "${STEP_NOTES[$i]}"
    [[ ${STEP_RESULTS[$i]} == FAIL ]] && failed+=("${STEP_NAMES[$i]}")
  done
  printf '%-16s %-6s %8s\n' ---------------- ------ --------
  if (( ${#failed[@]} )); then
    printf '%-16s %-6s %8s  %s\n' TOTAL FAIL "$(fmt_time "$total")" "failed: ${failed[*]}"
  else
    printf '%-16s %-6s %8s\n' TOTAL PASS "$(fmt_time "$total")"
  fi
  echo "Logs: $LOG_DIR"
  (( ${#failed[@]} == 0 ))
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
acquire_lock
recover_interrupted_run
if (( ! ISOLATED )); then
  cfg_id=$(awk -F'"' '/^project_id[[:space:]]*=/ { print $2; exit }' supabase/config.toml)
  if [[ $cfg_id != tiffin ]]; then
    die "supabase/config.toml has project_id = \"$cfg_id\" (local edits?). Run with PROJECT_ID=$cfg_id PORT_BASE=<base>, or restore supabase/config.toml first."
  fi
fi
echo "verify-all: $ROOT (project $PROJECT_ID), logs in $LOG_DIR"

run_step node - step_node
if [[ ${RESULT[node]} == PASS ]]; then
  run_step install node step_install
else
  skip_step install "needs node"
fi

if [[ ${RESULT[install]} == PASS ]]; then
  if ! check_stack_owner; then
    record stack FAIL 0 "project $PROJECT_ID is running from another checkout"
  else
    if (( ISOLATED )); then isolate_stack; fi
    prepare_functions_env
    if ! check_stack_ports; then
      record stack FAIL 0 "project $PROJECT_ID is running on other ports"
    else
      STOP_ON_EXIT=1
      run_step stack - step_stack
      last=$(( ${#STEP_NAMES[@]} - 1 ))
      if [[ ${RESULT[stack]} == PASS ]]; then
        if read_stack_env; then
          STEP_NOTES[last]=$API_URL
          if (( STACK_REUSED )); then STEP_NOTES[last]+=" (reused running stack)"; fi
          echo "    API ${STEP_NOTES[last]}"
        else
          echo "    could not read 'supabase status'; treating the stack as failed"
          RESULT[stack]=FAIL
          STEP_RESULTS[last]=FAIL
          STEP_NOTES[last]="supabase status unreadable"
        fi
      fi
    fi
  fi
else
  skip_step stack "needs install"
fi

run_step db_reset stack step_db_reset
run_step pgtap db_reset step_pgtap
run_step types db_reset step_types
run_step db_reset_2 stack step_db_reset
run_step integration db_reset_2 step_integration
run_step loadtest db_reset_2 step_loadtest
run_step typecheck install step_typecheck
run_step lint install step_lint
run_step core install step_core
if (( SKIP_BUILD )); then skip_step web_build "--skip-build"; else run_step web_build install,stack step_web_build; fi
if (( SKIP_MOBILE )); then skip_step mobile_export "--skip-mobile-export"; else run_step mobile_export install step_mobile_export; fi

cleanup
status=0
print_table || status=1
if (( RESTORE_FAILED )); then
  echo "verify-all: FAILED to restore the files edited for stack isolation (see above)" >&2
  status=1
fi
exit "$status"
