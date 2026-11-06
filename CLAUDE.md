# CLAUDE.md: Tiffin Vendor Platform

A free operating system for small tiffin vendors in Bhubaneswar.

| Doc | What it holds |
|---|---|
| `docs/SPEC.md` | The spec |
| `docs/PLAN.md` | Work packages and their status |
| `docs/DECISIONS.md` | Defaults and open questions |
| `docs/AUDIT.md` | Initial audit |
| `docs/LOGIN.md` | Login codes: WhatsApp/SMS providers, hosted auth settings |

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
Requirements: Node 22 (22.13 or later; `nvm use` reads `.nvmrc`), pnpm 10, Docker. Node 20 cannot run the integration tests or Expo SDK 58.

```bash
pnpm install
pnpm db:start                # local Supabase (first run pulls Docker images)
pnpm db:reset                # apply migrations + supabase/seed.sql
pnpm db:test                 # pgTAP: RLS, roles, guards, import
pnpm --filter @tiffin/core test
pnpm test:integration        # needs db:start + db:reset
pnpm db:types                # regenerate packages/db/src/types.ts after every migration
pnpm db:loadtest             # 5,000-subscription lock timing (rolled back)
pnpm db:restore-drill        # backup → restore → compare counts and ledger totals (DB_URL=…: into a staging copy)
scripts/deploy.sh --self-test   # hosted deploy guards; real deploys: docs/OPERATIONS.md (never config push / db reset / seed)

# Every check in one go (stack, pgTAP, types, integration, load test, typecheck, lint, builds);
# prints a PASS/FAIL table. In a worktree, give it its own stack: docs/OPERATIONS.md "Verifying a branch"
scripts/verify-all.sh [--skip-mobile-export] [--skip-build] [--keep-stack]
PROJECT_ID=tiffinmv PORT_BASE=6132 INSPECTOR_PORT=8783 scripts/verify-all.sh

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
| 90000 00110 | Manager, kitchen A |
| 90000 00111 | Accountant, kitchen A |
| 90000 00011 | Owner, kitchen B (Saheed Nagar Mess) |
| 90000 00012 | Staff, kitchen B |
| 90000 00013 | Rider, kitchen B |
| 90000 00099 | Platform admin |
| 90000 00100 | Pending rider invite to kitchen A |
| 90000 00021 | Owner, kitchen C (Infocity Home Kitchen, live on the platform) |
| 90000 00101 – 90000 00106 | Spare (used by the M1, M3, M7, M6, P5/P6 and vendor-first wave 1 integration tests; test files run in parallel, so each suite needs its own number) |
| 90000 00107 | Spare (login codes: `tests/integration/auth-sms.test.ts`) |
| 90000 00112 – 90000 00119 | Spare (00113–00115: the wave-2 integration test's owner, manager and accountant) |
| 90000 00120 – 90000 00121 | Spare (used by the vendor-first wave 3 ops integration test: owner of its own kitchen, and an outsider) |
| 90000 00130 | Spare (used by the wave 3 riders integration test, `tests/integration/w3-riders.test.ts`) |
| 90000 00140 – 90000 00148 | Spare (wave 3 safety: `tests/integration/w3-safety.test.ts` uses 00140) |
| 90000 00149 | Spare (wave 4: phone + password sign-up test; never logs in with a code) |
| 90000 00150 – 90000 00159 | Spare for the wave 4 onboarding tests (00155 – 00159 are deliberately not on the seed's allowed list, so new kitchens are refused for them) |
| 90000 00160 – 90000 00169 | Spare for the Phase 2 hardening tests (00160: `tests/integration/phase2.test.ts`) |
| 90000 00170 – 90000 00179 | Spare (00170: the held-back import integration test's owner) |
| 90000 00180 – 90000 00189 | Spare for the held-back apps track (`held-apps.test.ts` uses 00180 – 00182) |

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
  - Manager (D-117/D-156): every `'{owner}'` check also accepts a manager (`private.expand_roles`). Owner-only areas pass `true`: `private.require_role(k, '{owner}', true)` / `private.kitchen_ids('{owner}', true)` (inbox, broadcasts, settings, members and invites, payouts, commission, audit log). Decide for every new owner check.
  - Accountant: reads money only. Add `accountant` explicitly to money reads (`'{owner,accountant}'`); never to a write. Phones masked.
  - Staff: no money, no phone numbers.
  - Riders: only their stops (M5); change requests via `rider_request_change`, approved by owner/manager.
  - Admins: read all; reveals are logged.

**Writes and ledgers**
- Writes that need encryption, multi-row transactions or money/count logic go through `SECURITY DEFINER` RPCs in `public`. Each one:
  - sets `search_path = ''`;
  - qualifies every name;
  - starts with `perform private.require_role(...)`.
- Internal helpers live in schema `private` (not exposed by PostgREST).
- RPCs raise short error codes (`forbidden`, `invalid_phone`, `already_exists`, …). Map them to UI text in `apps/web/src/lib/errors.ts` and `apps/mobile/src/i18n/en.ts`.
- **Ledgers are append-only:** `audit_log` now; `balance_entries` and `stock_moves` later. Use triggers raising on UPDATE/DELETE. Never store a balance or stock number.
- **Audit:** attach `private.audit_row()` to every table with money, count, membership or customer data. (`balance_entries` is the exception: append-only with `created_by`/`created_at`, it is its own audit record.)

**Daily engine (M2)**
- `meal_orders` for the next 7 days are reconciled by `private.refresh_orders()`. It never edits a frozen (date, slot): one whose cutoff has passed or that has a `count_snapshots` row.
- Customer requests go through `private.apply_change()`; the vendor RPC is `request_schedule_change(..., p_dry_run)`. Always preview first in the UI.
- Counted order = `status <> 'skipped' or charged`. The lock (`private.lock_slot`) is idempotent. Never add a second path that posts `meal` entries.
- Use `private.now()` / `private.ist_today()` in SQL, never `now()`, so tests can set `app.now`.
- pg_cron jobs: `tiffin-lock-due-slots` (every minute), `tiffin-nightly` (00:30 IST), `tiffin-owner-summary` (22:00 IST), `tiffin-plan-prices` (00:05 IST, wave 4).

**Money (M3)**
- **Billing mode (D-115, D-156):** `customers.billing_mode` is `monthly` (default from `kitchen_settings.default_billing_mode`; pay later, never suspended or cancelled automatically) or `prepaid` (meal balance, low balance, suspend, grace cancel).
  - Owed meals are valued only by `private.recent_meals_value` (newest debt rows at their own price, the rest at the price per meal). A mode switch carries dues in rupees on its conversion row; never value meal debts anywhere else.
  - Monthly: the rupee balance Σ `amount_paise` is the truth; dues = −that. Payments carry 0 meals; credits are valued by the trigger `balance_entries_value_monthly`; adjustments take `p_amount_paise`.
  - Never value dues or statements with today's plan price: every meal carries its own `amount_paise`. `private.customer_unit_price` is only for turning rupees into meals.
  - Switch modes only with `set_billing_mode` (converts the balance once). Anything that suspends, cancels, reminds or flags on a low balance must skip monthly customers.
  - Customer messages (D-157): monthly customers get the month-end `statement_ready` (Phase 2 flag only) instead of low-balance/dues reminders, and `payment_receipt_monthly` (rewritten at outbox insert). "Overdue" for monthly customers is `private.unpaid_through(customer, cutoff)` (oldest charges settled first) with `kitchen_settings.dues_overdue_days`; never flag a monthly customer just for owing.
- Payments: `record_payment` takes `p_client_op` (idempotency) and `p_paid_at` (backdate); mistakes are fixed with `void_payment` (append-only reversal), never a negative adjustment.
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
  - Events: `payment_link.paid`, `payment.captured`, `payment.failed`, `payment_link.expired`, `payment_link.cancelled`, `refund.processed`, `refund.failed`, and (Route, wave 3) `transfer.processed`, `transfer.settled`, `transfer.failed`, `transfer.reversed`.

**WhatsApp (M4)**
- One platform number. Inbound goes through `whatsapp-webhook` (Meta HMAC check, dedupe on message id). It calls service-role RPCs `wa_*`, then the bot (`_shared/bot.ts`).
- The bot is pure logic with injected `BotDeps`; add flows there and unit-test them in `tests/integration/bot.test.ts`.
- **Guardrails stay in code** (`_shared/ai.ts`: `needsHuman`, `guardReply`). Never let the AI state prices or make promises.
- **Outbound:** always enqueue to `notifications_outbox`. Add a template to `_shared/templates.ts` **and** `docs/WHATSAPP_TEMPLATES.md`, and get it approved by Meta before use.
- **Outbox states (D-157):** `pending → sending → sent | mock | failed | cancelled`. Mock sends are `mock`, never `sent`: anything that means "the customer got it" (e.g. `rider_today.otp_sent`, admin metrics) counts only `sent`. A sent row is final: `wa_complete_outbox` ignores later completions, and the row id goes to Meta as `biz_opaque_callback_data` (`outbox:<id>`), matched in `wa_message_status`. Rows stuck in `sending` over 10 minutes are re-queued by `tiffin-outbox-stuck`. Never report a failure after the provider accepted a message; `whatsapp-webhook` answers 503 when it cannot record an `outbox:` status (Meta retries). Admin stuck counts and the sweep are WhatsApp-only.
- **Customer page:** `portal_*` RPCs are granted to anon and must start with `private.portal_customer(p_token)`.
- **Inbox:** owner-only (D-060).

**Rider mode (M5)**
- Runs are built at lock by `private.build_runs()` (trigger on `count_snapshots`); it re-syncs only `planned` runs. Owners can rebuild with `plan_runs`.
- The saved order lives in `route_stops`. Any reorder or move must write back there (`persist_run_order`), so the next day keeps it.
- Rider actions go through `complete_stop` / `fail_stop` / `start_run` / `finish_run` with `p_at` (device time) and `p_client_op` (idempotency key). Never use `now()` for a rider's action time.
- Riders reach data only via `rider_today()` and `my_run_ids()` (today's own runs). Never expose `delivery_stops.otp` or full phone numbers to them; calls go through `rider_call_number` (logged).
- The mobile offline queue is `apps/mobile/src/lib/rider-store.ts`: every rider write goes through `act()`.
- The queue never drops an action. Only the codes in `FINAL_ERRORS` (`rider-queue.ts`, mobile and web twins) are final, and those move to the saved "needs attention" list with photo and cash; everything else is retried with backoff. If a rider RPC gets a new `raise`, add the code there and in `tests/integration/rider-queue.test.ts`.

**Riders, wave 3 (D-167…D-171, D-174…D-176, D-179)**
- A new route's rider comes only from `private.default_rider()` (the only rider; no rider = the owner; 2+ riders = nobody). Owners see riderless runs through `unassigned_runs()` and take them with `assign_run`.
- Bulk route changes go through `assign_routes_by_area` (preview with `p_dry_run` first). The import Route column is handled by the `import_rows` trigger (`private.import_row_route`); don't add route logic to `import_customers`.
- Delivery credits are posted only by `private.post_stop_credit()` and taken back only by `private.reverse_stop_credit()` (an `adjust` row, `ref_type 'stop_credit_reversal'`). A kitchen-fault failure by a non-owner waits (`delivery_stops.credit_status = 'pending'`) for `decide_stop_credit`. Recorded outcomes change only through `correct_stop` (owner, note required).
- Rider cash is confirmed in bulk with `confirm_rider_cash`, which calls `confirm_payment` per payment; never post recharges another way.
- A kitchen's first rider takes over owner-held routes and planned runs (`members_joined_routes`, D-175). `correct_stop(..., 'pending')` is today-only (`retry_today_only`, D-176). Rebuild locked slots after route changes with `private.rebuild_locked_runs` (uses wave 1's `resync_runs` when present).

**Push and app alerts (D-172, D-173, D-177, D-178)**
- Member alerts queued for WhatsApp get a `push` twin automatically (trigger `notifications_outbox_push_twin`) when the member has a device in `member_devices`. App-only alerts use `private.notify_owners_push()`.
- When you add a member template (WhatsApp or push-only), add its title/body/path to `private.member_alert_text` (one text for push and the in-app list, `my_notifications`). Paths must be screens in `apps/mobile/src/lib/push.ts` `PATHS`.
- `push-outbox` (Edge Function, service role) sends through Expo; pure logic in `_shared/push.ts` (unit tests in `tests/integration/push.test.ts`). `PUSH_MODE=mock` is refused outside a local stack.
- The mobile app-wide guards live in `apps/mobile/src/components/app-guards.tsx` (minimum version from `app_config()` after the rider queue is sent and today's run is finished, push registration); sign-out calls `unregisterPush()` right before `auth.signOut()`, and keeps the saved token unless the server confirmed.
- Member alerts are owner alerts: who receives and lists them is `private.is_alert_role` (D-177). Non-owners who sign in on a phone call `release_device` for a token left there. Add `customer_id` to any new member-alert payload that names a customer (erasure trigger `customers_erased_alerts`).
- Native code or new permissions in the mobile app mean a version bump in `apps/mobile/app.json` and a store/EAS build, never only an `eas update`.

**Inventory (M6)**
- Stock is the sum of `stock_moves` (append-only); never store a stock number. Every write goes through an RPC that converts units with `private.convert_qty()` and stores the item's unit.
- Consumption happens only in `private.consume_for_slot()` (lock trigger), one move per item per snapshot. Never add a second path that posts `consume` moves.
- Costs: `private.item_unit_cost()` (90-day weighted average); store `unit_cost_paise` on each move.
- Supplier dues, payments, adjustments and cost reports are owner-only; staff do the rest of inventory.

**Acquisition (M7)**
- Leads and vendor applications belong to the platform: admin-only RLS; vendors see a customer only once the lead picks their kitchen.
- All lead writes go through `private.upsert_lead()` (one open lead per phone) and `private.convert_lead()` (the only place that creates `platform_sourced` customers). Funnel stages after matching are set only by real events (the recharge trigger), never by hand.
- Matching is `private.match_kitchens()`; change its rules there and in `docs/DECISIONS.md` D-078.
- While the `customer_whatsapp` flag is off the webhook sends no bot replies (`wa_receive` returns `customer_messages: false`) and `wa_claim_outbox` cancels customer, lead and applicant rows. Integration suites that drive the bot call `setCustomerWhatsapp(true)` (reset after the run by `tests/integration/global-setup.ts`).
- Unknown WhatsApp numbers go to `_shared/lead-bot.ts` (customer qualification, or vendor sign-up); unit-test flows in `tests/integration/lead-bot.test.ts`.
- Outbox recipients can be `lead` or `vendor_application`; they need opt-in outside the 24 h window like customers, except the templates in `CUSTOMER_TEMPLATES_WITHOUT_OPT_IN` (`_shared/templates.ts`: only `lead_confirm`, the confirmation link the person just asked for on the website). While `customer_whatsapp` is off, wave 2's outbox gate cancels every customer, lead and applicant row, so `lead_choose` (which only sends that link) also requires `customer_whatsapp` and answers `feature_disabled` otherwise: the marketplace needs both flags on (D-188).
- Public RPCs validate everything themselves. Anon-callable (the `09_security` anon allowlist): `kitchen_profile`, `kitchen_directory` (flag `marketplace`), `lead_confirm` (the link from the confirmation message; the only path that turns a website lead into a customer), `lead_attach_gclid`, `list_areas`, `feature_flags`, `app_config`, `referral_invite` / `referral_join` (flag `customer_portal`) and the `portal_*` customer-page RPCs (incl. `portal_review`). Since wave 3, `submit_lead`, `lead_choose` and `submit_vendor_application` are service-role only, reached through the `public-forms` Edge Function (Turnstile, per-IP and per-phone limits; see Safety below): never grant them to anon again.

**Hardening (M8)**
- `supabase/tests/09_security.test.sql` pins schema-wide rules (RLS everywhere, definer hygiene, anon allowlist, no direct ledger writes, private buckets). If you add an anon RPC or a public bucket, update its allowlist deliberately.
- Performance: `pnpm db:loadtest` (21:00 lock for 5,000 subscriptions must stay under 60 s). Anything you hang off the lock (`count_snapshots` triggers) must stay fast and must never raise.
- Backups: `pnpm db:backup`, `pnpm db:restore-drill` (docs/OPERATIONS.md). Edge Function errors go through `_shared/monitor.ts` (`reportError`, phones masked).

**P5 / P6 (P6 ships switched off)**
- **Parent pays:** balances stay per eater.
  - Set payers only through `set_payer` (trigger `private.guard_payer`: same kitchen, no self, no chains).
  - Money templates in `private.payer_templates()` are rerouted to the payer at outbox insert (`<template>_payer`); add a `_payer` template when you add one there.
- **Veg days and Kartika** are decided only in `private.refresh_orders()` (`private.is_veg_day`, `meal_orders.veg_override`). Never change diet anywhere else, and never on frozen slots.
- **Credits** (first complaint, referral) are `credit` rows with their own `ref_type` (`complaint_auto`, `referral_referee`/`referral_referrer`, `delivery_stop_order` for office stops), idempotent on the ref, followed by `sync_balance_status`.
- **Dispatch photos** are prepared time for the late alert. `delivery_stops.qr_token` is the sticker code; `complete_stop` takes an optional `p_scan_token` (last parameter, `wrong_tiffin`).
- **Commission:**
  - only `private.payment_link_record` computes it (platform customers, online);
  - `platform_commissions` is append-only, written once per captured payment;
  - the Route transfer is `routeTransfer()` in `_shared/razorpay.ts`.
- **Feature flags** live in `platform_settings`. Gate every entry point with `private.require_feature('<key>')` (`feature_disabled`), and test both flag states.
  - Phase flags (all off): `customer_whatsapp`, `customer_portal`, `online_payments`, `marketplace`, `growth`, `extras`. While `customer_whatsapp` is off the outbox stores messages to customers, leads and applicants as `cancelled` (`customer_messages_off`); tests that need customer messages switch it on. Crons go through flag-checked wrappers (`private.cron_*`).
  - Outbox rows expire (`expires_at`, default 48 h after due); the worker never sends an expired row.
- **Shared phones (D-118):** several customers of a kitchen may share a phone. Never assume one customer per phone hash: return all, or pick deterministically (oldest) and document it. Same phone + same name = duplicate; a different name needs `p_allow_shared_phone`.
- **Offices:** grouping happens in `private.build_runs()` (one stop per office, `delivery_stops.office_id`); counts and charges stay per customer.
- **Health tags** (`customer_health`): consent required, owner + staff only, never in rider payloads.
- **Notebook import** is a preview only. Rules live in `_shared/notebook.ts` (keep `normalizePhone` in sync with `@tiffin/core`); writes go through `import_customers`.
- **Customer import (D-157):** `import_customers` takes chunks (`p_batch` client uuid, `p_first_row`, `p_total`) and is idempotent per row number; the web wizard sends `IMPORT_CHUNK_SIZE` (100) rows per call. Keep `packages/core/src/import.ts` (`previewImportRows`, error and warning codes) in step with the server: status, second plan, repeated rows (same phone + name in one batch add plans), diet warning. A retried chunk reports the stored outcome (new or merged, `import_rows.warnings`). The Status column is mapped from exact headers only (never an address "State").
- **Weather rules** live in `_shared/weather.ts` (`WEATHER_MODE=mock` by default). The `weather_*` RPCs are service-role only.

**Login codes (D-126, docs/LOGIN.md)**
- Apps call `signInWithOtp({ phone, options: { channel } })` (`whatsapp` | `sms`, offered per `*_LOGIN_CHANNELS`) and always `verifyOtp(..., type: 'sms')`. Map auth errors through `loginErrorKey` (`@tiffin/core`) in both apps.
- Default delivery is Supabase's built-in Twilio provider (dashboard settings). The optional Send SMS hook `auth-send-sms` (logic in `_shared/auth-sms.ts`, tests in `tests/integration/auth-sms.test.ts`) checks the Standard Webhooks signature first (missing secrets answer like a bad signature; replayed `webhook-id`s are refused), never logs the code or a full phone, and its mock uses `mockAllowed` (`_shared/platform.ts`).
- Supabase does not pass the channel to hooks, so with the hook on the apps must run channel-neutral (`*_LOGIN_DELIVERY=hook`, `channelNeutral` in `@tiffin/core`). Never label a code with a channel the screen cannot know.
- Hosted: "Confirm phone" on, provider keys only in the dashboard / `supabase secrets set`, never `config push`. The signup policy is still open (D-127).

**Channels, web app, builds (M9)**
- Lead channels and their setup: `docs/LEAD_SOURCES.md` (Google Ads click ids + offline conversions via `ad_conversions` and the `ads-conversions` function, mock unless `GOOGLE_ADS_MODE=live`; Justdial/Sulekha via `lead-intake`, `lead-email`, `admin_import_leads`).
- The web app is installable (docs/WEB_APP.md). The web rider queue `apps/web/src/lib/rider-store.ts` mirrors the mobile one; new fields on queued actions must be optional. Bump `VERSION` in `apps/web/public/sw.js` when its logic changes; never cache pages holding customer data.
- Android APK: `apps/mobile/scripts/build-apk.sh` (needs dl.google.com) or push a branch `apk/<name>` (GitHub Actions → pre-release). iOS: `.github/workflows/ios-testflight.yml`. Never commit a keystore.

**Held-back apps (D-128 – D-130)**
- A rider action that moves to "needs attention" is also reported to `report_sync_reject` (best effort, own storage key, `lib/rider-reject.ts` in both apps, kept identical). Never let a report block, reorder or drop a queued action; the queue rules stay in `rider-queue.ts`. Reports never carry the photo, its path, the delivery code or a phone; the server rebuilds the summary from a whitelist (`private.sync_reject_summary`).
- `rider_sync_rejects`: riders read their own rows, owners read/resolve their kitchen's (`sync_rejects`, `resolve_sync_reject`), admins all; staff nothing. `report_sync_reject` checks only that run, stop and kitchen are the same kitchen (a moved stop is the main case); a report for a client op that already synced is stored closed. Log-out sends waiting reports first (`pendingReportCount`). Customer erasure must also blank `summary.note`/`stop_label` of that `customer_id`'s reports.
- Mobile photos go through `shrinkPhoto()` (`apps/mobile/src/lib/photo.ts`) before they are saved or queued; never queue a full-size camera file.
- Adding a native module: install with `EXPO_OFFLINE=1 npx expo install`, bump `expo.version` in `apps/mobile/app.json` (runtime version policy `appVersion`) so no over-the-air update reaches an install without it, and say a new APK/TestFlight build is needed.
- Mobile text goes through `t()`; dates through the `@tiffin/core` helpers with `locale()` from `@/i18n`. New keys go in `en.ts`; Odia/Hindi drafts (`or.ts`, `hi.ts`) fall back to English until a translator adds them. Web: only the nav and Today use `lib/i18n` (`getTranslator()` on the server); keep other pages English until the drafts are reviewed.
**Onboarding and founder support (wave 4)**
- New kitchens need approval (D-131): `create_kitchen` checks `private.vendor_signup_basis()` (approved application, `vendor_allowed_phones`, `open_vendor_signup` flag, existing owner, admin). Change who may sign up there, not in the apps. A phone counts only when proven (D-139): `private.session_phone()` (OTP session, JWT `amr` `otp`); never trust `phone_confirmed_at` alone. When an account gains trust (a kitchen on an approved number, platform admin) call `private.secure_account()` (random password, other sessions end). pgTAP claims for such tests need `"amr":[{"method":"otp","timestamp":0}]`. `open_vendor_signup` changes only through `admin_set_vendor_signup` (reason, logged). The seed allows the spare test numbers except 00155 – 00159; a new integration test that creates a kitchen must use an allowed number.
- "Set up your kitchen" is gated by `onboarding_status()` (web `app/onboarding/gate.tsx`, mobile `components/onboarding-gate.tsx`): invited people are joined and sent to their kitchen, never shown the create form.
- Every founder support action writes `admin_actions` through `private.log_admin_action()` (append-only; reasons via `private.require_reason()`). Never change `private.audit_row` for this. Admin RPCs start with `perform private.require_admin()`.
- Login phones change only through the Edge Function `admin-change-phone` (Auth admin API, service role), between `admin_phone_change_check` (records a pending `private.phone_changes` row) and `admin_phone_change_done(change_id)` called as the admin; `admin_sign_out_user` signs someone out everywhere. Never log client-supplied phone digits.
- Owner-only areas (full customer phones, closing the kitchen, the admin log) check the exact owner: `private.require_owner()` / `private.owner_kitchen_ids()` (wave 2's `'{owner}'` also admits managers).
- Vendor messages that say "log in and set up your kitchen" go only to approved applicants (`growth_tick`, D-143).
- Prices: a meal is charged the plan price in force on its service date (`plan_prices`, read by `private.charge_orders`; `private.plan_price_on()` elsewhere). Change prices with `set_plan_price(plan, price, from)`; `plans.price_per_meal_paise` is "today's price", moved by `tiffin-plan-prices`.
- Phoned-in complaints: `log_complaint` (channel `vendor`, starts `responded`). Exports: `export_kitchen` (owner, paged; customer pages are logged); CSV/ZIP helpers in `@tiffin/core` (`toCsvText`, `zipFiles`). Closing a kitchen is a request (`kitchen_close_requests`), never a delete.
- Support contact: `NEXT_PUBLIC_SUPPORT_WHATSAPP` / `EXPO_PUBLIC_SUPPORT_WHATSAPP` via `SupportLink` (web falls back to `NEXT_PUBLIC_GRIEVANCE_CONTACT`; mobile onboarding shows a hint).
**Phase 2 hardening (D-146 – D-155)**
- **Delivery codes:** never raise after counting a code attempt (the raise rolls the counter back): answer `status 'pending'`, `otp_ok false`. A wrong code is counted once per `p_client_op` (`delivery_stops.otp_last_op`). `otp` is a redacted audit column (`private.audit_redacted_columns`); outbox payloads lose `otp` once not pending/sending; never copy a code anywhere else.
- **Referrals:** the share link is `/k/<slug>/join?ref=<CODE>` (`referral_invite`, `referral_join`, flag `customer_portal`). A join creates the kitchen's own customer (`source 'web'`, never platform-sourced) and records the referral; codes from another kitchen raise `referral_other_kitchen`. Count the attempt (`referral_join_attempts`) before looking at the number, give an existing number the same answer (the owner gets `referral_existing`), and never record WhatsApp opt-in from a public form that cannot prove who holds the phone.
- **AI fallback:** every model call takes a unit of the budget first (`BotDeps.aiBudget` → `wa_ai_take`; caps `AI_CONVERSATION_DAILY_CAP`, `AI_DAILY_CAP`). Build the Claude call only with `makeClaudeComplete` (`_shared/ai-claude.ts`); the model comes from `ANTHROPIC_CHAT_MODEL` / `ANTHROPIC_MODEL`.
- **Payment links:** wrap every Razorpay link creation in `createLinkOrCancel` (`_shared/payment-link.ts`, steps `create` / `attach` / `cancelGateway`): a failed create cancels the `created` row (`cancel_payment_link_record`); a failed attach is retried, then the link is cancelled at Razorpay (`cancelPaymentLink`) before the row.
- **Lead-intake keys:** header `X-Lead-Key` or Basic auth only, checked by `checkLeadKey` / `checkGoogleKey` (`_shared/leads.ts`); the only URL key is `JUSTDIAL_LEAD_KEY` on `?source=justdial`.
- **Google Ads:** mock mode stores every conversion as `mock` (never `sent` or `skipped`); only live mode skips a stage without an action id.
- **Escalated complaints:** the platform team works through the `admin_*complaint*` RPCs (reveals logged, team log `complaint_admin_events`, append-only except the erasure scrub of `note`); the team never credits meals.
- **Templates:** a new template goes in `_shared/templates.ts`, `TEMPLATE_SAMPLES` (`_shared/template-pack.ts`) and `docs/WHATSAPP_TEMPLATES.md`; regenerate `docs/whatsapp-templates.csv` (`UPDATE_TEMPLATE_PACK=1`, see the doc).
**Ops: engine health, retention, deploy (vendor-first wave 3)**
- Engine pg_cron jobs run through `private.run_job('<job>')` (heartbeat in `engine_heartbeats` when it finishes). A new engine job: add it to `run_job` and `private.engine_jobs()` (critical or not, max age), schedule it with `run_job`, and to `CRON_JOBS` in `scripts/deploy.sh`.
- Health is `private.engine_health()`: admin tile `engine_health()`, service-role `ops_health()` for the public `ops-health` function (booleans and counts only, never names, ids or error text). Wave 1's open `engine_errors` rows (seen in 26 h) make it unhealthy; only critical jobs' failed runs do (others are warnings), and a heartbeat after a failed run clears it. Anything that locks a slot outside `run_due_locks` must call `private.resolve_engine_errors(kitchen, 'lock', date, slot)` too.
- "Count not frozen" + **Freeze now** (`freeze_slot`, owner or manager) goes through `private.lock_slot` and `sync_balance_status`: the lock stays the only path that posts meal entries.
- Audit log: updates on tables listed in `private.audit_personal_keys` store only changed keys. A new table with personal data: list its personal keys there (and in `private.customer_audit_tables()` if erasure must scrub it); a new secret column: add it to `private.audit_redacted_columns()`. Never update `audit_log` except through `private.scrub_customer_audit` / `private.scrub_lead_audit` (the `tiffin.audit_scrub` guard allows `"[erased]"` replacements only).
- Erasure lives in `private.customer_erased_cleanup` (trigger on `customers.deleted_at`). New customer data anywhere must be scrubbed or deleted there.
- Retention: days in `platform_settings` `retention` (`private.retention_days`, `admin_set_retention`); `private.purge_old_data()` (job `tiffin-purge`) for rows; storage objects only through the `storage-retention` function (SQL cannot delete them). Never purge ledgers, receipts or bills.
- Hosted deploys only through `scripts/deploy.sh` (explicit function allowlist; `razorpay-mock` is never deployed; a new function must be added to `ALLOWLIST` or `NEVER`, or every deploy refuses; production needs `OPS_HEALTH_KEY`). A staging copy of production keeps its messaging jobs paused (`scripts/restore-drill.sh`). Its `service_role` ops RPCs are pinned in `09_security`.

**Safety (vendor-first wave 3)**
- **Phase flags** (D-180): `customer_whatsapp`, `customer_portal`, `online_payments`, `marketplace`, `growth`, `extras`, `kitchen_switching`, all off in Phase 1. Apps read them with `public.feature_flags()` (anon + signed in; a missing key is off): web `getFlags()` / `requireFlag()` in `apps/web/src/lib/flags.ts` (pages of a switched-off phase call `notFound()`), mobile `useFlags()` in `apps/mobile/src/lib/flags.ts`. Which screens each flag controls: `apps/web/src/lib/flag-keys.ts`. Database gates: `private.portal_customer` (customer_portal, so every `portal_*`), `private.payment_link_record` (online_payments, every payment link), `kitchen_profile`/`kitchen_directory`/`submit_lead`/`lead_choose`/`lead_confirm` (marketplace), `submit_vendor_application` (growth). A new Phase 2/3 screen or RPC gets its flag; tests switch flags on inside their transaction (pgTAP) or with `enableFlags()` (integration; never switch one off there).
- **Public forms** (D-183): the website's lead form, kitchen pick and vendor sign-up go through `supabase/functions/public-forms` (Turnstile via `_shared/turnstile.ts`, required outside a local stack; caller IP passed as `x-tiffin-client-ip`, read by `clientIp()`: `cf-connecting-ip`, else X-Forwarded-For per `PUBLIC_FORMS_XFF_HOPS`, D-187). Rate limits are `private.rate_limit(bucket, subject, limit, window)` over `rate_limit_hits` (keyed hashes only). Picking a kitchen sends a `lead_confirm` WhatsApp link; only `lead_confirm` (the phone holder) converts, so the site never reveals whether a number is a kitchen's customer.
- **Customer-page links** (D-182): owners revoke (`revoke_customer_page_links`) or rotate (`rotate_customer_page_link`); no automatic cap (links already queued or sent must keep working). A link the customer did not ask for again (e.g. reopening `lead_confirm`) must not mint a new one.
- **Refunds to Razorpay** (D-184): always `claim_refund_for_gateway` first (one gateway call per refund); Razorpay idempotency key = `<refund id>-<attempt>` (`refundIdempotencyKey`; a stale claim keeps its attempt, a retry after a failure is a new one); `release_refund_claim` only on a definite refusal.
- **Route transfers** (D-185): `payments.transfer_status` (pending at capture, then from `transfer.*` webhooks via `private.apply_transfer_event`); every payment-link path builds its Razorpay input with `linkInputFromRecord()` (commission included).
- **Verified ≠ listed** (D-186): `kitchens.verified_at` (admin `admin_verify_kitchen`); a person can list (`status = 'active'`) only a verified kitchen, and the owner cannot change a verified FSSAI number.
- **Vendor terms + DPA** (D-181): kitchen agreements are `consents` rows with `customer_id` null (purposes `vendor_terms`, `data_processing`, basis `kitchen_owner`); `accept_vendor_terms` / `vendor_terms_status`. Versions: `private.vendor_terms_versions()` = `apps/web/src/lib/legal-versions.ts` = `apps/mobile/src/lib/legal.ts`; bump all three (and the pages) together. Owners are sent to `/onboarding/terms` until they accept.
- Legal env (web): `NEXT_PUBLIC_OPERATOR_NAME`, `NEXT_PUBLIC_OPERATOR_ADDRESS`, `NEXT_PUBLIC_GRIEVANCE_OFFICER`, `NEXT_PUBLIC_GRIEVANCE_CONTACT`; a production build against a hosted Supabase URL fails without the operator name and the grievance contact (`apps/web/src/lib/legal-env.mjs`).

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
| `PLATFORM_ENV` | `local` (default only when `SUPABASE_URL` is a local stack), `staging` or `production`. Mock modes (Razorpay, WhatsApp, notebook fixture) run only when local (`_shared/platform.ts`) |
| `RAZORPAY_MODE` | `mock` (default without keys, local only) or `test` |
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
| `ANTHROPIC_CHAT_MODEL`, `AI_CONVERSATION_DAILY_CAP`, `AI_DAILY_CAP`, `AI_TIMEOUT_MS` | Chat model override and caps (D-148) |

Web: `NEXT_PUBLIC_WHATSAPP_NUMBER` (platform number for invites), the legal settings `NEXT_PUBLIC_OPERATOR_NAME`, `NEXT_PUBLIC_OPERATOR_ADDRESS`, `NEXT_PUBLIC_GRIEVANCE_OFFICER`, `NEXT_PUBLIC_GRIEVANCE_CONTACT` (production builds for a hosted project need the name and the contact), and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (public forms CAPTCHA; its secret `TURNSTILE_SECRET_KEY` is an Edge Function secret, required on hosted projects; `PUBLIC_FORMS_XFF_HOPS`, optional Edge Function secret, picks the trusted X-Forwarded-For entry for per-IP limits, D-187), and `NEXT_PUBLIC_SUPPORT_WHATSAPP` (vendor support link, wave 4; mobile: `EXPO_PUBLIC_SUPPORT_WHATSAPP`).

Login channels (docs/LOGIN.md): `NEXT_PUBLIC_LOGIN_CHANNELS` (web) and `EXPO_PUBLIC_LOGIN_CHANNELS` (mobile, build time), e.g. `whatsapp,sms`; unset means `sms` (local test numbers). `NEXT_PUBLIC_LOGIN_DELIVERY` / `EXPO_PUBLIC_LOGIN_DELIVERY`: `channel` (default, built-in provider) or `hook` (Send SMS hook on: channel-neutral screens).

Login code Edge Function secrets (`auth-send-sms`, same file; only when the Send SMS hook is used):

| Variable | Notes |
|---|---|
| `SEND_SMS_HOOK_SECRETS` | `v1,whsec_…` from Authentication > Hooks (several separated by a pipe, for rotation). The `.env.example` value is a published local placeholder, refused when hosted |
| `AUTH_SMS_MODE` | `mock` (local only, nothing sent) or `live` |
| `AUTH_SMS_ROUTES`, `AUTH_SMS_PROVIDER` | Order tried, e.g. `whatsapp:twilio,sms:telnyx`; provider for plain `sms` (`twilio` or `telnyx`) |
| `AUTH_SMS_ESCALATE_SECONDS`, `AUTH_SMS_TIMEOUT_MS`, `AUTH_SMS_BUDGET_MS` | Resend window (600), per call (2000) and total (4300) ms |
| `AUTH_SMS_ALLOWED_COUNTRY_CODES`, `AUTH_SMS_TEMPLATE`, `AUTH_SMS_VALIDITY_SECONDS`, `AUTH_SMS_MOCK_FAIL` | `91`; SMS text with `{code}` (= DLT template); Twilio validity; mock-only failures |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_WHATSAPP_CONTENT_SID`, `TWILIO_WHATSAPP_FROM`, `TWILIO_SMS_FROM` | WhatsApp authentication template (`HX…`) and senders |
| `TELNYX_API_KEY`, `TELNYX_FROM`, `TELNYX_MESSAGING_PROFILE_ID` | Telnyx SMS (India: DLT-registered alphanumeric sender) |

