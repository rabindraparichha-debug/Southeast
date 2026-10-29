# CLAUDE.md: Tiffin Vendor Platform

A free operating system for small tiffin vendors in Bhubaneswar.

| Doc | What it holds |
|---|---|
| `docs/SPEC.md` | The spec |
| `docs/PLAN.md` | Work packages and their status |
| `docs/DECISIONS.md` | Defaults and open questions |
| `docs/AUDIT.md` | Initial audit |

**Working rules from the product owner:**
- Build one milestone at a time, then stop for review. (During M5 the owner asked to build through to the end without stopping; see D-077.)
- Never delete or rewrite existing work without asking.
- Razorpay stays in test mode until the owner explicitly approves live keys.

## Layout
```
apps/web            Next.js 16 (App Router, Tailwind 4): vendor dashboard, /c customer pages (M4), /admin
apps/mobile         Expo SDK 58 + Expo Router (src/app): vendor app + rider mode
packages/core       Pure TS shared logic: phone, money (paise), IST time, import validation (+ Vitest)
packages/db         Generated Supabase types (src/types.ts) + aliases
supabase/           config.toml, migrations/, seed.sql, tests/ (pgTAP)
tests/integration   Vitest against the running local API (OTP login + raw REST)
docs/               SPEC, PLAN, DECISIONS, AUDIT
```

## Commands
Requirements: Node 20+, pnpm 10, Docker.

```bash
pnpm install
pnpm db:start                # local Supabase (first run pulls Docker images)
pnpm db:reset                # apply migrations + supabase/seed.sql
pnpm db:test                 # pgTAP: RLS, roles, guards, import
pnpm --filter @tiffin/core test
pnpm test:integration        # needs db:start + db:reset
pnpm db:types                # regenerate packages/db/src/types.ts after every migration
pnpm db:loadtest             # 5,000-subscription lock timing (rolled back)
pnpm db:restore-drill        # backup → restore → compare counts and ledger totals

# Web
cp apps/web/.env.example apps/web/.env.local       # anon key: pnpm supabase status
pnpm --filter @tiffin/web dev                      # http://localhost:3000
pnpm --filter @tiffin/web typecheck && pnpm --filter @tiffin/web lint

# Mobile
cp apps/mobile/.env.example apps/mobile/.env.local # on a phone, use your computer's LAN IP
pnpm --filter @tiffin/mobile start                 # Expo dev server (press a for Android)
pnpm --filter @tiffin/mobile typecheck && pnpm --filter @tiffin/mobile lint
```

**Local logins:** OTP is always `123456` for the seed numbers.

| Number | Who |
|---|---|
| 90000 00001 | Owner, kitchen A (Maa Tarini Tiffin, Patia) |
| 90000 00002 | Staff, kitchen A |
| 90000 00003 | Rider, kitchen A |
| 90000 00011 | Owner, kitchen B (Saheed Nagar Mess) |
| 90000 00012 | Staff, kitchen B |
| 90000 00013 | Rider, kitchen B |
| 90000 00099 | Platform admin |
| 90000 00100 | Pending rider invite to kitchen A |
| 90000 00021 | Owner, kitchen C (Infocity Home Kitchen, live on the platform) |
| 90000 00101 – 90000 00104 | Spare (used by the M1, M3, M7 and M6 integration tests; test files run in parallel, so each suite needs its own number) |

## Conventions (follow these in every change)

**Time**
- Store `timestamptz` (UTC); display IST (`Asia/Kolkata`).
- Cutoffs are IST `time` plus a `*_prev_day` flag. Use `@tiffin/core` time helpers.

**Money**
- Integer paise only (`*_paise` columns). Use `formatPaise` / `rupeesToPaise`.

**Tenancy and access**
- Every vendor-owned table has `kitchen_id`, RLS enabled, and composite FKs `(x_id, kitchen_id)` to parents, so rows can't cross kitchens.
- Policies use `kitchen_id = any ((select private.kitchen_ids('{owner,...}'))::uuid[])`.
- **Grants are fail-closed:** new tables and functions get nothing. Add explicit `grant`s in the migration, and pgTAP tests for each role (owner, staff, rider, other kitchen, admin, anon).
- **Roles:**
  - Staff: no money, no phone numbers.
  - Riders: only their stops (M5).
  - Admins: read all; reveals are logged.

**Writes and ledgers**
- Writes that need encryption, multi-row transactions or money/count logic go through `SECURITY DEFINER` RPCs in `public`. Each one:
  - sets `search_path = ''`;
  - qualifies every name;
  - starts with `perform private.require_role(...)`.
- Internal helpers live in schema `private` (not exposed by PostgREST).
- RPCs raise short error codes (`forbidden`, `invalid_phone`, `already_exists`, …). Map them to UI text in `apps/web/src/lib/errors.ts` and `apps/mobile/src/i18n/en.ts`.
- **Ledgers are append-only:** `audit_log` now; `balance_entries` and `stock_moves` later. Use triggers raising on UPDATE/DELETE. Never store a balance or stock number.
- **Audit:** attach `private.audit_row()` to every table with money, count, membership or customer data.

