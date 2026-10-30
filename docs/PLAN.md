# Plan

Build order: P1 → P6 (P5 and P6 built 2026-10-30 on your instruction; P6 ships switched off). Status: ✅ done · 🟡 partial · ⬜ not started.

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

### M5: Rider mode ✅ (built 2026-10-30; VROOM not tried against a real server)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 2.6 | Runs, stops, proof (OTP or photo + GPS + time), failed flow with kitchen-fault credit, offline sync | ✅ | `supabase/migrations/20261031000100_delivery.sql`, mobile "My stops" tab + `stop/[id]`, `apps/mobile/src/lib/rider-store.ts` |
| 2.7 | Route optimiser, saved routes, drag reorder that persists | ✅ (built-in optimiser; VROOM optional) | `private.tsp_order`, `build_runs`, `reorder_run`, `supabase/functions/route-optimize`, web `/delivery/routes` |
| 2.8 | Tiffin tracking, live board, "on the way" message, rider stats | ✅ | `tiffin_ledger`, web `/delivery`, `/delivery/tiffins`, `/delivery/riders`, template `on_the_way_v1` |

Acceptance tests:
- ✅ **25 stops within 3 km produce a sensible order, and a drag reorder persists to the next day.**
  - `supabase/tests/06_delivery.test.sql`: 25 customers on a 1.5 km circle around the kitchen, created in shuffled order. The run built at lock visits them house by house around the circle (planned ≈ 13.7 km). Staff drag the last stop to the front; Wednesday's run keeps Tuesday's hand-made order, and a new 26th customer is slotted in at the cheapest place without disturbing it.
  - The optimiser on its own: on scattered points within 3 km the path is under half the unordered one.
- ✅ **A delivery marked offline syncs later with its original timestamp.**
  - pgTAP: marked at 12:41, synced at 14:30 → `done_at` 12:41, `synced_at` 14:30; tiffin and cash entries also carry 12:41; the same queued action sent twice counts once.
  - `tests/integration/m5.test.ts`: the same over HTTP, with a real proof photo uploaded to Storage.
  - In the app (Expo web build, Playwright): delivered while the browser was offline, the queue survived, and the stop reached the server 8.6 s later with the tap time.
- Also covered:
  - OTP proof (wrong code online is retried, offline it is recorded and flagged), photo proof in the kitchen's folder only, GPS distance from the pin;
  - kitchen-fault failures credit the meal at the charged price and tell the customer; customer-side failures don't;
  - "on the way" messages with the delivery code, sent once; a stop moved into a run that is already out gets its own code;
  - riders see only their own runs, today only, with masked phones and no codes; calling reveals the number only for their pending stop on a run that is out, and is logged;
  - staff see the board without cash and can't see rider pay stats; other kitchens and anon see nothing;
  - tiffin ledger append-only, returns capped; rider stats (shifts, stops, km, proof rate, cash).

Known gaps carried forward:
- **VROOM:** the client and Edge Function are written and unit-tested against VROOM's documented API, but the VROOM image could not be pulled here (registry blocked), so it has never answered a real request. Without `VROOM_URL` the built-in optimiser is used (D-067).
- **Call masking** is reveal-on-tap with an audit entry, not a virtual number (D-069).
- **Delivery codes** go only to customers who opted in to WhatsApp; others need photo proof. Meta may want the code in an authentication-category template (D-070).
- **Planned km**, not GPS odometer, is what rider pay stats use (D-075).
- **Live location** is a ping every minute while the app is open on the stop list; there is no background tracking.
- **No "undo"** for a stop marked by mistake: the owner corrects it with a balance adjustment.
- **The 3-hour complaint window** after a slot closes isn't enforced; complaints are accepted any time.
- **Mobile web build only:** a web page can't reload without network (the phone app keeps running).

