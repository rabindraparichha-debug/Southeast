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

## P5: Kitchen and customer extras ✅ (built 2026-10-30: backend, web and mobile screens)

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
- **Odia and Hindi texts** for the new web, customer-page and mobile screens are not written yet (English fallback).
- **Dispatch photo retakes** leave the earlier photo in storage (the bucket is insert-only).
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
- Refund reversals of commission: done (D-113, `platform_commission_reversals`, `13_commission_reversals.test.sql`).
- **Live notebook reading is untested.** It has only run with the fixture: no API key in the sandbox.
- **Notebook photos** are kept until retention is decided.

Screens (both P5 and P6): web customer detail cards, settings "care" form, festival specials, offices and
statements, dispatch photo, printable QR stickers (`/print/stickers`), owner Insights, notebook import into
the import wizard, web rider sticker check, admin calendar / quality / commission / switching, customer-page
extras; mobile rider QR scan (expo-camera, works offline, queue backward compatible), office stops, dispatch
photo, counts and packing list extras, customer extras, insights. Checked with Playwright (web) and
`tests/integration/rider-queue.test.ts` (mobile queue).

## M9: Channels, web app and app builds ✅ (2026-10-30)

| Pkg | Scope | Status | Where |
|---|---|---|---|
| 9.1 | Google Ads lead forms + click ids + offline conversions (trial, plan, renewal with value) | ✅ mock until keys | `ad_conversions`, `ads-conversions` function, cron `tiffin-ad-conversions`, `/find?gclid=`, admin "Google Ads conversions" |
| 9.2 | Justdial push (RECEIVED ack) and enquiry emails | ✅ | `lead-intake?source=justdial`, `lead-email` |
| 9.3 | Sulekha: enquiry email forwarding, CSV import, partner JSON | ✅ | `lead-email`, `admin_import_leads`, Admin → Leads → Import |
| 9.4 | Installable web app: rider mode with offline queue, stock entry | ✅ | `apps/web` manifest, `public/sw.js`, `(field)/rider`, `(field)/stock-entry` (docs/WEB_APP.md) |
| 9.5 | Android test APK | ✅ | `apps/mobile/scripts/build-apk.sh`, `.github/workflows/android-apk.yml` (push `apk/*` → pre-release `apk-build-<n>`) |
| 9.6 | iOS TestFlight | ✅ workflow, needs Apple/Expo accounts | `.github/workflows/ios-testflight.yml` (docs/RELEASE.md) |

Setup steps: docs/LEAD_SOURCES.md, docs/RELEASE.md, docs/WEB_APP.md. Tests: `10_lead_channels.test.sql`, `tests/integration/lead-channels.test.ts`.

Known gaps:
- **The sandbox cannot build the APK** (dl.google.com is blocked); GitHub Actions builds it.
- **iOS needs** an Apple Developer account, an App Store Connect API key and an Expo token (docs/RELEASE.md).
- **Google Ads conversion upload** runs in mock mode until the developer token and OAuth are set.

## Vendor-first wave 1: daily engine (2026-11-06)

From docs/VENDOR_FIRST_AUDIT.md "Recommended work order" and owner decision D-116. Defaults: D-119 – D-125.
Migrations `20261107000200` – `20261107000500`; pgTAP `14_vendor_first.test.sql` (118 checks).

