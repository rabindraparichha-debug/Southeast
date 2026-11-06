# Operations

How to run the platform day to day: deploying, scheduled jobs, engine health and monitoring, retention, backups and the restore drill, load testing, and what to do when something breaks.

## Environments

| | Local | Staging / production (hosted Supabase) |
|---|---|---|
| Database, Auth, Storage, Edge Functions | `pnpm db:start` (Docker) | One Supabase project each (Pro plan); never share one between staging and production |
| Web (Next.js) | `pnpm --filter @tiffin/web dev` | Any Node host (Vercel, a VPS with `next start`). Set `NEXT_PUBLIC_*` variables from `.env.example` |
| Mobile | Expo dev server | EAS build → Play Store (docs/RELEASE.md) |
| VROOM (optional) | — | Docker on your VPS; set `VROOM_URL` (D-067) |

## Deploying a change

Always through `scripts/deploy.sh` (vendor-first wave 3). It pushes migrations, deploys Edge Functions from an explicit allowlist and checks secrets and Vault first. It never runs `supabase config push`, `db reset`, `db push --include-seed` or anything else that would plant the local `config.toml` (test OTP logins, dummy SMS) or `seed.sql` (dev Vault keys, demo service key, test users) on a hosted project.

1. Run every check locally: `pnpm db:reset && pnpm db:test && pnpm --filter @tiffin/core test && pnpm test:integration`, plus web and mobile `typecheck` and `lint` (or all of them at once: `scripts/verify-all.sh`, see "Verifying a branch" below). Regenerate types if the schema changed (`pnpm db:types`) and commit them. Migrations are append-only: never edit one that a shared environment has applied (CLAUDE.md).
2. Staging first, then production, outside delivery hours (old app builds may still be on riders' phones; migrations must only add things):
   ```bash
   export SUPABASE_ACCESS_TOKEN=...        # or `npx supabase login`
   export DB_URL='postgresql://postgres:<db password>@db.<ref>.supabase.co:5432/postgres'   # Dashboard → Connect → Direct
   scripts/deploy.sh --env staging --project-ref <ref> --dry-run   # read-only: checks + pending migrations + plan
   scripts/deploy.sh --env staging --project-ref <ref>
   ```
   Options: `--skip-db`, `--skip-functions`, `--only ops-health,storage-retention`. Older Postgres client tools than the server (17)? Set `PG_TOOLS_IMAGE=postgres:17`.
3. What it checks, and refuses on (nothing secret is printed; only names):
   - **Edge Function secrets** (`supabase secrets list`, names and SHA-256 digests): `PLATFORM_ENV` set to the `--env` you deploy; no value still equal to a placeholder from `supabase/functions/.env.example`; `RAZORPAY_ALLOW_LIVE` unset (only the owner approves live payments; after approval rerun with `OWNER_APPROVED_LIVE_PAYMENTS=yes`). Missing optional secrets are warnings: those functions refuse until set (`PLATFORM_ENV` fail-closed mocks).
   - **Vault** (via `DB_URL`): `phone_encryption_key`, `phone_hash_key`, `functions_base_url`, `service_role_key`, `public_web_url` exist; the phone keys are not the seed's dev keys; `functions_base_url` is an `https://` hosted URL; `service_role_key` is not the local demo key; the seed test logins do not exist.
   - **After deploy**: every `tiffin-*` pg_cron job exists and is active, then prints `public.ops_health()` and the `ops-health` HTTP status.
4. Edge Functions deployed (allowlist, with `--no-verify-jwt` where `supabase/config.toml` says `verify_jwt = false`): `ops-health`, `storage-retention`, `whatsapp-outbox`, `whatsapp-webhook`, `razorpay-payment-link`, `razorpay-refund`, `razorpay-webhook`, `notebook-import`, `route-optimize`, `lead-intake`, `lead-email`, `ads-conversions`, `weather-alerts`. **Never** `razorpay-mock` (the local test payment page): the script refuses it even with `--only`, and `scripts/deploy.sh --self-test` fails if a new function directory is on neither list.
5. Secrets: `supabase secrets set KEY=value`, with real random values; `supabase/functions/.env.example` lists the names but its values are local placeholders. Set `PLATFORM_ENV=staging` or `PLATFORM_ENV=production` on every hosted project. Mock modes (Razorpay, WhatsApp, the notebook-import fixture) run only when `PLATFORM_ENV` is `local`, so a hosted project without keys refuses (`payments_not_configured`, `whatsapp_not_configured`, `ai_not_configured`) instead of pretending to work. Vault secrets are set once per project in the SQL editor (CLAUDE.md > Secrets).
6. Web: deploy as usual. Mobile: `eas build` / `eas update` (docs/RELEASE.md).

Self-tests (no hosted project needed): `scripts/deploy.sh --self-test` (forbidden commands refused, every function on a list) and `scripts/deploy.sh --env staging --local` (against the local stack: the four dev-data guards must fire, and the migration/function plan is printed).

## Verifying a branch

`scripts/verify-all.sh` runs every check on the current checkout (the main one or any git worktree), prints a PASS/FAIL table with timings, and exits non-zero if any step fails. Run it before merging or pushing a branch.

```bash
scripts/verify-all.sh                                                         # project "tiffin", ports from config.toml
PROJECT_ID=tiffinmv PORT_BASE=6132 INSPECTOR_PORT=8783 scripts/verify-all.sh   # its own stack, beside other stacks
scripts/verify-all.sh --skip-mobile-export --skip-build --keep-stack
```

Steps, in order: Node ≥ 22.13; `pnpm install --frozen-lockfile`; a slim local stack (no Studio, imgproxy, mail server, analytics/vector or pooler); `supabase db reset`; pgTAP (one ok/FAIL line per test file, plus the failed assertions); regenerate `packages/db/src/types.ts` as `pnpm db:types` does; `db reset` again; `pnpm test:integration`; the lock load test (fails if the first 5,000-subscription lock takes over 60 s); `pnpm typecheck`; `pnpm lint`; core unit tests; the web build (URL and anon key from `supabase status`); `EXPO_OFFLINE=1 npx expo export --platform android` into a temporary directory. A step whose prerequisite failed shows SKIP; the others still run.

- **Stale types fail the run.** The regenerated `types.ts` is left in the working tree (the old copy is in the log directory): review it with `git diff` and commit it.
- **Edge Function settings.** If `supabase/functions/.env` is missing, the run creates it from `.env.example` (mock modes, as CI does) and deletes it again at the end.
- **Parallel stacks.** With a `PROJECT_ID` other than `tiffin`, `PORT_BASE` is required. For the length of the run, the script edits `supabase/config.toml` (project id; ports `<PORT_BASE>0` shadow, `1` API, `2` db, `3` Studio, `4` mail, `7` analytics, `9` pooler; `INSPECTOR_PORT`), the kong host in `supabase/seed.sql`, and `PUBLIC_FUNCTIONS_URL` in `supabase/functions/.env`. It restores all three on exit, including after a failure or Ctrl-C, so `git status` is clean afterwards and the edits are never committed. The backups live in the worktree's git directory; if a run is killed with `kill -9`, the next run restores them. Choose a project id and port base that no other stack on the machine uses (`docker ps`).
- **The stack is its own.** At the end it stops only its project (`supabase stop --project-id <id>`, with `--no-backup` unless the id is `tiffin`). `--keep-stack` leaves it running; stop it later with `pnpm exec supabase stop --project-id <id>`. A stack of the same project already running from this checkout is reused, and stopped at the end unless you pass `--keep-stack`. The script refuses a project id that is running from another checkout, never runs `supabase stop --all`, and never prunes Docker.
- **Output.** The script prints one line per step, details for pgTAP, types, integration and the load test, and the last 40 lines of any failed step. Full logs go to a temporary directory (set `LOG_DIR` to choose one). `VERBOSE=1` streams everything.
- **Time.** A full run takes about 4 minutes on a 4-CPU machine shared with other stacks, once the Docker images are present. Typecheck and lint always run fresh (`TURBO_FORCE`); the web build reuses `.next/cache`.

## Scheduled jobs (pg_cron, inside the database)

The engine jobs run through `private.run_job('<job>')`, which stamps `engine_heartbeats` when the job finishes. A failed run rolls back (nothing half-done) and pg_cron records the failure in `cron.job_run_details`.

| Job | When (IST) | What | If it stops |
|---|---|---|---|
| `tiffin-lock-due-slots` | every minute | Locks slots whose cutoff passed: counts, meal charges, delivery runs, ingredient deduction, production sheet | Counts aren't frozen: the owner sees "Count not frozen" with **Freeze now**; ops-health turns 503. Run `select private.run_job('tiffin-lock-due-slots');` (idempotent) |
| `tiffin-nightly` | 00:30 | Subscription states, 7 days of orders, reminders | Run `select private.run_job('tiffin-nightly');` |
| `tiffin-owner-summary` | 22:00 | Owners' WhatsApp summary (counts, collections, low stock) | Run `select private.run_job('tiffin-owner-summary');` |
| `tiffin-purge` | 03:00 | Retention: old pg_cron run log and finished outbox rows (below) | Run `select private.run_job('tiffin-purge');` |
| `tiffin-storage-retention` | 03:15 | Starts the `storage-retention` Edge Function (expired photos, erasure clean-up) | Call the function with the service role key (below) |
| `tiffin-tomorrow-nudge` | 19:00 | "Tomorrow's menu, skip?" | Run `select private.queue_tomorrow_nudges();` |
| `tiffin-escalate-complaints` | every 15 min | Complaints with no reply in 2 h go to the admin page | Run `select private.escalate_complaints();` |
| `tiffin-outbox` | every minute | Starts the WhatsApp outbox worker via `pg_net` | Messages queue up. Check Vault `functions_base_url` and `service_role_key`; call the function by hand |
| `tiffin-growth` | hourly at :07 | Trial follow-ups, lead reminders, vendor nudges | Run `select private.growth_tick();` |

Check jobs: `select jobname, status, start_time, return_message from cron.job_run_details order by start_time desc limit 50;` (kept 14 days).

## Engine health and monitoring

- **Admin → Dashboard → Engine** (`public.engine_health()`, admins only): each job's last finished run and whether it is late or unscheduled, every slot past its cutoff with orders but no count ("count not frozen", with kitchen, date and slot), `tiffin-*` jobs whose latest run failed (with the error), and engine errors once wave 1's `engine_errors` table exists (it is read only if present).
- **Uptime pinger** (free: UptimeRobot, Better Stack, cron-job.org): monitor `GET https://<ref>.supabase.co/functions/v1/ops-health` every 5 minutes and alert on anything but 200.
  - 200 `{"ok":true,...}`: the lock job finished in the last 5 minutes, nightly and summary in the last 26 hours, all three are scheduled, no slot is more than 5 minutes past its cutoff without a count, no `tiffin-*` job's latest run failed, and no engine error in the last 15 minutes.
  - 503 `{"ok":false,"checks":{...}}`: open the admin Engine tile. The body has booleans and counts only (no names, ids or errors).
  - Optional secret `OPS_HEALTH_KEY`: when set, the URL needs `?key=<value>`.
- **Vendors see it too:** a slot card turns red with "Count not frozen" 5 minutes after its cutoff if it has orders and no lock. The owner can press **Freeze now** (`freeze_slot`: the same idempotent lock and balance sync as the job; only after the cutoff, last 7 days); staff see the banner and are told to ask the owner.
- **Errors:** set `SENTRY_DSN` (Edge Functions secret, plus the web and mobile variables in `.env.example`). Edge Function errors are reported with phone numbers masked (`_shared/monitor.ts`).
- **Daily glance (admin console):** `/admin` platform metrics. Watch failed outbox messages, escalated complaints, waitlisted leads, stops proved (goal 90%), the share of changes made on WhatsApp/web.
- **Database:** Supabase dashboard (CPU, connections, slow queries, disk). Postgres logs carry `build_runs failed` / `consume_for_slot failed` warnings if routing or inventory fail during a lock (the lock itself still succeeds).

## Retention

Defaults live in `platform_settings` key `retention` (`enabled` = purges run; `value` = days). Change them with `select public.admin_set_retention('{"proof_photo_days": 120}');` as an admin (whole days, 1–3650; the database never goes below its safety minimums), or switch purges off with `admin_set_retention(null, false)`.

| What | Kept | Deleted by |
|---|---|---|
| Delivery proof photos (`proofs`) | 90 days | `storage-retention` (Storage API) |
| Dispatch photos (`dispatch`) | 30 days | `storage-retention` |
| Notebook-import photos (`imports`) | 7 days | `storage-retention` |
| Receipts and purchase bills (`receipts`, `bills`) | always (money records) | — |
| Outbox rows that were sent, failed or cancelled (and expired ones, once wave 2's `expires_at` exists) | 90 days | `tiffin-purge` |
| pg_cron run log (`cron.job_run_details`) | 14 days | `tiffin-purge` |
| Audit log | always (append-only) | — but smaller: updates on personal-data tables store only what changed, rider location pings are not logged |

SQL cannot delete storage objects (Supabase blocks it), so photos go through the `storage-retention` function. To run it by hand: `curl -X POST -H "Authorization: Bearer <service role key>" https://<ref>.supabase.co/functions/v1/storage-retention`.

## Backups and the restore drill

- **Hosted (primary):** Supabase Pro daily backups on the production project (PITR optional). They restore the whole database (Vault and pg_cron included) through the dashboard.
- **Portable copy:** `DB_URL=<direct connection string> pnpm db:backup` writes `backups/tiffin-<timestamp>.dump` (schemas `public`, `private`, `auth`) and `<dump>.checks` (row counts and ledger totals). Store both encrypted, off the server.
- **Keys are not in backups.** Vault keys (`phone_encryption_key`, `phone_hash_key`) live in your password manager. A restore into a new project needs the same keys, or phone numbers can't be decrypted. The drill below proves the keys you hold still fit.
- **Photos are not in database backups.** Proof, dispatch and import photos expire anyway (Retention). Receipts and bills are money records: copy the `receipts` and `bills` buckets monthly with an S3 client against the project's S3 endpoint (Storage → Settings → S3 access keys).
- **Local drill (monthly, and after big migrations):** `pnpm db:restore-drill` backs up the local database, restores it into a scratch database and checks every table's row count plus the ledger totals. It exits non-zero on any difference. If your local project id is not `tiffin`, set `DB_CONTAINER=supabase_db_<project_id>`.
- **Staging-copy drill (before go-live, then quarterly):**
  1. The staging project has every migration (`scripts/deploy.sh --env staging ...`) and the **production** Vault phone keys.
  2. `DB_URL=<staging direct URL> CONFIRM_WIPE=<host:port/db of staging> SOURCE_DB_URL=<production direct URL> pnpm db:restore-drill` (or pass a dump file written by `db:backup` instead of `SOURCE_DB_URL`).
  3. It pauses staging's `tiffin-*` jobs, replaces staging's data in one transaction (all or nothing), switches the jobs back on, and checks: row counts and ledger totals equal the source's, every `tiffin-*` cron job exists, and sampled phone numbers decrypt and re-hash to their stored hash (`decrypt_phone` works with the keys from the password manager). No phone number is printed.
  Last local runs: scratch-database drill 66 tables matched; staging-copy drill against a local stack matched 66 tables, 13 cron jobs, 31/31 phones; with a wrong `phone_encryption_key` it failed as it should.
- **Real disaster, new project:** create the project, run `scripts/deploy.sh` against it (migrations, functions, checks), set the Vault keys from the password manager, then run the staging-copy steps with the new project as `DB_URL` and the latest dump. Point the web and app at the new URL.

## Load test

`pnpm db:loadtest` builds 50 kitchens × 100 subscriptions (with addresses, recipes and menus) in a transaction that is rolled back. It times the 21:00 lunch lock, including delivery runs and ingredient deduction, and fails if it exceeds 60 s.

Last local runs (Docker on the build sandbox):

| Run | Time |
|---|---|
| First-ever lock (every route built and optimised from scratch) | ~9–13 s (13.2 s on a shared 4-CPU sandbox after the lean audit log) |
| A normal day (routes saved) | 1.8 s |

## Runbooks

- **ops-health is 503 / the Engine tile is red:** read which check failed.
  - `lock_job` false: the minute job is late or unscheduled. `select * from cron.job where jobname = 'tiffin-lock-due-slots';` If missing, apply the latest migration again with `scripts/deploy.sh` (it reschedules jobs) or run the `cron.schedule(...)` line from `supabase/migrations/20261110000100_engine_health.sql`.
  - `failing_jobs` > 0: the tile shows the job and its error. Fix the cause, then run the job by hand (table above); the next success clears it.
  - `overdue_slots` > 0: run `select private.run_job('tiffin-lock-due-slots');` or ask the owner to press Freeze now.
- **A slot didn't lock:** the owner presses **Freeze now** on the red slot card (web or app). Or as ops: `select private.run_job('tiffin-lock-due-slots');`.
- **Customers say they didn't get WhatsApp messages:** check `notifications_outbox` for `failed` or `cancelled` rows and `last_error`:
  - `not_opted_in`: expected;
  - a Meta error: check the template status and the access token.
- **Razorpay payment not credited:** find the payment in `webhook_events` by provider and event id. A missing event means the webhook URL or secret is wrong in the Razorpay dashboard. Re-deliver from the dashboard; it's deduplicated.
- **A rider's deliveries didn't sync:** they stay on the phone until the network returns (the app retries every 30 s and on opening). Logging out is blocked while actions are waiting.
- **Data deletion request (DPDP):** the owner uses "Erase customer" (`erase_customer`, after cancelling their subscriptions). Ledger rows and counts stay; their name, phone, notes, address, delivery GPS and notes, complaint text, review comment, health tags, import row, WhatsApp conversation (unless a family member shares the number) and messages to them go, and every audit-log value of theirs becomes `"[erased]"`. Their proof photos are queued and deleted by the next `storage-retention` run. For leads (platform data), an admin marks them lost and removes notes.