**Daily engine (M2)**
- `meal_orders` for the next 7 days are reconciled by `private.refresh_orders()`. It never edits a frozen (date, slot): one whose cutoff has passed or that has a `count_snapshots` row.
- Customer requests go through `private.apply_change()`; the vendor RPC is `request_schedule_change(..., p_dry_run)`. Always preview first in the UI.
- Counted order = `status <> 'skipped' or charged`. The lock (`private.lock_slot`) is idempotent. Never add a second path that posts `meal` entries.
- Use `private.now()` / `private.ist_today()` in SQL, never `now()`, so tests can set `app.now`.
- pg_cron jobs: `tiffin-lock-due-slots` (every minute), `tiffin-nightly` (00:30 IST), `tiffin-owner-summary` (22:00 IST).

**Money (M3)**
- Every recharge, refund, credit and adjustment is one `balance_entries` row.
  - Recharges come only from `private.post_recharge()` (idempotent on the payment id).
  - Refunds come only from `private.create_refund()` (FIFO value).
- After any balance change, call `private.sync_balance_status()`. Never set `low_balance` or `suspended` by hand.
- Provider events enter only through `public.razorpay_process_event()` (service role), deduplicated on `webhook_events(provider, event_id)`.
- Edge Functions live in `supabase/functions`.
  - Shared code in `_shared/` uses no external imports, so it's unit-testable from Node.
  - Secrets go in `supabase/functions/.env` locally (see `.env.example`) and `supabase secrets set` in hosted projects.
- **Razorpay is test/mock only.** `loadConfig()` refuses live keys unless `RAZORPAY_ALLOW_LIVE=true`. Never set that without the owner's explicit approval.
- Hosted setup:
  - Webhook URL: `https://<project>.functions.supabase.co/razorpay-webhook`.
  - Events: `payment_link.paid`, `payment.captured`, `payment.failed`, `payment_link.expired`, `payment_link.cancelled`, `refund.processed`, `refund.failed`.

**WhatsApp (M4)**
- One platform number. Inbound goes through `whatsapp-webhook` (Meta HMAC check, dedupe on message id). It calls service-role RPCs `wa_*`, then the bot (`_shared/bot.ts`).
- The bot is pure logic with injected `BotDeps`; add flows there and unit-test them in `tests/integration/bot.test.ts`.
- **Guardrails stay in code** (`_shared/ai.ts`: `needsHuman`, `guardReply`). Never let the AI state prices or make promises.
- **Outbound:** always enqueue to `notifications_outbox`. Add a template to `_shared/templates.ts` **and** `docs/WHATSAPP_TEMPLATES.md`, and get it approved by Meta before use.
- **Customer page:** `portal_*` RPCs are granted to anon and must start with `private.portal_customer(p_token)`.
- **Inbox:** owner-only (D-060).