| Item | Scope | Status | Where |
|---|---|---|---|
| 2 | Date-dependent pgTAP fixed (05 tests 17–25, 07 test 76; also 06, 12, 13 used the real clock) | ✅ | `notifications_outbox.send_after` default `private.now()`; tests use `private.now()` |
| 7 | Safe defaults: marketplace leads and first-complaint credit are opt-in | ✅ | `20261107000300_safe_defaults.sql` (D-119) |
| 8 | `rider_today.otp_sent` only when the code message was really sent | ✅ SQL (screens: apps agent) | `rider_today` |
| 11 | Vendor changes use the slot's real cutoff (no 19:00 phone close) | ✅ SQL | `private.apply_change` (D-120) |
| 12 | Lock job: per-kitchen errors, 7-day catch-up, `engine_errors`; nightly per step; cancel charges only its own meals | ✅ | `run_due_locks`, `nightly`, `charge_orders`, `engine_errors`, `dismiss_engine_error` (D-123) |
| 14 | Dated moves keep earlier meals; first address fills subscriptions; "Make default" can move meals | ✅ | `apply_change`, `sync_subscription_status`, `set_default_address`, mobile quick add address (D-124) |
| 15 | Undo one skip/pause; resume honours its end date; upcoming list | ✅ SQL | `revoke_schedule_change`, `subscription_holds`, `active_hold` (D-122) |
| 16 | Reactivate a cancelled subscription | ✅ SQL | `reactivate_subscription` (D-122) |
| 17 | Closure days (or one meal); weekly off per meal | ✅ SQL + settings | `kitchen_closures`, `set_kitchen_closure`, `remove_kitchen_closure`, `kitchens.weekly_off_lunch/dinner` (D-125) |
| 18 | Changes after lock reach planned and out runs; office stops fixed; `changed` flag | ✅ SQL | `build_runs`, `resync_runs`, `rider_today` (D-121) |
| 19 | Skip a locked meal: charged, or "don't charge" = one credit linked to the meal; stop leaves the run | ✅ SQL | `waive_meal_charge`, `meal_orders.charge_waived` (D-120) |

Still to build on screens (apps): an Undo list on the customer page (web and mobile), a Reactivate button, "Closed tomorrow" on Today, mobile locked meals as chips with "don't charge", showing `changed` on rider stops, and removing the unused "Phone requests close at" setting.

## Vendor-first wave 3 — ops (docs/VENDOR_FIRST_AUDIT.md items 30–32)

| Item | Scope | Status | Where |
|---|---|---|---|
| 30 | Engine health: heartbeats, health check, `ops-health` for an uptime pinger, admin Engine tile, "Count not frozen" + Freeze now on web and mobile slot cards | ✅ | `20261110000100_engine_health.sql`, `supabase/functions/ops-health`, `apps/web/src/app/admin/engine-tile.tsx`, `slot-card.tsx` (web, mobile), D-158, D-159 |
| 31 | Retention and real erasure: diff-only audit rows for personal data, no rider pings, OTP never logged; purge job (cron log, outbox); photo retention through the Storage API; erasure scrubs audit log, conversations, import rows, delivery GPS and photos | ✅ | `20261110000200_lean_audit.sql`, `…0300_real_erasure.sql`, `…0400_retention.sql`, `supabase/functions/storage-retention`, D-160–D-162 |
| 32 | Hosted deploy script, backups, restore drill into a staging copy, runbook | ✅ locally (dry run and staging-copy drill against the local stack); needs the founder's Pro projects for a real run | `scripts/deploy.sh`, `scripts/restore-drill.sh`, `scripts/backup.sh`, `docs/OPERATIONS.md`, D-163 |

Rebased onto m9-p5-p6 (wave 1, login, screens). Review fixes: engine health reads wave 1's `engine_errors` (open rows seen in 26 h make it unhealthy; Freeze now closes the slot's lock error), a manual rerun clears a failed cron run, non-critical job failures are warnings, erasure also covers payer-routed messages, owner alerts and the platform lead (D-164), the staging-copy drill keeps messaging jobs paused and cancels copied outbox rows (D-165), deploy refuses unlisted functions and a production deploy without `OPS_HEALTH_KEY` (D-166), backups take their checks in the dump's snapshot, bash 3.2 support. Slot cards use `slot_summary.overdue` and show `engine_error`; closed slots never show "not frozen". Decisions D-158 – D-166.

Tests: `supabase/tests/14_ops.test.sql` (all 1,129 pgTAP tests pass on the rebased branch), `09_security` allowlists, `tests/integration/ops.test.ts` (11; 284 integration tests pass), `scripts/deploy.sh --self-test` and `--env staging --local`, `pnpm db:restore-drill` (both modes). Load test 12.0 s (normal day 2.0 s).

Merged into `m9-p5-p6` (after wave 2 and the held-back DB items) with `20261130000300_merge_ops.sql`: wave 4's `tiffin-plan-prices` runs through `run_job`; wave 2's `change_requests` and held-back apps' `rider_sync_rejects` are in the lean audit, the erasure scrub and `customer_erased_cleanup`; Freeze now shows for managers; `deploy.sh` lists `admin-change-phone`, `tiffin-plan-prices` and `tiffin-outbox-stuck`. Wave 5's `complaint_admin_events.note` was already blanked on erasure by its own trigger. Tests: `19_merge_ops.test.sql`.

