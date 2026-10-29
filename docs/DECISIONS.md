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
- Unknown numbers get a polite generic reply. Lead intake for them is M7.

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