## P3: Kitchen operations (M6) ✅ (built 2026-10-30)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 3.1 | Items, suppliers, purchases with bill photo and supplier credit dues | ✅ | `supabase/migrations/20261102000100_inventory.sql`, web `/inventory`, `/inventory/purchases`, `/inventory/suppliers`, mobile Stock tab |
| 3.2 | Recipes per portion (any unit, e.g. "30 g") and automatic consumption at the lock; production plan | ✅ | `recipe_lines`, `private.consume_for_slot` (lock trigger), `production_plan()`, web `/inventory/recipes` |
| 3.3 | Stock-take with variance and reason prompt, wastage with reason, alerts (low stock, price jump > 15%, high variance) | ✅ | `stock_takes`, `record_waste`, `inventory_alerts()`, `stock_alert_v1`, low stock in the 10 pm summary |
| 3.4 | Cost per meal (ingredients + gas + packaging, plus waste and stock losses) and margin | ✅ | `cost_report()`, web `/reports/costs` |

Acceptance tests:
- ✅ **Toor dal at 30 g per portion with a count of 100 deducts 3 kg.**
  - `supabase/tests/08_inventory.test.sql`: the recipe is entered as "30 g" for an item stocked in kg (stored as 0.03 kg). 10 subscriptions × 10 tiffins lock at 100 meals; the lock posts one consumption of exactly −3.000 kg (stock 20 → 17 kg), plus oil and rice from the same menu. Locking again deducts nothing twice. The production plan showed the same 3 kg before the lock.
- ✅ **A stock-take 1 kg short shows as variance with a reason prompt.**
  - pgTAP: counted 26 kg against 27 kg expected → variance −1 kg, `needs_reason`; closing is refused (`reason_required`) until a reason is given; closing then posts one `count` move with the reason, and book stock equals the count. A 0.3% difference needs no reason. Items not counted are left alone.
  - `tests/integration/m6.test.ts`: the same over HTTP, with a supplier bill photo uploaded to Storage.
- Also covered: unit conversion and mismatch, price-jump flag and owner alert, supplier dues and payments, wastage, owner-only adjustments, cost per meal and margin, the 10 pm summary now carrying collections and low stock, permissions (staff: no dues, payments or costs; riders and other kitchens: nothing), append-only ledgers.

Known gaps carried forward:
- **Consumption needs menu dish names to match dish names** (case-insensitive). The production plan lists menu dishes without a recipe so they can be added.
- **Diet variants** are handled by which diets a dish serves (dal for everyone, chicken curry for non-veg). Per-plan recipes (e.g. a bigger portion for a "large" plan) aren't modelled.
- **Costing** uses a 90-day weighted average purchase price, not exact FIFO batches (D-089).
- **Gas and packaging** are flat per-meal costs set by the owner, not tracked as stock (D-089).
- **Bill photo OCR** (reading amounts from the photo) isn't built; amounts are typed.
- **Supplier payments** can't be undone or edited (append-only); "paid now" is capped at the bill total. A wrong payment is corrected with a note and the next bill.
- **The variance alert** (over 10%) is fixed; only the reason threshold (2%) is a kitchen setting.

## P4: Growth and launch (M7–M8)
**Goal:** 30 vendors live and the first platform-sourced customers paid.

### M7: Acquisition ✅ (built 2026-10-30; customers *and* vendors, as you asked)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 4.1 | Lead intake: website form, WhatsApp (incl. Instagram/Google click-to-chat codes), Google Ads lead forms, Justdial, calls, generic JSON (Zapier/Make for Meta lead ads); source + campaign on every lead | ✅ | `supabase/migrations/20261101000100_acquisition.sql`, `supabase/functions/lead-intake`, `_shared/leads.ts`, web `/find` |
| 4.2 | Qualification (location, meal times, diet, budget, start date) and matching (radius, capacity, plan/diet, ranked by verified rating and price fit; 2–3 kitchens) | ✅ | `private.match_kitchens`, `_shared/lead-bot.ts` |
| 4.3 | Public kitchen profile pages (photos, plans, menu, FSSAI number, verified ratings), directory | ✅ | web `/k/[slug]`, `/kitchens`, `kitchen_profile()`, `kitchen_reviews` |
| 4.4 | Paid trial → day-2 plan offer → plan → month-2 renewal; `platform_sourced` permanent | ✅ | `convert_lead`, `lead_funnel_on_recharge`, `growth_tick` (hourly) |
| — | **Vendor acquisition**: sign-up page and WhatsApp "Hi VENDOR" flow, auto-link to the kitchen created with the same number, onboarding checklist, nudges on day 1/3/7, demand gaps showing where to recruit | ✅ | `vendor_applications`, web `/vendors`, `/admin/vendors`, `/admin/funnel` |
| 4.5 (part) | Admin: lead console (routing, reveal logged), funnel per source/campaign, demand gaps, vendor applications | ✅ | web `/admin/leads`, `/admin/funnel`, `/admin/vendors` |

