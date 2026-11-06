#!/usr/bin/env bash
# Hosted deploy (vendor-first wave 3, item 32): database migrations, an explicit Edge Function
# allowlist, and secret and Vault checks. It never seeds, never resets and never pushes config.toml.
#
#   DB_URL=<direct connection> scripts/deploy.sh --env staging|production --project-ref <ref> [options]
#
#   --dry-run          print every write it would do; run only the read-only checks (db push --dry-run)
#   --skip-db          do not push migrations
#   --skip-functions   do not deploy Edge Functions
#   --only a,b         deploy only these functions (each must be on the allowlist below)
#   --include-all      pass --include-all to `db push`: needed when a branch merged later added migrations
#                      dated before ones already on the project (the dry run lists them first; read it)
#   --local            self-test against the local stack (DB_URL from `supabase status`; implies --dry-run,
#                      skips the hosted secrets list). The local stack has dev keys, so it must refuse.
#   --self-test        check the script's own guards (no network, no database)
#
# Needs: the Supabase CLI (npx supabase, logged in or SUPABASE_ACCESS_TOKEN), psql (or PG_TOOLS_IMAGE,
# scripts/lib/pg.sh), node, and DB_URL = the project's direct connection string
# (Dashboard → Connect → Direct connection). Nothing secret is printed: checks report names only.
# Live Razorpay keys: refused while RAZORPAY_ALLOW_LIVE is set, unless the owner approved live mode
# and you pass OWNER_APPROVED_LIVE_PAYMENTS=yes (CLAUDE.md).
# Every function directory must be on ALLOWLIST or NEVER: a function nobody listed is refused before
# anything is written (add it to ALLOWLIST when its branch merges). Production needs OPS_HEALTH_KEY.
# Works with bash 3.2 (macOS) and later.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/pg.sh

# Edge Functions that may be deployed. razorpay-mock (the local test payment page) is never deployed.
ALLOWLIST=(ops-health storage-retention whatsapp-outbox whatsapp-webhook razorpay-payment-link razorpay-refund
           razorpay-webhook notebook-import route-optimize lead-intake lead-email ads-conversions weather-alerts
           auth-send-sms admin-change-phone push-outbox public-forms)
NEVER=(razorpay-mock)
# Vault secrets every project needs (CLAUDE.md > Secrets, docs/OPERATIONS.md).
VAULT=(phone_encryption_key phone_hash_key functions_base_url service_role_key public_web_url)
# pg_cron jobs the migrations create.
CRON_JOBS=(tiffin-lock-due-slots tiffin-nightly tiffin-owner-summary tiffin-tomorrow-nudge tiffin-escalate-complaints
           tiffin-outbox tiffin-growth tiffin-ad-conversions tiffin-weather tiffin-churn tiffin-late-delivery
           tiffin-purge tiffin-storage-retention tiffin-outbox-stuck tiffin-plan-prices tiffin-push)

