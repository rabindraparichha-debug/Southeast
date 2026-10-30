# Spec: Tiffin Vendor Platform (Bhubaneswar, Odisha)

Verbatim copy of the spec section of the build prompt. Work packages and their status live in `docs/PLAN.md`; deviations and defaults live in `docs/DECISIONS.md`.

---

### What we're building
A free operating system for small tiffin vendors (home cooks, tiffin services, mess operators with 10–300 subscribers): daily meal counts, pause and cancel notices, customer balances, payment collection, rider delivery, inventory and a WhatsApp bot. In parallel, we bring vendors new customers through our own marketing. Later we earn commission on customers we bring. The vendor software stays free.

### Key decisions
- **Vendors are free.** Revenue later comes from commission on platform-sourced customers only.
- **Customers don't need an app.** They use WhatsApp plus a mobile web page opened by magic link (no password).
- **Many customers will never use anything digital at first.** Every customer action (pause, skip, pay cash, change address) must also be doable by the vendor in two taps. Counts, balances and dues must stay correct for offline customers.
- **We never hold customer money.** Razorpay settles directly to each vendor's linked account (Razorpay Route linked accounts / sub-merchants). There is no pooled account in our name.
- **The "wallet" is a prepaid meal balance per customer per vendor, usable only with that vendor.** No cross-vendor wallet; it may need RBI authorisation, so it's out of scope until legal clears it.
- **Delivery uses the vendor's own riders** in a rider mode of the same mobile app. We don't employ riders in v1.
- **Inventory is Petpooja-style but simpler:** purchases, recipes, auto-deduction from the locked daily count, stock-take, alerts, cost per meal.
- **One platform WhatsApp number** for all vendors. The bot answers first, AI covers free text, and anything else hands off to the vendor's in-app inbox. Vendors' personal numbers stay private.

### Surfaces (one backend)
| Surface | Users | Tech | Main jobs |
|---|---|---|---|
| Vendor app (mobile) | Owner, staff | Expo / React Native, Android first | Today's count, change feed, collections, menu, inventory entry, inbox |
| Rider mode (same app) | Vendor's riders | Expo, rider role, offline cache | Ordered stop list, navigation, OTP or photo proof, failed-delivery reason, tiffin returns, cash collected |
| Vendor dashboard (web) | Owner, accountant | Next.js + Tailwind | Customers, plans, ledgers, reports, bulk import, settings |
| Customer page + WhatsApp | Subscribers | Next.js mobile pages + WhatsApp Cloud API | Pay, pause or skip, menu, balance, complaint |
| Admin console (web) | Our team | Next.js | Vendor onboarding and KYC, lead routing, funnel, support, audit |

**Roles:**
- **Owner:** everything for their kitchen.
- **Staff:** counts, production and inventory only. No money, no customer phone numbers.
- **Rider:** today's assigned stops only, with masked phone numbers.
- **Customer:** their own data.
- **Platform admin:** all kitchens, every access logged.

### Tech stack (default; see rule 3 if the folder differs)
- **Database:** Supabase Postgres with row-level security on `kitchen_id`.
- **Auth and storage:** Supabase Auth with phone OTP; Supabase Storage for photos and bills.
- **Server logic:**
  - Supabase Edge Functions for webhooks (Razorpay, WhatsApp).
  - Postgres functions for money and count logic, always inside transactions.
  - `pg_cron` for cutoffs and nightly jobs.
  - A `notifications_outbox` table plus a worker for outbound messages.
- **Web:** Next.js (App Router) + TypeScript + Tailwind for the vendor dashboard, customer pages and admin console.
- **Mobile:** Expo (React Native) + TypeScript for the vendor app and rider mode. Offline support for riders.
- **Shared code:** generated database types in a shared package; a monorepo (e.g. pnpm workspaces or Turborepo) unless the folder already has a structure.
- **Payments:** Razorpay Payment Links, UPI Autopay (Subscriptions) with a pre-debit notice at least 24 hours before each charge, and Route linked accounts. Use test mode only until I say otherwise.
- **WhatsApp:** Meta WhatsApp Cloud API with approved templates.
- **AI:** Claude API for the chat fallback only, answering strictly from the vendor's data.
- **Routing:** VROOM in Docker on my VPS, with Ola Maps or Google for geocoding.
- **Monitoring:** PostHog for analytics, Sentry for errors, Metabase later for reports.
- **Time:** store everything in UTC, display in IST, define cutoffs in IST.

### Data model (about 30 tables; every vendor-owned table has `kitchen_id` with RLS)
- **Tenancy:**
  - `kitchens` (name, slug, owner_id, address, geo_point, service_radius_km, fssai_no, cutoff_lunch, cutoff_dinner, capacity_lunch, capacity_dinner, weekly_off, status)
  - `members` (kitchen_id, user_id, role: owner | staff | rider)
  - `kitchen_payout_accounts` (razorpay_linked_account_id, kyc_status)