Acceptance tests:
- ✅ **A Patia lead matches only kitchens within 3 km that have capacity.**
  - `supabase/tests/07_acquisition.test.sql`: eight kitchens around Patia. Only the two that are active (FSSAI), taking leads, in range, with a veg lunch plan and a free place are offered. A full kitchen, one whose last place is held by an unpaid trial, a 5 km one, a draft one, an opted-out one and a non-veg-only one are not. A kitchen that fills up drops out. Ranking: a 5★ kitchen at the budget beats a closer, pricier one.
- ✅ **A converted lead keeps `platform_sourced = true`, and the vendor can't change it.**
  - pgTAP: website lead → pick → paid trial → day-2 plan offer → plan bought (converted) → recharge 30 days later (renewed), every step logged. The owner can't update the flag through the API or create platform-sourced customers; even with full database rights the flag can't be cleared; an existing customer of the kitchen can't be claimed by the platform.
  - `tests/integration/m7.test.ts`: the same over HTTP, with the trial paid online through the payment-link function and the Razorpay webhook; the vendor's update is refused.
- Also covered:
  - the WhatsApp lead bot end to end through the webhook (location → meal times → diet → budget → start → shortlist → pick); afterwards the number reaches the kitchen's own bot;
  - a kitchen owner signing up on WhatsApp ("Hi VENDOR <campaign>");
  - Google Ads lead forms through `lead-intake` (key checked, idempotent on the lead id), Justdial and generic parsers;
  - waitlist and demand gaps, the 24 h reminder, vendor nudges, verified-only ratings (hidden reviews drop out), public profile without phone numbers;
  - permissions: leads are admin-only (vendors and anon see none), admin phone reveals are logged.

Known gaps carried forward:
- **No real ad accounts connected.** Google Ads, Justdial and Meta lead ads have only been tested with their documented payloads; each needs its webhook URL and key configured on their side (see CLAUDE.md).
- **Instagram/Facebook lead ads** come in through click-to-chat codes ("Hi TIFFIN ig-…") or a Zapier/Make hook to the generic endpoint, not a direct Meta Lead Ads integration (it needs a Meta app review).
- **Area matching** uses 31 approximate area centres for typed areas; a shared location is precise (D-080).
- **Kitchen photos** are uploaded by owners; the seed has none, so profile pages show a placeholder.
- **A 2-meal trial is a "low balance"** under the M3 rules, so the customer may also get the low-balance reminder that evening, as well as the day-2 plan offer (D-079).
- **Calls** are entered by the team in the admin console; there is no telephony (IVR) integration.
- **Review moderation** has its RPCs (`admin_reviews`, `admin_hide_review`); the admin page for it comes with the M8 admin console.