ENV_NAME="" REF="" DRY=0 SKIP_DB=0 SKIP_FN=0 ONLY="" LOCAL=0 SELF_TEST=0 INCLUDE_ALL=0
problems=0
fail() { echo "  FAIL  $*"; problems=$((problems + 1)); }
ok() { echo "  ok    $*"; }
warn() { echo "  warn  $*"; }
die() { echo "refusing: $*" >&2; exit 2; }
# SHA-256 of a string (sha256sum on Linux, shasum on macOS). No tool: refuse rather than compare with "".
sha() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  else die "neither sha256sum nor shasum is installed (needed to compare secret digests)"
  fi
}
# Function directories on neither list (printed one per line; empty when all are listed).
unlisted_functions() {
  local d fn
  for d in supabase/functions/*/; do
    fn=$(basename "$d")
    [[ "$fn" == _shared ]] && continue
    [[ " ${ALLOWLIST[*]} ${NEVER[*]} " == *" $fn "* ]] || echo "$fn"
  done
}

# Every Supabase CLI call goes through here. Commands that could plant local settings, seed data or
# wipe a hosted database are refused whatever the caller asks.
guard_cli() {
  local all=" $* "
  case "$all" in
    *" config push "*) echo "config push";;
    *" db reset "*) echo "db reset";;
    *"--include-seed"*) echo "--include-seed";;
    *" seed "*) echo "seed";;
    *" functions deploy "*)
      local fn
      fn=$(awk '{for (i = 1; i <= NF; i++) if ($i == "deploy") { print $(i + 1); exit }}' <<<"$*")
      if [[ -z "$fn" || "$fn" == -* ]]; then echo "functions deploy without a function name"; return; fi
      for n in "${NEVER[@]}"; do [[ "$fn" == "$n" ]] && { echo "deploying $n"; return; }; done
      local allowed=0
      for n in "${ALLOWLIST[@]}"; do [[ "$fn" == "$n" ]] && allowed=1; done
      (( allowed )) || echo "deploying $fn (not on the allowlist)";;
    *) ;;
  esac
}
sb() {
  local why
  why=$(guard_cli "$@")
  [[ -n "$why" ]] && die "scripts/deploy.sh never runs: $why"
  npx --yes supabase "$@"
}
run() {  # a write: printed (connection string masked), and executed unless --dry-run
  local shown="$*"
  [[ -n "${DB_URL:-}" ]] && shown="${shown//"$DB_URL"/\$DB_URL}"
  echo "  + supabase $shown"
  (( DRY )) && return 0
  sb "$@"
}

self_test() {
  local bad=0
  for cmd in "config push" "db reset --linked" "db push --include-seed" "seed buckets" "functions deploy" \
             "functions deploy razorpay-mock" "functions deploy unknown-fn" "functions deploy --project-ref x"; do
    # shellcheck disable=SC2086
    if [[ -z "$(guard_cli $cmd)" ]]; then echo "self-test: '$cmd' was not refused"; bad=1; fi
  done
  for cmd in "db push --db-url x" "functions deploy ops-health --project-ref x" "secrets list --project-ref x -o json"; do
    # shellcheck disable=SC2086
    if [[ -n "$(guard_cli $cmd)" ]]; then echo "self-test: '$cmd' was refused"; bad=1; fi
  done
  # Every function in the repo is either deployable or deliberately never deployed.
  local fn
  for fn in $(unlisted_functions); do echo "self-test: function $fn is on neither list"; bad=1; done
  [[ "$(sha abc)" == ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad ]] || { echo "self-test: sha() is wrong"; bad=1; }
  # An empty array must expand to nothing under set -u (bash 3.2 aborts on a bare "${a[@]}").
  local empty=() n
  n=$(set -u; printf '%s' ${empty[@]+"${empty[@]}"} | wc -c)
  [[ "$n" -eq 0 ]] || { echo "self-test: empty array expansion"; bad=1; }
  (( bad )) && { echo "SELF-TEST FAILED"; exit 1; }
  echo "SELF-TEST PASSED: forbidden commands refused, $(echo "${ALLOWLIST[@]}" | wc -w) deployable functions, never: ${NEVER[*]}"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2;;
    --project-ref) REF="${2:-}"; shift 2;;
    --dry-run) DRY=1; shift;;
    --skip-db) SKIP_DB=1; shift;;
    --skip-functions) SKIP_FN=1; shift;;
    --only) ONLY="${2:-}"; shift 2;;
    --include-all) INCLUDE_ALL=1; shift;;
    --local) LOCAL=1; DRY=1; shift;;
    --self-test) SELF_TEST=1; shift;;
    *) die "unknown option $1 (see the header of scripts/deploy.sh)";;
  esac
done
(( SELF_TEST )) && self_test

[[ "$ENV_NAME" == "staging" || "$ENV_NAME" == "production" ]] || die "--env must be staging or production"
if (( LOCAL )); then
  DB_URL=$(npx supabase status -o json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("{")));console.log(j.DB_URL)})')
  REF="local"
else
  [[ "$REF" =~ ^[a-z0-9]{20}$ ]] || die "--project-ref must be the 20-character project ref"
fi
[[ -n "${DB_URL:-}" ]] || die "set DB_URL to the project's direct connection string"
target=$(pg_url_target "$DB_URL")
if (( ! LOCAL )) && [[ "$target" =~ ^(localhost|127\.|0\.0\.0\.0|\[::1\]|host\.docker\.internal) ]]; then
  die "DB_URL points at a local database ($target); use --local for the self-test"
fi

FUNCS=("${ALLOWLIST[@]}")
unlisted=$(unlisted_functions | tr '\n' ' ')
if [[ -n "$ONLY" ]]; then
  IFS=',' read -r -a FUNCS <<<"$ONLY"
  for fn in "${FUNCS[@]}"; do
    [[ " ${ALLOWLIST[*]} " == *" $fn "* ]] || die "$fn is not on the deploy allowlist (never: ${NEVER[*]})"
  done
fi

echo "deploy: env=$ENV_NAME project=$REF database=$target$( (( DRY )) && echo ' (dry run)')"
echo "  commit $(git rev-parse --short HEAD)$(git diff --quiet && git diff --cached --quiet || echo ', with UNCOMMITTED changes')"

# ---------------------------------------------------------------------------------------------
echo "1. Edge Function secrets (names and digests only)"
if (( LOCAL )); then
  warn "skipped on --local (no hosted project)"
else
  secrets_json=$(sb secrets list --project-ref "$REF" -o json)
  # Name -> digest (the CLI shows a SHA-256 digest of each value, never the value).
  digest_of() { node -e 'const a=JSON.parse(process.argv[1]); const x=a.find(s=>s.name===process.argv[2]); console.log(x ? (x.digest ?? x.value ?? "") : "")' "$secrets_json" "$1"; }
  d=$(digest_of PLATFORM_ENV)
  if [[ -z "$d" ]]; then
    fail "PLATFORM_ENV is not set (supabase secrets set PLATFORM_ENV=$ENV_NAME)"
  elif [[ "$d" =~ ^[0-9a-f]{64}$ && "$d" != "$(sha "$ENV_NAME")" ]]; then
    fail "PLATFORM_ENV is set but not to '$ENV_NAME'"
  else
    ok "PLATFORM_ENV"
  fi
  if [[ -n "$(digest_of RAZORPAY_ALLOW_LIVE)" && "${OWNER_APPROVED_LIVE_PAYMENTS:-}" != "yes" ]]; then
    fail "RAZORPAY_ALLOW_LIVE is set: only the owner may approve live payments (unset it, or rerun with OWNER_APPROVED_LIVE_PAYMENTS=yes after approval)"
  fi
  # Values copied from supabase/functions/.env.example are local placeholders, never valid in a hosted project.
  while IFS='=' read -r name value; do
    value="${value%%#*}"; value="${value%"${value##*[![:space:]]}"}"
    [[ -z "$name" || -z "$value" || "$name" == \#* ]] && continue
    [[ "$name" == PLATFORM_ENV || "$name" == *_MODE || "$name" == WEATHER_MOCK_SCENARIO || "$name" == ANTHROPIC_MODEL ]] && continue
    d=$(digest_of "$name")
    [[ -n "$d" && "$d" == "$(sha "$value")" ]] && fail "$name still has the local placeholder value from supabase/functions/.env.example"
  done < supabase/functions/.env.example
  for name in WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN RAZORPAY_WEBHOOK_SECRET LEAD_INTAKE_KEY PUBLIC_WEB_URL SENTRY_DSN; do
    [[ -n "$(digest_of "$name")" ]] || warn "$name not set (the functions that need it refuse until it is)"
  done
  # ops-health is public (--no-verify-jwt): without a key anyone can make it run the health query.
  if [[ -z "$(digest_of OPS_HEALTH_KEY)" ]]; then
    if [[ "$ENV_NAME" == production ]]; then
      fail "OPS_HEALTH_KEY is not set (supabase secrets set OPS_HEALTH_KEY=<random>; the pinger URL gets ?key=<random>)"
    else
      warn "OPS_HEALTH_KEY not set: ops-health is open to anyone with the URL"
    fi
  else
    ok "OPS_HEALTH_KEY"
  fi
fi

# ---------------------------------------------------------------------------------------------
echo "1b. Edge Function lists"
if [[ -n "$unlisted" ]]; then
  fail "function(s) on neither ALLOWLIST nor NEVER in scripts/deploy.sh: ${unlisted% } (add them before deploying)"
else
  ok "every function directory is on ALLOWLIST or NEVER"
fi

# ---------------------------------------------------------------------------------------------
echo "2. Vault and data checks"
pq() { pgtool psql "$DB_URL" -XAtq -v ON_ERROR_STOP=1 "$@"; }
vault_in=$(printf "'%s'," "${VAULT[@]}")
present=$(pq -c "select coalesce(string_agg(name, ' '), '') from vault.secrets where name in (${vault_in%,})")
for name in "${VAULT[@]}"; do
  [[ " $present " == *" $name "* ]] && ok "Vault $name" || fail "Vault $name missing (SQL editor: select vault.create_secret('<value>', '$name');)"
done
dev_guards=0
while IFS='|' read -r check bad; do
  [[ -z "$check" ]] && continue
  if [[ "$bad" != "t" ]]; then
    ok "not: $check"
  elif (( LOCAL )); then
    echo "  FAIL  $check (expected on the local stack: a hosted deploy would stop here)"
    dev_guards=$((dev_guards + 1))
  else
    fail "$check"
  fi
done < <(pq <<'SQL'
select 'phone keys are the local dev keys from seed.sql', exists (select 1 from vault.decrypted_secrets
  where name in ('phone_encryption_key', 'phone_hash_key') and (decrypted_secret like '%NOT-FOR-PRODUCTION%' or decrypted_secret like 'local-dev-%'));
select 'functions_base_url is not a hosted https URL', exists (select 1 from vault.decrypted_secrets
  where name = 'functions_base_url' and (decrypted_secret !~ '^https://' or decrypted_secret ~ '(kong|localhost|127\.0\.0\.1)'));
select 'service_role_key is the local demo key', exists (select 1 from vault.decrypted_secrets
  where name = 'service_role_key' and decrypted_secret like '%.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIi%');
select 'the seed test logins exist (seed.sql was applied)', exists (select 1 from auth.users
  where phone in ('919000000001', '919000000002', '919000000003', '919000000011', '919000000099'));
SQL
)

# ---------------------------------------------------------------------------------------------
echo "3. Database migrations"
if (( SKIP_DB )); then
  warn "skipped (--skip-db)"
elif (( problems )); then
  warn "not pushed: fix the $problems problem(s) above first"
else
  push_flags=()
  (( INCLUDE_ALL )) && push_flags+=(--include-all)
  echo "  pending (dry run):"
  sb db push --db-url "$DB_URL" --dry-run ${push_flags[@]+"${push_flags[@]}"} 2>&1 | sed 's/^/    /'
  run db push --db-url "$DB_URL" ${push_flags[@]+"${push_flags[@]}"}
fi

# ---------------------------------------------------------------------------------------------
echo "4. Edge Functions (allowlist; never: ${NEVER[*]})"
if (( SKIP_FN )); then
  warn "skipped (--skip-functions)"
elif (( problems )); then
  warn "not deployed: fix the $problems problem(s) above first"
else
  for fn in "${FUNCS[@]}"; do
    [[ -d "supabase/functions/$fn" ]] || { fail "supabase/functions/$fn does not exist"; continue; }
    flags=()
    # verify_jwt = false in config.toml: the function checks its own signature, key or service role.
    if awk -v s="[functions.$fn]" '$0 == s {f = 1; next} /^\[/ {f = 0} f && /^verify_jwt *= *false/ {found = 1} END {exit !found}' supabase/config.toml; then
      flags+=(--no-verify-jwt)
    fi
    run functions deploy "$fn" --project-ref "$REF" ${flags[@]+"${flags[@]}"}
  done
fi

# ---------------------------------------------------------------------------------------------
echo "5. After deploy"
if (( problems )); then
  :
elif (( DRY )); then
  warn "dry run: nothing changed"
else
  jobs=$(pq -c "select coalesce(string_agg(jobname, ' '), '') from cron.job where active")
  for j in "${CRON_JOBS[@]}"; do [[ " $jobs " == *" $j "* ]] || fail "pg_cron job $j missing or inactive"; done
  (( problems )) || ok "${#CRON_JOBS[@]} pg_cron jobs active"
  echo "  ops_health: $(pq -c "select public.ops_health()")"
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$REF.supabase.co/functions/v1/ops-health" || true)
  echo "  GET https://$REF.supabase.co/functions/v1/ops-health -> $code (200 healthy; 401: OPS_HEALTH_KEY is set, use ?key=; on 503 open /admin → Engine)"
fi

if (( problems )); then
  echo "DEPLOY REFUSED: $problems problem(s)"
  exit 1
fi
if (( LOCAL )); then
  if (( dev_guards == 4 )); then
    echo "LOCAL SELF-TEST PASSED: all 4 dev-data guards fired (dev phone keys, local functions URL, demo service key, seed logins); plan above"
    exit 0
  fi
  echo "LOCAL SELF-TEST FAILED: only $dev_guards of 4 dev-data guards fired on the local stack"
  exit 1
fi
echo "DEPLOY $( (( DRY )) && echo 'DRY RUN ' )OK"
