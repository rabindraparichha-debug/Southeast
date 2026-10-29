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

### M2: Daily engine ✅ (built 2026-10-29, waiting for your test pass)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 1.4 | Generation, skip, pause, resume, cancel, cutoffs, lock (pg_cron, idempotent) | ✅ | `supabase/migrations/20261029000100_daily_engine.sql` |
| 1.5 | Production sheet, packing list, owner's 10 pm summary | 🟡 | Web `/sheet` (printable) and mobile packing list ✅. The 22:00 summary and production sheet are **queued** in `notifications_outbox`; WhatsApp delivery comes in M4 |

Acceptance tests:
- ✅ **20 customers, 3 skips before cutoff and 1 after → locked count 17, late skip marked charged.** Covered by `supabase/tests/03_daily_engine.test.sql` (simulated clock).
- ✅ **Running the lock job twice duplicates nothing** (snapshot, meal entries, production-sheet message). Same file.
- Also covered:
  - the phone-close rule and waiver;
  - pause → paused → resume → active, with every transition logged;
  - weekly off;
  - temporary address change;
  - cancel with notice;
  - permissions for staff, other kitchens and anon;
  - append-only ledgers;
  - `tests/integration/m2.test.ts` over the API.
- Scale probe: 5,000 subscriptions across 50 kitchens. Nightly generation (60,000 orders) takes 3.1 s; locking 3 slots (15,000 meal entries) takes 1.0 s.

Known gaps carried forward:
- Low-balance and suspended transitions need recharges (M3). Until then balances can go negative and nobody is auto-suspended (D-029).
- Ingredient deduction at lock needs recipes (M6); the hook point is in `lock_slot`.
- Add-ons in counts come with priced add-ons (M3).
- WhatsApp image/PDF of the sheet and the 10 pm summary are delivered in M4. The push notification at cutoff needs expo-notifications plus an EAS project (M4).
- Trial subscriptions generate no meals, as the spec says (D-033).

### M3: Money ✅ (built 2026-10-30, waiting for your test pass)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 1.6 | Ledger, Razorpay links, webhooks, linked accounts | ✅ (test/mock mode) | `supabase/migrations/20261029000200_money.sql`, `supabase/functions/razorpay-*` |
| 1.7 | Cash, dues, refunds, collections report | ✅ | Customer Money panel, `/money`, receipts |
| 1.8 | Offline-customer quick actions and printed sheets | ✅ | Two-tap cash and links (mobile), `/print/register`, `/print/receipt/[id]` |

Acceptance tests:
- ✅ **A ₹2,000 test payment creates exactly one recharge, even if the webhook fires twice.**
  - `supabase/tests/04_money.test.sql`: the same event id, plus a second event type for the same payment.
  - `tests/integration/m3.test.ts`: real HTTP through the webhook Edge Function, with signature check.
- ✅ **Cancelling with 9 meals left gives the correct refund, visible to both sides.**
  - pgTAP: 30 meals prepaid at ₹70, 21 eaten through real locks, cancel → ₹630 refund. The vendor sees it on the customer page and Money page; the customer gets a refund notice and a receipt (queued for WhatsApp).
  - Integration: the same flow over the API, refunded online through `razorpay-refund` and closed by the refund webhook.
- Also covered:
  - FIFO valuation across price changes, and partial refunds;
  - meals already past cutoff are charged before a refund is valued;
  - balance-driven states (low balance, suspended, back to active; trial → active on payment; grace-period and unpaid-trial cancellation);
  - credit limit;
  - dues reminders on day 1, 3 and 7;
  - collections report;
  - permissions for staff, rider, other kitchen, admin and anon;
  - live-key guard and signature verification (unit tests).

