# Plan

Build order: P1 → P4. P5 and P6 are design-for only. Status: ✅ done · 🟡 partial · ⬜ not started.

## P1: Vendor OS core (M1–M3)
**Goal:** 5 pilot vendors run a full week with no paper register.

### M1: Foundation ✅ (built 2026-10-27, waiting for your test pass)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 1.1 | Tables, roles, RLS, audit log, generated types | ✅ | `supabase/migrations/2026102700010x_*.sql`, `packages/db` |
| 1.2 | Phone OTP login, kitchen profile, members, cutoffs, capacity; Expo and Next.js shells | ✅ | `apps/web`, `apps/mobile` |
| 1.3 | Customers and plans, Excel/CSV import, address pin | ✅ | `apps/web/src/app/(app)/customers`, `packages/core/src/import.ts`, `import_customers()` |

Acceptance tests:
- ✅ **2 kitchens; kitchen A staff can't see kitchen B's customers, including via the API.** Covered by `supabase/tests/01_rls_isolation.test.sql` and `tests/integration/m1.test.ts` (OTP login plus raw REST calls).
- ✅ **Import 50 customers, 3 bad rows: bad rows reported, the rest saved.** Covered by `supabase/tests/02_rpcs_and_guards.test.sql`, `tests/integration/m1.test.ts` and `packages/core/test/core.test.ts`.

Known gaps carried forward:
- Seed has no "week of meals" yet (comes with M2's `meal_orders`).
- Web dashboard strings aren't on translation keys yet (D-006).
- Production OTP channel and production map tiles aren't set up (D-004, D-013).

### M2: Daily engine ⬜ (needs D-002 and D-007 answered)

| Pkg | Scope | Status |
|---|---|---|
| 1.4 | Generation, skip, pause, resume, cancel, cutoffs, lock (pg_cron, idempotent) | ⬜ |
| 1.5 | Production sheet, packing list, owner's 10 pm summary | ⬜ |

Tests: 20 customers, 3 skips before cutoff and 1 after → locked count 17, late skip marked charged. Running the lock job twice duplicates nothing.

### M3: Money ⬜ (needs D-002 and D-003)

| Pkg | Scope | Status |
|---|---|---|
| 1.6 | Ledger, Razorpay links, webhooks, linked accounts (test mode) | ⬜ |
| 1.7 | Cash, dues, refunds, collections report | ⬜ |
| 1.8 | Offline-customer quick actions, printed sheets | ⬜ |

Tests: a ₹2,000 test payment creates exactly one recharge even if the webhook fires twice. Cancelling with 9 meals left gives the correct refund, visible to both sides.

## P2: WhatsApp and riders (M4–M5)

| Pkg | Scope | Status |
|---|---|---|
| 2.1 | Cloud API webhook, templates, outbox, opt-in | ⬜ |
| 2.2 | Bot flows, 3 languages, 7 pm nudge | ⬜ |
| 2.3 | Customer magic-link page (placeholder route `/c` exists) | 🟡 |
| 2.4 | Vendor inbox | ⬜ |
| 2.5 | AI fallback with guardrails | ⬜ |
| 2.6 | Runs, stops, proof, failed flow, offline sync (rider tab placeholder exists) | 🟡 |
| 2.7 | VROOM service, saved routes, drag reorder | ⬜ |
| 2.8 | Tiffin tracking, live board, "on the way" message | ⬜ |

## P3: Kitchen operations (M6)

| Pkg | Scope | Status |
|---|---|---|
| 3.1 | Items, suppliers, purchases | ⬜ |
| 3.2 | Recipes and auto-consumption | ⬜ |
| 3.3 | Stock-take, wastage, alerts | ⬜ |
| 3.4 | Cost per meal | ⬜ |

## P4: Growth and launch (M7–M8)

| Pkg | Scope | Status |
|---|---|---|
| 4.1 | Lead intake | ⬜ |
| 4.2 | Qualification and matching (PostGIS columns and indexes already in place) | ⬜ |
| 4.3 | Kitchen profile pages | ⬜ |
| 4.4 | Trial and conversion, `platform_sourced` (guard trigger and tests already in place) | 🟡 |
| 4.5 | Admin console and funnel (kitchen list and status control exist) | 🟡 |
| 4.6 | Backups, restore drill, Sentry, load test, security review | ⬜ |
| 4.7 | Play Store build | ⬜ |

## P5 / P6: design-for only
Schema room already left:
- `customers.payer_customer_id` (parent pays, student eats);
- `kitchen_payout_accounts` (Route split commission);
- `platform_sourced`.

Nothing else is built.

## Things to start outside code now
These have external lead times:
- Meta Business verification and WhatsApp number.
- Razorpay test account, plus the Route/Subscriptions question (D-003).
- DLT registration if SMS OTP is wanted (D-004).
- Ola Maps or Google Maps API key (D-013).
