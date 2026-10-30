# Decisions

Defaults chosen during the build, and questions still open for the product owner. **⏳ PENDING** means I picked a default so work could continue, but it needs your confirmation. Changing a pending decision later is cheap until the milestone that depends on it starts.

| ID | Decision | Status | Affects |
|---|---|---|---|
| D-001 | Greenfield build | Assumed | — |
| D-002 | Billing model: prepaid meal balance | ⏳ PENDING | M2, M3 |
| D-003 | Razorpay Route, confirm merchant-of-record | ⏳ PENDING | M3 |
| D-004 | OTP delivery channel | ⏳ PENDING | Pilot |
| D-005 | FSSAI gates public listing, not OS use | ⏳ PENDING | M1, M7 |
| D-006 | Vendor app languages | ⏳ PENDING | M1+ |
| D-007 | Slots: lunch and dinner only | ⏳ PENDING | M2 |
| D-008 – D-028 | Technical defaults | Decided | — |
| D-031 | Phone-close rule: late vendor-entered changes are charged | ⏳ PENDING | M2 |
| D-033 | Trial subscriptions get no meals | ⏳ PENDING | M2, M7 |
| D-035 | Cancellation defaults to today + notice days | ⏳ PENDING | M2, M3 |
| D-029 – D-042 | Daily-engine defaults (M2) | Decided | — |
| D-048 | When subscriptions go low balance, suspended, or cancelled after the grace period | ⏳ PENDING | M3 |
| D-049 | How often low-balance and dues reminders go out | ⏳ PENDING | M3, M4 |
| D-056 | New customers start at zero balance, so onboarding needs opening balances | ⏳ PENDING | M3 |
| D-043 – D-055 | Money defaults (M3) | Decided | — |
| D-057 | Odia and Hindi bot/page texts are drafts | ⏳ PENDING (native review) | M4 |
| D-058 | AI fallback model and when it runs | ⏳ PENDING | M4 |
| D-060 | Inbox is owner-only (staff excluded) | ⏳ PENDING | M4 |
| D-059, D-061 – D-066 | WhatsApp defaults (M4) | Decided | — |
| D-067 | Route optimiser: built-in, VROOM optional | ⏳ PENDING (VPS) | M5 |
| D-068 | No maps API key needed yet | ⏳ PENDING | M5, M7 |
| D-069 | Rider calls: reveal on tap, logged (no virtual numbers) | ⏳ PENDING | M5 |
| D-070 | Delivery code in the "on the way" message | ⏳ PENDING (Meta category) | M5 |
| D-071 – D-076 | Rider-mode defaults (M5) | Decided | — |
| D-077 | Build through all milestones without stopping | Your instruction | M5+ |
| D-078 | Matching rules and ranking weights | ⏳ PENDING | M7 |
| D-079 | Paid trial: per-kitchen trial meals at plan price | ⏳ PENDING | M7 |
| D-081 | WhatsApp leads count as opted in for follow-ups | ⏳ PENDING | M7 |
| D-080, D-082 – D-086 | Acquisition defaults (M7) | Decided | — |
| D-087 | Staff can record supplier bills but not see dues or costs | ⏳ PENDING | M6 |
| D-088 – D-091 | Inventory defaults (M6) | Decided | — |
| D-092 | Monitoring without vendor SDKs (Sentry envelopes, optional PostHog) | Decided | M8 |
| D-093 | Backups: Supabase backups + portable dump + monthly restore drill | Decided | M8 |
| D-094 | Play Store via EAS, internal track first | ⏳ PENDING (accounts) | M8 |
| D-095 | Odisha food calendar dates are approximate drafts | ⏳ PENDING (verify dates) | P5 |
| D-099 | First complaint credited with 1 free meal (kitchen's cost) | ⏳ PENDING | P5 |
| D-101 | Rain/heat thresholds and delivery windows | ⏳ PENDING | P5 |
| D-105 | Commission only on online payments of platform customers, rounded down | ⏳ PENDING (legal/tax) | P6 |
| D-106 | Kitchen switching: platform customers only, admin approves, flag off | ⏳ PENDING | P6 |
| D-096 – D-098, D-100, D-102 – D-104, D-107 – D-112 | P5/P6 defaults | Decided | P5, P6 |

---

## Product decisions (need your confirmation)

### D-001 Greenfield
The folder and repo were empty at audit time (see `docs/AUDIT.md`). You said "start the work" without pointing to earlier code, so the build starts fresh. If earlier work turns up, I'll reconcile it.

### D-002 Billing model ⏳ PENDING (blocks M2/M3 design)
- **Source of truth:** the prepaid meal balance (Σ `balance_entries.meals`). `subscriptions.end_date` is optional and informational only.
- **Pauses:** meals simply aren't consumed during a pause. That covers "pause auto-extends", so "credit instead" doesn't need its own mechanism.
- **No monthly postpaid (khata) customers in v1.** "Credit up to N meals" (`kitchen_settings.credit_limit_meals`, default 0) is the only way to go negative.
- **Refund valuation:** first-in-first-out (FIFO) across recharges at their actual price per meal.
- **Add-ons:** rupee-only balance entries; unpaid amounts become dues.

**Your call:** do pilot vendors need monthly pay-later billing? Is FIFO refund pricing acceptable?

### D-003 Razorpay Route ⏳ PENDING (before M3)
- Keep Route linked accounts as specified.
- Before M3, get written confirmation from Razorpay on two points: who is merchant of record, and whether Subscriptions (UPI Autopay) work with Route transfers.
- `kitchen_payout_accounts` holds one linked account per kitchen. Only platform/service code can write to it.

### D-004 OTP delivery ⏳ PENDING (before pilot)
- **Local development:** fixed test OTP `123456` for seed numbers (`supabase/config.toml [auth.sms.test_otp]`). No SMS is sent.
- **Production proposal:**
  - WhatsApp OTP through Supabase's Send SMS hook (needs a Meta authentication template).
  - SMS fallback through MSG91 or Twilio. This needs TRAI DLT registration; start it now, as it takes 1–3 weeks.

### D-005 FSSAI gating ⏳ PENDING
- Any kitchen can use the OS privately (`kitchens.status = 'draft'`).
- Being **listed** (`status = 'active'`, needed for public profile pages and platform leads) requires a 14-digit FSSAI number. A database check constraint enforces this.
- Only platform admins change status.

### D-006 Languages ⏳ PENDING
- Every vendor-facing string goes through translation keys:
  - mobile: `apps/mobile/src/i18n`;
  - web: still English literals, moving to keys when Odia is added.
- English ships first. The Odia and Hindi dictionaries exist but are empty (they fall back to English) until a native speaker writes and reviews them. I won't machine-translate vendor-facing text.

### D-007 Meal slots ⏳ PENDING
- `meal_slot` enum is `lunch | dinner`.
- Breakfast can be added with one migration (enum value plus `cutoff_breakfast*` columns).
- **Your call:** do pilot vendors serve breakfast?

### D-012 Vendor-facing wording ⏳ PENDING review
These are drafts, all in English:
- error messages (`apps/web/src/lib/errors.ts`, `apps/mobile/src/i18n/en.ts`);
- consent text ("The customer agreed to be contacted by my kitchen about their tiffin…");
- import messages (`packages/core/src/import.ts`).

They need your review before the pilot.

### D-024 Default kitchen policy settings ⏳ PENDING
Each kitchen can change these in Settings. Please confirm the defaults:

| Setting | Default | Source |
|---|---|---|
| Low-balance alert | 3 meals | Spec |
| Credit limit | 0 meals | — |
| Grace days before auto-cancel | 7 | My pick |
| Cancellation notice | 1 day | My pick |
| Phone requests close | 19:00 IST | Spec ("phone pauses close at 7 pm") |

### D-020 Consent ⏳ legal check before launch
- When adding or importing customers, the vendor confirms that the customers agreed to be contacted. This is stored as `consents` rows (`basis = vendor_attested`).
- WhatsApp opt-in is separate (`customers.whatsapp_opt_in`). It stays false until the customer replies to an opt-in template (M4).
- Model: the vendor is the data fiduciary for its own customers, and we are the processor. Needs a DPDP legal check.

---

## Technical decisions (decided; change on request)

### D-008 Customer magic link (M4)
Supabase magic links are email-only. We'll issue our own tokens: random, stored hashed, expiring, scoped to one customer. Customer pages call `SECURITY DEFINER` RPCs that validate the token. Customers get no `auth.users` row.

### D-009 Phone numbers
- **Storage:** normalised to `+91XXXXXXXXXX` and stored in three columns:
  - `phone_enc`: pgcrypto `pgp_sym_encrypt`, keyed by Vault secret `phone_encryption_key`;
  - `phone_hash`: HMAC-SHA256, keyed by Vault secret `phone_hash_key`, used for lookups and uniqueness;
  - `phone_last4`: for masking.
- **Who sees what:**
  - Owners see the full number through `customers_v.phone`.
  - Staff see `+91 ••••••1234`.
  - Riders see no customers in M1 (their stop list comes in M5).
  - Admins see masked numbers. `reveal_customer_phone()` shows a full number and is always written to `audit_log`.
- **Limit:** owner, staff and rider phones in `auth.users` stay plaintext, as Supabase stores them.

### D-010 Hiding columns per role
RLS filters rows, not columns, so:
- Phone ciphertext columns are not granted to API roles at all (column-level `GRANT`).
- Apps read customers through `customers_v` (`security_invoker`).
- All customer writes go through RPCs (`create_customer`, `update_customer`, `import_customers`, `erase_customer`).

### D-011 Fail-closed grants
Default privileges for `anon` and `authenticated` are revoked, so every table and function grant is explicit. A new table is invisible to the API until a migration grants access.

### D-013 Maps
- The web address pin uses Leaflet with OpenStreetMap tiles. That's for development only: OSM's tile policy doesn't allow production use at scale.
- Production tiles and geocoding (Ola Maps or Google, per spec) need an API key and a cost decision. They'll go behind an adapter.

### D-014 Plan days
The spec's `plans.days_per_week` is ambiguous about which days, so `plans.days_of_week smallint[]` (ISO days) is stored and `days_per_week` is generated from it.

### D-015 Money
All amounts are integers in paise (`price_per_meal_paise`), with no floats. `packages/core/src/money.ts` handles formatting and parsing.

### D-016 Cutoffs
- Stored as IST wall-clock `time` plus a `*_prev_day` flag:
  - lunch: 21:00, previous day;
  - dinner: 12:00, same day.
- `packages/core/src/time.ts::cutoffInstant()` converts to UTC. India has no daylight saving time, so IST is a fixed +05:30.

### D-017 Tables per milestone
M1 creates the tenancy, customer, plan, import and audit tables. Each later milestone adds its own tables in its own migrations, together with the logic and tests that use them.

### D-018 Web app shape
- One Next.js 16 app: vendor dashboard at `/`, customer pages at `/c` (M4), admin at `/admin`.
- Cache Components is **off**: every page is per-user, so pages render per request with the caller's Supabase session, and RLS applies to every query.

### D-019 Kitchen status
`draft` (private) → `active` (listed) → `suspended`. Only platform admins change it, through `set_kitchen_status()`.

### D-021 Team invites
- The owner invites staff or riders by phone.
- If the person already has an account, they're added immediately. Otherwise a `member_invites` row is created, and `claim_invites()` turns it into a membership after their first OTP login. Both apps call it on login.
- The owner role can't be invited, changed or removed (no ownership transfer in v1).

### D-022 Staff and rider visibility
- Staff can see customer names, addresses, diet and notes (needed for packing), but not phone numbers, plans, prices or subscriptions.
- Riders see nothing about customers until M5 gives them today's stops.

### D-023 Data erasure
- `erase_customer()` scrubs name, phone, notes and address details. It keeps the row so payment records (M3) stay consistent.
- It's refused while a non-cancelled subscription exists.

### D-025 Import
- At most 2,000 rows per batch.
- File types: `.xlsx` and `.csv`. Legacy `.xls` is rejected with instructions to re-save.
- Dates are read as dd/mm/yyyy (Indian convention). Excel serial dates are handled.
- Rows with a plan create `active` subscriptions starting on the given date, or today if none is given.
- Each row runs in its own savepoint, so bad rows never block good ones. The raw row is stored without the phone number.

### D-026 Subscription status in M1
New subscriptions start as `trial` or `active` only (enforced by a trigger). Every other transition belongs to the daily engine (M2) and will be logged there.

### D-027 Toolchain
- pnpm workspaces + Turborepo.
- TypeScript 5.9 pinned across packages.
- Next.js 16.4 (`proxy.ts` replaces middleware).
- Expo SDK 58 with Expo Router (`src/app`).
- Supabase CLI as a pinned dev dependency.

### D-028 Mobile session storage
Supabase session tokens are kept in AsyncStorage, as Supabase's React Native guide recommends. Moving the refresh token to SecureStore can be reconsidered in the M8 security review.

---

## Daily engine (M2)

### D-029 Balance-driven statuses wait for M3
- The lock posts one `meal` entry per counted order from day one, so the ledger is right from the start.
- *Active → Low balance → Suspended* only makes sense once recharges exist, so those transitions arrive in M3. Until then balances can go negative and nobody is auto-suspended.
- The seed gives active customers an opening balance of 40 meals (`adjust` entries).

### D-030 What "late = charged" means
- A skip or pause that lands after the meal's cutoff is accepted. The meal stays in the locked count and its `meal` entry is posted (charged). It's marked `skipped` + `charged`, so the packing list shows "don't deliver".
- A meal that was already skipped on time is never charged by a later request.
- A late address change is still applied to meals that haven't left the kitchen, with no charge.

### D-031 Phone-close rule ⏳ PENDING (policy)
- The spec says "phone pauses close at 7 pm, WhatsApp stays open until cutoff". Implementation:
  - Changes the vendor enters (`channel = vendor`) count as late once it's past `kitchen_settings.phone_pause_close_time` (default 19:00) on the evening before service, or past the slot cutoff if that's earlier.
  - WhatsApp and web changes use the slot cutoff.
- The vendor sees the charge in the preview and can **waive** it, but only while the slot itself is still open. Once the count is frozen, a late change is always charged. Waivers are recorded (`late_waived`).
- **Your call:** charge or waive by default? Should the rule also apply to dinner (it currently closes 7 pm the evening before)?

### D-032 Resume semantics
A resume ends every skip or pause requested before it that had already started by the resume date, for dates on or after the resume date. A future skip (for a date after the resume date) stays.

### D-033 Trial subscriptions ⏳ PENDING
Following the spec literally, meals are generated only for Active and Low balance (and Paused, for the days after the pause). A **trial gets no meals** until it becomes Active (payment, M3/M7). If pilot vendors run free or cash trials, I can generate meals for trials too.

### D-034 Paused status
- A subscription is `paused` while a pause covers today (all its meals). The nightly job flips it to paused and back to active.
- A pause that starts in the future leaves the status `active`; its days just come out as skipped.

### D-035 Cancellation ⏳ PENDING
- **Default:** cancellation takes effect today + `notice_days` (default 1). The owner can pick an earlier date.
- `end_date` is set to the day before the effective date, and the nightly job sets `cancelled` once it passes. A cancellation effective today cancels immediately; meals already frozen stay.
- The pro-rata refund comes with M3.

### D-036 Production sheet delivery
- **Now:** the web `/sheet` page (print to PDF from the browser) and the mobile packing list.
- **M4:** the WhatsApp image/PDF and the owner's 22:00 summary. Both are already queued in `notifications_outbox` with dedupe keys, so the worker sends each once.
- The "one push at cutoff" needs `expo-notifications` and an EAS project ID (M4).

### D-037 to D-042 Engine mechanics
- **D-037 Stock:** stock deduction at lock is an M6 hook (no recipes yet).
- **D-038 Add-ons:** add-ons in counts arrive with priced add-ons in M3.
- **D-039 Test clock:** `private.now()` honours a simulated clock (`app.now`) only for direct `postgres` sessions (tests, seed). API roles always get the real time.
- **D-040 Empty slots:** every slot past its cutoff gets a snapshot, even with zero meals. That keeps "locked" visible and the lock idempotent.
- **D-041 Audit of the ledger:** `balance_entries` rows aren't copied into `audit_log` one by one. The ledger is immutable and carries `created_by` and `ref`. Changes, snapshots and menus are audited.
- **D-042 Generation:**
  - Orders cover 7 days ahead.
  - They're created immediately when a subscription, plan or kitchen schedule changes (triggers), plus nightly at 00:30 IST.
  - Reconciliation never touches a frozen (date, slot).

---

## Money (M3)

D-002 was still unanswered, so M3 uses its recommended answers:
- the meal balance is the source of truth;
- refunds are valued FIFO;
- no monthly postpaid billing, only the credit limit.

### D-043 Who can take money, and how
- **Online (Payment Links):** only when the kitchen has a verified Razorpay Route linked account. The whole amount transfers to that account, so we hold nothing.
- **Owner-entered:** cash, UPI to the vendor's own number, or bank transfer, with an optional receipt photo stored in the private `receipts` bucket, one folder per kitchen.
- **Rider cash at the door:** recorded against a meal order and *pending* until the owner confirms or marks it "not received".

### D-044 How many meals a payment buys
- **Payment links:** always N meals × the plan price.
- **Manual entries:** default to amount ÷ plan price, rounded down. The owner can type the meal count instead.
- Each purchase lot is valued at what was actually paid (amount ÷ meals), so nothing is lost when the customer is refunded.

### D-045 How refunds are valued
- Meals are used up oldest purchase first.
- Unused meals are valued at the price of the lots they come from. Partial refunds take the oldest remaining meals, so later valuations stay consistent.
- Credits (free meals) are worth ₹0.
- An opening balance or positive adjustment is valued at the plan price.
- A `seq` column breaks ties when several entries share a timestamp.

### D-046 Refund on cancellation
- When a customer's **last** live subscription is cancelled, a pending refund for all unused meals is created automatically. The meals leave the balance at once.
- Meals already past their cutoff are locked (charged) first, so they're never both refunded and charged.
- The owner pays the refund out in cash, by UPI, or online.

### D-047 Which payment an online refund goes back to
- The most recent online payment that still has enough un-refunded amount to cover the refund. Route transfers are reversed (`reverse_all`).
- One refund is never split across several payments. If no single payment covers it, it's paid in cash or UPI.

### D-048 Balance-driven statuses ⏳ PENDING (policy)
| Change | When |
|---|---|
| Active → Low balance | Balance at or below `low_balance_meals` (3) |
| → Suspended | Balance at or below −`credit_limit_meals` (0) |
| Back to Active (or Low balance) | On recharge |
| Trial → Active | On first payment |
| Suspended → Cancelled | After `grace_days` (7) with no recharge |
| Unpaid trial → Cancelled | Once `start_date + grace_days` has passed |

Statuses are re-checked after every lock, payment, credit and refund, and nightly.

**Your call:** are 7 grace days, and the trial rule, right for pilots?

### D-049 Reminder cadence ⏳ PENDING
- **Low balance:** one reminder a day while the subscription is low.
- **Dues:** on day 1, 3 and 7 after the balance went negative.

Both are queued for WhatsApp, which arrives in M4. **Your call:** is a daily low-balance reminder too frequent?

### D-050 Razorpay modes
- `mock`: local only, no network. The mock pay page sends correctly signed events through the real webhook.
- `test`: needs `rzp_test_` keys.
- `live`: refused unless `RAZORPAY_ALLOW_LIVE=true`, which you approve explicitly.

### D-051 Setting up a kitchen's payout account
For now, KYC happens in the Razorpay dashboard and an admin pastes the `acc_…` id and KYC status (admin page). Creating linked accounts through the API comes with M8 onboarding.

### D-052 UPI Autopay is not built yet
Subscriptions with 24-hour pre-debit notices depend on the Route + Subscriptions answer (D-003). The "on autopay" metric reads 0% until then.

### D-053 Receipts
- A printable receipt page (`/print/receipt/[id]`).
- WhatsApp receipt, refund notice and refund receipt are queued in the outbox.

### D-054 Add-ons
Still deferred (see D-038).

### D-055 Payment links
- Links expire after 7 days.
- Razorpay's own SMS/email notifications are off. The vendor shares the link on WhatsApp (their own app now, the platform number from M4).
- The message wording is a draft (D-012).

### D-056 Opening balances are needed at onboarding ⏳ PENDING
- With a credit limit of 0, a customer with no balance is suspended at their first lock.
- Vendors enter existing customers' remaining meals through:
  - the import's "Opening balance (meals)" column;
  - "Credit / adjust → Opening balance" on the customer page;
  - or by recording a payment.
- **Your call:** should new kitchens default to a small credit limit (e.g. 2 meals) during the pilot instead?

---

## WhatsApp (M4)

### D-057 Bot and customer-page languages ⏳ PENDING (native review)
- English is the source text.
- I wrote the Odia and Hindi bot replies, customer-page labels and template texts so the three-language flow works end to end. They are **drafts**: a native speaker must review them before customers see them or templates are submitted to Meta.
- Vendor-facing screens stay English-only for now (D-006).

### D-058 AI fallback ⏳ PENDING
- **What it is for:** free text the deterministic bot didn't understand.
- **Model:** `claude-opus-5-5` by default, configurable with `ANTHROPIC_MODEL`.
- **Settings:** effort `low` (chat), structured JSON output (`reply`, `intent`, `handoff`), and Anthropic's server-side refusal fallback. A refusal hands the conversation to the kitchen.
- **Guardrails in code, not just the prompt:**
  - money negotiations (discounts, refunds, "free", compensation) never reach the model;
  - replies mentioning a price that isn't in the kitchen's data, or promising anything, are replaced by a hand-off.
- **Without `ANTHROPIC_API_KEY`:** a rule-based fallback answers a few FAQs (cutoff times, FSSAI number, plan price) and hands off everything else.
- **SDK:** pinned to `@anthropic-ai/sdk@0.137.0` (the 1.x line was 6 days old) and loaded only when a key is set.
- **Your call:** keep Opus 5.5, or use a cheaper model for this high-volume, simple job? That is a cost/quality decision I haven't made for you.

### D-059 One platform number, routing
- Customers are recognised by the hash of their phone number.
- A number that is a customer at several kitchens is asked which kitchen. The choice sticks for 12 hours, or comes from an invite code ("Hi maa-tarini-tiffin").
- Unknown numbers ~~get a polite generic reply~~ start the new-customer bot, or the vendor sign-up bot when they say they run a kitchen (M7, D-083).

### D-060 The inbox is owner-only ⏳ PENDING
- Conversations include balances and payments, and staff have no money access, so only owners see the inbox.
- **Your call:** should staff be able to see and answer messages, perhaps with money messages hidden?

### D-061 How the bot behaves
- **Priority order:** menu buttons, then keywords (English, Hindi, Odia), then the guardrails, then the AI fallback, then the kitchen inbox.
- **Changes:** an on-time skip is applied immediately. A late skip or pause is previewed with "will still be charged" and needs confirmation, so the customer is told before confirming.
- **Cancellations** always go to the kitchen, so refund terms are explained by a person.
- **While a conversation is with the kitchen**, the bot stays quiet except for "hi"/"menu", until the owner taps "Done, hand back to bot".

### D-062 Opt-in and the 24-hour window
- The bot asks for opt-in once, on the customer's first message.
- Business-initiated templates (receipts, reminders, the 7 pm nudge, announcements) go only to customers who opted in. Replies inside the 24-hour window go to anyone, because the customer wrote first.
- Opt-in and withdrawal are recorded in `consents`.
- Vendors move offline customers to WhatsApp with an invite link that opens a chat with the platform number and carries their kitchen code.

### D-063 Customer page links
- Random 256-bit tokens, stored only as a SHA-256 hash, valid 7 days, one customer each.
- Sent by the bot ("my page") or shared by the owner.
- The page works without a login: every RPC checks the token and is limited to that customer.
- Cancellations aren't possible from the page (they go to the kitchen); changes are recorded with channel `web`.

### D-064 Complaints
- **Created** from WhatsApp, the customer page, or by the vendor. Creating one hands the conversation to the kitchen and alerts the owner.
- **Escalation:** if there's no response within **2 hours**, the complaint escalates to the platform team (admin page).
- **Resolution:** the owner can add free-meal credits, linked to the complaint.
- **Grievance contact:** shown on the customer page (`NEXT_PUBLIC_GRIEVANCE_CONTACT`). The bot acknowledges every complaint immediately, well within the 48-hour rule.

### D-065 Announcements
- Owner-written and sent only to opted-in customers with a live subscription.
- Capped at **4 per kitchen per month** by default. The cap is a platform setting that owners can't change.
- Sent with the `kitchen_update_v1` template (marketing category, so Meta charges more for it).

### D-066 How outbound messages are sent
- `notifications_outbox` is drained by the `whatsapp-outbox` Edge Function. pg_cron starts it every minute through `pg_net`, using the Vault secrets `functions_base_url` and `service_role_key`; the inbox also starts it right after a reply.
- Failed sends retry with exponential backoff for up to 5 attempts.
- Messages to customers are logged in their conversation.

---

## Rider mode (M5)

### D-067 Route optimisation ⏳ PENDING (VROOM hosting)
- **Always available:** a built-in optimiser in Postgres (`private.tsp_order`: nearest neighbour, then 2-opt until no move improves). It runs in milliseconds for a kitchen's stops, needs no server, and is what the acceptance test checks.
- **VROOM (optional):** set `VROOM_URL` (Edge Function secret). "Optimise" on a route then asks VROOM and saves its order. By default we send VROOM a travel-time matrix computed from straight-line distances, so VROOM needs no OSRM road-routing server (heavy: it needs the Odisha road map). With `VROOM_USE_ROUTING=true` VROOM gets coordinates and uses its own router. If VROOM fails or times out, the built-in optimiser is used.
- **Never worse:** "Optimise" also improves the current saved order with 2-opt and keeps the shorter of the two results, so it can't make a route longer (fix found by the integration tests, migration `20261101000200`).
- **Not tested against a real VROOM server**: the image couldn't be pulled in this sandbox.
- **Your call:** run VROOM (plus OSRM if you want road distances) on your VPS now, or stay on the built-in optimiser for the pilot? With 10–80 stops in 3 km the difference is small.

### D-068 Maps and geocoding ⏳ PENDING
- v1 needs no maps API key. Locations come from the vendor's map pin (Leaflet + OpenStreetMap) and WhatsApp location shares; distances are computed from coordinates.
- Navigation opens Google Maps with a directions link (`travelmode=two-wheeler`), which needs no key.
- An Ola Maps or Google key is only needed for typed-address search (geocoding), useful for lead intake (M7). OSM tiles are fine for low traffic; a production tile provider is D-013.

### D-069 Rider calls ⏳ PENDING
- The rider sees `XXXXXX1234`. Tapping Call fetches the real number only for their own pending stop on a run that is out (today), writes an `ACCESS` row to `audit_log`, and opens the dialer, so the number is visible in the phone's call log.
- True masking (a virtual number that bridges the call) needs a telephony provider such as Exotel or Knowlarity, which costs per minute.
- **Your call:** is reveal-on-tap acceptable for the pilot?

### D-070 Proof of delivery ⏳ PENDING (Meta category)
- Starting a run sends each customer `on_the_way_v1` with a 4-digit code. The rider types the code to deliver; wrong codes online are rejected (5 tries, then photo).
- Customers who haven't opted in to WhatsApp get no code, so the rider takes a photo (stored in the private `proofs` bucket, readable by the owner). "Deliver without proof" exists but lowers the proof rate (goal: 90% of stops proved).
- Offline, the code can't be checked on the phone (the phone never holds it); it is recorded and checked at sync, and a wrong one is flagged for the owner.
- **Meta:** a template carrying a code might be re-categorised as "authentication". Check when submitting.

### D-071 Failed deliveries
- Customer-side reasons (not home, wrong address, refused, phone unreachable) keep the meal charged.
- Kitchen-side reasons (food late, food problem, meal missing, vehicle or rider problem; the vendor's riders are the vendor's responsibility) post a `credit` balance entry for the meals at the price they were charged, and the customer gets `delivery_credit_v1`.
- "Other" needs a note and gives no automatic credit; the owner can credit by hand.
- Meals skipped after the cutoff stay charged but aren't delivered (the customer said no).

### D-072 Offline timestamps
- Every rider action carries the time it was tapped and a client id. The server keeps the device time, clamped between the day before the service date and the server's "now"; a clamped raw time is kept in `device_at`.
- The same client id sent twice counts once. If two actions hit one stop, the first one wins and the second is reported back as a conflict.
- The queue lives in the phone's storage, so it survives the app being closed. Logging out is blocked while actions are waiting.

### D-073 How runs are built
- At each slot lock, deliverable orders become one run per route, one stop per customer address.
- A kitchen starts with "Route 1" (its only rider is assigned automatically). Owners or staff can add routes and move stops between them.
- The first build of a route is fully optimised. After that, new addresses are slotted in at the cheapest place and the saved order is kept.
- Drag reorders and moves are written back to the saved route, so the next day's run keeps them.

### D-074 Who delivers
- Riders, and owners (many home cooks deliver themselves: owners get a "Deliver" tab).
- Staff can't be assigned as riders. An owner can change a staff member's role to rider in Team.

### D-075 Rider pay stats
- Shifts = finished runs; km = the run's planned km (straight-line × 1.3), not a GPS odometer; plus stops delivered/failed, proof rate and cash collected.

### D-076 Tiffins
- Each delivery records tiffins given and empties taken back (`tiffin_ledger`, append-only). A customer holding 2 or more with nothing returned for 2 days is flagged as overdue.

### D-077 Building without stopping
- Your instruction during M5: "continue till the all finish also complete automate about getting the new customers and food vendor in parallel as well". So I'm building M5 → M8 without pausing for review between milestones, and adding automated acquisition of both new customers and new vendors (lead intake and matching, vendor sign-up and onboarding).
- I still commit and push each milestone separately with its tests, and log every default here.

---

## Acquisition (M7)

### D-078 Matching ⏳ PENDING (weights)
- **Who can be offered:** kitchens that are active (which needs an FSSAI number, D-005) and taking platform leads (owner setting), with the lead inside the kitchen's own service radius (default 3 km), an active plan covering the requested meals and the exact diet, and a free place for every requested slot.
- **Free places** = capacity minus the busiest day's counted meals over the 7 days from the start date, minus trials waiting for payment (each holds a place).
- **Ranking:** 60% verified rating, 40% price fit (how close the plan price is to the budget), then distance. Ratings use a prior of 4.0 worth 3 reviews, so a single 5★ review doesn't top the list and new kitchens aren't buried.
- **Plan offered:** per kitchen, a plan with exactly the requested meals first (a lunch-only lead gets a lunch plan, not a cheaper lunch + dinner one), then the price closest to the budget.
- **Shortlist:** the top 3, from which the customer picks (spec: "2–3 kitchen profiles").
- **Your call:** are the 60/40 weights right? Should distance count more?

### D-079 Paid trial and funnel ⏳ PENDING
- Each kitchen sets its trial length (`trial_meals`, default 2, max 7). The trial is paid at the plan price, online or in cash, through the normal payment paths. The money goes to the kitchen; we hold nothing.
- The customer is created at the kitchen when they pick it (trial subscription). Meals start once the trial is paid (D-033).
- **Funnel stages come from real events:** first payment = trial (or straight to converted if it buys more than the trial), next payment = converted (plan), a payment 25+ days after conversion = month-2 renewal. The team can only set new/qualifying/waitlist/lost by hand.
- **Day-2 follow-up:** about 20 hours after the trial payment, the customer gets `trial_followup_v1` offering a month of the plan (plan days × 4 weeks) with a payment link.
- **Known overlap:** a 2-meal balance is "low balance" under the M3 rules, so the low-balance reminder can also go out. **Your call:** keep both, or suppress the low-balance reminder during a trial?

### D-080 Areas without geocoding
- 31 Bhubaneswar areas with approximate centres and common spellings ("csp" → Chandrasekharpur, "kiit" → KIIT Square) let a typed area be matched without a maps API key (D-068). The bot always asks for a shared location first, which is precise. Unknown areas are asked again.

### D-081 Consent for leads ⏳ PENDING
- **Website and vendor forms:** consent to be contacted is required; WhatsApp updates are a separate, optional tick.
- **Google Ads forms:** WhatsApp only if the form has a WhatsApp question answered yes; otherwise the team calls.
- **Justdial:** never opted in (they don't collect it); the team calls.
- **Customers can always opt out** by replying STOP (and back in with UPDATES).
- **People who message us on WhatsApp** are treated as opted in for follow-ups about their enquiry (the 24 h reminder, the trial offer). **Your call:** is this acceptable, or should the bot ask an explicit opt-in question?

### D-082 Platform-sourced customers
- Created only by the platform (website pick, WhatsApp pick, or the team placing a lead), with `source = platform` and `platform_sourced = true`, which nobody can clear (database trigger) and vendors can't set or change.
- A person who is already that kitchen's customer can't be claimed (`already_customer`), so commission can never be charged on a vendor's own customers.
- The vendor is told on WhatsApp (`new_platform_customer_v1`) and sees a "Platform" badge.

### D-083 Bringing in new vendors
- **Entry points:** the `/vendors` page, WhatsApp ("Hi VENDOR", or "I run a mess"), Instagram/Google campaign codes, and the team.
- **Applications** are linked automatically to the kitchen created with the same phone number (onboarding) and closed when it goes live.
- **Nudges:** on day 1, 3 and 7 the applicant gets `vendor_nudge_v1` naming their next step (sign up, profile, FSSAI, plans, menu, payout KYC, customers, rider).
- **Where to recruit:** the funnel page's demand gaps list areas where leads are waitlisted (no kitchen with space), the nearest live kitchen and open applications there. Applications show how much waiting demand is within 3 km.
- Going live still needs an FSSAI number and an admin (D-005).

### D-084 Public pages
- `/find`, `/kitchens`, `/k/<slug>` and `/vendors` need no login. Profiles show only active kitchens and never phone numbers.
- **Abuse guard:** at most 5 website enquiries per phone per day.
- **Ratings** count only when the reviewer has received meals from the kitchen (verified). Admins can hide a review.
- Refund and cancellation terms are shown before payment (consumer protection).

### D-085 Lead intake endpoints
- `lead-intake?source=google_ads`: Google's lead-form webhook, authenticated by the `google_key` field (`GOOGLE_ADS_LEAD_KEY`).
- `lead-intake?source=justdial|instagram|website|referral|other&key=…`: Justdial's push and a generic JSON format, authenticated by `LEAD_INTAKE_KEY`.
- Idempotent on (source, external id), matched immediately, and welcomed on WhatsApp only when opted in.

### D-086 Funnel log
- `lead_events` (append-only) records created, enquiry, qualified, matched/waitlist, chose_kitchen, trial_paid, trial_followup, reminded, converted, renewed, status changes and phone reveals. Bot answers are not events.

---

## Inventory (M6)

### D-087 Who does what in inventory ⏳ PENDING
- **Owner and staff:** items, recipes, supplier bills (quantities and bill amounts), wastage, stock-takes, the production plan, alerts.
- **Owner only:** paying suppliers and supplier dues, stock adjustments outside a stock-take, cost per meal and margins, stock value, cost per portion, the money value of stock-take differences and old/new prices in price-jump warnings (staff see the percentage).
- **Riders:** nothing.
- **Your call:** the spec says staff handle "inventory only, no money". I treated supplier bill amounts as kitchen costs staff may enter (they usually do the shopping), but kept dues, payments and margins from them. Should staff enter bill amounts at all?

### D-088 Units and recipes
- Each item has one stock unit (kg, g, l, ml or pc), and every quantity of it is stored in that unit. Forms accept any unit of the same kind and convert ("30 g" of dal stocked in kg → 0.03 kg).
- A dish lists which diets it serves; at the lock, portions per dish = counted meals of those diets for the slot's menu. Menu dishes are matched to recipes by name.
- Consumption is posted once per item per locked slot (unique key), so the idempotent lock stays idempotent. A recipe problem never blocks the lock (it is logged instead).

### D-089 Costing
- **Unit cost:** weighted average of the last 90 days of purchases, else the last price; stored on every stock move at the time it happens.
- **Cost per meal** = (recipe consumption + wastage + stock-take losses + gas + packaging) ÷ meals locked. Gas and packaging are flat per-meal amounts the owner sets (default ₹0).
- **Revenue** = meals locked × the price frozen at lock, so margin is per meal actually charged.

### D-090 Stock-take and alerts
- A variance needs a reason when it is more than 2% of the expected quantity (kitchen setting `variance_reason_pct`). Closing is refused until every such line has one.
- **Alerts:** low stock (at or below the item's minimum, once a day per item), a purchase price more than 15% above the recent average (kitchen setting `price_jump_pct`), and a stock-take variance over 10%. The owner gets `stock_alert_v1` on WhatsApp; the 10 pm summary lists low-stock items.

### D-091 The 10 pm summary
- It now includes today's collections (paid payments) and low-stock items. Both were placeholders since M2/M3; the template gained a sixth parameter (`owner_summary_v1`, not yet submitted to Meta).

---

## Admin and hardening (M8)

### D-092 Monitoring
- **Errors:** Sentry, through its plain HTTP envelope API from Edge Functions, the web app and the mobile app. There are no heavy SDKs or native modules, so it works in Expo Go and adds nothing to the bundle. Phone numbers are masked before sending. Nothing is sent unless a DSN is set.
- **Analytics:** PostHog on the web only, off unless `NEXT_PUBLIC_POSTHOG_KEY` is set. It records page views and funnel events (lead submitted, kitchen picked, vendor applied) without phone numbers or names. Turn it on only after the privacy policy mentions it.

### D-093 Backups and restore
- **Production:** Supabase's daily backups or PITR (a paid-plan feature: your call when going live), plus `pnpm db:backup` for a portable copy kept off the server.
- **Restore drill** (`pnpm db:restore-drill`): restore into a scratch database and compare every table's row count and the ledger totals. It passed locally (51 tables). Run it monthly.
- Vault keys are never in backups; keep them in a password manager.

### D-094 Play Store ⏳ PENDING (your accounts)
- Android first via EAS: `development`, `preview` and `production` profiles; production goes to the internal track as a draft.
- Needs your Expo account, a Google Play developer account and a service-account key (docs/RELEASE.md). No build has been made yet (expo.dev was unreachable from the sandbox).

---

## P5 and P6 (built 2026-10-30; P6 switched off)

Your instruction: "build P5 and P6", and for P6 "build both, switched off". Everything below is on by default in P5 only where it costs the kitchen nothing; anything that moves money or meals is off or zero until someone turns it on.

### D-095 Odisha food calendar ⏳ PENDING (verify dates)
- One platform table (`food_calendar`): Kartika month as a date range per year, and festivals (some marked veg-only). The platform team edits it in the admin console (`admin_upsert_calendar_entry`, `admin_delete_calendar_entry`).
- **Seeded 2026–2027 with approximate dates** (Purnimanta Odia calendar): Kartika 27 Oct – 24 Nov 2026 and 16 Oct – 14 Nov 2027 (day after Kumar Purnima to Kartika Purnima), plus Raja, Rath Yatra, Nuakhai, Durga Puja, Diwali, Prathamastami, the Manabasa Gurubar Thursdays, Pana Sankranti and others.
- **Your call:** please check the dates against this year's Odia panjika (or ask a pilot vendor) before vendors rely on them.

### D-096 Veg days and Kartika
- **Kitchen settings:** veg days of the week (Tue/Thu by default, but **off** until the kitchen turns them on) and Kartika veg mode (off).
- **Customer opt-ins** (off): "observes veg days" and "observes Kartika". The owner sets them, or the customer on their page.
- On such a day a **non-veg** order is counted, cooked and packed as **veg** (`meal_orders.veg_override`). Jain and veg orders never change, and the price stays the plan's price.
- A festival marked veg-only counts as a veg day for customers who observe veg days (in kitchens that have veg days on).
- It happens inside `private.refresh_orders()`, so a slot past its cutoff or already locked is never changed, and the lock is still the only path that posts meal entries. Counts show `veg_switched`; the packing list and stickers mark the switched tiffins.

### D-097 Parent pays, student eats
- **Balances stay per eater.** The payer is another customer of the same kitchen (`set_payer`). Nobody pays for themselves, and there are no chains: a payer has no payer, and someone who pays for others can't get one (a database trigger enforces this for every path).
- **Messages:** low-balance, dues, payment receipts and refund messages for the eater go to the payer, naming the eater and linking the payer's customer page (templates `*_payer_v1`). Menus, delivery codes and complaint replies still go to the eater.
- **Payer's page** lists each dependent's balance and lets them pay for that dependent (`portal_dependent_payment_link_record`; Razorpay's contact is the payer). The payment and its meals belong to the eater.
- Staff still never see phones or money.

### D-098 Dispatch photo and QR stickers
- Owner or staff record a photo of the packed meals per slot (or per run) in the private `dispatch` bucket. The **first** photo's time is the slot's "prepared" time; a retake keeps it.
- Every stop gets a random 10-character sticker code (50 bits), stable while the run is rebuilt. The sticker sheet (owner + staff) has route order, name, flat/landmark, meal count, diets (veg-day switch marked), notes and the code. No phone numbers, no money.
- **Scanning is optional.** `complete_stop` accepts `p_scan_token` (new last parameter; existing callers work unchanged) and refuses a mismatch with `wrong_tiffin`. The code is also in `rider_today()` so the app can check a scan offline before queueing.

### D-099 First complaint credited ⏳ PENDING
- A customer's **first** food or delivery complaint at a kitchen (late, quality, quantity, missing, hygiene, delivery) gets **1 free meal** at once, through the normal `credit` entry (valued ₹0, like credits given when resolving a complaint), once per complaint, then the balance status is re-checked and the customer is told (`complaint_credit_v1`).
- Earlier billing, privacy or "other" complaints don't use up the first credit. Kitchen setting `auto_credit_first_complaint`, **on** by default.
- **Your call:** this is the kitchen's cost. Is "on by default" right, or should kitchens opt in?

### D-100 Complaint scores
- **Kitchen:** complaints in the last 30 days per 100 meals served (locked and not skipped or failed), median minutes to the first response (the first inbox reply or resolution), unanswered and escalated counts, by category.
- **Customer:** complaints in the last 90 days against their meals served.
- Owners see their own; the platform team sees every kitchen (`admin_complaint_scores`).

### D-101 Rain and heat alerts ⏳ PENDING
- Twice a day (06:00 and 16:00 IST) the `weather-alerts` function reads Open-Meteo's free hourly forecast (no key) for each kitchen location.
- **Windows:** lunch 11:00–14:00, dinner 19:00–22:00. **Heavy rain:** 7.5 mm or more in any hour of the window, or a thunderstorm/heavy-shower code with at least 60% probability. **Heat:** 40 °C, or feels-like 45 °C.
- At most one alert per kitchen, date and slot. The owner is told (on by default); customers with a meal in that slot get "delivery may be late" only if the kitchen opts in (off).
- `WEATHER_MODE=mock` is the default and needs no network. **Your call:** are these thresholds right for Bhubaneswar summers and monsoon?

### D-102 Churn alerts
- Nightly at 01:00 IST, per kitchen, customers with a live subscription are flagged with reasons: `balance_out` (0 meals or fewer and no recharge for 3 days), `skips` (3 or more skipped days in the last 7), `open_complaint`, `paused_long` (paused more than 7 days), `trial_not_converted` (platform customer whose trial is unpaid, or paid more than 3 days ago with no plan yet).
- Owner-only list (`at_risk_customers`); the 10 pm summary payload carries the count (the approved template text is unchanged).

### D-103 Referrals
- Every customer has an 8-character code for their kitchen, shown on their page.
- **Linking a new customer:** the owner (`apply_referral_code`, right after adding them), the customer on their page before their first payment, or a lead whose campaign is `ref-<CODE>` (the website `?ref=` link or "Hi TIFFIN ref-CODE" on WhatsApp) once they pick that same kitchen. Codes from another kitchen are ignored.
- **Reward:** after the referee's first paid recharge (cash counts), both get N free meals. N is the kitchen setting `referral_reward_meals`, **default 0 (off)** because it is the vendor's money. Once per referral.

### D-104 Prepared to delivered
- A run is "prepared" at its dispatch photo (its own, else the slot's), else when it started. Every 5 minutes, runs with stops still pending that long after alert the owner **once per run** (`late_delivery_v1`).
- Kitchen setting `late_alert_minutes`, default 90 (30–600).

### D-105 Platform commission ⏳ PENDING (legal/tax)
- A per-kitchen rate in basis points, set only by the platform team (default 0, at most 3000 = 30%).
- It applies only to **online payments by platform-sourced customers**. A vendor's own customers and cash payments never pay commission.
- Commission is rounded down. The Route transfer to the kitchen is the amount minus the commission, and the commission is recorded once per captured payment in an append-only ledger (`platform_commissions`).
- With rate 0 (today) nothing changes.
- **Gap:** a refund reverses the whole Route transfer but doesn't yet write a negative commission row.
- **Your call:** confirm the GST/invoicing treatment with your CA before setting any rate.

### D-106 Kitchen switching ⏳ PENDING
- Behind the platform flag `kitchen_switching`, **off**. Every entry point (customer page and admin) refuses with `feature_disabled` while it's off.
- **Who can switch:** only platform-sourced customers, so we never move a vendor's own customers.
- **Flow:** the customer sees kitchens with the same meals, diet and exact price per meal and requests one; the platform team approves or rejects.
- **On approval:** the old subscription ends at the first date with nothing frozen, through the normal cancel path, so unused meals are refunded by `private.create_refund` (we hold no money). The customer joins the new kitchen through the normal lead → customer path (platform-sourced, trial to pay the new kitchen directly). Both sides are told.
- An open lead for the old kitchen is closed as lost ("Switched kitchen"); closed funnel stages are left alone.

### D-107 Switch matching
- Same eligibility as `private.match_kitchens` (active, taking platform leads, inside the kitchen's radius, a free place), plus the exact same plan slots, diet and price. Ranked by verified rating, then distance.
- If the matching rules in D-078 change, change `private.switch_options()` too.

### D-108 Shared riders
- A rider can be a member of several kitchens (invite them in each). `rider_today()` and `my_run_ids()` already returned the caller's runs across kitchens: each run carries its kitchen's name. Tests now prove it: still only their own stops, phones masked, and each kitchen's rider-pay report counts only its own runs.

### D-109 Office plans
- **An office** has a name, delivery point, contact (phone encrypted) and a billing customer.
- **Payment:** members' payer is the billing customer (reuses D-097), so balances and counts stay per person.
- **Delivery:** route building puts all members' meals into **one stop per office** (meal count = sum, addressed to the office). A kitchen-fault failure credits each member their own meal.
- **Monthly statement** for the owner: meals charged per member, payments and balances.

### D-110 Health tags
- **Fixed list:** diabetic, low salt, low oil, low spice, no onion/garlic, soft food. Stored only with consent (a `health_data` consent record); an empty list withdraws consent and deletes the data. Erasing a customer deletes it too.
- **Who sees them:** owner and staff (packing list, stickers, count breakdown `by_health`), never riders.
- **Who records them:** the owner, or the customer on their page.

### D-111 Notebook-photo import
- The owner uploads a photo of the paper register to the private `imports` bucket (5 MB, owner-only). The `notebook-import` function asks Claude to transcribe it, using `ANTHROPIC_MODEL` (default `claude-opus-5-5`, the same as the chat fallback), with a JSON schema.
- **Guardrails** (`_shared/notebook.ts`): nothing invented, phones checked with the same rules as `@tiffin/core`, low-confidence rows flagged, meals left only as a suggestion. It returns a **preview only**; the owner confirms through `import_customers`, which re-validates.
- Without an API key it returns a fixture (mock mode).
- **Gap:** uploaded photos are not deleted automatically yet (retention to decide).

### D-112 Review fixes in P5
- Rider idempotency keys are now scoped to their stop: an op id already used on another stop is refused (`invalid_client_op`) instead of returning that stop's result.
- Inventory variance alerts show the IST date of the stock-take.
- `otp_sent` in `rider_today` was checked and is right: a queued, sending or sent "on the way" message means the customer got a code, and a cancelled one (not opted in) or failed one means they didn't. Seed runs read false because the seed cancels its own messages.


### D-113 Refunds reverse the platform commission
- A processed refund of an online payment that carried a commission writes one `platform_commission_reversals` row: commission × refund ÷ payment amount, rounded down, never more than what is left of that commission (`private.reverse_commission`, trigger on `refunds`). Append-only, owner/admin read.
- Razorpay refunds already use `reverse_all`, so the vendor's transferred share comes back and the platform pays back its own share; the ledger now matches.
- `admin_commission_report` and `commission_statement` return gross, `reversed_paise` and net commission (reversals counted in the period they happen).
- Refunds paid from the FIFO value without a linked online payment (`payment_id` null) reverse nothing: no commission was taken on cash.