- **Customers:**
  - `customers` (kitchen_id, name, phone encrypted, source, platform_sourced bool, payer_customer_id nullable for "parent pays", whatsapp_opt_in, preferred_language)
  - `addresses` (geo_point, landmark, delivery_notes)
  - `leads` (phone, source, campaign, area, meal_times, diet, budget, status, assigned_kitchen_id)
- **Plans:**
  - `plans` (slots, diet, days_per_week, price_per_meal)
  - `subscriptions` (customer, plan, address, start_date, end_date, status, autopay_mandate_id)
  - `schedule_changes` (type: skip | pause | resume | address | cancel; from_date, to_date, slot, requested_at, after_cutoff, channel: whatsapp | web | vendor | rider)
- **Daily engine:**
  - `menus` (date, slot, dishes, published)
  - `meal_orders` (subscription, date, slot, qty, status: scheduled | locked | prepared | out | delivered | failed | skipped; run_id, stop_seq)
  - `count_snapshots` (date, slot, totals_json, locked_at)
- **Money:**
  - `balance_entries`: append-only; type recharge | meal | credit | refund | adjust; meals, amount, ref_id, created_by
  - `payments` (razorpay ids, method, amount, status, settled_to_account)
  - `dues`
  - `platform_fees` (later)
- **Delivery:**
  - `delivery_runs` (rider, date, slot, status, km)
  - `delivery_stops` (seq, meal_count, status, proof_type, otp_ok, photo_url, gps, failed_reason)
  - `tiffin_ledger` (out, returned)
- **Inventory:**
  - `items` (unit, min_qty, last_price)
  - `stock_moves`: append-only; purchase | consume | waste | adjust | count
  - `suppliers`, `purchases`, `purchase_lines` (bill_photo, credit_due)
  - `dishes`, `recipe_lines` (qty_per_portion)
- **Chat:**
  - `conversations`, `messages` (direction, body, bot_intent, handled_by)
  - `complaints` (category, photo_url, status, refund_entry_id)
- **Platform:**
  - `audit_log` (actor, table, row_id, action, before, after)
  - `notifications_outbox`

Balance is the sum of `balance_entries.meals` per customer per kitchen, and stock is the sum of `stock_moves.qty`. Never store either as an editable number.

### Subscription states
- **States:** Trial, Active, Paused, Low balance, Suspended, Cancelled.
- **Transitions:**
  - Trial → Active when the customer pays.
  - Active ⇄ Paused on pause and resume.
  - Active → Low balance at 3 meals left (configurable).
  - Low balance → Active on recharge.
  - Low balance → Suspended when the balance hits 0. The vendor may allow credit up to N meals.
  - Suspended → Active on recharge.
  - Suspended → Cancelled after the vendor's grace days with no recharge.
  - Active → Cancelled when the customer cancels, after the vendor's notice period, with a pro-rata refund of unused meals.
  - A Trial that is never paid ends as Cancelled.
- **Meals are generated only in Active and Low balance.** Log every transition.

### Daily engine (per slot)
1. **00:30 nightly:** generate `meal_orders` 7 days ahead for Active and Low balance subscriptions. Respect pauses and weekly off-days.
2. **Change window:** skip, pause and address changes update orders until the cutoff. Defaults are lunch at 21:00 the previous day and dinner at 12:00 the same day, configurable per kitchen. After cutoff, a change is accepted but charged, and the customer is told before confirming.
3. **Lock at cutoff:**
   - Freeze the orders.
   - Write the count snapshot.
   - Post one `meal` balance entry per order.
   - Deduct expected ingredients from stock using the recipes.
   - Send the production sheet and packing list to the vendor (PDF and WhatsApp image).
   - **Idempotent:** running the job twice must not duplicate anything.
4. **Route build:** group stops into runs per rider and order them with VROOM. Reuse saved routes when nothing changed; vendors can drag to reorder.
5. **Dispatch:** the rider starts the run and customers get an "on the way" message.
6. **Deliver:** each stop is marked delivered (OTP or photo + GPS + time) or failed with a reason. A failure that is the kitchen's fault posts a credit entry.
7. **Close slot:** reconcile, flag unreturned tiffins, keep the complaint window open for 3 hours.
8. **Nightly:**
   - Low-balance reminders and autopay pre-debit notices.
   - Dues reminders on day 1, 3 and 7.
   - The owner's 10 pm WhatsApp summary: tomorrow's count, collections, low stock.