Local config only (`config.toml` `env()`, unset locally): `SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID`, `SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN`, `SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID`, `SUPABASE_AUTH_SMS_TWILIO_CONTENT_SID` (accepted for `config push`; CLI 2.122.0 does not pass it to the local Auth container), and `SEND_SMS_HOOK_SECRETS` in `supabase/.env` for the hook's local check (`SUPABASE_AUTH_HOOK_SEND_SMS_ENABLED=true pnpm db:start`).

Lead intake Edge Function secrets (same file): `LEAD_INTAKE_KEY` (generic JSON and `lead-email`, header `X-Lead-Key` or Basic auth), `JUSTDIAL_LEAD_KEY` (Justdial push, the only key allowed in a URL) and `GOOGLE_ADS_LEAD_KEY` (must match the key set in the Google Ads lead form). Hosted projects refuse the `local-dev-*` examples and keys under 24 characters (D-150). Endpoints: `https://<project>.functions.supabase.co/lead-intake?source=google_ads|justdial|instagram|website|referral|other`.

Vault also needs `public_web_url` (links in messages, e.g. `https://app.example.in`).

P5/P6 Edge Function secrets (same file):

| Variable | Notes |
|---|---|
| `WEATHER_MODE` | `mock` (default, no network) or `live` (Open-Meteo, no key) |
| `WEATHER_MOCK_SCENARIO` | `none` (default), `rain` or `heat`, mock mode only |
| `OPEN_METEO_URL` | Optional override of `https://api.open-meteo.com/v1/forecast` |
| `NOTEBOOK_IMPORT_MODE` | Optional `mock` to force the fixture even with `ANTHROPIC_API_KEY` set; the model is `ANTHROPIC_MODEL` |

