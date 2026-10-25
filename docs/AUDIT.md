# Audit: Tiffin Vendor Platform

Date: 2026-10-25 · Auditor: Claude Code (lead engineer) · Scope: step 1 of the build prompt (audit only; no code written)

---

## 1. What exists

### 1.1 Findings

| Where I looked | Result |
|---|---|
| Working folder `/home/user/Southeast` | **Empty.** Only `.git/` exists. No package files, apps, migrations, env examples, README or docs. |
| Git history | **No commits.** Branch `master` is unborn; `git log` fails with "does not have any commits yet". |
| Remote `github.com/rabindraparichha-debug/Southeast` | **Empty.** No branches or refs (`git ls-remote` and the GitHub API both return nothing). Repo was created on 2026-10-25 at 05:35 UTC, just before this session. |
| Your other GitHub repos (names only) | None look like this project. The others are SnappyHires, Staffio, pfin, campaign-os, social-hub and similar. I did **not** open them because they are outside this session's scope. |

**Conclusion: there is no earlier work in this folder or this repo. The project is greenfield.**

If earlier work exists somewhere else (your laptop, another repo, Google Drive, a zip), push it to this repo or tell me where it is and I will redo this audit against it before writing any code. Until then, sections 2 to 4 treat the spec as the only source of truth.

### 1.2 What this environment can run (checked)

| Tool | Status | Relevance |
|---|---|---|
| Node 22.22, npm 10.9, pnpm 10.28 | Installed | Monorepo, Next.js, Expo |
| Docker 29.9 | Installed | Local Supabase stack (`supabase start`), later VROOM |
| psql 16 | Installed | Running migrations and tests by hand |
| Supabase CLI | Missing | Will add as a pinned dev dependency (`pnpm dlx supabase` / `devDependencies`) |
| Deno | Missing | Only needed for Edge Functions (M3/M4); the Supabase CLI bundles its own runtime |
| Python 3.13 | Installed | Not needed |

This is an ephemeral cloud container: anything not committed and pushed is lost when the session ends. Android builds and on-device Expo testing have to happen on your machine.

---

## 2. Mapping to work packages

Nothing exists, so every package is **missing**. There are no conflicts with existing code.

| Package | Milestone | Status | Notes |
|---|---|---|---|
| 1.1 Tables, roles, RLS, audit log, types | M1 | Missing | |
| 1.2 OTP login, kitchen profile, members, cutoffs, capacity, app shells | M1 | Missing | OTP delivery channel needs your decision before pilot (see 3.2-D) |
| 1.3 Customers, plans, CSV/Excel import, address pin | M1 | Missing | |
| 1.4–1.5 Daily engine, production sheet, 10 pm summary | M2 | Missing | Depends on the billing model decision (3.2-B) |
| 1.6–1.8 Ledger, Razorpay, cash, dues, refunds, quick actions | M3 | Missing | Depends on 3.2-B and 3.2-C |
| 2.1–2.5 WhatsApp, bot, magic link, inbox, AI fallback | M4 | Missing | Meta Business verification and template approval take days; start early |
| 2.6–2.8 Rider mode, VROOM, tiffins, live board | M5 | Missing | Masked calling needs a telephony provider that isn't in the stack (3.3) |
| 3.1–3.4 Inventory | M6 | Missing | |
| 4.1–4.4 Acquisition | M7 | Missing | |
| 4.5–4.7 Admin, hardening, Play Store | M8 | Missing | |
| P5, P6 | Design-for | Missing | Schema will leave room (e.g. `payer_customer_id`, `platform_fees`) |

---

## 3. Spec review: contradictions, gaps and recommendations

There is no existing code to contradict the spec, so this section covers issues **inside the spec**: places where two requirements pull against each other or where the stack doesn't support something as written.

### 3.1 Stack check

The default stack fits a small team well. **Recommendation: keep it as written.** No migration question arises (rule 3) because nothing exists yet.

### 3.2 Items that need your decision

**A. Earlier work.** The folder is empty. Please confirm it's greenfield, or point me to the earlier work.

