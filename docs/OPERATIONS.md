# Operations

How to run the platform day to day: deploying, scheduled jobs, monitoring, backups and the restore drill, load testing, and what to do when something breaks.

## Environments

| | Local | Staging / production (hosted Supabase) |
|---|---|---|
| Database, Auth, Storage, Edge Functions | `pnpm db:start` (Docker) | One Supabase project each; never share one between staging and production |
| Web (Next.js) | `pnpm --filter @tiffin/web dev` | Any Node host (Vercel, a VPS with `next start`). Set `NEXT_PUBLIC_*` variables from `.env.example` |
| Mobile | Expo dev server | EAS build → Play Store (docs/RELEASE.md) |
| VROOM (optional) | — | Docker on your VPS; set `VROOM_URL` (D-067) |

## Deploying a change

1. Run every check locally: `pnpm db:reset && pnpm db:test && pnpm --filter @tiffin/core test && pnpm test:integration`, plus web and mobile `typecheck` and `lint` (or all of them at once: `scripts/verify-all.sh`, see "Verifying a branch" below).
2. Database: `supabase link --project-ref <ref>` then `supabase db push`. Migrations are append-only: never edit one that a shared environment has applied (CLAUDE.md).
3. Regenerate types if the schema changed: `pnpm db:types`, and commit them.
4. Edge Functions: deploy each changed function by name, and only functions from this list. Never run `supabase functions deploy` without a name: that also deploys `razorpay-mock`, the local test payment page, which must never reach a hosted project (it answers 404 there, but keep it off anyway).

   | Function | Deploy with |
   |---|---|
   | `razorpay-payment-link`, `razorpay-refund`, `whatsapp-outbox`, `notebook-import`, `route-optimize`, `admin-change-phone` | `supabase functions deploy <name>` |
   | `razorpay-webhook`, `whatsapp-webhook`, `lead-intake`, `lead-email`, `ads-conversions`, `weather-alerts` | `supabase functions deploy <name> --no-verify-jwt` (they check their own signature or key, matching `supabase/config.toml`) |

   Not deployed: `razorpay-mock` (local only).
5. Secrets: `supabase secrets set KEY=value`, with real random values. `supabase/functions/.env.example` lists the names, but its values are local placeholders: never copy that file to a hosted project. The lead-intake functions refuse their `local-dev-*` example keys and keys shorter than 24 characters outside a local stack (`intake_not_configured`, D-150). Set `PLATFORM_ENV=staging` or `PLATFORM_ENV=production` on every hosted project. Mock modes (Razorpay, WhatsApp, the notebook-import fixture) run only when `PLATFORM_ENV` is `local`, so a hosted project without keys refuses (`payments_not_configured`, `whatsapp_not_configured`, `ai_not_configured`) instead of pretending to work. Vault secrets are set once per project in the SQL editor (CLAUDE.md > Secrets).
6. Web: deploy as usual. Mobile: `eas build` / `eas update` (docs/RELEASE.md).

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

| Job | When (IST) | What | If it stops |
|---|---|---|---|
| `tiffin-lock-due-slots` | every minute | Locks slots whose cutoff passed: counts, meal charges, delivery runs, ingredient deduction, production sheet | Counts aren't frozen. Run `select private.run_due_locks();` (idempotent) |
| `tiffin-nightly` | 00:30 | Subscription states, 7 days of orders, reminders | Run `select private.nightly();` |
| `tiffin-owner-summary` | 22:00 | Owners' WhatsApp summary (counts, collections, low stock) | Run `select private.queue_owner_summaries();` |
| `tiffin-tomorrow-nudge` | 19:00 | "Tomorrow's menu, skip?" | Run `select private.queue_tomorrow_nudges();` |
| `tiffin-escalate-complaints` | every 15 min | Complaints with no reply in 2 h go to the admin page | Run `select private.escalate_complaints();` |
| `tiffin-outbox` | every minute | Starts the WhatsApp outbox worker via `pg_net` | Messages queue up. Check Vault `functions_base_url` and `service_role_key`; call the function by hand |
| `tiffin-growth` | hourly at :07 | Trial follow-ups, lead reminders, vendor nudges | Run `select private.growth_tick();` |

Check jobs: `select jobname, status, start_time, return_message from cron.job_run_details order by start_time desc limit 50;`

## Monitoring

- **Errors:** set `SENTRY_DSN` (Edge Functions secret, plus the web and mobile variables in `.env.example`). Edge Function errors are reported with phone numbers masked (`_shared/monitor.ts`).
- **Daily glance (admin console):** `/admin` platform metrics. Watch:
  - failed outbox messages (Meta template or token problems);
  - escalated complaints;
  - waitlisted leads (demand gaps);
  - stops proved (goal 90%);
  - share of changes made on WhatsApp/web (goal: half of customers).
- **Database:** Supabase dashboard (CPU, connections, slow queries). Postgres logs carry `build_runs failed` / `consume_for_slot failed` warnings if routing or inventory fail during a lock (the lock itself still succeeds).

## Backups and the restore drill

- **Hosted:** enable Supabase daily backups (or PITR) on the production project.
- **Portable copy:** `DB_URL=<direct connection string> pnpm db:backup` writes `backups/tiffin-<timestamp>.dump` (schemas `public`, `private`, `auth`). Store it encrypted, off the server.
- **Keys are not in backups.** Vault keys (`phone_encryption_key`, `phone_hash_key`) live in your password manager. A restore into a new project needs the same keys, or phone numbers can't be decrypted.
- **Restore drill (monthly, and after big migrations):** `pnpm db:restore-drill` backs up the database, restores it into a scratch database, and checks every table's row count plus the ledger totals (meal balance, money, stock, locked meals). It exits non-zero on any difference. Last local run: 51 tables, all totals matched.

## Load test

`pnpm db:loadtest` builds 50 kitchens × 100 subscriptions (with addresses, recipes and menus) in a transaction that is rolled back. It times the 21:00 lunch lock, including delivery runs and ingredient deduction, and fails if it exceeds 60 s.

Last local run (Docker on the build sandbox):

| Run | Time |
|---|---|
| First-ever lock (every route built and optimised from scratch) | ~9–12 s |
| A normal day (routes saved) | 1.8 s |

## Runbooks

- **Customers say they didn't get WhatsApp messages:** check `notifications_outbox` for `failed` or `cancelled` rows and `last_error`:
  - `not_opted_in`: expected;
  - a Meta error: check the template status and the access token.
- **A slot didn't lock:** `select * from count_snapshots where service_date = '…'`; run `private.run_due_locks()`.
- **Razorpay payment not credited:** find the payment in `webhook_events` by provider and event id. A missing event means the webhook URL or secret is wrong in the Razorpay dashboard. Re-deliver from the dashboard; it's deduplicated.
- **A rider's deliveries didn't sync:** they stay on the phone until the network returns (the app retries every 30 s and on opening). Logging out is blocked while actions are waiting.
- **Data deletion request (DPDP):** the owner uses "Erase customer" (`erase_customer`), which keeps ledger totals but removes personal data. For leads, an admin marks them lost and removes notes.