### M8: Admin and hardening ✅ (built 2026-10-30; Play Store build waits on your accounts)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 4.5 | Admin console: platform metrics vs the P2/P4 goals, kitchens (KYC, status, FSSAI correction, checklist), leads, funnel, demand gaps, vendor applications, audit log, review moderation | ✅ | web `/admin/*`, `platform_metrics()`, `admin_kitchens()`, `admin_audit_log()`, `admin_reviews()` |
| 4.6 | Backups and restore drill, error monitoring (Sentry envelopes), analytics (PostHog, opt-in), load test, security review | ✅ | `scripts/backup.sh`, `scripts/restore-drill.sh`, `supabase/perf/lock_load.sql`, `supabase/tests/09_security.test.sql`, `_shared/monitor.ts`, docs/SECURITY.md, docs/OPERATIONS.md |
| 4.7 | Play Store build | 🟡 configured | `apps/mobile/eas.json`, `app.json`, docs/RELEASE.md. A build needs your Expo and Play accounts (D-094) |
| — | Privacy policy and terms (drafts) | ✅ | web `/privacy`, `/terms` |

Acceptance tests:
- ✅ **The 21:00 lock for 5,000 subscriptions finishes in under 60 seconds.** `pnpm db:loadtest`: 50 kitchens × 100 subscriptions with addresses, recipes and menus. Everything the lock does is included: snapshot, 5,000 meal charges, 5,000 delivery stops, 200 ingredient deductions.
  - First-ever lock, when every route is built and optimised from scratch: 9–12 s.
  - A normal day: 1.8 s.
  - The load test found a quadratic first route build (31 s), fixed in `20261103000200_route_build_speed.sql`.