Known gaps carried forward:
- **No real Razorpay call has been made.** Everything ran in mock mode with correctly signed events, since there are no keys yet. Test-mode keys plus the Route answer (D-003) are needed to try the real API.
- **UPI Autopay** (Razorpay Subscriptions, 24-hour pre-debit notices) is not built; it's blocked on D-003. The autopay share shows 0%.
- **Linked-account onboarding through the API** is manual for now: an admin pastes the Route account id after KYC in the Razorpay dashboard. M8 automates it.
- **Messages:** receipts, refund notices, low-balance and dues reminders are queued in `notifications_outbox`; WhatsApp delivery comes in M4.
- **Add-ons** (D-038) are still deferred.
- **Refunds:** one online refund can't be split across several payments; if no single payment covers it, it's paid in cash or UPI.

## P2: WhatsApp and riders (M4–M5)

### M4: WhatsApp ✅ (built 2026-10-30, mock Cloud API; waiting for your test pass)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 2.1 | Cloud API webhook, templates, outbox, opt-in | ✅ (mock mode) | `supabase/functions/whatsapp-webhook`, `whatsapp-outbox`, `_shared/templates.ts`, `docs/WHATSAPP_TEMPLATES.md` |
| 2.2 | Bot flows, 3 languages, 7 pm nudge | ✅ (Odia/Hindi are drafts) | `_shared/bot.ts`, `_shared/bot-i18n.ts`, `private.queue_tomorrow_nudges` |
| 2.3 | Customer magic-link page | ✅ | `apps/web/src/app/c/[token]` |
| 2.4 | Vendor inbox | ✅ | Web `/inbox`, mobile Inbox tab |
| 2.5 | AI fallback with guardrails | ✅ (rule-based without a key) | `_shared/ai.ts` |

Acceptance tests:
- ✅ **A WhatsApp pause at 20:55 drops tomorrow's lunch count by one and shows in the vendor feed.**
  - `supabase/tests/05_whatsapp.test.sql`: simulated clock, plus a 21:05 change that is previewed as charged.
  - `tests/integration/m4.test.ts`: the same pause over real HTTP.
- ✅ **"Can I get a discount?" gets no promise and is handed off to the vendor.**
  - `tests/integration/bot.test.ts`: even a model that *would* promise a discount is never asked, because the code guardrail catches it first.
  - `tests/integration/m4.test.ts`: through the webhook; the conversation shows in the inbox as "needs reply" and the owner gets an alert.
- Also covered:
  - routing (unknown numbers, customers of several kitchens, invite codes) and message dedupe;
  - outbox window and opt-in rules, retries, delivery statuses;
  - permissions (owner-only inbox, anon customer page);
  - complaint escalation after 2 hours, with resolution credit;
  - expired customer-page links, broadcast cap, 7 pm nudge.

Known gaps carried forward:
- **No real Meta account yet**, so everything ran in `WHATSAPP_MODE=mock`. Templates must be submitted and approved (`docs/WHATSAPP_TEMPLATES.md`) before live use.
- **Translations:** Odia and Hindi bot and page texts are my drafts; a native speaker must review them (D-057).
- **AI fallback:** without `ANTHROPIC_API_KEY` it is rule-based (a few FAQs, otherwise hand-off). The Claude path is written with the SDK but has not been called for real.
- **Complaint photos:** WhatsApp media is stored as the Meta media id. Downloading it into Supabase Storage comes later.
- **Push notifications** (cutoff push, inbox alerts in the app) still need expo-notifications and an EAS project. Owner alerts currently go out as WhatsApp templates.
- **Mobile web build only:** after switching tabs, the hidden previous tab can block taps. This doesn't affect the Android target, but needs a check on a device.

### M5: Rider mode ⬜

| Pkg | Scope | Status |
|---|---|---|
| 2.6 | Runs, stops, proof, failed flow, offline sync (rider tab placeholder exists) | 🟡 |
| 2.7 | VROOM service, saved routes, drag reorder | ⬜ |
| 2.8 | Tiffin tracking, live board, "on the way" message (`record_cash_at_door` already exists) | ⬜ |

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