Routing Edge Function secrets (same file): `VROOM_URL` (optional; without it the built-in optimiser is used) and `VROOM_USE_ROUTING` (`true` only if the VROOM server has its own OSRM/ORS).

Push Edge Function secrets (same file): `PUSH_MODE` (`mock` | `live`; unset = mock on a local stack, live on a hosted project; mock is refused when hosted), `EXPO_ACCESS_TOKEN` (optional, only with Expo enhanced push security) and `EXPO_PUSH_URL` (optional override of `https://exp.host/--/api/v2/push/send`).

Vault (database), needed for the cron to reach the outbox function: `functions_base_url`, `service_role_key`. Local values come from `seed.sql`.

Monitoring (optional): `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (Edge Functions), `NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_POSTHOG_KEY`/`NEXT_PUBLIC_POSTHOG_HOST` (web), `EXPO_PUBLIC_SENTRY_DSN` (mobile). All listed in `.env.example`.

Ops: `OPS_HEALTH_KEY` (Edge Function secret, required in production; `ops-health` then needs `?key=`). The deploy and restore scripts read `DB_URL`, `SOURCE_DB_URL`, `CONFIRM_WIPE`, `RESUME_JOBS`, `DB_CONTAINER`, `PG_TOOLS_IMAGE` and `OWNER_APPROVED_LIVE_PAYMENTS` (root `.env.example`, docs/OPERATIONS.md).

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