- ✅ **A restored backup matches the counts.** `pnpm db:restore-drill` dumps `public`, `private` and `auth`, restores into a scratch database, and compares all 51 tables' row counts plus the ledger totals (meal balance and money, stock, payments, locked meals). Passed.
- Also covered:
  - automated security review (RLS everywhere, definer hygiene, anon allowlist, no direct ledger writes, append-only triggers, private buckets, encrypted phones);
  - FSSAI lock for live kitchens (finding #1 in docs/SECURITY.md);
  - admin RPCs refused to owners (`tests/integration/m8.test.ts`);
  - phone masking in error reports (`monitor.test.ts`);
  - audit-log paging that never skips rows written in one transaction;
  - WhatsApp STOP / UPDATES keywords;
  - malformed dates in page URLs no longer crash pages (`isIsoDate`).

Known gaps carried forward:
- **No Play Store build yet:** needs your Expo account, a Google Play developer account and the store listing (docs/RELEASE.md).
- **Monitoring is configured but unused** until DSNs/keys are set. No Sentry or PostHog account exists yet.
- **Legal pages are drafts** for a lawyer to review; the operator's name and address are placeholders.
- **Load numbers come from the build sandbox's Docker database**, not a hosted Supabase instance. Re-run `pnpm db:loadtest` against staging before launch.
- **CAPTCHA** on the public forms is recommended before running paid ads (docs/SECURITY.md #4).

## P5: Kitchen and customer extras ✅ (built 2026-10-30, backend; web/mobile screens in progress)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 5.1 | Parent pays, student eats: payer rules, money messages to the payer, payer's page pays for dependents | ✅ | `set_payer`, `private.guard_payer`, `private.route_outbox_to_payer`, `portal_dependent_payment_link_record`, `*_payer_v1` templates (D-097) |
| 5.2 | Odisha food calendar (Kartika, festivals, admin-editable), veg days, customer opt-ins, counted/packed as veg in the daily engine; festival specials announced | ✅ | `food_calendar`, `private.refresh_orders` (veg_override), `set_customer_food_prefs`, `portal_set_food_prefs`, `create_festival_special` (D-095, D-096) |
| 5.3 | Packed-meal photo before dispatch, QR sticker codes, sticker sheet, wrong-tiffin check | ✅ | `record_dispatch_photo` (`dispatch` bucket), `delivery_stops.qr_token`, `sticker_sheet`, `complete_stop(…, p_scan_token)` (D-098) |
| 5.4 | Complaint scores; first complaint auto-credited | ✅ | `vendor_complaint_score`, `customer_complaint_score`, `admin_complaint_scores`, `private.complaint_auto_credit` (D-099, D-100) |
| 5.5 | Rain and heat alerts | ✅ mock | `_shared/weather.ts`, `weather-alerts` function, cron `tiffin-weather` (D-101) |
| 5.6 | Churn alerts | ✅ | `private.compute_churn`, cron `tiffin-churn`, `at_risk_customers` (D-102) |
| 5.7 | Referrals | ✅ (reward 0 = off) | `referrals`, `apply_referral_code`, `portal_apply_referral`, `ref-CODE` lead campaigns (D-103) |
| 5.8 | 90-minute "prepared to delivered" alert | ✅ | `private.queue_late_delivery_alerts`, cron `tiffin-late-delivery` (D-104) |

Acceptance tests (`supabase/tests/11_p5.test.sql`, 132 assertions; `tests/integration/p5p6*.test.ts`):
- payer rules, routing and the payer's page;
- veg days and Kartika switch non-veg to veg without touching a frozen slot, with one meal entry per order at the lock;
- specials reach opted-in customers, and staff don't see the price;
- the sticker sheet has no phones, and the wrong sticker is refused while old callers keep working;
- the first complaint is credited once (not for "other" complaints, nor with the setting off);
- weather alerts go out once per slot and only with the service role;
- churn reasons, referral credits once each, the 90-minute alert once per run;
- each feature checked per role (owner, staff, rider, other kitchen, admin, anon).

Known gaps:
- **Web and mobile screens** for these RPCs are being built by the UI work.
- **The calendar dates** are approximate (D-095).
- **Weather has only run in mock mode;** live Open-Meteo calls need outbound network from the Edge runtime.
- **The new WhatsApp templates** need Meta approval (docs/WHATSAPP_TEMPLATES.md).

## P6: Platform revenue and scale ✅ built, switched off (2026-10-30)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 6.1 | Platform commission through the Razorpay Route split (platform customers, online payments), ledger, admin report | ✅ rate 0 | `kitchen_payout_accounts.commission_bps`, `platform_commissions`, `admin_set_commission`, `admin_commission_report`, `commission_statement`, `_shared/razorpay.ts` `routeTransfer` (D-105) |
| 6.2 | Kitchen switching at the same price, admin approval | ✅ flag off | `platform_settings.kitchen_switching`, `portal_switch_options`, `portal_request_switch`, `admin_decide_switch` (D-106, D-107) |
| 6.3 | Shared riders across kitchens | ✅ verified | `rider_today`, `my_run_ids`, `rider_stats` (D-108) |
| 6.4 | Office plans: billing customer pays, one stop per office, monthly statement | ✅ | `offices`, `upsert_office`, `set_customer_office`, `office_statement`, `private.build_runs` (D-109) |
| 6.5 | Health tags with consent: packing list, stickers, counts; never riders | ✅ | `customer_health`, `set_health_tags`, `portal_set_health_tags`, `packing_list`, `slot_totals.by_health` (D-110) |
| 6.6 | AI notebook-photo import (preview only) | ✅ mock without a key | `notebook-import` function, `_shared/notebook.ts`, `notebook_import_context`, `imports` bucket (D-111) |

Acceptance tests (`supabase/tests/12_p6.test.sql`, 106 assertions):
- commission is charged once per captured payment and nothing changes at rate 0;
- switching refuses in both flag states where it should, and an approved switch refunds through the cancel path and creates the customer through convert;
- a shared rider sees both kitchens, and rider-pay reports stay separate;
- an office gets one stop while meals stay per member, and a kitchen-fault failure credits each member;
- health tags need consent and are hidden from riders;
- the notebook-import context is owner-only.

Known gaps:
- **No refund reversal row** in the commission ledger yet (D-105).
- **Live notebook reading is untested.** It has only run with the fixture: no API key in the sandbox.
- **Notebook photos** are kept until retention is decided.

## Things to start outside code now
These have external lead times:
- Meta Business verification and WhatsApp number.
- Razorpay test account, plus the Route/Subscriptions question (D-003).
- DLT registration if SMS OTP is wanted (D-004).
- Ola Maps or Google Maps API key (D-013).