**Rider mode (M5)**
- Runs are built at lock by `private.build_runs()` (trigger on `count_snapshots`); it re-syncs only `planned` runs. Owners can rebuild with `plan_runs`.
- The saved order lives in `route_stops`. Any reorder or move must write back there (`persist_run_order`), so the next day keeps it.
- Rider actions go through `complete_stop` / `fail_stop` / `start_run` / `finish_run` with `p_at` (device time) and `p_client_op` (idempotency key). Never use `now()` for a rider's action time.
- Riders reach data only via `rider_today()` and `my_run_ids()` (today's own runs). Never expose `delivery_stops.otp` or full phone numbers to them; calls go through `rider_call_number` (logged).
- The mobile offline queue is `apps/mobile/src/lib/rider-store.ts`: every rider write goes through `act()`.

**Inventory (M6)**
- Stock is the sum of `stock_moves` (append-only); never store a stock number. Every write goes through an RPC that converts units with `private.convert_qty()` and stores the item's unit.
- Consumption happens only in `private.consume_for_slot()` (lock trigger), one move per item per snapshot. Never add a second path that posts `consume` moves.
- Costs: `private.item_unit_cost()` (90-day weighted average); store `unit_cost_paise` on each move.
- Supplier dues, payments, adjustments and cost reports are owner-only; staff do the rest of inventory.

**Acquisition (M7)**
- Leads and vendor applications belong to the platform: admin-only RLS; vendors see a customer only once the lead picks their kitchen.
- All lead writes go through `private.upsert_lead()` (one open lead per phone) and `private.convert_lead()` (the only place that creates `platform_sourced` customers). Funnel stages after matching are set only by real events (the recharge trigger), never by hand.
- Matching is `private.match_kitchens()`; change its rules there and in `docs/DECISIONS.md` D-078.
- Unknown WhatsApp numbers go to `_shared/lead-bot.ts` (customer qualification, or vendor sign-up); unit-test flows in `tests/integration/lead-bot.test.ts`.
- Outbox recipients can be `lead` or `vendor_application`; they need opt-in outside the 24 h window like customers.
- Public anon RPCs (`submit_lead`, `lead_choose`, `kitchen_profile`, `kitchen_directory`, `submit_vendor_application`, `portal_review`) must validate everything themselves.

**Hardening (M8)**
- `supabase/tests/09_security.test.sql` pins schema-wide rules (RLS everywhere, definer hygiene, anon allowlist, no direct ledger writes, private buckets). If you add an anon RPC or a public bucket, update its allowlist deliberately.
- Performance: `pnpm db:loadtest` (21:00 lock for 5,000 subscriptions must stay under 60 s). Anything you hang off the lock (`count_snapshots` triggers) must stay fast and must never raise.
- Backups: `pnpm db:backup`, `pnpm db:restore-drill`. Edge Function errors go through `_shared/monitor.ts` (`reportError`, phones masked).

**Migrations and data**
- Migrations are named `supabase/migrations/YYYYMMDDHHMMSS_name.sql`. Never edit an applied migration once it has been pushed to a shared environment; add a new one.
- Seed data lives only in `supabase/seed.sql` (local).

**Tests (required for every change)**
- Money, counts and permissions logic: pgTAP in `supabase/tests`.
- Pure logic: Vitest in `packages/core`.
- End-to-end API behaviour: `tests/integration`.

**Next.js 16**
- `src/proxy.ts`, not middleware.
- `cookies()`, `params` and `searchParams` are async.
- Read `apps/web/AGENTS.md` and `node_modules/next/dist/docs` before using unfamiliar APIs.
- Server pages read data through `@/lib/supabase/server` with the user's session. Client forms call the same RPCs the mobile app uses.

**Expo SDK 58**
- Read `apps/mobile/AGENTS.md`.
- Install native packages with `npx expo install` (in a sandbox without api.expo.dev, use `EXPO_OFFLINE=1 npx expo install …`).
- Routes live in `apps/mobile/src/app`.

## Environment variables
Every variable is documented in the root `.env.example`.

| Variable | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | apps/web | `apps/web/.env.local` |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | apps/mobile | `apps/mobile/.env.local` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | tests/integration | Optional; defaults to `supabase status` |

Edge Function secrets (`supabase/functions/.env`):

| Variable | Notes |
|---|---|
| `RAZORPAY_MODE` | `mock` (default without keys) or `test` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | `rzp_test_…` only |
| `RAZORPAY_WEBHOOK_SECRET` | Must match the webhook secret set in Razorpay |
| `PUBLIC_FUNCTIONS_URL` | Browser-reachable functions URL, used for mock payment pages |
| `RAZORPAY_ALLOW_LIVE` | Unset. Only the owner may approve live mode |

WhatsApp and AI Edge Function secrets (same file):

| Variable | Notes |
|---|---|
| `WHATSAPP_MODE` | `mock` (default) or `live` |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Live only |
| `WHATSAPP_APP_SECRET` | Verifies Meta webhooks |
| `WHATSAPP_VERIFY_TOKEN` | Webhook subscription handshake |
| `PUBLIC_WEB_URL` | Base URL for customer page links |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional AI fallback |

Web: `NEXT_PUBLIC_WHATSAPP_NUMBER` (platform number for invites) and `NEXT_PUBLIC_GRIEVANCE_CONTACT`.

Lead intake Edge Function secrets (same file): `LEAD_INTAKE_KEY` (Justdial and generic JSON, `?key=`) and `GOOGLE_ADS_LEAD_KEY` (must match the key set in the Google Ads lead form). Endpoints: `https://<project>.functions.supabase.co/lead-intake?source=google_ads|justdial|instagram|website|referral|other`.

Vault also needs `public_web_url` (links in messages, e.g. `https://app.example.in`).

Routing Edge Function secrets (same file): `VROOM_URL` (optional; without it the built-in optimiser is used) and `VROOM_USE_ROUTING` (`true` only if the VROOM server has its own OSRM/ORS).

Vault (database), needed for the cron to reach the outbox function: `functions_base_url`, `service_role_key`. Local values come from `seed.sql`.

Monitoring (optional): `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (Edge Functions), `NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_POSTHOG_KEY`/`NEXT_PUBLIC_POSTHOG_HOST` (web), `EXPO_PUBLIC_SENTRY_DSN` (mobile). All listed in `.env.example`.

## Secrets
- Never commit secrets. `.env*` files are gitignored except `.env.example`.
- Phone encryption keys live in **Supabase Vault**, never in code. Local dev keys are created by `seed.sql`.
- For each real project, run this once in the SQL editor, with values from a password manager:
  ```sql
  select vault.create_secret('<64 random chars>', 'phone_encryption_key');
  select vault.create_secret('<64 random chars>', 'phone_hash_key');
  ```
  Losing `phone_encryption_key` makes stored phone numbers unreadable. Rotating `phone_hash_key` requires re-hashing every number.

## Sandbox notes (cloud sessions)
- Start Docker with `dockerd &` if `docker info` fails.
- If image pulls from ECR or GHCR are rate-limited, pull from `mirror.gcr.io/library/<image>` and `docker tag` the result to the expected name.
- docs.expo.dev and api.expo.dev are blocked. Use the docs and types bundled in `node_modules`.