### Feature details
- **Money:**
  - Vendor-defined plans.
  - Payment links by WhatsApp.
  - UPI Autopay for renewals.
  - Manual cash or UPI entry with receipt photo and audit trail; the rider can record cash at the door.
  - Low-balance flow, a dues/khata view, pro-rata refunds.
  - Reports: collections, outstanding dues, and prepaid-meal liability.
- **Pause and cancel:**
  - Channels: WhatsApp buttons, the customer page, or the vendor (for phone customers).
  - Pause auto-extends the end date; the vendor can choose a balance credit instead.
  - A "changes since last count" feed, and one push at cutoff with the final numbers.
- **Daily count:**
  - Totals by slot and by veg, non-veg and Jain, plus add-ons.
  - A breakdown by route or area.
  - Production quantities from recipes.
  - A packing list in route order with special notes.
  - A running "tomorrow preview" through the evening.
- **Rider mode:**
  - Stop list showing name, flat, landmark and meal count.
  - One-tap Google Maps navigation and masked calls.
  - Proof of delivery, with offline sync that keeps the original timestamp.
  - Tiffin out and returned counts.
  - Vendor live board.
  - Monthly stops, km and shifts per rider, for the vendor to pay.
- **Inventory:**
  - Items, suppliers, and purchases with bill photo and credit dues.
  - Recipes per portion and auto-consumption at lock.
  - Weekly stock-take and variance, and wastage with a reason.
  - Alerts: low stock, a price jump over 15%, high variance.
  - Cost per meal (ingredients + gas + packaging) and margin.
- **WhatsApp bot:**
  - Buttons: today's and the week's menu, balance, pause or skip, pay, change address, complaint, talk to kitchen.
  - The 7 pm "tomorrow's menu, skip?" nudge.
  - English, Odia and Hindi.
  - AI fallback that never invents prices or promises refunds.
  - Complaints with category and photo, a 2-hour vendor response target, escalation to admin.
  - Vendor broadcasts, capped monthly.
- **Customer acquisition:**
  - Lead intake from Google Ads forms and calls, Justdial, the website and Instagram, each with a source tag.
  - Bot qualification: shared location, meal times, diet, budget, start date.
  - Matching to kitchens within the radius (default 3 km) that have spare capacity, ranked by rating and price fit; the customer picks from 2–3 kitchen profiles.
  - A paid trial, then a day-2 follow-up and plan offer.
  - The `platform_sourced` flag is permanent and the vendor can't edit it.
  - Funnel: lead → qualified → trial → plan → month-2 renewal.
- **Offline customers:**
  - Two-tap quick actions, search at the top of every screen, printed sheets.
  - Bulk import from Excel, CSV or contacts.
  - SMS or WhatsApp receipts for cash.
  - Vendor settings that move customers to WhatsApp and autopay step by step: phone pauses close at 7 pm, WhatsApp stays open until cutoff.
  - Dashboard metric: % of customers on WhatsApp and on autopay.

### Guardrails
- **Data integrity:**
  - Ledgers (balance, stock) are append-only.
  - Every money or count change writes `audit_log`.
  - Webhooks are idempotent (dedupe on the Razorpay or Meta event id).
  - RLS is tested: kitchen A can never read kitchen B, including through the API directly.
- **Privacy:**
  - Phone numbers encrypted at rest and masked for riders and staff.
  - Consent captured at sign-up.
  - Data deleted on request.
  - Design to the DPDP Rules.
- **Consumer protection:**
  - Show refund and cancellation terms before payment.
  - No hidden charges or subscription traps.
  - A named grievance contact, with complaints acknowledged within 48 hours.
- **FSSAI:** show each kitchen's FSSAI number on its profile. A kitchen without one can't go live.
- **Payments:** Razorpay test mode only until I explicitly approve live keys. Never put secrets in code; use `.env` and document every variable in `.env.example`.

---

### Phases P5 and P6 (added after the original spec)
The original spec left room for "parent pays", Route-split commission and `platform_sourced` and called P5/P6 design-for only. On the product owner's instruction ("build P5 and P6"; P6 "build both, switched off") they are now built. The work packages are in `docs/PLAN.md` and the defaults in `docs/DECISIONS.md` D-095 – D-112.
- **P5 (on, with safe defaults):**
  - parent pays, student eats;
  - Odisha food calendar (veg days, Kartika, festival specials);
  - packed-meal photo and QR stickers;
  - complaint scores and a first-complaint credit;
  - rain/heat alerts, churn alerts, referrals (reward off by default);
  - the 90-minute "prepared to delivered" alert.
- **P6 (built, switched off):**
  - platform commission via the Razorpay Route split (rate 0);
  - kitchen switching at the same price (admin flag off);
  - shared riders, office plans, health tags with consent;
  - AI notebook-photo import (preview only).