Known gaps:
- **Managers** (D-117, wave 2): `freeze_slot` already accepts them through wave 2's `expand_roles`; the slot cards must show Freeze now for `manager` too when wave 2 merges.
- **Other waves' functions and jobs** must be added to `scripts/deploy.sh` (`ALLOWLIST`: push-outbox, public-forms, admin-change-phone; `CRON_JOBS`: tiffin-push, tiffin-plan-prices, tiffin-outbox-stuck) as they merge; the deploy refuses unlisted functions.
- **Erasure and other waves' free text:** wave 2's `change_requests` notes, wave 3 riders' `delivery_stops.credit_note`/`correction_note` and wave 5's `complaint_admin_events.note` (append-only) need adding to `audit_personal_keys` / `customer_erased_cleanup` when they merge.
- **Not run against hosted yet:** `scripts/deploy.sh` without `--local`, and the staging-copy drill against a real staging project (needs the founder's projects, DB password and access token).

## Held-back apps track (2026-11-06)

From docs/VENDOR_FIRST_AUDIT.md items 24 (rest) and 35. Decisions D-128 – D-130. Migrations `20261116000100_rider_sync_rejects.sql`, `20261116000200_rider_sync_rejects_fixes.sql` (review fixes);
pgTAP `15_rider_sync_rejects.test.sql` (78 checks); Vitest `rider-reject.test.ts`, `i18n-drafts.test.ts`, `held-apps.test.ts`.

| Item | Scope | Status | Where |
|---|---|---|---|
| 1 | Server record of rider actions the server refused; owner list + "Mark handled" (web Delivery, mobile Today); auto-close on a later sync | ✅ | `rider_sync_rejects`, `report_sync_reject`, `sync_rejects`, `resolve_sync_reject`; `lib/rider-reject.ts` (both apps) (D-128) |
| 2 | Mobile photos shrunk before they are saved or queued (proof 1280 px / 0.7, bills and dispatch 1600 px / 0.75); old full-size queued proofs shrunk at upload | ✅ needs a new build | `apps/mobile/src/lib/photo.ts`, `expo-image-manipulator` (D-129) |
| 3 | Queue sync on network reconnect (NetInfo), on top of the app-in-front and 1-minute triggers | ✅ needs a new build | `apps/mobile/src/lib/use-reconnect-sync.ts`, `@react-native-community/netinfo` (D-129) |
| 4 | Odia/Hindi groundwork: mobile picker (per phone), drafts for every mobile key, audited literals moved to keys; web helper + `tiffin_lang` cookie for the nav and Today only | ✅ drafts, need a native reviewer | `apps/mobile/src/i18n/{or,hi}.ts`, `components/language-picker.tsx`, `apps/web/src/lib/i18n/` (D-130) |

Known gaps:
- **The two native modules need the next APK/TestFlight build.** `app.json` version is now 1.1.0, so the runtime version changes and no over-the-air update built from this code can reach a 1.0.0 install that lacks the modules.
- **Translations are drafts**: written without a native speaker. A reviewer must check the ~470 mobile strings (rider, Today and phone desk first) before any pilot vendor sees them; the rest of the web app is still English.
- Rider sync reports are best effort, but log-out now sends waiting reports first and is refused while any are left (both apps), so a discarded refused action's report is not wiped with the phone.
- Review fixes (2026-11-06): a report naming the old run of a stop the owner moved (`move_stop`) is accepted (it used to be refused and dropped); a report that arrives after the same action synced is stored closed and never reopens; reports keep `customer_id`.
- On merge: wave3/ops erasure must also blank `summary.note` / `summary.stop_label` of the erased customer's `rider_sync_rejects` rows (match on `customer_id`) and add the table to its audit scrub; wave2 managers: gate the mobile Today card with `isLead(kitchen.role)` (done in the wave 2 merge, also the web Delivery list); renumber D-128 – D-130 into the global sequence (the migration headers cite the decision by title, not number).

## Vendor-first wave 4: onboarding and founder support (2026-11-06)

From docs/VENDOR_FIRST_AUDIT.md Phase 1 steps 2, 4, 5 and 7 (work order 34, parts of 21, 33 and 35). Defaults: D-131 – D-138.
Migrations `20261113000100` – `20261113000600`; pgTAP `15_onboarding.test.sql` (156 checks); integration `onboarding.test.ts`.

| Item | Scope | Status | Where |
|---|---|---|---|
| 1 | New kitchens need an approved application, an allowed number or `open_vendor_signup` | ✅ | `create_kitchen`, `vendor_allowed_phones`, `admin_set_vendor_approval`, `admin_allow_vendor_phone`, Admin → Access, Admin → Vendor applications (D-131) |
| 2 | Odia / non-Latin kitchen names get a valid web address; short error codes | ✅ | `private.kitchen_slug`, `create_kitchen` (D-132) |
| 3 | Invited staff/riders never see "Set up your kitchen"; retry on a slow network | ✅ | `onboarding_status`, web `onboarding/gate.tsx`, mobile `components/onboarding-gate.tsx` |
| 4 | Founder support: kitchen detail, logged reveal, phone change, ownership transfer, platform admins, support contact | ✅ | `admin_actions`, `admin_kitchen_detail`, Edge Function `admin-change-phone`, `admin_transfer_ownership`, `admin_add/remove_platform_admin`, `/admin/kitchens/[id]`, `/admin/access` (D-133, D-134, D-138) |
| 5 | Plan price from a date ("₹80 from next month"), charged per service date | ✅ | `plan_prices`, `set_plan_price`, `cancel_plan_price`, `charge_orders`, cron `tiffin-plan-prices`, Plans editor (D-135) |
| 6 | Phoned-in complaints | ✅ web | `log_complaint`, customer page Complaints card (D-136) |
| 7 | Export my kitchen (ZIP of CSVs), request to close | ✅ | `export_kitchen`, `kitchen_close_requests`, `/settings/export`, `@tiffin/core` `toCsvText`/`zipFiles` (D-137) |

Review fixes (`20261113000700`, D-139 – D-145): proven phone (OTP session) for the gate and `onboarding_status`, accounts secured (random password, other sessions end) when they get a kitchen or admin rights; owner basis only in good standing; pending phone changes (`admin_phone_change_done(change_id)`, `admin_sign_out_user`); exact-owner export and close requests; vendor messages and nudges wait for approval (backfill of onboarding/live applications); `admin_set_vendor_signup`; `charged_slots` from `set_plan_price`; `enable_confirmations = true` locally.

Known gaps:
- Mobile has no "Log complaint" form yet (web only).
- Wave 2 already lets managers into `'{owner}'` checks. Wave 4's owner-only areas (export, close requests, admin_actions) check the exact owner (D-142); `log_complaint` and plan prices follow `'{owner}'` (so managers too). Since the wave 2 merge `plan_prices_select` is `'{owner,accountant}'` (accountants read plans there) and the accountant never gets `export_kitchen`; pgTAP manager/accountant cases are in `17_merge_wave2.test.sql`.
- ~~Dues valued at today's plan price~~: fixed by wave 2's ledger-valued `private.dues` since the merge (D-144; the `15_onboarding` check is a real test now).
- On merge with wave 3/ops: add `tiffin-plan-prices` to `private.engine_jobs` and run it through `private.run_job`. With wave 5: its complaint support RPCs should also write `admin_actions`.
- Meta must approve `vendor_welcome_v2` before deploy.

## Vendor-first wave 2: money, roles, shared phones, phase flags (2026-11-06)

From docs/VENDOR_FIRST_AUDIT.md "Recommended work order", with the owner's decisions D-115..D-118.
Defaults chosen while building are in D-156. Built in parallel with wave 1 (items 2, 7, 8, 11, 12,
14–19 and the app work), on branch `wave2/db`.

| Item | Scope | Status | Where |
|---|---|---|---|
| 20 | Billing mode per customer with a rupee ledger: monthly pay-later by default, prepaid keeps the M3 rules; dues from each meal's own price; payments, rider cash, credits, refunds and import in rupees for monthly customers; mode switch with a one-time conversion | ✅ | `20261108000300_billing_mode.sql`, `…0500_shared_phones_customer_billing.sql`, `set_billing_mode`, seed (monthly zero-balance customers) |
| 21 | Customer statement (by service date, reconciles with the ledger), bills for the month, CSV exports (payments, dues aging, rider cash), register built on the server | ✅ DB + register page | `…0600_statements_exports_register.sql`, `apps/web/src/app/print/register/page.tsx` |
| 22 | Payments: idempotency key, backdating, void with reason (append-only reversal); idempotent purchases and waste | ✅ | `…0400_payment_void_backdate_idempotency.sql` |
| 23 | Manager and accountant roles; owner-only areas; invites for the new roles; claim needs a code sign-in; rider change requests approved by owner or manager; owner alerts to managers | ✅ | `…0100_wave2_enum_values.sql`, `…0200_manager_accountant_roles.sql`, `…0700_rider_change_requests.sql` |
| D-118 | Shared phones: no unique phone per kitchen; every phone lookup checked | ✅ | `…0500_shared_phones_customer_billing.sql` |
| 13 | Outbox expiry, customer-message gate, phase-flag keys, flag-checked crons | ✅ | `…0800_outbox_expiry_phase_flags.sql` |

Tests: `supabase/tests/14_billing.test.sql`, `15_roles_requests_phones_flags.test.sql`, manager and
accountant sections in `01_rls_isolation` and `02_rpcs_and_guards`; `tests/integration/wave2.test.ts`;
core import validation (`packages/core`).

Web (branch `wave2/web`, apps/web only):
- Roles: `apps/web/src/lib/roles.ts` decides pages and buttons. Managers get the owner's pages except
  inbox, kitchen settings and team; accountants get Customers (masked phones, no addresses or meals),
  Money, Bills, Costs, statements and the register, all read-only. Team invites managers and accountants.
- Billing: the kitchen default in Settings, the choice on Add customer, a badge on lists and customer
  pages, rupee dues on Money and the customer Money card (monthly), switching from the Money card.
- Payments: payment date (backdating), note and an idempotency key on every save; Void with a reason;
  monthly credits, adjustments and refunds in rupees. Purchases and waste pass `p_client_op` too.
- Statement `/print/statement/[id]?month=YYYY-MM` (print, WhatsApp share from the vendor's phone),
  "Bills for this month" on Money and `/money/bills`, CSV downloads (payments, dues aging, rider cash).
- Rider requests: `/requests` (preview, don't-charge toggle, plan or address choice, approve or reject).
- Shared phones: the confirm step on Add customer and edit, "shares this phone with" on the customer
  page, a warning on phone search. Import shows the billing and dues columns.

Mobile (branch `wave2/mobile`, apps/mobile only):
- Roles: `apps/mobile/src/lib/roles.ts` (same lists as the web). Managers get the owner's tabs except
  Inbox, and the Deliver tab; accountants get a Money home tab, Customers (masked phones, no meals,
  addresses or notes) and Account, all read-only. Today shows owners and managers a card with rider
  requests waiting and rider cash / dues, opening `/requests` and `/money`.
- Billing: the choice on Add customer (kitchen default preselected), with food type, an address and an
  opening balance (rupees owed or advance for monthly, meals for prepaid); a badge, the balance
  (rupees for monthly) and this month's statement line on the customer Money card; switching mode.
- Payments: any amount by cash, UPI or bank, a payment date (backdating), a note and one idempotency
  key per form; Void with a reason; confirm or reject rider cash on the customer page and on Money.
  Purchases and waste pass `p_client_op`. Monthly bills can be sent on WhatsApp as a text summary.
- Rider requests: a card at the bottom of the stop screen (skip, pause, new address; one key per
  form, kept for a resend after a network error) and `/requests` for owners and managers (preview,
  don't-charge toggle, plan choice, pick or save the new address, approve or reject).
- Shared phones: the confirm step on Add customer (lists who has the number), "Same phone" links on
  the customer page, a count on a full-number search.

Still to do (UI agents): item 27 hides Phase 2 screens behind the flags.

Merged with wave 1, login and screens on branch `wave2/integrated`; review fixes in
`20261108000900_wave2_review_fixes.sql` (D-156 "Review fixes"; tests `16_wave2_review.test.sql`).

Known gaps:
- A rider request raises no WhatsApp alert (would need a Meta template); owners see the list.
- WhatsApp from a shared phone always talks about the oldest customer on it (Phase 2).
- The customer page and bot still show prepaid meal balances for monthly customers (Phase 2 screens; the context now carries `billing_mode` and `balance_paise`).

Merged into `m9-p5-p6` (after held-back apps and wave 4) with `20261130000100_merge_wave2.sql`: union bodies for the functions both wave 2 and a later or earlier migration define (see the migration header), plan prices readable by accountants, production sheet to managers.

## Phase 2 hardening (2026-11-06)

From docs/VENDOR_FIRST_AUDIT.md Phase 2 steps 1–6 (the parts that do not depend on the running waves). Defaults: D-146 – D-155.
Migrations `20261114000100` – `20261114000700`; pgTAP `15_phase2_hardening.test.sql`; unit tests `phase2-shared.test.ts`, `template-pack.test.ts`.

| Item | Scope | Status | Where |
|---|---|---|---|
| 1 | Delivery OTP: lockout sticks, offline wrong code not delivered, codes out of audit log / outbox / message log | ✅ | `private.do_complete_stop`, `private.audit_redacted_columns`, triggers `notifications_outbox_scrub_codes`, `messages_mask_codes` (D-146) |
| 2 | Referral links to the kitchen's own join page; other-kitchen codes named; no card at reward 0 | ✅ SQL + web | `referral_invite`, `referral_join`, `/k/[slug]/join`, `private.portal_extras`, `private.link_referral` (D-147) |
| 3 | AI fallback caps (per conversation, per day), chat model env, SDK failure hand-off, timeout | ✅ | `ai_usage`, `wa_ai_take`, `_shared/ai-claude.ts` (D-148) |
| 4 | Failed payment links cancel their row (owner, page, payer, bot) | ✅ | `cancel_payment_link_record`, `_shared/payment-link.ts` (D-149) |
| 5 | Lead-intake keys in headers only (Justdial's own URL key), example keys refused on hosted | ✅ | `_shared/leads.ts` `checkLeadKey` (D-150) |
| 6 | Google Ads mock conversions stored as `mock`, uploaded after going live | ✅ | `ads_claim_conversions(p_include_mock)`, `ads_complete_conversion(p_mock)`, `admin_requeue_mock_conversions` (D-151) |
| 7 | Admin escalation queue: context, logged reveal, assign / reassign, note, resolve | ✅ SQL + web | `admin_escalations`, `admin_complaint_detail`, `admin_reveal_complaint_phone`, `admin_assign_complaint`, `admin_note_complaint`, `admin_resolve_complaint`, `/admin/complaints` (D-152) |
| 8 | `/find` and `/vendors` WhatsApp boxes start unticked | ✅ | (D-153) |
| 9 | WhatsApp template pack: docs and code in sync, CSV for Meta/Twilio | ✅ | `docs/whatsapp-templates.csv`, `_shared/template-pack.ts` (D-154) |

Not done here: Turnstile / IP limits on the new join form (wave 3 owns public-form protection), a "too many wrong codes" message on the 5th wrong code in the rider apps (the 6th try already shows `otp_locked`), and logging the team's complaint actions in wave 4's `admin_actions`.

### Review fixes (D-155)
Migration `20261114000700_phase2_review_fixes.sql`.

| Fix | Status | Where |
|---|---|---|
| A resent wrong-code submit (same op) is counted once | ✅ | `delivery_stops.otp_last_op`, `private.do_complete_stop` |
| Join limits count every attempt before the number is looked at (no "who is a customer" oracle) | ✅ | `referral_join_attempts`, `referral_join` |
| A join from a number the kitchen has: same answer, owner told | ✅ | template `referral_existing_v1` |
| No WhatsApp opt-in / consent from the join page (phone not proven); UPDATES link on the thank-you screen | ✅ SQL + web | `referral_join`, `/k/[slug]/join` |
| Google Ads mock mode never stores `skipped`; old `skipped` / mock-`sent` rows backfilled; requeue takes `skipped` | ✅ | `_shared/google-ads.ts`, `admin_requeue_mock_conversions` |
| A link Razorpay created is cancelled there before our row fails; attach retried | ✅ | `_shared/payment-link.ts`, `cancelPaymentLink` |
| Erasure blanks the team's complaint notes | ✅ | trigger `customers_erased_complaint_notes`, guard on `complaint_admin_events` |
| `trial_followup_v1`, `lead_reminder_v1` listed as marketing; login template `tiffin_login_code` | ✅ | `templates.ts`, `template-pack.ts`, CSV |
| Functions `.env.example`: comments on their own lines | ✅ | `supabase/functions/.env.example` |

Still open: Turnstile / IP limits on the join form (wave 3's public-forms function at merge), logging the team's complaint actions in wave 4's `admin_actions`, renumbering D-146 – D-155 at merge, and adding samples for the other branches' new templates to the pack.

## Held-back items: billing-aware messages, import, outbox (2026-11-06)

Built on `wave2/db` (branch `held/db`, review fixes on `held/db-final-r2`). Defaults in D-157 (written as D-120, then D-136 on the branch; renumbered at merge).

| Item | Scope | Status | Where |
|---|---|---|---|
| Phase 2 step 6 + Phase 1 step 7 | Monthly customers get no low-balance or dues reminders mid-month; one month-end `statement_ready` message (Phase 2 flag only, unpaid only); monthly payment receipt; churn `dues_overdue` after `dues_overdue_days` (default 40) instead of "owes money" | ✅ DB, templates, settings field, at-risk labels | `20261115000100_billing_aware_messages.sql`, `_shared/templates.ts`, `docs/WHATSAPP_TEMPLATES.md` |
| Phase 1 step 5 | Import: status column (paused from a date, stopped without a plan), second plan column and repeated rows merged by phone + name, diet taken from or checked against the plan, 100-row chunks with a client batch id (idempotent per row, resumable), IST start date, full template example | ✅ DB, core, web wizard | `20261115000200_import_upgrades.sql`, `packages/core/src/import.ts`, `apps/web/src/app/(app)/customers/import/` |
| Phase 2 step 6 / item 41 / item 10 (mock) | Outbox: stuck `sending` rows re-queued (cron), provider id stored with the sent mark, row id sent to Meta and matched on status webhooks, no failure report after a send; `mock` status for mock sends (conversation, rider OTP hint, admin metrics) | ✅ | `20261115000300_outbox_reliability.sql`, `whatsapp-outbox`, `whatsapp-webhook` |

Tests: `supabase/tests/16_held_back.test.sql` (both billing modes, import per role, outbox paths),
`tests/integration/held-db.test.ts` (245-row import in chunks with a retried chunk, templates, the
callback key), core Vitest (preview, chunks, template); `m4.test.ts` now expects `mock`.

Known gaps:
- Refund notices and delivery or complaint credits still use meal wording for monthly customers.
- The statement message has no link to a statement page (the customer page is a Phase 2 flag).
- Mobile has no import (web only, as before) and no settings screen for `dues_overdue_days`.

Overlaps with other waves (resolve at merge; see D-157 "Overlaps"):
- `public.rider_today` (wave 1, `20261107000500`): not re-created here; `20261115000300` patches the
  live body's otp_sent test and is a no-op on wave 1's body (keeps `changed`/`changed_at` and the
  skipped filter).
- `whatsapp-outbox/index.ts` (wave 1): keep wave 1's try/catch around `loadWaConfig`, drop its comment
  "Mock mode still records a send as sent".
- Import (wave 3 riders `Route` column; wave 2 web wizard and page): `importTemplateRows` fills the
  example rows by header (a `Route` entry is ready); keep this `previewImportRows`/plans API and take
  wave 2 web's `LEAD_ROLES` page guard and billing/dues preview columns.
- Templates (wave 5 template pack): add `TEMPLATE_SAMPLES` entries for `payment_receipt_monthly`,
  `statement_ready` and their `_payer` variants, then regenerate the CSV (`UPDATE_TEMPLATE_PACK=1`).
- Push outbox (wave 3 riders): `push_complete_outbox` records mock pushes as `sent`; move it to `mock`
  or record push as the exception.

## Things to start outside code now
These have external lead times:
- Meta Business verification and WhatsApp number.
- Razorpay test account, plus the Route/Subscriptions question (D-003).
- DLT registration if SMS OTP is wanted (D-004).
- Ola Maps or Google Maps API key (D-013).