**B. Billing model (blocks M2 and M3).** The spec mixes two models:
- **Prepaid meal balance:** balance = Σ `balance_entries.meals`; Low balance at 3 meals; Suspended at 0.
- **Calendar subscription:** `subscriptions.start_date` / `end_date`, "pause auto-extends the end date", "or a balance credit instead".

With a pure meal balance, pausing simply doesn't consume meals, so "extend end date vs. credit" never comes up. Four questions:
1. Is the meal balance the single source of truth, with `end_date` only a projection? *(My recommendation: yes.)* Or do vendors sell calendar plans such as "November, Mon–Sat, ₹2,600"?
2. Many Bhubaneswar mess operators bill **monthly in arrears (khata)**, not prepaid. Should v1 support postpaid customers whose balance goes negative and is billed at month-end, beyond "credit up to N meals"?
3. **Refund valuation** when a customer recharged at different prices: refund unused meals at the price of the latest recharge, first-in-first-out (FIFO), or a weighted average? *(Recommendation: FIFO. It's exact, and both sides can see how it was calculated.)*
4. **Add-ons** (extra roti, curd) are priced in rupees, not meals. Should they come out of a rupee balance next to the meal balance, or be added to dues? *(Recommendation: `balance_entries` keeps both `meals` and `amount`; add-ons post as rupee-only entries that become dues if unpaid.)*

**C. Razorpay Route vs. "we never hold customer money" (blocks M3; KYC lead time starts now).** With Route linked accounts, the payment is captured on **our** Razorpay merchant account and then transferred to the vendor's linked account. Funds stay in Razorpay's nodal account rather than a bank account in our name, but **we become the merchant of record**: chargebacks, refunds, customer-facing terms, and probably Razorpay's marketplace review. Two more points to check with Razorpay:
- whether transfers can be attached to **Subscriptions (UPI Autopay)** at order time, or only after capture;
- what KYC home cooks need for a linked account.

The alternative is **Razorpay's partner/technology-partner model**: each vendor has their own Razorpay account, we create links and subscriptions for them through the partner API, and the vendor is merchant of record. That needs heavier KYC from each vendor and makes our later commission harder.

*Recommendation:* keep Route, as in the spec, because it supports your commission plan. But get written confirmation from Razorpay (and ideally a lawyer) on merchant-of-record status and Subscriptions + Route **before M3**. M1 and M2 don't depend on the answer.

**D. OTP delivery (needed before pilot, not for M1 development).** Supabase phone OTP needs a sender:
- **SMS in India** requires TRAI DLT registration (entity, sender ID and template approval, often 1–3 weeks) and a provider such as MSG91, Twilio or Vonage.
- **WhatsApp OTP** through Supabase's "Send SMS" auth hook and our platform number needs a Meta-approved authentication template, and Meta charges per message.

*Recommendation:* WhatsApp OTP as primary and SMS as fallback; start DLT registration now. M1 uses Supabase **test OTP numbers** locally, so nothing is blocked today.

**E. FSSAI gating scope.** "A kitchen without one can't go live." Many home cooks start without FSSAI registration. Does "go live" mean:
- (i) can't use the vendor OS at all, or
- (ii) can use the OS privately with their own customers, but can't get a public profile or platform leads?

*Recommendation: (ii).* It keeps the free OS useful for onboarding while staying compliant for anything we market.

**F. Vendor-app language.** The bot speaks English, Odia and Hindi, but the spec doesn't say which languages the vendor app and dashboard use. Should v1 be English only, or English + Odia (+ Hindi)? *(Recommendation: build with i18n keys from day one, ship English + Odia for the mobile app, and keep the dashboard English-only at first.)* Translating vendor-facing wording is your call.

### 3.3 Spec gaps I'll resolve with sensible defaults

Unless you object, I'll log each of these in `docs/DECISIONS.md` and proceed.

| # | Issue | Default I'll use |
|---|---|---|
| 1 | **Customer magic link.** Supabase magic links are email-only; phone auth only does OTP. | Our own magic-link tokens: random, stored hashed, expiring, single-customer scope. The customer page reads and writes only through `SECURITY DEFINER` RPCs that validate the token. Customers get no `auth.users` row. |
| 2 | **Staff can't see money or phone numbers, but RLS filters rows, not columns.** | Role-specific views/RPCs: staff and riders read customers through `customers_ops_v` (name, address, diet, notes, masked phone); money tables have owner-only policies. Tests cover it. |
| 3 | **Phone encryption vs. lookups.** WhatsApp inbound and dedup need to find a customer by phone. | `phone_enc` (pgcrypto, key held in Supabase Vault), `phone_hash` (HMAC-SHA256 of the E.164 number, used for unique lookup), `phone_last4` (for masking). Owner, staff and rider phones in `auth.users` stay plaintext, as Supabase stores them (encrypted disk at rest). |
| 4 | **"Every admin access logged" includes reads, but triggers can't log SELECTs.** | Admin console reads go through server-side functions that write `audit_log`. Writes are logged by triggers on every table. |
| 5 | **Slots.** Kitchens have only `cutoff_lunch` and `cutoff_dinner`. | v1 has lunch + dinner as an enum, designed so breakfast can be added with a migration. **Tell me if Bhubaneswar vendors need breakfast in the pilot.** |
| 6 | **Late changes are "charged".** | Late skip/pause: the order stays locked, the `meal` entry is still posted, and the order is marked `skipped` + `charged_late`. Late address change: accepted with no fee if the rider hasn't been dispatched. The customer sees "this meal will still be charged" before confirming. |
| 7 | **The M2 test "20 − 3 = 17" means a late skip doesn't reduce the locked count.** | Matches #6: the late skip happens after lock, so the food is already in production. |
| 8 | **Masked calls for riders need telephony** (Exotel/Knowlarity-style call masking), which isn't in the stack. | M5 v1: the rider app shows the masked number and calls through a vendor-configured bridge if one exists; otherwise "call kitchen". Real call masking stays a later decision with its cost. |
| 9 | **Tables per milestone.** Package 1.1 says "tables". | M1 creates the tenancy, customer, plan, audit and import tables. Each later milestone adds its own tables in its own migrations, so every migration ships with the logic and tests that use it. The full ~30-table model is still designed up front (section 4.3) so names and keys don't change. |
| 10 | **Seed data: "a week of meals"** needs the daily engine (M2). | M1 seeds 2 kitchens, 30 customers (20 in kitchen A to match the M2 test, 10 in B), plans and subscriptions. M2 extends the seed with a week of `meal_orders`. |
| 11 | **Number of web apps.** | One Next.js app with route groups: `/(vendor)` dashboard, `/c/*` customer pages, `/admin/*` console guarded by `platform_admins`. It can be split later if needed. |
| 12 | **Geo.** | PostGIS `geography(Point,4326)` for kitchens and addresses (needed for radius matching in M7). The M1 address pin uses Leaflet with OSM tiles for development; production geocoding (Ola Maps / Google) sits behind an adapter and needs an API key from you later. |
| 13 | **Cutoffs run in IST, pg_cron runs in UTC.** | Cutoffs are stored as local `time` in IST. One pg_cron job runs every minute and locks any (kitchen, date, slot) whose IST cutoff has passed and isn't locked yet. A unique key on `count_snapshots(kitchen_id, date, slot)` makes it idempotent. |
| 14 | **Bulk-imported customers and WhatsApp consent.** Meta requires opt-in; DPDP requires consent. | At import, the vendor confirms they have the customers' consent to be contacted. `whatsapp_opt_in` stays false until the customer replies to an opt-in template. The vendor is recorded as data fiduciary for its own customers, and we are the processor. **Needs a legal check before launch** (not blocking). |
| 15 | **Riders record cash** but riders have no money access. | Riders can insert `cash_collected` on their own stops only, with no read access to balances. The owner confirms it in collections. |
| 16 | **WhatsApp costs** (daily 7 pm nudge, "on the way", 10 pm summary) are paid by us; vendors are free. | Decide in M4. I'll bring a per-customer monthly cost estimate and a per-kitchen cap setting. |

---

## 4. Proposed architecture and order of work

### 4.1 Repository layout (pnpm workspaces + Turborepo)

```
apps/
  web/          Next.js App Router + Tailwind: vendor dashboard, customer pages (/c), admin (/admin)
  mobile/       Expo + TypeScript: vendor app + rider mode (role-based)
packages/
  db/           generated Supabase types + typed client helpers
  core/         pure TS shared logic: IST/cutoff helpers, phone normalisation, CSV/XLSX import validation, money formatting
supabase/
  config.toml   local stack, test OTP numbers
  migrations/   SQL migrations (one per change)
  functions/    Edge Functions (razorpay-webhook, whatsapp-webhook, outbox-worker) — from M3/M4
  tests/        pgTAP tests (RLS, money, counts)
  seed.sql      local seed data
docs/           SPEC, PLAN, DECISIONS, AUDIT
CLAUDE.md       conventions, commands, env vars
.env.example
```

### 4.2 Testing approach

- **pgTAP** (`supabase test db`): RLS isolation, role permissions, ledger and count logic, idempotency.
- **Vitest**: `packages/core` (import validation, IST cutoff maths) and API integration tests that call the local PostgREST endpoint with real JWTs for kitchen A staff and kitchen B owner. This covers "including via the API directly".
- Playwright for one or two smoke flows on the dashboard (from M2).

### 4.3 Full schema design (ahead of build)

Spec tables plus additions needed to meet the guardrails:
- `kitchen_settings` (low-balance threshold, credit limit N, grace days, notice period, phone-pause close time, broadcast cap)
- `platform_admins`
- `member_invites`
- `consents`
- `customer_magic_links`
- `import_batches` / `import_rows`
- `subscription_events` (the transition log)
- `webhook_events` (dedupe on provider event id)
- `add_ons` / `order_add_ons`
- `kitchen_ratings` (M7)

Every vendor-owned table gets `kitchen_id` + RLS. `balance_entries` and `stock_moves` are append-only: no UPDATE or DELETE grants, and triggers raise on any attempt.

### 4.4 Order of remaining work

Same as the spec, with two things pulled forward because of external lead time:
1. **Now, outside code (you):** start the Meta Business verification for the WhatsApp number, the Razorpay test account + Route/partner question (3.2-C), and DLT registration if SMS OTP is wanted.
2. **M1:** Foundation (detailed below).
3. **M2:** Daily engine, after decision 3.2-B.
4. **M3:** Money, after decision 3.2-C (test mode only).
5. **M4 → M8:** as specced.

---

## 5. Exact plan for M1 (adjusted: greenfield)

### 5.0 Scaffolding and docs
- pnpm workspace + Turborepo, shared `tsconfig`, ESLint + Prettier, `.gitignore`, `.env.example` with every variable documented.
- `docs/SPEC.md` (verbatim copy of the spec), `docs/PLAN.md` (work packages with status), `docs/DECISIONS.md` (section 3.3 items plus your answers), `CLAUDE.md`.
- Supabase CLI pinned as a dev dependency; `supabase init`; `config.toml` with test OTP numbers for seed users.

### 5.1 Tables, roles, RLS, audit log, types (1.1)

Migrations:
1. **Extensions:** `pgcrypto`, `postgis`, `pg_cron` (enabled now, used in M2), `citext`.
2. **Enums:** `member_role` (owner, staff, rider), `slot` (lunch, dinner), `diet` (veg, nonveg, jain), `kitchen_status` (draft, active, suspended), `customer_source`.
3. **Tenancy:**
   - `kitchens` with the spec columns; cutoffs as `time` in IST; capacities; `weekly_off smallint[]`; `geo_point geography`.
   - `kitchen_settings`, `members` (unique on `kitchen_id` + `user_id`), `member_invites`, `kitchen_payout_accounts` (structure only), `platform_admins`.
4. **Customers:**
   - `customers`: `phone_enc`, `phone_hash`, `phone_last4`, `source`, `platform_sourced` (protected by a trigger: only platform admins can set it, and nobody can change it once true), `payer_customer_id`, `whatsapp_opt_in`, `preferred_language`, `consent_at`, `deleted_at`.
   - `addresses` (`geo_point`, `landmark`, `delivery_notes`, `is_default`), `consents`.
5. **Plans:** `plans` (`slots slot[]`, `diet`, `days_per_week`, `price_per_meal` in **paise as integer**, `active`) and `subscriptions` (columns from the spec, `status` enum with all six states; the state machine logic comes in M2).
6. **Import:** `import_batches`, `import_rows` (raw JSON, status, error list).
7. **Security helpers** (`SECURITY DEFINER`, `search_path` locked):
   - `is_member(kitchen_id)`, `has_role(kitchen_id, roles)`, `is_platform_admin()`;
   - phone helpers `encrypt_phone`, `phone_hash`, `reveal_phone(customer_id)` (owner/admin only; writes to the audit log).
8. **RLS on every table:**
   - Owners: full access to their kitchen.
   - Staff: read-only, through `customers_ops_v` (no phone, no money columns).
   - Riders: nothing in M1 beyond their own membership and kitchen basics.
   - Platform admins: everything.
   - Base tables deny everything not explicitly allowed.
9. **`audit_log`** and a generic trigger (actor, table, row id, action, before/after JSON, with phone columns redacted) on all M1 tables.
10. **Types:** `supabase gen types typescript` writes to `packages/db/src/types.ts`, run with `pnpm db:types`.

### 5.2 Auth, kitchen profile, members, cutoffs, capacity, shells (1.2)
- **Phone OTP login** in web and mobile using Supabase Auth (test OTPs locally). Phone numbers are normalised to `+91XXXXXXXXXX`.
- **`create_kitchen` RPC:** creates the kitchen + owner membership + default settings in one transaction, with a unique slug.
- **Invites:** the owner invites staff or riders by phone. The invite is claimed automatically on that user's first OTP login (handled by an RPC).
- **Web dashboard:** login, onboarding wizard (name, address + pin, FSSAI number, cutoffs, capacity, weekly off), kitchen settings, members page, global search bar placeholder.
- **Expo app:** login, kitchen picker (if the user belongs to several kitchens), role-aware tabs (owner/staff see a "Today" placeholder; riders see a "Rider mode" placeholder), Android first.
- **i18n scaffolding** (English strings in keys) so Odia can be added without refactoring.

### 5.3 Customers and plans with import and address pin (1.3)
- **Plans:** create, list, edit and deactivate on the dashboard.
- **Customers:** list with search (name / last 4 digits of phone / landmark), create/edit with a map pin, default address, diet, notes, preferred language, and consent checkbox. Two-tap create from the mobile app (name, phone, plan).
- **Import:**
  - Upload CSV/XLSX (parsed client-side with SheetJS), map columns, preview with row-level validation (`packages/core`: required name, valid Indian mobile, duplicates within the file and against existing customers, known plan, valid date).
  - Commit through a single RPC that saves valid rows in a transaction and records bad rows with reasons.
  - Downloadable error report.
  - "Bad rows don't block good rows."
- **Seed:** 2 kitchens (A: Patia, B: Saheed Nagar), 1 owner + 1 staff + 1 rider each, 30 customers (20 A / 10 B), 3 plans per kitchen, subscriptions.

### 5.4 M1 tests (automated + manual)
1. pgTAP: kitchen A staff can't select, insert or update any of kitchen B's rows in any M1 table.
2. pgTAP: staff can't read `phone_enc` or call `reveal_phone`; a rider can't read customers.
3. pgTAP: `platform_sourced` can't be changed by an owner; `audit_log` gets a row for each insert, update and delete.
4. Vitest integration: kitchen A staff JWT → `GET /rest/v1/customers?kitchen_id=eq.<B>` returns `[]`; a direct `PATCH` on B's customer affects 0 rows.
5. Vitest: import 50 rows with 3 bad (invalid phone, missing name, duplicate phone) → 47 saved, 3 reported with reasons.
6. Manual: create 2 kitchens, log in as kitchen A staff in the web app and confirm kitchen B's customers are invisible; repeat in the mobile app.

### 5.5 What M1 won't include (deferred on purpose)
- Meal generation, cutoff locking, ledgers and payments (M2/M3).
- Real SMS/WhatsApp OTP delivery (blocked on 3.2-D; test OTPs only).
- Production geocoding (needs an API key).
- Play Store build (M8).
