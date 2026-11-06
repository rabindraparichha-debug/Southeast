# Vendor-first audit (research only)

| | |
|---|---|
| Repository | `rabindraparichha-debug/Southeast` |
| Commit audited | `34c5877` on `m9-p5-p6` (2026-11-06, "app.json: remove duplicates written by eas init"). This is also the current tip of `m9-p5-p6`, so every citation below matches that branch. |
| Date | 2026-11-06 |
| Scope | Phase 1 automates the vendor (owner, staff, riders) while their customers stay offline. Phase 2 automates the customer. |
| Method | 165 agents in all.<br>• 9 code readers, one per area of the code.<br>• 2 vendor-journey walkthroughs: Sujata, a home cook with 28 mostly offline customers who bills at month end and whose son delivers; and Ramesh, a mess with 180 subscribers, 2 staff, 3 riders and an accountant.<br>• A full build and test run against a local Supabase stack.<br>• Every critical and high finding was checked by 2–3 independent skeptics.<br>• A completeness critic, then 5 follow-up deep dives.<br>The journey sections below were drafted from those results, and their citations were checked again against `34c5877`. |
| Changes made | None to the repo except adding this file on branch `audit/vendor-first`. Nothing else was edited. Tests ran in a throw-away copy. |

Path note: short migration names mean `supabase/migrations/2026xxxx_<name>.sql`. For example, `money.sql` is `supabase/migrations/20261029000200_money.sql` and `p5.sql` is `supabase/migrations/20261105000100_p5.sql`.

---

## Summary

### Ready for Phase 1 (vendor automation)

The vendor engine is real, and most of it is sound. It needs **no Razorpay, Meta, Anthropic or maps account**.

What already works:
- Tenant isolation through row-level security.
- Encrypted phone numbers.
- Meal generation 7 days ahead.
- A cutoff lock that is safe to repeat, with frozen counts and charges.
- The kitchen sheet and packing lists.
- Delivery runs built at lock, with saved routes and a built-in optimiser.
- A rider mode that works offline, with photo or no-proof delivery.
- Excel/CSV import.
- Recording cash, UPI and bank payments.
- Inventory and printing.

One test proves the point for offline customers. As an owner, it added an offline customer, subscribed them, recorded cash, skipped, paused, resumed, changed the address, cancelled and refunded. **No customer app was needed at any step.**

Typecheck, lint and the web build pass. With Node 22, all 121 integration tests pass. 873 of 882 database tests pass; the 9 failures are a date bug in the tests themselves.

### Ready for Phase 2 (customer automation)

The code exists, but it has **only ever run in mock mode**. That covers:
- the WhatsApp bot with guardrails
- the customer page
- the delivery OTP
- lead capture from the website, WhatsApp, Google Ads and email
- matching
- trials
- online payment links through Razorpay Route
- reviews, commission and kitchen switching

UPI Autopay is not built. The Razorpay model makes the platform the merchant of record, which contradicts "we never hold customer money", and that decision (D-003) is still open. Phase 2 also needs Meta verification, about 33 WhatsApp templates, and several security fixes first.

### Top blockers

1. **Money is prepaid-only.**
   - Any customer with a zero balance is suspended at the next lock.
   - Their future meals are deleted from counts, packing and routes.
   - 7 days later they are cancelled for good, and nothing can bring them back.
   - This hits every cash and month-end customer, which is most Phase 1 customers.
   - Dues are also valued at today's plan price.
2. **No one can log in on a hosted project.** Login is phone OTP only, and no SMS sender is configured. This is a setup task, but India's TRAI DLT registration takes 1–3 weeks.
3. **Only the owner can act.** Staff and riders cannot record a skip, pause, new customer or cash, and the owner is away about 40 days in 60.
4. **The rider app can silently lose records.** It deletes any queued delivery, together with its photo and the cash collected, whenever the server refuses it, including for temporary errors.
5. **Nobody is told when the daily engine fails.** One failing kitchen blocks the lock for every kitchen, and the catch-up looks back only one day.
6. **The basics for running on hosted are missing:**
   - **Signing:** APKs get a new signing key on every build, so each update means uninstalling, which wipes unsynced rider data.
   - **Storage:** nothing is ever deleted, so Supabase Free is outgrown in the first month, and then the lock stops.
   - **Credentials:** the Vault keys must be created and backed up.
   - **Login safety:** hosted auth settings (phone confirmation) must be fixed, or a stranger could claim staff invites.
   - **Legal:** the pages are drafts, with no vendor terms.

**Next most important (each has a workaround, but they cause wrong charges or wrong deliveries):**
- **Changes the vendor enters follow the wrong rules.**
  - They count as late from 19:00 the day before, so every same-day dinner skip is charged.
  - Changes after the lock never reach the rider until someone presses "Plan / refresh".
  - A dated address move redirects earlier meals too (found by the test run).
  - There are no closure days.
- **Customer and growth features sit in the vendor screens with no switch, and three of their defaults are unsafe:**
  - a kitchen marked active is open to marketplace leads
  - the first complaint gives a free meal
  - customer messages pile up with no expiry
  - on a hosted project with no payment keys, a public test page can also credit meals for free
- **There is no CI.**
  - The database tests have been red since about 3 November.
  - The declared Node 20 cannot run the integration tests.
  - No milestone has had the founder's test pass.

---
## Phase 1 — Vendors

This walks a vendor's journey from first hearing about us to staying with us. Each step lists **what exists**, with file:line citations, and **what is missing or broken**.

**Severity**, relative to Phase 1:
- **Blocker:** the pilot cannot start, a vendor cannot run a normal week without the paper register, records or money can be silently lost or wrong for most customers, or a security hole would be exposed on a live hosted project.
- **Important:** wrong or painful in common specific cases, or needed before the pilot ends.
- **Nice-to-have:** polish, or later.

Phase 2/3 code that is present but must stay switched off is marked **Switch-off**.

**Status column:**
- **Verified:** every skeptic confirmed it.
- **Verified, corrected:** confirmed, with the skeptics' correction applied.
- **Found by test run:** observed while executing the code.
- **Follow-up, spot-checked:** from a follow-up deep dive, and I checked it in the code.
- **Follow-up, not verified:** from a follow-up deep dive, not checked.
- **Not verified (medium/low):** never sent to the skeptics.

#### 1. Finding us
In Phase 1 the founder recruits each pilot vendor in person, so this step needs nothing from the product. The code has two self-serve channels, both built for the marketplace. The public /vendors page works, but it sells Phase 2 and 3 features. The "Hi VENDOR" WhatsApp flow runs only in mock mode until Meta WhatsApp is set up.

**What exists**
- Public "Join free" page at /vendors, no login needed — works — `apps/web/src/app/(public)/vendors/page.tsx:20-47`, `apps/web/src/proxy.ts:7`
- Page copy and search description. Daily counts, rider app and "free" are fine for Phase 1. WhatsApp pause/skip, Razorpay payouts and "new customers from us" are not (see below) — works — `apps/web/src/app/(public)/vendors/page.tsx:8,11-18,30,42`
- Campaign tracking: `?src=` and `?c=` on a link are saved with the application, and a `vendor_applied` analytics event fires on submit — works — `apps/web/src/app/(public)/vendors/page.tsx:45`, `apps/web/src/lib/public.ts:83-87`, `apps/web/src/app/(public)/vendors/vendor-form.tsx:45`
- WhatsApp sign-up: someone who is not a customer messages the platform number with "vendor", "kitchen owner", "mess owner" or similar. A 3-question bot (kitchen name, area, size) then files an application — mock only (needs Meta WhatsApp) — `supabase/functions/whatsapp-webhook/handler.ts:89-105`, `supabase/functions/_shared/lead-bot.ts:127-134,301-330`, `acquisition.sql:1115-1124`
- A campaign code in the first WhatsApp message ("Hi VENDOR ig-oct") is mapped to Instagram, Google Ads, Justdial or referral — mock only — `supabase/functions/_shared/lead-bot.ts:130-133`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Important | /vendors promises things Phase 1 will not deliver: customers pausing, skipping and checking their balance on WhatsApp, UPI and card payments through Razorpay, and "new customers from us". A vendor recruited from this page is misled. Rewrite it for Phase 1 or hide it. | `apps/web/src/app/(public)/vendors/page.tsx:8,11-18,30,42` | Not verified (medium/low) |
| Important | Switch-off: the public pages cannot be turned off. /vendors, /find, /kitchens and /k/[slug] are always public. The only platform flag that exists is for kitchen switching. | `apps/web/src/proxy.ts:7`, `p6.sql:204-215` | Not verified (medium/low) |
| Important | Switch-off: the platform WhatsApp bot treats any number that is not a customer as a stranger. If WhatsApp is switched on (for example for owner alerts), an owner who replies to the platform number gets the customer lead bot. A vendor's own customer whose number is not on file is offered competing kitchens. Keep the webhook undeployed in Phase 1, or put the vendor and lead branches behind a flag. | `whatsapp.sql:276-280`, `supabase/functions/whatsapp-webhook/handler.ts:89-115` | Not verified (medium/low) |

#### 2. Applying
A vendor can apply on /vendors (or on WhatsApp, mock only). The founder sees each application in /admin/vendors, with a phone reveal that is logged. But the application does not act as a gate: anyone who can log in can create a kitchen straight away. This works for Phase 1 if two things hold. First, the founder onboards each pilot vendor by hand: a call, then the vendor logs in with their number and creates the kitchen, which starts in draft. Second, signup is limited to invited numbers. The form needs anti-abuse and consent fixes before it is promoted.

**What exists**
- Application form: name, mobile, kitchen name, area, number of customers, optional FSSAI and a consent box. It is checked in the browser and again in the database — works — `apps/web/src/app/(public)/vendors/vendor-form.tsx:18-47`, `acquisition.sql:960-986`
- Stored safely. The phone is encrypted, with a hash and the last 4 digits kept separately. Each phone can have one open application, and a repeat submission updates it. Only platform admins can read the table, and every change goes into the audit log — works — `acquisition.sql:165-191`, `acquisition.sql:987-996`, `acquisition.sql:205-206`, `acquisition.sql:1528-1529`
- Linked to the vendor's kitchen by phone number. If the number already owns a kitchen, the link is made at once. Otherwise it happens when that number creates a kitchen, and the status becomes "onboarding" — works — `acquisition.sql:1004-1008`, `acquisition.sql:625-650`
- The thank-you screen offers "Start now: log in with this number", so a vendor can set up without waiting for a call — works locally; on hosted it needs a real SMS login (step 4) — `apps/web/src/app/(public)/vendors/vendor-form.tsx:49-60`, `tenancy.sql:224-275`
- Admin queue /admin/vendors:
  - filter by status
  - masked phone with a Reveal button, which writes an audit row and gives call and WhatsApp links
  - dated notes, "Mark contacted" and "Reject"
  - setup progress and the number of waiting leads nearby

  works — `apps/web/src/app/admin/vendors/page.tsx:21-92`, `apps/web/src/app/admin/vendors/application-actions.tsx:16-43`, `apps/web/src/app/admin/reveal-phone.tsx:9-35`, `acquisition.sql:1401-1460`
- A WhatsApp welcome is queued for every application. The hourly `tiffin-growth` job then sends up to 3 nudges, on days 1, 3 and 7 — mock only — `acquisition.sql:1009-1013`, `acquisition.sql:728-748,754`, `supabase/functions/_shared/templates.ts:270-287`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | Phone confirmation is switched off in the checked-in auth config. The follow-up found that with this setting, a sign-up with a phone number and a password counts as a confirmed phone without any code. That account then picks up every staff or rider invite sent to that number (more in step 4). This is a hosted setting, not code: check that "Confirm phone" is on before the first vendor signs up. | `supabase/config.toml:261-263`, `tenancy.sql:341-345` | Follow-up, spot-checked |
| Important | Signup is open: any phone that receives an OTP can create a kitchen, so the application and the founder's review do not keep anyone out. With a paid SMS sender this also invites SMS-pumping costs. For Phase 1, allow only invited and approved numbers. | `supabase/config.toml:177,261`, `tenancy.sql:244-246`, `tenancy.sql:468-470`, `apps/web/src/app/(public)/vendors/vendor-form.tsx:56-58` | Follow-up, spot-checked |
| Important | There is no CAPTCHA, IP limit or daily cap. Anyone can call `submit_vendor_application` directly from a script. Each call files an application for whatever number was typed (it is never verified) and queues a WhatsApp welcome to it, followed by up to 3 nudges. Once WhatsApp is live, this costs template fees and invites spam reports against the single platform number. | `acquisition.sql:1552-1553`, `acquisition.sql:1009-1013`, `acquisition.sql:728-748`, `supabase/config.toml:215-218` | Not verified (medium/low) |
| Important | "Send me setup help on WhatsApp" is ticked by default, and that box is what allows the welcome and the nudges to be sent. Pre-ticked consent is weak under DPDP. The customer form on /find has the same default. | `apps/web/src/app/(public)/vendors/vendor-form.tsx:13,91-94`, `acquisition.sql:797`, `supabase/functions/whatsapp-outbox/index.ts:40-44`, `apps/web/src/app/(public)/find/find-client.tsx:83` | Not verified (medium/low) |
| Important | Switch-off: the hourly `tiffin-growth` job has no off switch. It nudges an applicant until their kitchen is publicly listed, and listing is the only way an application reaches "live". Each nudge points at the first unfinished item on the marketplace checklist, usually the public profile and photos rather than plans, customers or riders. Phase 1 kitchens stay in draft, so every applicant stays in "onboarding" and gets all 3 nudges. | `acquisition.sql:641-643`, `acquisition.sql:653-675`, `acquisition.sql:728-748,754` | Not verified (medium/low) |

#### 3. Verification incl. FSSAI
A Phase 1 vendor needs no verification to use the software. A kitchen in **draft** runs the whole daily engine without an FSSAI number and cannot be seen by the public. The problem is the status model. The only state above draft is "active", which the admin screen calls "Listed". Making a kitchen active publishes it and, by default, opens it to marketplace customers.

For Phase 1:
- Check the FSSAI certificate by hand and record the number with the admin FSSAI form.
- Keep every kitchen in draft and never press List.
- Leave payout KYC alone. It is needed only for Phase 2 online payments.

The FSSAI rule itself, D-005, still needs your decision (`docs/DECISIONS.md:76-79`).

**What exists**
- FSSAI number on the kitchen: optional, 14 digits. It can be entered when the kitchen is created, in Settings, or on the application form — works — `tenancy.sql:25`, `apps/web/src/app/onboarding/onboarding-form.tsx:18-25`, `apps/web/src/app/(app)/settings/settings-form.tsx:73`, `acquisition.sql:176`
- Listing needs FSSAI. A database rule blocks "active" without a number, and the List button is greyed out until one is entered — works — `tenancy.sql:39`, `apps/web/src/app/admin/status-buttons.tsx:21`
- Admin FSSAI form on /admin/kitchens: set, correct or clear the number. Only the format is checked — works — `admin_hardening.sql:26-42`, `apps/web/src/app/admin/kitchens/page.tsx:85-91`
- FSSAI lock: once a kitchen is listed, its owner can no longer change the number. This is covered by tests, which passed in the test run (09_security 18/18) — works — `admin_hardening.sql:9-24`, `supabase/tests/09_security.test.sql:79-89`
- Kitchen status is draft (the default), active or suspended, and only a platform admin can change it. The admin screen shows these as Private, Listed and Suspended, with List, Make private and Suspend buttons — works — `tenancy.sql:36`, `tenancy.sql:424-439`, `apps/web/src/app/admin/kitchens/page.tsx:14-18`, `apps/web/src/app/admin/status-buttons.tsx:20-24`
- Draft is fully usable and private. Meal generation, the cutoff lock and owner summaries skip only suspended kitchens. The public directory, kitchen pages and lead matching show only active ones — works — `p5.sql:393`, `money.sql:394`, `p5.sql:1351`, `acquisition.sql:325,920,943`
- Admin kitchen list with useful Phase 1 signals: customers, live subscriptions, meals in the last 7 days and the last count lock. Status, FSSAI and payout changes are written to the audit log — works — `admin_hardening.sql:111-119`, `apps/web/src/app/admin/kitchens/page.tsx:72-75`, `tenancy.sql:168-169`, `tenancy.sql:176-177`
- Payout KYC (Phase 2): the admin types the Razorpay linked-account id and picks a KYC status. Online payment links are refused until the status is "verified". Recording cash, UPI and bank transfers never needs it — mock only — `money.sql:1243-1263`, `apps/web/src/app/admin/payout-form.tsx:10-29`, `p6.sql:83-86`, `money.sql:737-781`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Important | There is no "verified" state separate from "listed". The only promote button is List. Pressing it puts the kitchen on /kitchens and /k/[slug] at once, and makes it a target for lead matching and for admin lead assignment. Several things push the team to press it: the admin dashboard goal of "30 vendors live", the vendor's "Get your kitchen ready" checklist, and the FSSAI hint "Verified: your kitchen is listed". The checklist's last item is "Listed on the platform", so a Phase 1 vendor can never finish it. | `apps/web/src/app/admin/status-buttons.tsx:20-21`, `acquisition.sql:325,525,672,920,943`, `apps/web/src/lib/checklist.ts:14`, `apps/mobile/src/i18n/en.ts:170`, `apps/web/src/app/(app)/settings/settings-form.tsx:73`, `apps/web/src/app/(app)/settings/page.tsx:19`, `admin_hardening.sql:62`, `apps/web/src/app/admin/page.tsx:59-71` | Verified, corrected (high to medium). Nothing breaks while kitchens stay in draft; the risk is someone pressing List. Kitchen switching is already behind a flag that is off. |
| Important | Listing also opts the kitchen in to marketplace customers, because `accepts_platform_leads` defaults to true. Anyone on /find or using the WhatsApp lead bot can then become a permanent "platform" customer of that kitchen. They get a trial subscription that holds a seat, and the owner is messaged. If that person is one of the vendor's own customers who has not been entered yet, the vendor later gets "already exists". The vendor's opt-out box has gaps: `convert_lead` does not re-check it, `admin_assign_lead` ignores it, and the public directory still lists the kitchen. | `acquisition.sql:20,325`, `acquisition.sql:524-526`, `acquisition.sql:542-560`, `acquisition.sql:568-574`, `acquisition.sql:1302-1319`, `acquisition.sql:943`, `acquisition.sql:283-285`, `customers_plans.sql:390-392`, `apps/web/src/app/(app)/settings/listing-form.tsx:127-129` | Verified, corrected (high to medium). This happens only after an admin lists the kitchen. |
| Important | Suspend takes one click: no confirmation, no reason and no message to the owner. It silently stops meal generation, the count lock and owner summaries for that kitchen. One misclick on a working Phase 1 kitchen stops its counts and charges. | `apps/web/src/app/admin/status-buttons.tsx:24`, `p5.sql:393`, `money.sql:394`, `p5.sql:1351` | Not verified (medium/low) |
| Important | Switch-off: marking a payout account "verified" is just a dropdown, and only the `acc_` format is checked. Suppose an account is marked verified while the payment functions run in mock mode on a hosted project. A customer can then credit meals without paying, through the public `razorpay-mock` page, which `OPERATIONS.md` says to deploy. Phase 1 rule: leave every payout account at "not started". | `money.sql:1253-1258`, `apps/web/src/app/admin/payout-form.tsx:23-25`, `supabase/functions/_shared/razorpay.ts:20`, `supabase/functions/razorpay-mock/index.ts:24-46`, `supabase/config.toml:441-442`, `docs/OPERATIONS.md:19` | Verified, corrected (stays high). The hole needs three things at once: a webhook secret set, `razorpay-mock` deployed, and a payout account marked verified. |
| Important | The admin kitchen list shows no owner name, phone or team (staff, riders, pending invites). From the screen used to verify vendors, the founder cannot call a vendor or check who is calling. Phone reveal exists only for applications and leads. | `admin_hardening.sql:106-125`, `apps/web/src/app/admin/types.ts:17-22`, `apps/web/src/app/admin/reveal-phone.tsx:15-17` | Not verified (medium/low) |
| Nice-to-have | A platform admin can only be created with hand-written SQL; there is no admin RPC or screen for it. The only script that creates one, `seed.sql`, also creates development encryption keys and a demo service-role key. It must never be run on a hosted project; that risk is listed as a Blocker in step 4. | `tenancy.sql:444-445`, `tenancy.sql:456-457`, `supabase/seed.sql:39`, `supabase/seed.sql:11-12,351-352` | Follow-up, not verified (the seed.sql keys part is spot-checked) |
| Nice-to-have | FSSAI "verification" leaves no record. Nothing stores who verified it, when, a certificate photo or an expiry date, and the only check is the 14-digit format. While a kitchen is in draft, its owner can change the number at any time, including between the founder's check and pressing List. | `admin_hardening.sql:15-17`, `admin_hardening.sql:33-35`, `tenancy.sql:194-196`, `tenancy.sql:448-450` | Not verified (medium/low) |
| Nice-to-have | Suspending does not lock the vendor out. The owner and staff can still sign in and make changes, because role checks look only at membership. The founder has no clean way to freeze a kitchen during a dispute or after a vendor leaves. | `tenancy.sql:139-154` | Follow-up, not verified |


#### 4. Onboarding
Creating a kitchen, setting cutoffs and plans, and inviting staff and riders all work on the local test stack. On a hosted project nobody can log in yet, a new kitchen starts with prepaid-only defaults, only the owner can act, and on day one every customer lands on one route with no rider.

**What exists**
- Phone OTP login on web and mobile; staff and riders invited by phone join their kitchen at their first login — works on the local stack only (seed test numbers) — `apps/web/src/app/login/login-form.tsx:25,37,43`, `apps/mobile/src/app/login.tsx:33,43`, `apps/mobile/src/lib/session.tsx:36`
- Create kitchen: web form (name, owner name, area, address, optional FSSAI) or mobile (name, area); one step creates the kitchen, the owner membership, the settings row and the payout row — works — `tenancy.sql:224-275`, `apps/web/src/app/onboarding/onboarding-form.tsx:20-26`, `apps/mobile/src/app/onboarding.tsx:18`
- A new kitchen is 'draft' and runs the full daily engine privately; FSSAI is needed only to be listed — works — `tenancy.sql:36,39`, `p5.sql:393`
- Kitchen settings and their defaults: lunch cutoff 21:00 the day before, dinner cutoff 12:00 the same day, 50 meals per slot, no weekly off; low-balance alert at 3 meals, credit 0 meals, 7 grace days before cancelling, 1 day cancellation notice, phone requests close at 19:00 — partial: web only, owner only — `tenancy.sql:27-35,46-51`, `apps/web/src/app/(app)/settings/settings-form.tsx:48-50,98-99,127-130`, `apps/web/src/app/(app)/settings/page.tsx:9`
- Two later defaults are switched on and belong to Phase 2/3: a free meal on a customer's first complaint, and accepting marketplace leads — switch-off items (see the table below and step 3) — `p5.sql:47`, `acquisition.sql:20`
- Plans: name, lunch and/or dinner, days of the week (Mon–Sat by default), diet, one price per meal — works, web only — `customers_plans.sql:89-107`, `apps/web/src/app/(app)/plans/plans-editor.tsx:16,45-52`
- Team: invite a staff member or rider by phone, change a role, remove a member, cancel an invite — works, web only and owner only (the mobile app has no invite screen) — `tenancy.sql:279-322,381-421`, `apps/web/src/app/(app)/team/team-manager.tsx:29,50,54,70`, `apps/web/src/app/(app)/team/page.tsx:7`
- Delivery routes per slot with a default rider (the owner can be picked), set up on the web; if a slot has no route, "Route 1" is created at the first run build — partial — `delivery.sql:56-68,432-473`, `apps/web/src/app/(app)/delivery/routes/page.tsx:23-31`, `apps/web/src/app/(app)/delivery/routes/routes-manager.tsx:38`
- Onboarding checklist on the Today screen (web and mobile) — works, but it is a marketplace-readiness list — `acquisition.sql:653-675`, `apps/web/src/lib/checklist.ts:5-15`, `apps/mobile/src/app/(tabs)/index.tsx:37-41`
- Customer phone numbers are encrypted and hashed with two keys kept in Supabase Vault — works; the keys must be created in production — `foundation.sql:164-211`, `docs/SECURITY.md:39`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | Nobody can log in on a hosted project. Login is phone OTP only and no real SMS sender is set up, so owners, staff and riders get no code, and invites (claimed only after a login) cannot be accepted. A Supabase built-in SMS provider needs no code change, but Indian SMS needs TRAI DLT registration, which takes about 1–3 weeks. | `apps/web/src/app/login/login-form.tsx:25,37,43`, `apps/mobile/src/app/login.tsx:33,43`, `supabase/config.toml:273-287,307-313`, `docs/DECISIONS.md:70-74` | Verified, corrected: a setup and lead-time task, not a code bug; a closed pilot can bridge with hosted test numbers that have random codes |
| Blocker | Phone confirmations are off and signup is open in the project config. If the hosted project is set the same way, anyone can sign up with an invited rider's number and a password, get a "confirmed" phone without any code, and `claim_invites` then makes them staff or rider of every kitchen that invited that number. Turn "Confirm phone" on and allow only invited or approved numbers. | `supabase/config.toml:261,263`, `tenancy.sql:341-357` | Follow-up, spot-checked |
| Blocker | Only one owner can act. The owner role cannot be shared or handed over, and there is no manager or accountant role, so while the owner is away nobody can add customers or record changes or cash (the daily effects are under daily operation). This follows SPEC.md and D-022, so changing it is a founder decision. | `foundation.sql:27`, `tenancy.sql:296-298,395-397`, `customers_plans.sql:380`, `daily_engine.sql:885`, `money.sql:760`, `docs/SPEC.md:31` | Verified, corrected: by design; riders can already record cash at the door, which then waits for the owner to confirm it |
| Blocker | Production needs the Vault keys (`phone_encryption_key`, `phone_hash_key` and three others) created once and backed up offline. Without them, adding or importing any customer fails; losing the encryption key makes every stored number unreadable. `seed.sql` creates published dev keys and the demo service-role key, so running it on a hosted project would make those the production keys. | `foundation.sql:174-177`, `docs/SECURITY.md:39`, `CLAUDE.md:244-252`, `supabase/seed.sql:11-12,351-363` | Follow-up, spot-checked |
| Important | A new kitchen starts prepaid-only (credit 0 meals, auto-cancel after 7 days) and nothing at setup asks how it bills. Until billing is fixed, the stop-gap (credit about 120 meals, grace about 60 days) has to be typed into the web Settings page; the mobile app has no settings screen. The effect on customers is in step 5. | `tenancy.sql:47-48`, `apps/web/src/app/(app)/settings/settings-form.tsx:128-129`, `apps/mobile/src/app/_layout.tsx:29-40` | Verified, corrected |
| Important | On day one every customer of a slot lands on one route. Addresses without saved stops go to the first route, auto-named "Route 1", which gets a rider only if the kitchen has exactly one rider member. Splitting customers between riders means moving one stop at a time on a day's run on the web live board, for lunch and dinner separately (about 240 moves for 180 customers and 3 riders). The import has no route column. | `delivery.sql:453-470,1310-1330`, `p6.sql:1155,1171,1194-1195`, `apps/web/src/app/(app)/delivery/live-board.tsx:178`, `packages/core/src/import.ts:6-22` | Verified, corrected: about 240 moves, not 360; the moves are saved, and a riderless route is fixed with one default-rider edit |
| Important | An owner who delivers sees an empty Deliver tab. The auto-created route never defaults to the owner, and the rider screen lists only runs assigned to the person logged in. The fix is a one-time web step (make the owner the route's default rider); the mobile app cannot do it. | `delivery.sql:459-461`, `p6.sql:1312`, `apps/web/src/app/(app)/delivery/routes/page.tsx:23-31`, `apps/mobile/src/app/(tabs)/_layout.tsx:21-22` | Verified, corrected: a one-time web fix, not a daily one |
| Important | One price per meal covers both lunch and dinner. A kitchen with a ₹60 lunch and a ₹40 dinner needs two plans, and then that customer's payments, dues and refunds are all converted at one price (the newest plan's), so they come out wrong. | `customers_plans.sql:93,100`, `money.sql:132-143,510,767-768` | Verified, corrected: holds for different prices across slots or plans; the price-change part was overstated |
| Important | A plan price edit applies at once, with no start date, and the dues list then values all unpaid past meals at the new price. "₹80 from next month" means editing on the last evening before the lock. | `apps/web/src/app/(app)/plans/plans-editor.tsx:52`, `daily_engine.sql:490-496`, `money.sql:510` | Verified, corrected: not silent loss; on the web the owner can override the meal count, on mobile not |
| Important | Invited staff or riders can end up creating their own kitchen. Both apps ignore the result of `claim_invites`, and anyone with no membership is sent to "Set up your kitchen" (on a slow network a new rider can get there before the claim finishes), where they can create a stray draft kitchen. | `apps/web/src/app/login/login-form.tsx:43`, `apps/mobile/src/lib/session.tsx:36,58-61`, `apps/mobile/src/app/_layout.tsx:26-28`, `apps/web/src/lib/session.ts:53` | Not verified (medium/low) |
| Important | There is no way to change the owner's phone number, recover the account or transfer the kitchen; no phone-change call exists in the apps or Edge Functions. A lost SIM locks the owner out (the fix is hand-written SQL), and a recycled number lets a stranger log in as the owner. | `tenancy.sql:12,395-397,416-418`, `apps/web/src/app/actions.ts:16-19` | Follow-up, spot-checked |
| Important | Creating a kitchen fails when the name is typed in Odia script: the slug keeps only a–z and 0–9, the fallback "-kitchen" breaks the slug rule, and the raw database error is shown. | `foundation.sql:222-229`, `tenancy.sql:10-11,253-257`, `apps/mobile/src/lib/errors.ts:10` | Not verified (medium/low) |
| Nice-to-have | The owner can add any existing account as staff or rider with no acceptance step, even one whose phone was never confirmed; that person just finds another kitchen in their app. | `tenancy.sql:303-312,341-342` | Not verified (medium/low) |
| Nice-to-have | Switch-off: the Today checklist is ordered for the marketplace (profile text and photo, location, FSSAI, then plans, menu, Razorpay payout, customers, rider, "Listed on the platform"), and growth nudges point applicants to the first unticked item. Listing a kitchen also opens it to marketplace leads (step 3). Hide or reorder it for Phase 1. | `acquisition.sql:653-675,737-738`, `apps/web/src/lib/checklist.ts:5-15` | Not verified (medium/low) |
| Nice-to-have | Switch-off: `auto_credit_first_complaint` is on by default, so a customer's first food or delivery complaint posts 1 free meal at the kitchen's cost without the vendor choosing it. In Phase 1 nothing files complaints (only the WhatsApp bot and the customer page do), so it stays dormant. Turn the default off before either is switched on. | `p5.sql:47`, `p5.sql:977-1017`, `supabase/migrations/20261030000100_whatsapp.sql:446,771`, `apps/web/src/app/(app)/settings/care-form.tsx:83` | Not verified (medium/low) |

#### 5. First customers
An owner can add customers one at a time (web or phone), import an Excel/CSV register, or, with an AI key, read a photo of the notebook. But with the default settings every customer without a prepaid balance stops getting meals at the first lock and is cancelled a week later, which alone blocks Phase 1. Customers added on the phone also have no address.

**What exists**
- Add customer on the web: name, phone, diet, language, address with a map pin, consent tick — works, owner only — `apps/web/src/app/(app)/customers/customer-form.tsx:29-38`, `apps/web/src/app/(app)/customers/new/page.tsx:7`, `customers_plans.sql:362-396`
- Quick add on mobile: name, phone, optional plan, consent tick — partial: no address, diet or opening balance — `apps/mobile/src/app/customer/new.tsx:35-54`
- Consent is required for every customer and saved as "vendor attested"; the test run confirmed the server refuses a customer without the tick — works — `customers_plans.sql:339-354,381-383`
- Phone numbers stored encrypted; staff see only the last 4 digits — works — `customers_plans.sql:268-283`
- Excel/CSV import: guessed column mapping, preview check, plan, start date, tiffins per meal, opening balance (−200 to 1,000 meals), up to 2,000 rows; bad rows are skipped and can be downloaded as "rows to fix" — works, with the gaps below — `apps/web/src/app/(app)/customers/import/import-wizard.tsx:24-34,62-88,111-120`, `packages/core/src/import.ts:6-22`, `money.sql:984-1155`
- Notebook-photo import: AI reads a photo of the register, the vendor checks and edits the rows, then they go through the same import — mock only without an Anthropic key — `apps/web/src/app/(app)/customers/import/notebook-import.tsx:74-77,127,169`, `supabase/functions/notebook-import/index.ts:57-61`
- Add subscription on the web: plan, start date, tiffins per meal, "Active" or "Trial", delivery address (defaults to the customer's default address) — partial — `apps/web/src/app/(app)/customers/[id]/add-subscription.tsx:19-35,55-59`
- Meals are generated 7 days ahead as soon as a subscription is saved — works — `daily_engine.sql:779-780`, `p5.sql:356-450`
- Opening balance, free-meal credit and corrections on the web customer page (reason required, up to 200 meals per entry) — works, web only — `apps/web/src/app/(app)/customers/[id]/money-panel.tsx:124,261`, `money.sql:863-897`
- Addresses: add, edit, one default per customer — partial ("Make default", and a first address added after the subscription, do not reach existing subscriptions) — `apps/web/src/app/(app)/customers/[id]/address-manager.tsx:47,55-58`, `customers_plans.sql:164-180`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | Customers without a prepaid balance stop getting meals and are then cancelled. With the defaults (credit 0 meals, grace 7 days), a balance of 0 or less, including exactly 0, makes the subscription "suspended" at the kitchen's next lock of any slot or at the nightly run, sometimes before the first meal. Its future meals are deleted from counts, packing and routes, and after 7 days it is cancelled for good: nothing brings a cancelled subscription back, and a payment revives only a suspended one. Web, mobile and import all create subscriptions as active with no balance, and nothing warns the owner; the web page says suspended ones restart on recharge, which stops being true once they are cancelled. The seed gives every demo subscription 40 free meals, so the demo never shows this. Today's workarounds are kitchen-wide or false: raise the web-only credit limit (which also stops suspension for prepaid customers), record cash that was not paid, or enter a positive opening balance, which is stored as paid at plan price, so a later refund would pay it out. | `tenancy.sql:47-48`, `money.sql:231-235,283-284,400-402,419-426,887-891,1120-1130`, `p5.sql:392,431-443`, `customers_plans.sql:564`, `daily_engine.sql:643-645`, `apps/web/src/app/(app)/customers/[id]/add-subscription.tsx:32-35`, `apps/mobile/src/app/customer/new.tsx:47-50`, `apps/web/src/app/(app)/customers/[id]/page.tsx:252`, `supabase/seed.sql:246-252`, `supabase/tests/04_money.test.sql:204-223` | Verified, corrected: a hostile default plus missing guardrails rather than a hard code block; the kitchen-wide credit limit and grace days can be raised in web Settings |
| Blocker | Only the owner can add customers, addresses or subscriptions, import, or enter an opening balance; staff cannot even see plans or subscriptions. New customers wait until the owner is free (root cause and decision: step 4). | `customers_plans.sql:236-242,248-262,380`, `money.sql:877,1016`, `apps/web/src/app/(app)/customers/new/page.tsx:7`, `apps/mobile/src/app/(tabs)/customers.tsx:39-45` | Verified, corrected: by design (see step 4) |
| Important | Customers added in the mobile app have no address: quick add sends none, the subscription is saved without one, and the app cannot add or change addresses. An address added later on the web does not reach the subscription either, because meals use the subscription's own address, so the rider and the packing list get a blank stop at the end of the first route. | `apps/mobile/src/app/customer/new.tsx:40-50`, `apps/mobile/src/app/customer/[id].tsx:116`, `p5.sql:378`, `daily_engine.sql:285-293`, `p6.sql:1169-1171`, `apps/web/src/app/(app)/customers/[id]/address-manager.tsx:47,55-58` | Verified |
| Important | The mobile app cannot enter an opening balance, an adjustment, a UPI payment or any other amount: cash is only 10, 26 or 30 meals at the first listed plan's price, and a suspended subscription loses its action buttons with no explanation. A phone-only vendor cannot record what a customer already paid or owes; the only way out is logging a cash pack that was never paid. | `apps/mobile/src/app/customer/[id].tsx:81,104,125-127,155` | Verified, corrected: recording a cash pack does reactivate a suspended customer; the web already has an opening balance and a credit limit |
| Important | Phone number is mandatory and unique within a kitchen, so siblings, roommates or an elderly parent on one family number cannot be separate customers (founder decision). | `customers_plans.sql:37-43,390-393`, `money.sql:1049-1054` | Not verified (medium/low) |
| Important | The whole import file goes in one request and is saved in one database transaction, with meal generation and encryption for each row; a register of a few hundred customers may hit the database time limit and save nothing. Not measured. | `apps/web/src/app/(app)/customers/import/import-wizard.tsx:79-84`, `money.sql:1023-1025,1031`, `daily_engine.sql:779-780` | Not verified (medium/low) |
| Important | The import misses common register facts: there is no status column (paused or stopped customers come in active), only one plan per row (lunch and dinner on two plans cannot be imported), and a diet column is saved on the customer while cooking counts use the plan's diet, with no warning. The opening-balance column is optional, so most imported customers start at 0 (see the Blocker above). | `money.sql:979-981,1057,1097-1103,1114,1120-1124`, `p5.sql:376` | Not verified (medium/low) |
| Important | Switch-off: with no Anthropic key, the notebook-photo import returns 4 made-up rows (for example "Ramesh Panda") behind only an English "Demo mode" banner, and the vendor can save the ones with a valid name and phone as real customers. Refuse when no key is set. | `supabase/functions/notebook-import/index.ts:57-61`, `supabase/functions/_shared/notebook.ts:200-207`, `apps/web/src/app/(app)/customers/import/notebook-import.tsx:127,169` | Not verified (medium/low) |
| Important | Switch-off: "Starts as: Trial" on the web creates a subscription that generates no meals, has its actions hidden, and is cancelled after the grace days unless paid. A vendor who picks Trial for a tasting gets nothing in the count. Remove the option for Phase 1 (D-033 is pending). | `apps/web/src/app/(app)/customers/[id]/add-subscription.tsx:55-59`, `p5.sql:392`, `money.sql:428-433`, `apps/web/src/app/(app)/customers/[id]/page.tsx:235`, `docs/DECISIONS.md:227` | Not verified (medium/low) |
| Important | Mobile quick add hides a failed plan save: it sets the error and leaves the screen at once, so the customer is saved with no plan and no meals, and the vendor never sees why. | `apps/mobile/src/app/customer/new.tsx:47-54` | Not verified (medium/low) |
| Nice-to-have | The import sets the default start date from the UTC date (before 05:30 IST that is yesterday) and leaves balance states to the next lock; the template's example row is one column short (no opening balance). | `money.sql:1123`, `apps/web/src/app/(app)/customers/import/import-wizard.tsx:142`, `packages/core/src/import.ts:194-197` | Not verified (medium/low) |


#### 6. Daily operation
The core daily engine is real and tested: meals are generated a week ahead, the cutoff lock freezes counts and charges safely, and runs, packing lists and rider stops come out of it without any customer action. What stops a normal week without the paper register is around the engine: only the owner can enter changes and money, the rider app can lose delivery and cash records, changes made after the lock never reach the rider, and nobody is told when the lock job fails.

##### 6a. Counts, lock and kitchen sheet

**What exists**
- Meals generated 7 days ahead, nightly at 00:30 and again after every change; already frozen slots are never touched — works — `p5.sql:356-450`, `daily_engine.sql:767-815`, `daily_engine.sql:1027-1029`
- Cutoff lock every minute, safe to repeat (advisory lock, an existing snapshot is returned, each meal charge is written once) — works — `daily_engine.sql:471-526`, `money.sql:377-407`
- Each meal's price is frozen at lock and charged at that price — works — `daily_engine.sql:490-496`, `daily_engine.sql:505-510`
- Live and locked counts for today and tomorrow, plus a "changes since last count" feed, on web and mobile, for owner and staff — works — `daily_engine.sql:892-958`, `apps/web/src/app/(app)/page.tsx:19-24`, `apps/mobile/src/app/(tabs)/index.tsx:26-36`
- Kitchen sheet: production by plan and area, menu, notes and a printable packing list in route order; late skips are marked "don't deliver" on mobile — works — `apps/web/src/app/(app)/sheet/page.tsx:24-30`, `p6.sql:935-978`, `apps/mobile/src/app/sheet.tsx:68`
- 7-day menu, owner and staff — works — `apps/web/src/app/(app)/menu/menu-editor.tsx:24-36`
- Weekly off, whole days only — works — `tenancy.sql:34-35`, `p5.sql:399`
- Printed weekly register — partial (cut off, see below) — `apps/web/src/app/print/register/page.tsx:17-30`
- Test run: pgTAP 03_daily_engine 72/72; a 5,000-subscription lock took 6.17 s on the first day and 0.81 s after (local Docker, not hosted).

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Important | No kitchen closure or holiday day. On Diwali or Rath Yatra the engine still generates, locks and charges every customer unless the owner pauses each one by hand. | `tenancy.sql:34-35`, `p5.sql:399` (only a weekly off; no closure table in any migration) | Verified |
| Important | No weekly off for one slot ("Sunday dinner off"). Weekly off is whole-day and a plan's days apply to both slots, so it needs two subscriptions per customer. | `tenancy.sql:34-35`, `customers_plans.sql:93-98` | Not verified (medium/low) |
| Important | The printed register silently stops at 1,000 meal rows, the API's row limit. Above about 70 two-meal customers, cells go blank and customers with no returned row drop off the sheet, with no warning. | `apps/web/src/app/print/register/page.tsx:19-20`, `apps/web/src/app/print/register/page.tsx:30`, `supabase/config.toml:18` | Verified |
| Important | Production veg, non-veg and Jain counts use the plan's diet, not the customer's. One plan for mixed eaters, or an imported diet column, gives wrong cooking counts. | `p5.sql:376`, `p6.sql:917-920` | Not verified (medium/low) |
| Nice-to-have | The packing list is in route order but does not say which route or rider, so bags for several riders cannot be split from the sheet. | `p6.sql:935-953` | Not verified (medium/low) |
| Nice-to-have | A change saved in the same moment as the lock can leave one meal delivered but never charged. Rare. | `p5.sql:368`, `p5.sql:400`, `daily_engine.sql:490-496` | Not verified (medium/low) |

##### 6b. Customer changes entered by the vendor

**What exists**
- Skip, pause, resume, address change (temporary or permanent) and cancel, each with a preview of the affected meals before confirming — works, owner only — `daily_engine.sql:862-889`, `daily_engine.sql:607-762`, `apps/web/src/app/(app)/customers/[id]/subscription-actions.tsx:63-85`
- Mobile one-tap chips (skip next, skip a day, pause 3 or 7 days or open-ended, resume): the preview runs by itself, then one Confirm — works, owner only — `apps/mobile/src/app/customer/[id].tsx:52-75`, `apps/mobile/src/app/customer/[id].tsx:155-198`
- A late address change still applies to locked meals that have not left the kitchen — works — `daily_engine.sql:731-740`
- Waiving a late charge, on web only and only while the slot is still open — partial — `apps/web/src/app/(app)/customers/[id]/subscription-actions.tsx:149-154`, `daily_engine.sql:706`
- Proven by running it: add, subscribe, record cash, skip, pause, resume, change address, cancel and refund all succeeded through the same calls the apps use, with no customer action (test run).

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | Only the owner can record a skip, pause, resume, address change, cancel or new customer. Staff answering the phone cannot, and a rider cannot pass on "no lunch tomorrow" said at the door: the 'rider' change channel exists but nothing writes it. There are only three roles and the owner role cannot be shared. This follows SPEC.md:31 and D-022, so changing it is your decision. | `daily_engine.sql:885`, `customers_plans.sql:380`, `daily_engine.sql:62`, `foundation.sql:27`, `tenancy.sql:295-298`, `apps/mobile/src/app/customer/[id].tsx:155` | Verified, corrected: by design; riders can already record cash at the door, which then waits for the owner to confirm it |
| Important | Phone-close rule: a skip or pause the vendor enters counts as late from 19:00 the evening before, even when the real cutoff is later. Every same-day dinner skip (dinner cutoff 12:00) is charged and still cooked, and the setting cannot be switched off. Mobile never offers the waiver. Address, resume and cancel are never charged. | `daily_engine.sql:686-690`, `daily_engine.sql:706`, `tenancy.sql:29-30`, `tenancy.sql:51`, `apps/mobile/src/app/customer/[id].tsx:56-58`, `apps/mobile/src/app/customer/[id].tsx:67-69` | Verified, corrected (only skips and pauses are charged; the 19:00 close cannot be switched off because the setting cannot be empty) |
| Important | Changes made after the lock never reach the runs or the rider. A late skip or address change updates only the meal; the rider's stop keeps the old address and meal count, and its diet count still includes the skipped meal. The owner must press "Plan / refresh runs" on web. Once the run has started, the change is saved but applies to nothing, with no error. | `daily_engine.sql:723-740`, `daily_engine.sql:756`, `p5.sql:420`, `delivery.sql:639-640`, `p6.sql:1199-1202`, `p6.sql:1290-1293`, `delivery.sql:719-720`, `daily_engine.sql:696` | Verified, corrected (cancel was dropped from the claim: meals already frozen at a cancel are meant to be delivered) |
| Important | The common late call to skip tomorrow's lunch, which is already locked, cannot be entered on mobile at all and is always charged on web. The only remedy is a separate manual free-meal credit that is not tied to the meal. The stop stays on the rider's run. | `apps/mobile/src/app/customer/[id].tsx:157-158`, `daily_engine.sql:706`, `money.sql:863-897` | Verified, corrected (the web part was overstated: the owner can post a manual credit) |
| Important | Resume cannot undo a pause set for a later date. With the default date it says "Resume saved" and changes nothing, and the preview says no meals are affected. There is no list of upcoming skips and pauses and no way to undo one specific change. Mobile shows Resume only once the pause is inside the 7-day window. | `daily_engine.sql:266-274`, `apps/web/src/app/(app)/customers/[id]/subscription-actions.tsx:56-59`, `apps/web/src/app/(app)/customers/[id]/subscription-actions.tsx:136-138`, `apps/mobile/src/app/customer/[id].tsx:159`, `apps/mobile/src/app/customer/[id].tsx:177` | Verified, corrected (the ignored resume end date cannot be reached from either app today) |
| Important | A permanent address change with a later start date also moves the earlier meals to the new address, and the preview does not show it. The rider goes to the new flat before the move. | `daily_engine.sql:737-739`, `p5.sql:378` | Found by test run |
| Important | "Make default" on an address does not change where meals go. Subscriptions created before the customer had an address (mobile quick add) never get one, and those meals go to the end of the first route. | `apps/web/src/app/(app)/customers/[id]/address-manager.tsx:55-58`, `p5.sql:378`, `apps/mobile/src/app/customer/new.tsx:48-50`, `p6.sql:1169-1172` | Verified |
| Important | Neither app can change a customer's plan or number of tiffins, or add a one-off extra tiffin. The only route in the apps is cancel and re-add, and cancelling the last subscription automatically refunds and empties the balance (see 6c). The database already lets the owner change the plan and tiffin count, and it regenerates meals when they change, so the missing part is the screen. | `apps/web/src/app/(app)/customers/[id]/add-subscription.tsx:32`, `daily_engine.sql:61`, `money.sql:361-366`, `customers_plans.sql:564`, `daily_engine.sql:779-780` | Not verified (medium/low) |
| Important | A cancelled subscription can never be reactivated, and a payment does not restore it. The owner must add a new one, which inherits the old balance; after a grace cancel that balance is negative, so the new subscription is suspended at once. | `daily_engine.sql:643-645`, `money.sql:226`, `money.sql:283-284`, `customers_plans.sql:564` | Verified, corrected |
| Nice-to-have | The change feed shows "Late, charged" on resume, address and cancel changes entered after 19:00, although nothing was charged. | `daily_engine.sql:703`, `daily_engine.sql:719`, `apps/web/src/components/change-feed.tsx:37` | Not verified (medium/low) |

##### 6c. Money

**What exists**
- Record cash, UPI to the vendor or a bank transfer, with an optional receipt photo and a meals override, on web — works, owner only — `money.sql:737-781`, `apps/web/src/app/(app)/customers/[id]/money-panel.tsx:80-102`
- Opening balance, free-meal credit and corrections, reason required, up to 200 meals — works, owner only — `money.sql:863-897`
- Cash collected by a rider at the door: saved as pending, then confirmed or marked "Not received" by the owner on web — works — `p5.sql:1793-1801`, `money.sql:815-860`, `apps/web/src/app/(app)/money/page.tsx:67-78`
- Refund of unused meals, valued oldest purchase first, marked paid in cash or UPI — works — `money.sql:899-945`
- Automatic refund when the last live subscription is cancelled — works, but unwanted in Phase 1 (see below) — `money.sql:339-372`
- Dues (khata) list, collections report and a printable receipt — works, owner only — `money.sql:494-517`, `money.sql:1179-1240`, `apps/web/src/app/(app)/money/page.tsx:18`
- Balance states: low balance, suspended, auto-cancel after the grace days — works as designed for prepaid — `money.sql:210-245`, `money.sql:418-426`
- Test run: pgTAP 04_money 99/99.

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | Money is prepaid-only. A customer with zero balance is suspended at the next lock, drops out of counts, packing and routes, and is cancelled for good 7 days later. That is every cash or month-end customer. | `tenancy.sql:46-48`, `money.sql:232`, `money.sql:400-402`, `money.sql:421-426`, `p5.sql:392` | Verified, corrected: a hostile default plus missing guardrails rather than a hard code block; the kitchen-wide credit limit and grace days can be raised in web Settings (see step 5) |
| Blocker | Only the owner can record a payment, see dues or confirm rider cash. While the owner is away, rider cash stays pending, balances do not move, and customers who paid can still be suspended. The mobile app has no confirm step at all. Same decision as the owner-only row in 6b. | `money.sql:760`, `money.sql:828`, `money.sql:1187`, `p5.sql:1798`, `apps/web/src/app/(app)/money/money-actions.tsx:32-33` | Verified, corrected: by design (SPEC.md:31, D-022); riders can record cash at the door, but it waits for the owner to confirm |
| Important | Dues and payment-to-meal conversion use one price per customer, the newest live plan's price, instead of the price frozen on each meal. Different lunch and dinner prices give the wrong number of meals for a payment and wrong dues and refunds. A plan price edit applies at once, with no effective date, and revalues unpaid meals. Web lets the owner type the meal count; mobile does not. | `money.sql:132-143`, `money.sql:510`, `money.sql:767-768`, `p5.sql:1795-1799`, `daily_engine.sql:493`, `apps/web/src/app/(app)/plans/plans-editor.tsx:52` | Verified, corrected (prepaid meal counts survive a price change; the errors are in the rupee values and in mixed-price customers) |
| Important | Rupees are rounded into whole meals. A payment's remainder is dropped (₹2,000 at ₹70 gives 28 meals and the ₹40 never enters the balance), and any rider cash counts as at least one meal (₹50 on a ₹70 plan is 1 meal). The web confirm button cannot correct the meals. | `money.sql:768`, `p5.sql:1799`, `apps/web/src/app/(app)/money/money-actions.tsx:32` | Not verified (medium/low) |
| Important | A recorded payment cannot be voided, corrected or backdated; it is always dated now. A double tap on a slow network records it twice. The only fix, a negative adjustment, leaves the wrong amount in the collections report. | `money.sql:773-777`, `money.sql:854`, `money.sql:891` | Not verified (medium/low) |
| Important | No cash handover per rider: the pending list shows no rider name or totals and is confirmed one entry at a time, so the evening handover cannot be matched to each rider. | `apps/web/src/app/(app)/money/page.tsx:27-28`, `apps/web/src/app/(app)/money/page.tsx:70-73` | Not verified (medium/low) |
| Important | Cancelling the last subscription (including a plan change done as cancel and re-add, an end date passing, or a grace cancel) turns all unused meals into a pending refund and empties the balance. A refund cannot be undone: there is no cancelled refund status. | `money.sql:361-366`, `money.sql:371-372`, `money.sql:21` | Not verified (medium/low) |
| Important | No monthly statement for each customer. The customer page shows the last 8 balance rows and the printed register covers one week. Month-end billing needs this together with a pay-later mode. | `p6.sql:729-774` (offices only), `apps/web/src/app/print/register/page.tsx:12-14` | Verified, corrected (lowered for prepaid kitchens; for month-end vendors the real blocker is the prepaid-only row above) |
| Important | Suspended customers disappear with no alert to the owner. Mobile never shows a subscription's status and hides its action chips, and the dues list misses anyone at exactly zero. | `apps/mobile/src/app/customer/[id].tsx:155`, `money.sql:210-245`, `money.sql:516` | Verified, corrected |
| Important | No CSV or Excel export of payments, dues, refunds or rider cash. The Money page lists only the 25 newest payments, whatever date range is picked. | `apps/web/src/app/(app)/money/page.tsx:32-33`, `money.sql:1197-1240` | Verified, corrected |

##### 6d. Delivery and riders

**What exists**
- Saved routes per slot with a default rider; runs and stops built automatically at lock; a manual "Plan / refresh runs" button — works — `delivery.sql:56-84`, `delivery.sql:1191-1246`, `delivery.sql:622-640`, `p6.sql:1109-1267`, `delivery.sql:1179-1189`
- Built-in route optimiser that never makes a route longer; no maps or VROOM account needed — works — `route_optimizer_never_worse.sql:102-153`, `delivery.sql:1436`
- Live board: assign a rider for the day, reorder, move a stop, see proofs and last location; cash shown to the owner only — works, web only — `p6.sql:1318-1379`, `apps/web/src/app/(app)/delivery/live-board.tsx:175-178`
- Rider mode on web (installable, offline shell) and on mobile, with a cached day list and an offline queue — partial (see the queue rows) — `apps/mobile/src/lib/rider-store.ts:112-118`, `apps/mobile/src/lib/rider-store.ts:220-249`, `apps/web/src/lib/rider-store.ts:258-283`, `apps/web/public/sw.js:13`
- Proof by photo with GPS distance, by OTP, or "Deliver without proof"; a retried action is never applied twice — works — `p5.sql:1742-1787`, `apps/mobile/src/app/stop/[id].tsx:225-227`
- Failure reasons; a kitchen-fault reason credits the meal back at the price charged — works (no review, see below) — `delivery.sql:13-27`, `p6.sql:1432-1472`
- Tiffin box ledger, logged phone reveal for calls, monthly rider stats — works — `delivery.sql:154-170`, `delivery.sql:1151-1174`, `delivery.sql:1591`
- Sign-out on the account screen is blocked while actions wait to sync — works — `apps/mobile/src/app/(tabs)/account.tsx:33`
- Test run: pgTAP 06_delivery 111/111; the offline rider sync integration test with photo upload passed on Node 22+.

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | The rider queue throws away any action the server refuses, together with its photo and cash amount. It treats every error that carries a code as final, which includes temporary ones such as an expired login, a 503 or a database timeout. The loop then carries on, so one outage can wipe a whole offline backlog. A queued OTP delivery with a wrong code is also counted as done. Nothing is kept or reported to the owner. | `apps/mobile/src/lib/rider-store.ts:104-109`, `apps/mobile/src/lib/rider-store.ts:234-241`, `apps/web/src/lib/rider-store.ts:265-275`, `p5.sql:1773-1779`, `apps/web/src/lib/rider-store.ts:327-333` | Verified, corrected (not fully silent: a dismissible banner shows the last error and the stop returns to pending after the next refresh, but the record and the cash are lost) |
| Important | When a stop was already marked by someone else, a queued delivery gets a "conflict" answer before the cash is saved, and the app treats that as success, so the door cash is lost. | `p5.sql:1755-1756`, `p5.sql:1793-1801`, `apps/mobile/src/lib/rider-store.ts:240` | Follow-up, not verified |
| Important | No request timeouts, and every rider action waits for the whole queue. One stalled photo upload on a weak signal leaves each stop screen spinning and stops the next run from loading. The actions are still saved on the phone. | `apps/mobile/src/lib/supabase.ts:8-11`, `apps/mobile/src/lib/rider-store.ts:221-242`, `apps/mobile/src/lib/rider-store.ts:252-254`, `apps/mobile/src/lib/rider-store.ts:293` | Verified, corrected (later actions are saved locally; only the screens hang) |
| Important | If the app restarts with no signal more than about an hour after the last token refresh, the rider lands on the login screen and cannot reach the cached stops. After reconnecting they can land on "Set up your kitchen", whose Sign out button wipes the unsynced queue. | `apps/mobile/src/lib/session.tsx:58-67`, `apps/mobile/src/app/_layout.tsx:20-30`, `apps/mobile/src/app/onboarding.tsx:38`, `apps/mobile/src/lib/session.tsx:88-92`, `apps/mobile/src/lib/rider-store.ts:315-319`, `supabase/config.toml:166` | Verified, corrected (the cause is not a late start of token auto-refresh) |
| Important | Riders are told "The customer got a 4-digit code on WhatsApp", and "Confirm with code" is the main button, although no code was sent: pending messages and mock "sent" ones count as sent. Photo and "Deliver without proof" still work. | `p6.sql:1299-1300`, `apps/web/src/app/(field)/rider/rider-app.tsx:256`, `apps/web/src/app/(field)/rider/rider-app.tsx:453-460`, `apps/mobile/src/app/stop/[id].tsx:221-227` | Verified, corrected (the cause is counting pending rows as sent, not a missing opt-in check) |
| Important | An owner who delivers sees "No deliveries assigned to you today", because a route gets a default rider only when the kitchen has exactly one rider member. It can be fixed once on web by making the owner the route's rider; mobile cannot. | `delivery.sql:458-470`, `p6.sql:1312` | Verified, corrected |
| Important | All imported customers land on one 'Route 1' per slot. Splitting them across riders means moving one stop at a time on the web live board, about 240 moves for 180 customers on lunch and dinner. There is no bulk assign and no area-to-route rule. | `delivery.sql:432-477`, `delivery.sql:1310-1366`, `delivery.sql:1417-1420` | Verified, corrected (a one-time cost; riders seeing nothing is a one-step fix) |
| Important | Office stops (a P6 extra) can make run building fail for the whole slot, because two stops with the same customer and address hit the same row twice. The error is swallowed at lock, so riders get no runs. Only matters if the kitchen uses offices. | `p6.sql:1136-1144`, `p6.sql:1210-1216`, `p6.sql:1227-1232`, `delivery.sql:144`, `delivery.sql:630-634` | Verified |
| Important | A stop outcome can never be corrected or re-attempted. A mis-tap (failed instead of delivered), a second attempt after "not home", or a wrong kitchen-fault credit stays as it is. | `p5.sql:1755-1756`, `p6.sql:1416-1418` | Not verified (medium/low) |
| Important | Riders can give free meals without review by picking a kitchen-fault reason ("kitchen late", "food issue", "missing meal", "rider issue"); the credit is posted at once. | `delivery.sql:20-27`, `p6.sql:1434-1451`, `apps/mobile/src/app/stop/[id].tsx:236-238` | Not verified (medium/low) |
| Important | Mobile uploads proof photos at full pixel size; only the JPEG quality is lowered, while the web app shrinks them to 1280 px. A photo over the 3 MB limit is refused and, through the queue bug above, the delivery and its cash are dropped. | `apps/mobile/src/app/stop/[id].tsx:119`, `apps/web/src/app/(field)/rider/rider-app.tsx:379`, `delivery.sql:1677-1678` | Follow-up, not verified |
| Important | The queue syncs only while the Rider tab is open, and the server refuses actions on runs older than yesterday, so actions left on the phone can go stale and are then dropped. | `apps/mobile/src/app/(tabs)/rider.tsx:29-36`, `delivery.sql:974-977` | Not verified (medium/low) |
| Important | A rider cannot call a customer before the run starts or without mobile data, because the number is fetched from the server on every tap. Offline customers are reached by phone. | `apps/mobile/src/app/stop/[id].tsx:97-101`, `apps/mobile/src/app/stop/[id].tsx:175`, `delivery.sql:1165-1168` | Not verified (medium/low) |
| Nice-to-have | Offline the next morning, the cached runs from the day before are shown without a date. | `apps/mobile/src/lib/rider-store.ts:112-118`, `apps/mobile/src/app/(tabs)/rider.tsx:38-41` | Not verified (medium/low) |
| Nice-to-have | A removed rider stays the default rider on routes, so new runs are invisible until the owner reassigns them. | `tenancy.sql:402-420`, `p6.sql:1194-1195` | Not verified (medium/low) |

##### 6e. Stock

**What exists**
- Items, suppliers, supplier bills with a photo, supplier dues and payments — works — `inventory.sql:444-580`
- Recipes per portion, and ingredients deducted automatically at lock, once per lock — partial (see below) — `inventory.sql:274-340`
- Production plan: portions and ingredients needed against stock — works — `inventory.sql:757-787`
- Stock-take with variance reasons, waste, owner adjustments — works — `inventory.sql:607-662`, `inventory.sql:792-950`
- Low-stock, price-jump and variance alerts inside the app — works — `p5.sql:1915`
- Cost per meal and margin report, owner only — works — `inventory.sql:990-1047`
- Mobile stock tab: purchase with bill photo, waste and stock-take — works — `apps/mobile/src/app/stock/purchase.tsx:133`, `apps/mobile/src/app/stock/waste.tsx:76`
- Test run: pgTAP 08_inventory 74/74.

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Important | Automatic stock use needs a menu typed for every day, with dish names that match the recipe names exactly. A kitchen with a fixed thali that does not type the menu sees stock never go down, and cost per meal shows no ingredient cost. Nothing warns. | `inventory.sql:281-290`, `inventory.sql:304-313` | Not verified (medium/low) |
| Important | A wrong supplier bill or supplier payment cannot be voided or corrected (100 kg typed for 10 kg stays forever). Bill and waste saves from mobile carry no idempotency key, so a retry after a timeout can record them twice. | `inventory.sql:444-529`, `inventory.sql:1131-1134`, `apps/mobile/src/app/stock/purchase.tsx:133`, `apps/mobile/src/app/stock/waste.tsx:76` | Not verified (medium/low) |
| Nice-to-have | Unit costs are stored in whole paise per gram or millilitre, so spices bought by the gram round badly and trigger false price-jump alerts. | `inventory.sql:28`, `inventory.sql:71`, `inventory.sql:101`, `inventory.sql:503` | Not verified (medium/low) |
| Nice-to-have | Staff can read purchase prices straight from the tables, against the "staff see no money" rule (D-087). | `inventory.sql:1133-1134` | Not verified (medium/low) |

Stock failures during a lock are listed under 6f.

##### 6f. Alerts and engine health

**What exists**
- Production sheet queued for the owner at every lock; a 22:00 summary (tomorrow's counts, collections, low stock); stock and late-delivery alerts — mock only (WhatsApp, owner role only) — `daily_engine.sql:514-522`, `p5.sql:1323-1352`, `whatsapp.sql:114-124`
- A routing or stock error during a lock cannot block the lock itself — works — `delivery.sql:629-634`, `inventory.sql:329-334`
- The admin kitchens page shows each kitchen's last lock time — partial (see below) — `admin_hardening.sql:119`
- Runbook: read the cron job log by hand — manual only — `docs/OPERATIONS.md:35`
- The owner can still open the same data in the app whenever they look: Today counts, the kitchen sheet and stock alerts — works.

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | The minute lock job runs every kitchen in one transaction, with no error handling per kitchen. One error (a deadlock, a bad row, a full disk) rolls back every kitchen's lock and meal charges, every minute, leaving only a failed row in the cron log. | `money.sql:377-405`, `daily_engine.sql:1027` | Follow-up, spot-checked |
| Blocker | Nobody is told when the lock, nightly or summary job fails. An overdue slot looks like a normal open slot. A missed 21:00 lock is first noticed the next morning, when riders find no runs. | `docs/OPERATIONS.md:35`, `apps/web/src/components/slot-card.tsx:20-27`, `delivery.sql:639-640` | Follow-up, not verified |
| Important | The lock catch-up looks back only one day. After an outage of more than about a day, those meals are never locked, charged or routed. | `money.sql:392`, `p5.sql:385` | Follow-up, spot-checked |
| Important | Run-building and stock-use failures during a lock produce only a database warning: no record, no retry and no flag. The board just says "No runs for this meal yet". | `delivery.sql:632-633`, `inventory.sql:332-333`, `apps/web/src/app/(app)/delivery/live-board.tsx:160` | Follow-up, spot-checked |
| Important | Cancelling one subscription locks and charges the whole kitchen's slot for any older unlocked slot past its cutoff (for example after an outage). This also fires from the nightly auto-cancels. | `money.sql:349-359`, `money.sql:421-433` | Follow-up, spot-checked |
| Important | Owner alerts go only over WhatsApp and only to the owner. With no WhatsApp account, mock mode marks them "sent" with a fake ID, so the owner gets nothing and the system reports success. There are no push notifications and no in-app alerts list, and staff never get the production sheet. | `daily_engine.sql:516-520`, `whatsapp.sql:120-122`, `acquisition.sql:774`, `supabase/functions/_shared/whatsapp.ts:21`, `supabase/functions/_shared/whatsapp.ts:156`, `supabase/functions/whatsapp-outbox/index.ts:52-53`, `apps/mobile/package.json:5-39` | Verified, corrected (lowered: the data can still be opened in the app) |
| Important | The nightly job is one all-or-nothing step that also queues customer reminders. An error anywhere rolls back status updates and meal generation, and stays hidden for up to 6 days because meals already exist a week ahead. | `money.sql:409-438`, `p5.sql:385` | Follow-up, not verified |
| Important | Switch off: customer messages (payment receipts, refund notices, a delivery code for every stop) are queued for every customer, offline ones included, with no expiry. Mock mode records them as "sent"; without the worker they pile up and would go out in a burst when WhatsApp is switched on. | `money.sql:248-257`, `money.sql:288-291`, `delivery.sql:729-733`, `daily_engine.sql:183-198` | Verified, corrected |
| Nice-to-have | The admin "last lock" time is the newest lock of any slot, so a missed lunch lock is hidden when dinner locked. | `admin_hardening.sql:119` | Follow-up, not verified |

##### 6g. Vendor screens: mobile gaps, offline states, lists

**What exists**
- Mobile owner app: Today counts and change feed, packing list, customer search, one-tap change chips with an automatic preview, and cash chips — works — `apps/mobile/src/app/(tabs)/index.tsx:26-36`, `apps/mobile/src/app/sheet.tsx:21-23`, `apps/mobile/src/app/customer/[id].tsx:120-199`
- Customer search by name, area, landmark, last 4 digits or full phone — works — `customers_plans.sql:474-510`
- Web dashboard: 21 owner pages showed real seed data in the test run — works.

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Important | The mobile app has no cancel, no address capture or change, no UPI or any-amount payment (cash only, at 10, 26 or 30 meals, priced from whichever subscription the unordered query returns first), no opening balance, no waiver, no rider-cash confirm, no dues list, no subscription status and no settings screen. An owner away from a laptop cannot do these. | `apps/mobile/src/app/customer/[id].tsx:40`, `apps/mobile/src/app/customer/[id].tsx:81`, `apps/mobile/src/app/customer/[id].tsx:104`, `apps/mobile/src/app/customer/[id].tsx:116`, `apps/mobile/src/app/customer/[id].tsx:125-127`, `apps/mobile/src/app/customer/[id].tsx:164-180`, `apps/mobile/src/app/customer/new.tsx:40-50` | Verified |
| Important | Owner and staff screens show "empty" instead of "offline" or "could not load". With no signal the packing list says "No meals for this slot" and the customer list "No customers yet"; nothing is cached. | `apps/mobile/src/app/sheet.tsx:22`, `apps/mobile/src/app/sheet.tsx:51`, `apps/mobile/src/app/(tabs)/customers.tsx:23-25`, `apps/mobile/src/app/(tabs)/customers.tsx:52`, `apps/mobile/src/app/customer/[id].tsx:36-48`, `apps/mobile/src/app/(tabs)/index.tsx:35` | Verified |
| Important | The customer list stops at the first 200 names, on web and mobile, and shows that number as the total. It has no status, balance or dues columns and no filters (active, paused, suspended, owes). Customers past 200 can only be found by search. | `apps/web/src/app/(app)/customers/page.tsx:11`, `apps/web/src/app/(app)/customers/page.tsx:18`, `apps/mobile/src/app/(tabs)/customers.tsx:23`, `customers_plans.sql:487-491` | Verified, corrected (lowered: search still finds everyone, and owners have the dues list) |
| Important | On web a phone request takes 4 to 6 steps: search, open the customer, scroll past the other cards, pick the action, Check, Confirm. There are no row actions and no "phone desk" view. Mobile is already close to two taps once the customer is open. | `apps/web/src/app/(app)/customers/page.tsx:53-66`, `apps/web/src/app/(app)/customers/[id]/page.tsx:220-221`, `apps/web/src/app/(app)/customers/[id]/subscription-actions.tsx:129-160` | Verified, corrected |
| Nice-to-have | Switch off: the mobile money card always offers a "payment link" chip, even with no Razorpay account. Tapping it only shows an error, because links are refused until an admin marks the payout account verified. | `apps/mobile/src/app/customer/[id].tsx:128`, `p6.sql:83-86` | Not verified (medium/low) |


#### 7. Retention
Vendors get the day-to-day reports: collections, dues, customers at risk, cost per meal and rider numbers for the month. Little keeps them past the first month: there is no monthly bill per customer, no export, no alerts without WhatsApp, and no support tools for you beyond raw SQL. The most likely reasons a pilot vendor quits are:
- an app update that forces an uninstall and wipes unsynced rider work;
- a database that fills up on the Free plan;
- an owner who loses their SIM, and with it the kitchen.

**What exists**
- Collections report for a date range: money in by method and day, refunds, pending rider cash, dues and prepaid liability — works, owner only — `money.sql:1197-1240`, `apps/web/src/app/(app)/money/page.tsx:25-35`
- Dues list, a printable weekly register and a printable receipt for one payment — works, owner only — `money.sql:1179-1193`, `apps/web/src/app/print/register/page.tsx:12-14`, `apps/web/src/app/print/receipt/[id]/page.tsx:10`
- Customers who may leave — works on web Insights and on mobile — `p5.sql:1252-1320`, `p5.sql:1951`, `p5.sql:1347`, `apps/web/src/app/(app)/insights/page.tsx:27`, `apps/mobile/src/components/insights.tsx:72-79`
  - A nightly list with reasons: no balance, 3+ skips in a week, an open complaint, or a long pause. The count goes into the 22:00 summary.
  - One rule flags anyone at zero meals or below (`p5.sql:1269`). Under month-end billing, the list would therefore show every customer who owes. This was seen while checking citations and is not an audit finding.
- Cost per meal and margin — partial (ingredients are counted only through recipes) — `inventory.sql:990-1047`
- Monthly rider numbers for paying riders: shifts, days, stops, failures, proof rate, km and cash collected — works, owner only — `delivery.sql:1590-1633`, `apps/web/src/app/(app)/delivery/riders/page.tsx:26`
- Monthly statement — offices only (per-member totals for the office's billing contact) — `p6.sql:729-774`
- Owner alerts: production sheet at lock, 22:00 summary, low stock, late delivery — mock only (queued to WhatsApp, to the owner role only) — `daily_engine.sql:514-521`, `p5.sql:1334-1352`
- Founder console /admin — partial. It can change a kitchen's listing status, FSSAI number and payout account, and read the audit log. Nothing else. — `tenancy.sql:424-439`, `admin_hardening.sql:26-42`, `money.sql:1243-1263`, `admin_hardening.sql:132-155`
- Erasing one customer's personal data — partial (see the table) — `customers_plans.sql:446-471`
- Backups: a pg_dump script that can also dump a hosted database, plus a restore drill — partial (the drill runs on local Docker only) — `scripts/backup.sh:14-19`, `scripts/restore-drill.sh:7-27`
- App updates — partial
  - expo-updates is configured. — `apps/mobile/app.json:88-90`
  - Sign-out on the account screen is blocked while the rider queue still has unsent items. It cannot block an uninstall, and the Sign out button on the "Set up your kitchen" screen still wipes the queue (see Daily operation, 6d). — `apps/mobile/src/app/(tabs)/account.tsx:33`, `apps/mobile/src/app/onboarding.tsx:38`, `apps/mobile/src/lib/session.tsx:88-92`
- Translation set-up on mobile — stub (English only) — `apps/mobile/src/i18n/index.ts:6-11`
- Privacy policy and terms pages — draft — `apps/web/src/components/legal.tsx:5-20`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | Every app build from GitHub is signed with a new random key, so each update must be uninstalled first. That logs everyone out and erases any deliveries, photos and door cash not yet synced. The two test APKs already published have this problem. The fix is one upload key, kept in your password manager and set as GitHub secrets, before the first real install. | `.github/workflows/android-apk.yml:41-46`, `apps/mobile/scripts/build-apk.sh:28-33`, `apps/mobile/src/lib/rider-store.ts:68-69` | Verified |
| Blocker | Nothing is ever deleted. In the simulation, a 10-kitchen pilot writes about 530 MB of database a month, which is past Supabase Free's limit within the first month. A database over its quota turns read-only and the cutoff lock stops: no counts, no runs, no charges. Free also has no restorable backups. Pro is the minimum; check the quotas on supabase.com/pricing. | `foundation.sql:79-84`, `daily_engine.sql:1027-1029`, `p5.sql:1950-1952`, `docs/DECISIONS.md:553` | Follow-up, not verified |
| Blocker | Must be fixed before any outside vendor uploads customers. The privacy policy and terms are drafts with placeholders for the operator, address, grievance officer and retention periods. The list of processors leaves out Anthropic (notebook import) and the SMS provider. There are no vendor terms, no data processing agreement and no recorded acceptance; the only consent is a "By logging in you agree" line. | `apps/web/src/components/legal.tsx:5-13`, `apps/web/src/app/(public)/privacy/page.tsx:64-73`, `apps/web/src/app/(public)/privacy/page.tsx:80-81`, `apps/web/src/app/login/page.tsx:19-21` | Verified, corrected: the shared terms do list a few owner duties (`apps/web/src/app/(public)/terms/page.tsx:31-33,40`). The Google Ads and WhatsApp AI disclosures can wait for Phase 2. |
| Important | An owner who loses or changes their SIM loses the kitchen. There is no phone change, no account recovery and no remote sign-out, and the owner of a kitchen can never be changed. A deactivated number is reissued to a stranger, who could then log in by OTP as the owner. Needed before a real pilot ends; until then the recovery is hand-written SQL. | `tenancy.sql:12`, `tenancy.sql:395-397`, `tenancy.sql:416-418`, `apps/web/src/app/actions.ts:16-19`, `apps/mobile/src/lib/session.tsx:88-89` | Follow-up, spot-checked |
| Important | There is no monthly statement for one customer, on web, print or mobile. It would show meals by date, skips, late charges, payments, and opening and closing dues. Without it, month-end billing stays in the paper register. | `p6.sql:729-774`, `apps/web/src/app/(app)/customers/[id]/page.tsx:51,53`, `apps/web/src/app/print/register/page.tsx:12-14` | Verified, corrected: the dues list already gives the amount owed. The statement matters most once a pay-later billing mode exists. |
| Important | Nobody can see every payment in a month. The Money page lists only the latest 25 payments and ignores the chosen dates, and a customer page shows only the last 10 payments and 8 balance entries. So cash and UPI cannot be matched against the bank or the rider handovers. | `apps/web/src/app/(app)/money/page.tsx:32-33`, `apps/web/src/app/(app)/customers/[id]/page.tsx:51,53` | Verified, corrected: the verifiers rated this as the bigger part of the export finding. |
| Important | There is no CSV or Excel export of payments, dues, customers, refunds or rider cash. An accountant must retype the month into Excel, which keeps the old register alive. | `apps/web/src/app/(app)/customers/import/import-wizard.tsx:36-42`, `money.sql:1197-1240` | Verified, corrected: the money report gives totals only, and the only CSV code in the app is for import. |
| Important | There is no read-only accountant role, and the owner role cannot be shared. A bookkeeper must be given the owner's own login, with full power. The wider owner-only problem is covered under Daily operation. | `foundation.sql:27`, `tenancy.sql:296-298`, `apps/web/src/app/(app)/money/page.tsx:18`, `apps/web/src/app/print/register/page.tsx:9` | Verified |
| Important | The production sheet, the 22:00 summary and the stock and late-delivery alerts go only to WhatsApp, and only to the owner. Without a live WhatsApp Business number they are marked "sent" with a fake ID, so the owner gets nothing and the system reports success. There is no push and no in-app notifications list. | `p5.sql:1334-1352`, `acquisition.sql:774`, `supabase/functions/_shared/whatsapp.ts:21,156`, `supabase/functions/whatsapp-outbox/index.ts:52-53`, `apps/mobile/package.json:5-39` | Verified, corrected: the owner can still open the sheet, counts and stock screens. The gap is the alerts, not the data. |
| Important | The app tells vendors to "Ask Tiffin support", but no support number, WhatsApp link or help item exists anywhere in the vendor web or mobile app. Every support case starts with the vendor reaching you. | `apps/web/src/app/(app)/settings/settings-form.tsx:73`, `apps/web/src/lib/errors.ts:73`, `apps/web/src/app/(app)/layout.tsx:15-37` | Follow-up, not verified |
| Important | Neither the vendor nor /admin can undo common mistakes: a duplicate cash entry (a double tap, or a retry after a 3G timeout), a wrong lock or a closed day, a wrong refund, or a cancel on the wrong customer. The workarounds leave collections overstated or refunds valued wrongly. The real fix today is raw SQL. | `money.sql:737-781`, `money.sql:854-856`, `money.sql:21`, `daily_engine.sql:204-213` | Follow-up, not verified |
| Important | Every fix you run in the SQL editor is logged with no person and no reason. Balance entries leave no audit row at all. To run an owner action for a vendor you would have to pose as the owner, and the log would then blame them. A dispute like "who changed my balance?" cannot be answered. | `foundation.sql:111-122`, `tenancy.sql:146-148`, `daily_engine.sql:220-221` | Follow-up, not verified |
| Important | /admin shows no owner name, phone or team list. On a support call you cannot confirm that the caller is the owner, or see whether staff and riders were invited. | `admin_hardening.sql:106-125`, `apps/web/src/app/admin/types.ts:17-22` | Not verified (medium/low) |
| Important | The two APKs on phones today predate expo-updates, so no fix can reach them over the air. Every build calls itself 1.0.0 and sends no version, so the server cannot tell old phones apart or ask them to update. A database change can break phones still on an old build. Until this is fixed, migrations must only add things and must be deployed outside delivery hours. | `apps/mobile/app.json:5,28`, `apps/mobile/app.json:79-81`, `apps/mobile/src/lib/supabase.ts:8-11`, `apps/mobile/eas.json:22,29` | Follow-up, not verified |
| Important | Once over-the-air updates work: the documented update command does not set the build environment. An update published from a laptop can therefore send the laptop's local server address to every phone, and nobody could log in or sync until another update goes out. | `docs/RELEASE.md:44`, `apps/mobile/src/lib/env.ts:1-3` | Not verified (medium/low) |
| Important | No automatic test run happens on any push or pull request; the only workflows build the app. The database tests have failed since about 3 November because some tests mix the real and the simulated clock. That is a test bug, not a product bug, but nothing flagged it. Phase 1 changes to money, counts and access rules would reach a live kitchen unchecked. | `.github/workflows/android-apk.yml:9-19`, `.github/workflows/ios-testflight.yml:13-17`, `supabase/tests/05_whatsapp.test.sql:96-101` | Verified |
| Important | Restore has been proven only on local Docker. There is no written or tested way to restore a hosted project, and the photo files (delivery proofs, receipts, bills) are not backed up anywhere. | `scripts/backup.sh:14`, `scripts/restore-drill.sh:7-9,27`, `docs/OPERATIONS.md:50-53`, `delivery.sql:1677-1687` | Verified, corrected: OPERATIONS.md already names Supabase daily backups or PITR as the main hosted backup, and migrations recreate the cron jobs and buckets. This is an ops task, not a code defect. |
| Important | Nothing is cleaned up, even on Pro. The audit log stores full before and after copies of every update; rider GPS pings alone are about 39% of it. The mobile app uploads photos at full resolution (the web app already shrinks them to 1280 px), and no photo is ever deleted. The simulation puts a Ramesh-size kitchen at about 12.5 GB of photos a month, so Pro's storage fills in about two months. | `foundation.sql:96-125`, `delivery.sql:192-193`, `delivery.sql:1144`, `apps/mobile/src/app/stop/[id].tsx:119`, `apps/web/src/lib/image.ts:8` | Follow-up, not verified |
| Important | When a vendor erases a customer, the name, notes, address, location and health tags stay readable in the audit log, which can never be changed and which the owner and admins can read. Import rows keep the data too. The privacy policy's promise of "without the name, phone number or address" is therefore not true. | `foundation.sql:79-94`, `customers_plans.sql:208-211`, `customers_plans.sql:464-469`, `p6.sql:802-803`, `p6.sql:890`, `tenancy.sql:216-217`, `customer_import.sql:24`, `apps/web/src/app/(public)/privacy/page.tsx:79` | Verified |
| Important | A vendor who leaves cannot export their kitchen ("Export my data") and cannot be deleted: there is no "closed" status, kitchen records do not cascade, and the ledgers cannot be changed. "Can I take my customer list and have you delete everything?" is a common sales objection and a DPDP duty. | `foundation.sql:31`, `customers_plans.sql:16`, `daily_engine.sql:204-213`, `apps/web/src/app/(app)/customers/import/import-wizard.tsx:36-42` | Follow-up, not verified |
| Important | The vendor web and mobile screens are English only. The Odia and Hindi dictionaries are empty, nothing switches the language, there is no picker, and some labels bypass translation. Odia exists only on customer (Phase 2) screens. | `apps/mobile/src/i18n/index.ts:6-11`, `apps/mobile/src/app/(tabs)/index.tsx:16`, `apps/mobile/src/components/slot-card.tsx:33`, `apps/web/src/app/layout.tsx:25`, `docs/DECISIONS.md:81-85` | Verified, corrected: this is a documented pending decision (D-006), not a bug. Check with pilot vendors how much Odia they need. |
| Important | A kitchen name typed only in Odia script cannot be saved. The web address is built from Latin letters and digits only, and the fallback "-kitchen" breaks the format rule. This hits at sign-up. | `foundation.sql:228`, `tenancy.sql:10-11`, `tenancy.sql:254-257` | Not verified (medium/low) |
| Nice-to-have | Cost per meal counts ingredients only through recipes whose dish names exactly match the daily menu. Until the vendor has a full recipe book, the margin looks better than it is. | `inventory.sql:290`, `apps/web/src/app/(app)/reports/costs/page.tsx:93` | Not verified (medium/low) |
| Nice-to-have | Some screens still show builder notes, such as "balances arrive in the money milestone". That looks unfinished to a paying vendor. | `apps/web/src/app/(app)/plans/page.tsx:17`, `apps/web/src/app/(app)/customers/[id]/subscription-actions.tsx:155`, `apps/web/src/app/(app)/customers/[id]/money-panel.tsx:249` | Not verified (medium/low) |
| Nice-to-have | The adjustment form says "Reason (kept in the audit log)", but balance entries are not in the audit log. You and the vendor will look there and find nothing. | `apps/web/src/app/(app)/customers/[id]/money-panel.tsx:268`, `daily_engine.sql:220-221` | Follow-up, not verified |
| Nice-to-have | The /admin dashboard tracks "30 vendors live" and "half of changes via WhatsApp". It does not show Phase 1 health, such as kitchens that locked today or vendors who stopped using the app. | `apps/web/src/app/admin/page.tsx:65,91` | Not verified (medium/low) |
| Nice-to-have | The first platform admin on a hosted project can only be added with hand-written SQL, and nothing lets you add a second. Make two admins so that one lost SIM does not lock you out of /admin. | `supabase/seed.sql:39` | Follow-up, not verified |
| Nice-to-have | The repo says Node 20 is enough (`package.json` engines `>=20`, CLAUDE.md "Node 20+"). In the test run every API integration suite failed on Node 20 ("native WebSocket not found"), and Expo SDK 58 needs Node 22.13 or later. Anyone, or any future CI job, set up from the docs gets false failures. Pin Node 22. | `package.json:5-6`, `CLAUDE.md:29` | Found by test run |


---

## Phase 2 — Customers

This walks a customer's journey from lead to renewal. **All of this code has only run in mock mode.** No real Meta, Razorpay or Anthropic call has ever been made. Severities are relative to **switching Phase 2 on**. The format and status labels are the same as in Phase 1.

#### 1. Lead sources
Most of this is marketplace code. The audit files it under growth (Phase 3), except referrals, which are Phase 2. It has only run in mock mode: no real Google Ads, Justdial, Sulekha or WhatsApp traffic has ever reached it. The channels are built, but none of them can be switched off, and the WhatsApp lead bot starts the moment customer WhatsApp is turned on.

**What exists**
- Website lead form `/find`. It asks for name, phone, area or shared location, meals, diet, budget and start date. It then shows 2–3 kitchens, and picking one starts a paid trial. Status: mock only. The trial payment goes through mock Razorpay, or falls back to "pay cash" when the kitchen has no verified payout account. Evidence: `apps/web/src/app/(public)/find/find-client.tsx:107-140,233-252,318-333`, `acquisition.sql:819-865`
- Public directory `/kitchens` and kitchen page `/k/[slug]`: FSSAI number, plans, prices, the 7-day menu and verified reviews, for 'active' kitchens only. Status: works. Evidence: `apps/web/src/app/(public)/kitchens/page.tsx:15-17`, `acquisition.sql:889-921,924-947`. The kitchen page's "Start a trial" button opens `/find?kitchen=<slug>`. That page lists the kitchen first but also offers others nearby: `apps/web/src/app/(public)/k/[slug]/page.tsx:41`, `apps/web/src/app/(public)/find/find-client.tsx:148,230`
- WhatsApp lead bot for any number that is not a customer. It understands campaign codes such as "Hi TIFFIN ig-oct". Status: mock only, always on. Evidence: `supabase/functions/whatsapp-webhook/handler.ts:89-115`, `supabase/functions/_shared/lead-bot.ts:127-135,202-298`
- `lead-intake` Edge Function for Google Ads lead forms, Justdial push and a generic JSON format (Sulekha, Meta forms via Zapier, partners). Each lead is stored once per source and lead id. Status: mock only. It refuses every call while its keys are unset; the test run got 403. Evidence: `supabase/functions/lead-intake/index.ts:25-31`, `supabase/functions/_shared/leads.ts:95-100`, `lead_channels.sql:120-123`. The shared key can be sent in the URL (`?key=`), which puts it in access logs. A header also works: `supabase/functions/lead-intake/index.ts:30`
- `lead-email` Edge Function. It reads Sulekha and Justdial enquiry emails forwarded by an inbound-email service. Status: mock only. Evidence: `supabase/functions/lead-email/index.ts:41-62`, `supabase/functions/_shared/leads.ts:125-151`
- Google Ads click id (gclid). It is kept from the landing URL, and paid trial, plan and renewal are reported back to Google every 15 minutes. Status: mock only. It goes live only with `GOOGLE_ADS_MODE=live` and a developer token. Evidence: `apps/web/src/app/(public)/find/page.tsx:16-18`, `lead_channels.sql:33-68,211-228`, `supabase/functions/_shared/google-ads.ts:20-24`
- Referral codes. Status: partial. An owner can attach a friend's code by hand, and that works. The share link on the customer page is broken (see below). Evidence: `p5.sql:1425-1440`, `p6.sql:1086`
- Team tools: add a lead from a phone call, import up to 2,000 leads from a directory export, a lead list, and a funnel per source and campaign. Status: works. Evidence: `acquisition.sql:1267-1287,1342-1369`, `lead_channels.sql:156-189`, `apps/web/src/app/admin/leads/import/import-leads.tsx:81`
- Tests:
  - `supabase/tests/10_lead_channels.test.sql` 19/19.
  - `supabase/tests/07_acquisition.test.sql` 75/76. The one failure is the date-dependent test bug found by the test run (the lead_welcome outbox check), not a product bug.
  - The `lead-bot` and `lead-channels` unit suites pass, and the M7 lead flows pass on Node 22+.

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | The WhatsApp lead bot answers every number that is not a customer, and it cannot be switched off. Owner alerts come from the same platform number, so an owner who replies "ok" is greeted as a tiffin lead. A vendor's own customer whose number is missing, or saved differently, is asked the lead questions. Once any kitchen nearby is listed, that customer is also shown other kitchens with space. Turning on customer WhatsApp in Phase 2 turns this on too. | `whatsapp.sql:279-280,304-310`, `supabase/functions/whatsapp-webhook/handler.ts:89-115`, `acquisition.sql:785-789`, `p6.sql:215` | Not verified (medium/low) |
| Important | No lead channel has an on/off switch. Anyone holding the public app key can call the website lead functions. The hourly growth job and the 15-minute ads job always run. The only platform flag is for kitchen switching. Today the website flow places nobody only because no kitchen is 'active', so one "List" click opens every channel at once. | `acquisition.sql:754,1552-1553`, `lead_channels.sql:228`, `p6.sql:204-215` | Not verified (medium/low) |
| Important | Referral links do not work, and they send friends to other kitchens. The customer page shares `/find?ref=CODE`, but `/find` never reads `ref`. So no referral is recorded and no one is rewarded. The friend then gets matching across all kitchens and may join a competitor. A code from another kitchen fails without any message. The card shows for every customer, because every customer gets a code. | `p6.sql:1086`, `apps/web/src/app/(public)/find/page.tsx:12-28`, `p5.sql:63,1467-1468,1485-1489`, `apps/web/src/app/c/[token]/portal-extras.tsx:172-179` | Not verified (medium/low) |
| Important | The privacy policy does not name Google Ads. Yet `/find` stores the Google click id, and paid customers are reported back to Google. Google Ads must be added to the policy before ads run. | `apps/web/src/app/(public)/privacy/page.tsx:64-73`, `apps/web/src/app/(public)/find/find-client.tsx:136`, `supabase/functions/ads-conversions/index.ts:26` | Verified, corrected (can wait for Phase 2, but must be listed before Google Ads is switched on) |
| Important | The example secrets file has fixed values for the two lead-intake keys. The deploy guide says to set secrets from that file, and nothing rejects those values. If they are copied to a hosted project, anyone can post fake leads. | `supabase/functions/.env.example:27-28`, `docs/OPERATIONS.md:20`, `supabase/functions/lead-intake/index.ts:13-14` | Not verified (medium/low) |
| Nice-to-have | In mock mode, Google Ads conversions are marked "sent" although nothing leaves the server. They are never re-sent after the switch to live, and the team's conversions page shows them as sent. This only matters once you run Google Ads. | `supabase/functions/_shared/google-ads.ts:22,95`, `lead_channels.sql:82,98-99`, `docs/LEAD_SOURCES.md:79-80` | Not verified (medium/low) |
| Nice-to-have | The deploy guide leaves `lead-email` off the list of functions deployed without a login check. Inbound-email services send no login token, so a deploy that follows the guide breaks email intake. | `docs/OPERATIONS.md:19`, `supabase/config.toml:444-445` | Not verified (medium/low) |
| Nice-to-have | The public kitchen-page function returns the kitchen's location to about 110 m. The page does not show it, but anyone can call the function. For a home cook, this is roughly their home. | `acquisition.sql:900` | Not verified (medium/low) |

#### 2. Qualification
The website form and the WhatsApp bot collect what matching needs, and every lead gets a status. But nothing checks that a phone number belongs to the person typing it, and the public forms have no protection against scripts. Both problems must be fixed before `/find` or the vendor form go live. The synthesis lists them under "fix before turning it on".

**What exists**
- Website questions: name, mobile, area or shared location, lunch/dinner/both, veg/non-veg/Jain, budget and start date. Status: works. Evidence: `apps/web/src/app/(public)/find/find-client.tsx:81-84,116-131`. When a caller leaves meals or diet out, they default to lunch and veg: `acquisition.sql:820-821`
- Bot questions, skipping any that a form already answered: location (shared pin or typed area), meals, diet, budget (optional, "Any") and start date (tomorrow, this week, or just looking). Status: mock only. Evidence: `supabase/functions/_shared/lead-bot.ts:137-150,241-276`. Ad and directory leads bring only what their form had: name, phone, area, and sometimes meals and diet (`supabase/functions/_shared/leads.ts:42-92`)
- Typed areas are matched to 31 Bhubaneswar area centres with common spellings, so no maps key is needed (D-080). Status: works. Evidence: `acquisition.sql:27-66,239-252`
- A lead counts as "qualified" once it has a location and at least one meal time. Diet, budget and start date are optional. Evidence: `acquisition.sql:289-296`
- Statuses: new → qualifying → qualified → matched or waitlist → trial → converted → renewed, or lost. Trial, converted and renewed come only from real payments. The team can set only new, qualifying, waitlist or lost. Every step is logged in an append-only history. Status: works. Evidence: `acquisition.sql:9,480-485,587-619,1321-1339`, `acquisition.sql:140-148,199-200`
- Each phone has one open lead, and a repeat enquiry merges into it. Evidence: `acquisition.sql:116-118,434-438`
- Waitlist. Status: partial. When no kitchen fits, the lead is told "we'll WhatsApp you when one does". But matching only re-runs when the team presses "Re-run matching" or the lead messages the bot again. The team can see waitlisted demand by area. Evidence: `acquisition.sql:380-384,1373-1399`, `apps/web/src/app/(public)/find/find-client.tsx:265-270`, `apps/web/src/app/admin/leads/[id]/lead-actions.tsx:60`, `supabase/functions/_shared/lead-bot.ts:62,277-280`
- Consent:
  - The website requires "I agree to be contacted". "Send me updates on WhatsApp" is a separate box that starts ticked: `apps/web/src/app/(public)/find/find-client.tsx:83,114,196-203`, `acquisition.sql:837-839`
  - Bot leads are saved as consenting and opted in: `acquisition.sql:1056,1078`
  - Ad and directory leads are saved as agreeing to be contacted. They get WhatsApp only when the Google form said yes, and never from Justdial: `lead_channels.sql:124-127`, `supabase/functions/_shared/leads.ts:55,75`
- Abuse guard: at most 5 website enquiries per phone per day. Status: works. Evidence: `acquisition.sql:849-854`
- Phone check: format only. No code is sent to the number. Evidence: `acquisition.sql:834,840-842`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | Once a kitchen is listed, anyone can type someone else's number into `/find`, pick that kitchen and create a real customer with a trial subscription in the kitchen's books. No code is ever sent to the phone. If the number already belongs to one of that kitchen's customers, the page says "You are already a customer of this kitchen". So a stranger can test whether a number is a vendor's subscriber. Each fake trial also takes up a free place, and the lead link never expires. | `acquisition.sql:99,283-285,538-539,542-560,877-884`, `apps/web/src/lib/errors.ts:130` | Not verified (medium/low) |
| Blocker | The public forms have no CAPTCHA and no limit per IP address or overall, and a script can call them directly without the page. The only limit is 5 per phone, so a script can use thousands of different numbers. A website lead that was shown kitchens, with the pre-ticked WhatsApp box, gets a reminder 24 hours later. A vendor-form entry gets a welcome at once and then three nudges, to whatever number was typed. This costs template fees and invites spam reports against the one platform number, which also carries owner alerts. | `acquisition.sql:714-726,728-748,849-854,1009-1013,1552-1553`, `supabase/functions/whatsapp-outbox/index.ts:40`, `supabase/config.toml:215-219`, `apps/web/src/app/(public)/find/find-client.tsx:83`, `apps/web/src/app/(public)/vendors/vendor-form.tsx:13` | Not verified (medium/low) |
| Important | The consent rules for leads are not decided yet (D-081 is still pending). Everyone who messages the bot is recorded as opted in for follow-ups. The website's WhatsApp box starts ticked, which is weak consent under DPDP. Meta's policy must be checked before going live. | `acquisition.sql:1056,1078`, `docs/DECISIONS.md:484-489`, `docs/SECURITY.md:33`, `apps/web/src/app/(public)/find/find-client.tsx:83` | Not verified (medium/low) |

#### 3. Matching
Matching is the most complete part of the lead flow. It checks distance, meal times, diet and free places, ranks kitchens, and turns the customer's pick into a trial customer. The problems are about the vendor's control: a listed kitchen is opted in by default, the opt-out has gaps, and "verified" and "listed" are the same state.

**What exists**
- Who can be offered:
  - the kitchen is 'active' and takes platform leads;
  - the lead is inside the kitchen's own delivery radius;
  - an active plan covers the requested meals with the exact diet;
  - there is at least one free place for every requested meal.

  Status: works (tested in `07_acquisition`). Evidence: `acquisition.sql:301-352`
- Free places: capacity, minus the busiest day's counted meals over the 7 days from the start date, minus trials waiting for payment. Status: works. Evidence: `acquisition.sql:269-287`
- Ranking: 60% verified rating, then 40% price fit against the budget, then distance. The rating starts from 4.0 as if the kitchen already had 3 reviews, so one 5-star review does not put a kitchen on top. The top 3 are shown. The weights are your pending decision D-078. Status: works. Evidence: `acquisition.sql:255-266,340-350`, `docs/DECISIONS.md:466-472`
- Plan offered per kitchen: first one with exactly the requested meals, then the price closest to the budget. Evidence: `acquisition.sql:329-332`
- The shortlist is saved, and the lead moves to matched, or to waitlist if nothing fits. Evidence: `acquisition.sql:355-387`
- Choosing a kitchen:
  - The website (anyone holding the lead's link) and the bot both need a saved match.
  - The lead then becomes a permanent platform-sourced customer of that kitchen, with an address, a 'trial' subscription and a 14-day customer-page link.

  Status: works in mock mode. Evidence: `acquisition.sql:502-582,868-886,1088-1100`
- A person who is already that kitchen's customer cannot be claimed (`already_customer`), so commission cannot land on the vendor's own customers (D-082). Evidence: `acquisition.sql:537-540`, `docs/DECISIONS.md:491-494`
- Team placement: an admin can place a lead with any active kitchen. The screen lists listed kitchens within 8 km, including ones outside their own radius. Status: works. Evidence: `acquisition.sql:1301-1319`, `apps/web/src/app/admin/leads/[id]/lead-actions.tsx:36-42,67-75`
- Vendor notice: a `new_platform_customer` WhatsApp to the kitchen's owners. Status: mock only. Evidence: `acquisition.sql:567-574`, `supabase/functions/_shared/templates.ts:289-290`
- Vendor opt-out: "Send me new customers from the platform" in Settings. Status: works, with gaps (below). Evidence: `apps/web/src/app/(app)/settings/listing-form.tsx:23,40,128-129`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Important | Every kitchen is opted in to platform customers by default. As soon as an admin presses "List", anyone on `/find` or the WhatsApp bot can become a permanent platform customer with a trial subscription in that kitchen. The vendor does not approve each one. If the vendor later adds the same person as their own customer, the app refuses it as a duplicate. | `acquisition.sql:20,325,542-560`, `customers_plans.sql:42-43,390-392`, `apps/web/src/app/admin/status-buttons.tsx:20-21` | Verified, corrected (it needs an admin to press List; kitchens start as draft) |
| Important | The vendor's opt-out leaks in three places. Admin placement ignores it. The final step never re-checks it, so a match saved before the vendor unticked the box can still become a customer. The public directory still lists an opted-out kitchen. | `acquisition.sql:524-527,881-884,942-945,1095-1098,1301-1319` | Verified, corrected |
| Important | There is no separate "verified" state. 'Active' is the only step up from draft, and it means verified, publicly listed and open to matching, all at once. The admin goal (30 kitchens live), the vendor checklist and the FSSAI hint all push the team to press "List". So the team cannot mark a vendor as checked without opening the marketplace to them. | `apps/web/src/app/admin/kitchens/page.tsx:14-18`, `apps/web/src/app/admin/status-buttons.tsx:20-21`, `apps/web/src/app/(app)/settings/settings-form.tsx:73`, `apps/web/src/lib/checklist.ts:14`, `acquisition.sql:672`, `admin_hardening.sql:62`, `apps/web/src/app/admin/page.tsx:59-71` | Verified, corrected (no vendor operation needs 'active', so draft kitchens are safe; kitchen switching is already behind its own flag) |
| Important | The vendor hears about a new platform customer only through a WhatsApp to the owner. Staff are not told, and there is no in-app alert: the customer simply appears in the Customers list. Without WhatsApp keys, the message is marked "sent" although nothing went out. | `acquisition.sql:568-574`, `supabase/functions/_shared/whatsapp.ts:21,156`, `supabase/functions/whatsapp-outbox/index.ts:52-53` | Verified, corrected (part of the verified owner-alert finding, rated medium) |

#### 4. Trial
A platform lead who picks a kitchen becomes that kitchen's customer with a 'trial' subscription and pays for a short trial at the plan price. It works end to end in mock mode. But a trial cooks nothing until it is paid, and online payment is not ready to go live (step 5).

**What exists**
- Lead becomes a customer: `convert_lead` creates a platform-sourced customer, a 'Home' address from the lead, a 'trial' subscription starting tomorrow at the earliest, an owner alert and a 14-day customer-page link — works (mock) — `acquisition.sql:502-582` (customer `:542-548`, trial `:558-560`, link `:576`)
- Trial length per kitchen: `trial_meals`, default 2, allowed 1–7. Trial price = trial meals × plan price — works — `acquisition.sql:19`, `acquisition.sql:579`
- /find "Start trial" asks for a payment link. With no verified payout account it falls back to "pay cash" — mock only — `apps/web/src/app/(public)/find/find-client.tsx:305`, `apps/web/src/app/(public)/find/find-client.tsx:318-333`
- No meals while a subscription is 'trial': meal generation covers only active, low_balance and paused — works as designed, D-033 still pending — `p5.sql:392`, `docs/DECISIONS.md:227-228`
- The first payment turns the trial 'active' and queues a receipt — works — `money.sql:282-284`, `money.sql:288-291`
- An unpaid trial is cancelled once start date + grace days (default 7) have passed — works — `money.sql:428-433`, `tenancy.sql:48`
- Funnel stages come from real payments: trial paid → converted → renewed (a payment 25+ days after conversion) — works — `acquisition.sql:587-622`
- Day-2 follow-up: about 20 hours after the trial payment, `trial_followup_v1` offers a month of the plan with a fresh 14-day page link. Hourly cron `tiffin-growth` — mock only — `acquisition.sql:694-711`, `acquisition.sql:754`, `supabase/functions/_shared/templates.ts:146-156`. D-079 notes that a 2-meal trial also triggers the daily low-balance reminder, and leaves that choice to you (`docs/DECISIONS.md:474-479`).
- Vendor-side "Starts as Trial" option on web. Trial subscriptions hide the skip and pause actions on web and mobile — present — `apps/web/src/app/(app)/customers/[id]/add-subscription.tsx:55-59`, `apps/web/src/app/(app)/customers/[id]/page.tsx:235`, `apps/mobile/src/app/customer/[id].tsx:155`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Important | A trial cooks nothing until it is paid. There is no free trial and no "pay on the first delivery". A cash trial (the /find fallback, or the vendor's "Starts as Trial") stays at zero meals until the owner records the cash. If nobody does, it cancels itself after 7 days without telling anyone. D-033 is still open. Paid online trials also wait on the step 5 blockers. | `p5.sql:392`, `money.sql:428-433`, `apps/web/src/app/(public)/find/find-client.tsx:330`, `apps/web/src/app/(app)/customers/[id]/add-subscription.tsx:55-59`, `docs/DECISIONS.md:227-228` | Not verified (medium/low) |
| Important | The /find form ticks "WhatsApp updates" by default. `convert_lead` copies that into the new customer's opt-in and records a 'whatsapp' consent. A pre-ticked box is weak consent under DPDP and for Meta's opt-in rules. | `apps/web/src/app/(public)/find/find-client.tsx:83`, `acquisition.sql:545`, `acquisition.sql:551-554` | Not verified (medium/low) |

#### 5. Plan
The customer manages their own plan on the customer page (/c/[token]) and through the WhatsApp bot: see meals and balance, skip, pause, resume, change the address, complain and pay online. All of it has run only in mock mode against the local stack. Before it goes live, mock mode must fail closed, the money model (D-003) must be decided, and customer-page links need a way to be revoked.

**What exists**
- Customer page /c/[token]: balance, upcoming meals with skip and undo, pause and resume, new address, complaint, rating, payment history, language — works (mock) — `apps/web/src/app/c/[token]/page.tsx:8-24`, `apps/web/src/app/c/[token]/portal-client.tsx:74-140`, `p5.sql:1674-1712`
- Page RPCs check the token and that the subscription belongs to that customer. Cancel is refused ("cancel via kitchen") — works — `whatsapp.sql:716-737` (cancel `:729-731`), `whatsapp.sql:739-807`
- Customer-page links: 32 random bytes (256-bit), only the SHA-256 hash is stored, expiry and revocation are checked — works — `whatsapp.sql:193-233`. They last 7 days when issued by the bot, the owner or a payer message (`whatsapp.sql:501`, `whatsapp.sql:970`, `p5.sql:34`) and 14 days from lead conversion and the trial follow-up (`acquisition.sql:576`, `acquisition.sql:703`). The page is not indexed (`apps/web/src/app/c/[token]/page.tsx:5`).
- WhatsApp bot: menu, balance, skip, pause, resume, pay, address, complaint, talk to the kitchen, language — mock only — `supabase/functions/_shared/bot.ts:297-372`. Cancel requests and money questions go to the kitchen (`supabase/functions/_shared/bot.ts:339-344`). `wa_apply_change` checks that the subscription is the customer's and blocks cancel (`whatsapp.sql:388-407`).
- A location pin sent on WhatsApp becomes the default address for every live subscription from today — mock only — `whatsapp.sql:462-486`
- AI fallback for free text: Claude, default model `claude-opus-5-5`, only when an Anthropic key is set; otherwise a few rule-based answers, then a hand-off. Discount, refund and "free" questions never reach the model, and replies are checked in code — mock only — `supabase/functions/whatsapp-webhook/index.ts:22-44`, `supabase/functions/_shared/ai.ts:31-40`, `supabase/functions/_shared/ai.ts:119-129`. Model and cost choice (D-058) pending, `docs/DECISIONS.md:350-359`.
- Opt-in and the 24-hour window: opt-in is off by default and asked once on first contact. STOP and UPDATES work at any time. A customer message goes out only if the customer opted in or wrote in the last 24 hours — works — `customers_plans.sql:25`, `supabase/functions/_shared/bot.ts:326-333`, `supabase/functions/_shared/bot.ts:362-370`, `acquisition.sql:792-798`, `supabase/functions/whatsapp-outbox/index.ts:40-44`
- Owner inbox: reply, mark read, close — mock only — `whatsapp.sql:812-878`
- Delivery OTP: a 4-digit code is made at run start and sent only inside the WhatsApp 'on the way' message, then checked when the rider completes the stop — mock only — `delivery.sql:726-734`, `p5.sql:1771-1780`
- Online payment links (owner, customer page, payer paying for a dependent, bot): our payment row first, then a Razorpay Payment Link on the platform's account with a Route transfer to the kitchen's linked account. The webhook checks the signature, ignores duplicate events and credits meals — mock only — `supabase/functions/razorpay-payment-link/index.ts:36-54`, `p6.sql:60-110`, `p5.sql:258-271`, `supabase/functions/_shared/razorpay.ts:95-131`, `money.sql:562-664`
- Pay buttons stay hidden until an admin marks the kitchen's payout account verified — works — `whatsapp.sql:168-169`, `p6.sql:83-86`, `apps/web/src/app/c/[token]/portal-client.tsx:164`
- UPI Autopay — missing. It waits on D-003, and only a placeholder column exists — `docs/DECISIONS.md:318-319`, `customers_plans.sql:120`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | Mock mode is the default, and it fails open. With no Razorpay key id, or with `RAZORPAY_MODE=mock` copied from the example env file, payment links point to the public `razorpay-mock` page. Its "Pay (test)" button sends a correctly signed "paid" event to the real webhook, which credits meals with no money. The ops guide says to deploy that page. Once any payout account is marked verified, anyone with a customer-page link can repeat this. WhatsApp mock mode likewise marks every message 'sent' with a fake id. | `supabase/functions/_shared/razorpay.ts:20`, `supabase/functions/_shared/razorpay.ts:122-127`, `supabase/functions/razorpay-mock/index.ts:25-46`, `supabase/config.toml:441-442`, `docs/OPERATIONS.md:19`, `supabase/functions/.env.example:3`, `money.sql:1243-1263`, `supabase/functions/_shared/whatsapp.ts:21`, `supabase/functions/_shared/whatsapp.ts:156` | Verified, corrected (it needs three things at once: the webhook secret set, razorpay-mock deployed, and a payout account marked verified. Phase 2 makes the third normal.) |
| Blocker | The money model is undecided (D-003). Payment links are created on the platform's own Razorpay account and passed to the kitchen by Route, so the platform is the merchant of record. That contradicts "we never hold customer money" in the spec and security notes, and the vendor screen's "the money goes straight to your bank". There is no GST or e-commerce-operator analysis and no GSTIN field. Get answers from Razorpay and a CA before any live payment. | `supabase/functions/_shared/razorpay.ts:63-70`, `supabase/functions/_shared/razorpay.ts:102-115`, `docs/SPEC.md:14`, `docs/SECURITY.md:18`, `docs/AUDIT.md:81`, `docs/DECISIONS.md:65-68`, `apps/web/src/app/(app)/customers/[id]/money-panel.tsx:221` | Verified, corrected (rated medium because Phase 1 is unaffected; for Phase 2 it is a go/no-go decision) |
| Important | Customer-page links cannot be revoked. `revoked_at` is checked, but nothing ever sets it. Every new link (bot "my page", owner share, payer message, trial follow-up) adds another live token for 7–14 days. A forwarded link keeps working: it can change the delivery address, pause meals, file complaints and see payments. | `whatsapp.sql:89`, `whatsapp.sql:227`, `whatsapp.sql:207-208`, `whatsapp.sql:501`, `p5.sql:34`, `acquisition.sql:703`, `whatsapp.sql:732-758` | Not verified (medium/low) |
| Important | Nobody checks that the kitchen actually received its money. A payment is marked paid with whichever linked account was configured, and Razorpay `transfer.*` events are ignored. Gateway and Route fees come out of the platform's balance. A failed transfer leaves the vendor unpaid with no alert. | `money.sql:585-588`, `money.sql:636`, `supabase/functions/_shared/razorpay.ts:95-98` | Not verified (medium/low) |
| Important | Riders are told "The customer got a 4-digit code on WhatsApp" while the message is still pending or stuck, because `otp_sent` counts 'pending' and 'sending' rows (and mock mode marks rows 'sent'). Customers without WhatsApp never get a code, so photo or "Delivered" must stay the main action. | `p6.sql:1299-1300`, `delivery.sql:726-734`, `apps/web/src/app/(field)/rider/rider-app.tsx:453`, `apps/web/src/app/(field)/rider/rider-app.tsx:459`, `apps/mobile/src/i18n/en.ts:210` | Verified, corrected (the cause is counting pending rows, not a missing opt-in check: the worker already cancels rows for customers who did not opt in) |
| Important | There is no UPI Autopay, so every renewal needs the customer to act. It waits on D-003, which includes whether Route works with Razorpay Subscriptions. | `docs/DECISIONS.md:318-319`, `docs/DECISIONS.md:65-68`, `customers_plans.sql:120` | Not verified (medium/low) |
| Nice-to-have | Payments started from WhatsApp ignore the platform commission. The bot path does not pass the kitchen's share, so Route sends the full amount while the ledger still books a commission. Harmless while the commission is 0. | `supabase/functions/whatsapp-webhook/index.ts:55-60`, `supabase/functions/_shared/razorpay.ts:95-98`, `p6.sql:113-132` | Not verified (medium/low) |
| Nice-to-have | The AI fallback has no cost cap per conversation or per day and defaults to the most expensive model. Its SDK is loaded by a dynamic npm import that has never run on hosted Supabase; if it fails, the chat is handed to the kitchen. | `supabase/functions/_shared/bot.ts:348`, `supabase/functions/whatsapp-webhook/index.ts:22-34`, `docs/DECISIONS.md:350-359` | Not verified (medium/low) |
| Nice-to-have | The delivery OTP is weak. The wrong-code lockout never sticks, because the error rolls back the attempt counter. An offline submit records a wrong code as delivered. Every code stays readable in the audit log and the outbox. | `p5.sql:1773-1779`, `foundation.sql:93`, `delivery.sql:729-733` | Not verified (medium/low); the audit-log part is Follow-up, not verified |
| Nice-to-have | If the Razorpay call fails, a 'created' payment row with no link is left behind (owner, page and bot paths). | `supabase/functions/razorpay-payment-link/index.ts:36-60`, `supabase/functions/whatsapp-webhook/index.ts:55-62` | Not verified (medium/low) |
| Nice-to-have | Customer-page inputs have no length limits, and every page complaint alerts the owners. One link holder can flood the owner and put long text on rider sheets. | `whatsapp.sql:739-758`, `whatsapp.sql:761-779` | Not verified (medium/low) |

#### 6. Renewal
Renewal means reminder → payment → meals continue, plus keeping the customer (at-risk list, complaints, reviews, switching) and changes to their account (new phone number, erasure). The logic exists. But the WhatsApp side cannot start without Meta approval, the outbox needs an expiry and a fix for stuck rows, and a reused phone number lets one customer act on another's account.

**What exists**
- Low-balance reminder every day while the balance is low. Dues reminder on day 1, 3 and 7 after the balance goes negative. Both are queued nightly and say "Reply PAY" — mock only, cadence D-049 pending — `money.sql:519-556`, `money.sql:437`, `supabase/functions/_shared/templates.ts:85-102`, `docs/DECISIONS.md:304-308`
- Recharge: PAY in the bot or Pay on the page → payment link → webhook → `post_recharge` credits meals, re-checks status and queues a receipt — mock only — `money.sql:260-292`, `money.sql:562-593`
- Funnel 'renewed' stage — works — `acquisition.sql:587-622` (see step 4)
- Outbox worker runs every minute, retries with backoff and marks a row 'failed' after 5 attempts — mock only — `whatsapp.sql:1029-1054`, `acquisition.sql:759-811`, `whatsapp.sql:616-621`, `supabase/functions/whatsapp-outbox/index.ts:25-63`
- At-risk customers computed nightly (balance out, 3+ skips in 7 days, open complaint, long pause, trial not converted), shown on Insights and counted in the 22:00 owner summary — works — `p5.sql:1239-1320`, `p5.sql:1951`, `p5.sql:1347`, `apps/web/src/app/(app)/insights/page.tsx:27`
- Complaints from WhatsApp or the page: owner alert, chat handed to the kitchen, escalation to the platform after 2 hours, owner resolves with up to 30 free meals — partial — `whatsapp.sql:432-459`, `whatsapp.sql:761-780`, `whatsapp.sql:1009-1023`, `whatsapp.sql:1053`, `whatsapp.sql:881-920`
- The first food or delivery complaint gets 1 free meal automatically. The kitchen setting `auto_credit_first_complaint` is on by default — works — `p5.sql:47`, `p5.sql:977-1017`
- Reviews: 1–5 stars from the page, marked verified if a meal was delivered, admin can hide them — works — `acquisition.sql:151-163`, `acquisition.sql:1019-1039`, `acquisition.sql:1462-1495`
- Kitchen switching: flag off. When approved, the old subscriptions are cancelled (refund through the cancel path) and the customer starts a new trial at the new kitchen — works, switched off — `p6.sql:215`, `p6.sql:460-535`
- Commission: 0 bps by default, only on online payments by platform-sourced customers, append-only ledger, proportional reversal on refunds — works, inactive at 0 — `p6.sql:18-19`, `p6.sql:92`, `p6.sql:113-132`, `commission_reversals.sql:5-57`
- Online refund to the original payment, with `reverse_all` — mock only — `supabase/functions/razorpay-refund/index.ts:25-40`, `supabase/functions/_shared/razorpay.ts:134-142`
- Templates: 33 written (21 customer, 4 platform, 8 owner). English is ready to submit; Odia and Hindi are drafts — not submitted — `docs/WHATSAPP_TEMPLATES.md:9-10`, `docs/WHATSAPP_TEMPLATES.md:20-64`

**Missing or broken**
| Severity | Issue | Evidence | Status |
|---|---|---|---|
| Blocker | There is no Meta account yet, so none of the 33 templates has been submitted or approved. Outside the 24-hour window, receipts, reminders, the trial follow-up and delivery codes can only go out as approved templates. The WhatsApp cost per kitchen, promised for M4, was never worked out. Meta business verification takes weeks, so start it early. | `docs/PLAN.md:113`, `docs/WHATSAPP_TEMPLATES.md:3`, `docs/WHATSAPP_TEMPLATES.md:20-64`, `docs/RELEASE.md:65`, `docs/AUDIT.md:124` | Not verified (medium/low) |
| Blocker | A reused phone number opens another customer's account. A WhatsApp conversation keeps the customer it was first linked to. Say the owner changes customer A's phone and later adds customer B on A's old number in the same kitchen. B's messages then land in A's conversation: B sees A's balance and meals, can skip, pause or re-address A's subscriptions, and can get a link to A's page (addresses, payments). In the reverse case, one customer on two numbers gets every message twice. | `whatsapp.sql:298-302`, `whatsapp.sql:345`, `whatsapp.sql:399`, `whatsapp.sql:497-501`, `customers_plans.sql:416-435`, `acquisition.sql:806` | Verified, corrected (one verifier narrowed it: it happens only when the kitchen registers a new customer on the old number; a stranger who is not that kitchen's customer sees nothing) |
| Important | Outbox rows never expire. Any row still pending when WhatsApp goes live, or after a worker outage, is sent at once: old receipts, "tomorrow's menu" for past dates, delivery codes, dues. In the default mock setup, rows are instead marked 'sent' with a fake id, so the owner and the inbox show messages that never went out. | `daily_engine.sql:183-198`, `acquisition.sql:773-775`, `whatsapp.sql:1044-1046`, `supabase/functions/_shared/whatsapp.ts:156`, `whatsapp.sql:616-627` | Verified, corrected (no backlog builds while the worker runs in mock mode; then the problem is false 'sent' records; rated medium) |
| Important | Outbox rows can stay in 'sending' forever, because nothing resets a row after a crash between claim and completion. They can also be sent twice: if recording the success fails, the row goes back to 'pending'. The admin failure count only counts 'failed'. | `acquisition.sql:780`, `supabase/functions/whatsapp-outbox/index.ts:33-59`, `admin_hardening.sql:91` | Not verified (medium/low) |
| Important | Reminders do not know how the customer pays. Once Phase 1 adds month-end (pay-later) customers, any of them who opt in would get a "low balance" message every day and dues messages on day 1, 3 and 7, in the middle of the month. | `money.sql:532-538`, `money.sql:542-550`, `money.sql:231-235` | Not verified (medium/low) |
| Important | A late renewal does not bring meals back. A prepaid customer who runs out is suspended, and 7 days later the subscription is cancelled for good. A payment after that goes onto the balance but restarts nothing: payment only reactivates 'trial', and there is no reactivate action. Online, the customer pays, gets no meals, and nobody is alerted. | `money.sql:421-426`, `money.sql:226`, `money.sql:282-284`, `daily_engine.sql:643-645`, `customers_plans.sql:564` | Verified, corrected (the balance carries over to a new subscription, so the money is not lost, but the owner must set the plan up again) |
| Important | Recharge links and dues price every meal at the customer's newest plan, not the price the meals were charged at. With lunch and dinner at different prices, or after a price edit, the amount asked for and the meals credited are wrong. The Phase 1 rupee-ledger work fixes this. | `money.sql:132-143`, `p6.sql:87-91`, `money.sql:510` | Verified, corrected |
| Important | An online refund can reach Razorpay twice. `refund_for_gateway` only reads the row, there is no idempotency key, and the second `mark_refund_submitted` silently does nothing. Each refund pulls money back from the vendor (`reverse_all`). Razorpay's own cap stops a double full refund, but not a double partial one. | `supabase/functions/razorpay-refund/index.ts:26-34`, `money.sql:948-976`, `money.sql:678-686`, `supabase/functions/_shared/razorpay.ts:134-142` | Verified |
| Important | By default, a customer's first food or delivery complaint gives a free meal at the kitchen's cost, without the vendor choosing it. It stacks with any credit the owner adds when resolving. D-099 is pending. | `p5.sql:47`, `p5.sql:977-1017`, `whatsapp.sql:881-920`, `docs/DECISIONS.md:590-593` | Not verified (medium/low) |
| Important | Escalated complaints go to a read-only admin list with no customer or kitchen contact and no action, yet the Terms promise "our team steps in". Vendors cannot log a complaint that a customer phones in: the 'vendor' channel exists, but no RPC or grant lets them insert one. | `apps/web/src/app/admin/page.tsx:20-21`, `apps/web/src/app/admin/page.tsx:38-50`, `whatsapp.sql:1009-1023`, `apps/web/src/app/(public)/terms/page.tsx:20`, `apps/web/src/app/(public)/terms/page.tsx:75`, `whatsapp.sql:67`, `whatsapp.sql:1075-1079` | Not verified (medium/low) |
| Important | Erasure leaves the customer's data behind. Conversations keep the encrypted phone, the last 4 digits and the WhatsApp name. Messages, complaints, page links and reviews stay. The append-only audit log keeps name, address and health tags. `portal_get` creates a conversation for every customer who opens their page. | `customers_plans.sql:446-470`, `p6.sql:881-895`, `p5.sql:1688-1692`, `foundation.sql:87-94` | Verified (audit log and conversations); the messages, complaints, links and reviews part is Not verified (medium/low) |
| Important | The Odia and Hindi bot, page and template texts are drafts awaiting a native speaker (D-057). Meta's Odia code `or` is unconfirmed. If Meta has no Odia template, the send fails instead of falling back to English. | `docs/DECISIONS.md:345-348`, `docs/WHATSAPP_TEMPLATES.md:9-13`, `supabase/functions/_shared/templates.ts:345` | Not verified (medium/low) |
| Important | The nightly job runs status sync, auto-cancels, meal generation and customer reminders in one transaction. A failure in the reminder step rolls back the whole night, and nobody is told. | `money.sql:409-438`, `daily_engine.sql:1028` | Follow-up, not verified |
| Nice-to-have | The 19:00 "tomorrow's menu, skip?" message goes to every opted-in customer of every kitchen, and no kitchen can turn it off. | `whatsapp.sql:979-1006`, `whatsapp.sql:1052` | Not verified (medium/low) |
| Nice-to-have | Since about 3 November, 8 WhatsApp outbox tests (05_whatsapp) and 1 lead outbox test fail because they mix the real clock with the simulated one. Product code is unaffected, but the outbox has no passing test until V0 fixes this. | `supabase/tests/05_whatsapp.test.sql:96-103`, `acquisition.sql:774` | Found by test run |


---

## Test results

All runs used a copy of the repo at `34c5877` under the session scratchpad (`Southeast-exec`). The only changes in that copy were `project_id = "tiffinaudit"` in `supabase/config.toml` (so containers would not clash with yours) and `supabase/functions/.env` created from `.env.example` (mock mode).

Toolchain:
- Node v20.20.2 (your nvm default) for install, typecheck, lint, core tests and the web build.
- Node v26.4.0 for the integration re-run.
- pnpm 10.28.0, Supabase CLI 2.122.0, Postgres 17, edge-runtime 1.77.8 (Deno 2.1.4), pg_prove 3.36, Docker Desktop 29.6.1.

| # | Command | Result | Counts |
|---|---|---|---|
| 1 | `npx -y pnpm@10.28.0 install --frozen-lockfile` | pass | 912 packages, 6 s. Warning: `Ignored build scripts: core-js@3.51.0` |
| 2 | `pnpm typecheck` (turbo) | pass | 5/5 packages. The Deno Edge Functions are not typechecked by any script. |
| 3 | `pnpm lint` + `eslint .` in apps/web and apps/mobile | pass | 0 errors, 0 warnings. Expo prints `Node.js (v20.20.2) is outdated and unsupported... (required: >=22.13.0)` |
| 4 | `pnpm --filter @tiffin/core test` | pass | 28/28 |
| 5 | `pnpm --filter @tiffin/web build` (no env) | **fail** (by design) | Compile and TypeScript OK, then the env check throws. Full error below. |
| 6 | `NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… pnpm --filter @tiffin/web build` | pass | Next 16.4.3: 53 routes (46 dynamic, 7 static) |
| 7 | `cd apps/mobile && CI=1 npx -y expo-doctor` | **fail** | 19/20 checks. Full text below. |
| 8 | `cd apps/mobile && EXPO_OFFLINE=1 npx expo export --platform android` | pass | 1,449 modules, Hermes bytecode 3.9 MB. No native build was attempted. |
| 9 | `pnpm exec supabase start` | pass | All 17 migrations and the seed applied. 12 Edge Functions served. |
| 10 | `pnpm exec supabase db reset` | pass | 17/17 migrations, seed applied, 11 pg_cron jobs present |
| 11 | `pnpm exec supabase test db` (pgTAP) | **fail** | **873/882**. 01_rls 50/50, 02_rpcs 59/59, 03_daily_engine 72/72, 04_money 99/99, **05_whatsapp 46/54**, 06_delivery 111/111, **07_acquisition 75/76**, 08_inventory 74/74, 09_security 18/18, 10_lead_channels 19/19, 11_p5 132/132, 12_p6 106/106, 13_commission_reversals 12/12 |
| 12 | `pnpm test:integration` on Node 20.20.2 | **fail** | 17 files: 8 passed, 9 failed. 121 tests: 80 passed, 1 failed, 40 skipped |
| 13 | `supabase db reset && vitest run --reporter=verbose` in tests/integration on Node 26.4.0 | pass | **17/17 files, 121/121 tests**, about 22 s (mock mode only) |
| 14 | `docker exec -i supabase_db_tiffinaudit psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/perf/lock_load.sql` | pass | 5,000 subscriptions: first lock 6.17 s, second day 0.81 s (local Docker, not hosted). Rolled back. |
| 15 | `curl -X POST {}` to each of the 12 Edge Functions | pass | 12/12 boot and answer with their own guard. razorpay-mock answers 200 `Payment not found`. |
| 16 | `next start -p 3100` on Node 20, then an owner-session smoke test (21 dashboard pages) | pass | 21/21 pages return 200 with real seed data. Anonymous `/`, `/customers` → 307 to `/login`. |
| 17 | Phase 1 offline-customer flow over REST as the kitchen A owner (`probe/vendor_flow.mjs`) | partial | Add, subscribe, cash, skip, pause, resume, address, cancel and refund all returned 200/201. `create_customer` with consent unticked is refused (below). |
| 18 | Future-dated permanent address change (`probe/address_probe.mjs`) | **fail (product bug)** | Details below |
| 19 | `pnpm exec supabase stop --no-backup`, then quit Docker | pass | 0 containers, 0 volumes left |

### Full failure text

**Step 5, web build without env (by design; hosting and CI must set the public Supabase env at build time):**
```
Error: Failed to collect configuration for /onboarding
    at ignore-listed frames {
  [cause]: Error: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set (see apps/web/.env.example)
      at module evaluation (src/lib/supabase/env.ts:5:9)
      at module evaluation (src/lib/session.ts:6:1)
      at module evaluation (src/app/onboarding/page.tsx:2:1)
}
> Build error occurred
Error: Failed to collect page data for /onboarding
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @tiffin/web@0.1.0 build: `next build`
Exit status 1
```

**Step 7, expo-doctor (version drift only, no configuration errors):**
```
Check that packages match versions required by installed Expo SDK: FAILED
major mismatch: typescript expected ~6.0.3, found 5.9.3
minor mismatch: react-native-safe-area-context expected ~5.11.1, found 5.10.1
13 patch mismatches: expo 58.0.19 vs ~58.0.23, expo-router 58.0.26 vs ~58.0.30, react-native 0.88.0 vs 0.88.1,
  @expo/ui, expo-constants, expo-file-system, expo-font, expo-image, expo-linking, expo-splash-screen,
  expo-system-ui, expo-web-browser, react-native-screens
```

**Step 11, pgTAP (9 failures; a bug in the tests, not the product):**
```
05_whatsapp.test.sql
# Failed test 17: "due rows are claimed"                                       have: 0          want: 2
# Failed test 18: "claim decrypts the phone and reports the 24h window and opt-in"  have: NULL  want: +919444000001/true/true
# Failed test 19: "customer 3 has not opted in"                                 have: NULL       want: false
# Failed test 21: "sent rows are marked sent"                                   have: pending    want: sent
# Failed test 22: "sent customer messages appear in the conversation"           have: 0          want: 1
# Failed test 23: "a failed send is retried later (backoff)"                    have: pending/0  want: pending/1
# Failed test 24: "after 5 attempts it is marked failed"                        have: pending    want: failed
# Failed test 25: "delivery statuses never go backwards"                        have: NULL       want: read
# Looks like you failed 8 tests of 54
07_acquisition.test.sql
# Failed test 76: "the outbox worker gets the lead's number"                    have: NULL       want: +919861999003
# Looks like you failed 1 test of 76
Files=13, Tests=882 ... Result: FAIL
```

**Cause:** the tests mix the real clock with the simulated one.
- `supabase/tests/05_whatsapp.test.sql:96-102` sets `app.now` to 2026-11-02 21:10 IST, then inserts outbox rows with `send_after = now() - interval '1 day'` using the real clock.
- In `07_acquisition` the `lead_welcome` row takes its `send_after` from the column default `now()` (`daily_engine.sql:193`).
- `wa_claim_outbox` claims only rows with `send_after <= private.now()` (`acquisition.sql:774`). Once the real date passed about 3 November, those rows never come due.

**Proof:** copies of the two files using `private.now()` passed 54/54 and 76/76. Production is unaffected, because `private.now()` equals `now()` there.

**Step 12, integration tests on Node 20 (every suite that talks to the API fails the same way):**
```
FAIL  m1.test.ts > M1 test 1: kitchen A staff cannot see kitchen B, including via the API directly
Error: Node.js detected but native WebSocket not found.
Suggested solution: Ensure you are running Node.js 22+ or provide a WebSocket implementation via the transport option.
 ❯ WebSocketFactory.getWebSocketConstructor @supabase/realtime-js@2.118.0/src/lib/websocket-factory.ts:159:11
 ❯ RealtimeClient._initializeOptions @supabase/realtime-js/src/RealtimeClient.ts:826:63
 ❯ new SupabaseClient @supabase/supabase-js@2.118.0/src/SupabaseClient.ts:387:26
 ❯ createClient @supabase/supabase-js/src/index.ts:66:10
 ❯ anonClient helpers.ts:29:10
 ❯ loginAs helpers.ts:34:18
(the same error for m2, m3, m4, m5, m6, m7, m8 and p5p6)
 Test Files  9 failed | 8 passed (17)
      Tests  1 failed | 80 passed | 40 skipped (121)
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @tiffin/integration-tests@0.0.0 test: `vitest run`
```

**Cause:** `package.json:5-7` declares `engines.node >=20` and CLAUDE.md says "Node 20+". But supabase-js 2.118 needs Node 22+ for WebSocket, and Expo SDK 58, React Native 0.88, metro and vitest 5 all need `^22.13`. On Node 22 or later, all 121 tests pass.

**Step 17, offline-customer flow:**
```
create_customer with p_consent=false -> HTTP 400 consent_required
  (supabase/migrations/20261027000300_customers_plans.sql:381-383; require_role '{owner}' at :380)
```
What else this run showed:
- With consent ticked, every step worked.
- After a cancel from 12 Nov followed by `refund_unused_meals`, the subscription showed status `suspended` with `end_date` 2026-11-11 instead of `cancelled`, and its future orders were gone.
- `payment_receipt` and `refund_notice` were queued as pending WhatsApp messages for a customer who never opted in.

**Step 18, address change (product bug, high):**
```
orders before: Nov 7, 9, 10, 11, 12 on OLD address
permanent change from 2026-11-11 -> preview "affected" = [11-11, 11-12]
orders after: all 5 on NEW address  (Nov 7, 9, 10 should have stayed on OLD)
```
**Cause:**
- `private.apply_change` sets `subscriptions.address_id` at once when no end date or slot is given (`daily_engine.sql:737-739`).
- The refresh trigger (`daily_engine.sql:779`) then re-runs `refresh_orders`.
- `refresh_orders` falls back to `s.address_id` for dates before the change (`p5.sql:378`).

**Reachable from:** the vendor UI (`apps/web/src/app/(app)/customers/[id]/subscription-actions.tsx:67-75`) and the customer page (`apps/web/src/app/c/[token]/portal-client.tsx:119`).

**Not run:**
- Anything against a hosted Supabase project or a real Razorpay, Meta, SMS or Anthropic account.
- Any native Android or iOS build, or any real device.
- Deno typecheck of the Edge Functions (deno is not installed).

---

## Security

### Git-history secret scan

Two independent scans looked at all 44 commits on all 18 refs (14 remote branches, `master`, `HEAD` and 2 tags), including deleted files (none were ever deleted).

**Scan 1 (an audit agent):**
- Ran `git log --all -p`, about 77,000 patch lines.
- Patterns: `sk_live`, `rzp_live`, `key_secret`, `EAAG`, `sk-ant-`, `AIza`, `ghp_`, `github_pat_`, `AKIA`, `sbp_`, `whsec_`, `BEGIN PRIVATE KEY`, plus `.p8`/`.p12`/`.jks`/`.keystore`/`google-services` file names.

**Scan 2 (my own, written for this report):**
- Covered AWS, Razorpay, Anthropic, OpenAI-style, GitHub, Google API, private-key blocks, JWTs (decoded to read their issuer), Meta tokens, Slack, Twilio SIDs, new-style Supabase keys, hosted `*.supabase.co` URLs, Sentry DSNs, Expo tokens, generic `secret/password/token = "…"` assignments, and any sensitive filename.
- Values were never printed.

**Result: no real secret has ever been committed. Nothing to rotate.**

What the scans did find, all of it harmless:

| What | Where (commit) | Verdict |
|---|---|---|
| JWT with `iss=supabase-demo`, `role=service_role` | `supabase/seed.sql:352` (6642eef) | The public default key of every local Supabase stack. Not a secret. |
| Vault keys `local-dev-phone-*-NOT-FOR-PRODUCTION` | `supabase/seed.sql:11-12` | Local placeholders. **Must never be applied to a hosted project** (see below). |
| `local-dev-*` values | `supabase/functions/.env.example:6,14,15,27,28` | Placeholders. But `OPERATIONS.md` points at this file as the source for production secrets, and the code would accept these guessable values. |
| Dummy Twilio credentials (`auth_token = "local-dev-dummy"`) | `supabase/config.toml:307-313` | Placeholder |
| `openai_api_key`, Apple `secret` | `supabase/config.toml:102,345` (31fec69) | `env(...)` references, not values |
| `rzp_live_abc` / `rzp_test_abc` | `tests/integration/razorpay-shared.test.ts` (93508de) | Test fixtures for the live-key guard |
| Fake Sentry DSN | `tests/integration/monitor.test.ts` (28ab30c) | Test fixture |
| `BEGIN PRIVATE KEY` | `.github/workflows/ios-testflight.yml:63` | A grep string, not a key |
| Sensitive file names | only `.env.example` files ever committed | No `.env`, keystore, `.p8`, `.p12` or `google-services.json` was ever committed. `.gitignore:12-32` covers them. |

On GitHub, secret scanning and push protection are **on**. Dependabot security updates are **off**, and no branch is protected.

### Other security findings (not secrets)

| Severity | Finding | Evidence | Status |
|---|---|---|---|
| High | On a hosted project with no Razorpay key, payments fall back to mock mode. The public `razorpay-mock` page then sends a correctly signed "paid" webhook and **credits meals for free** once any payout account is marked verified. `OPERATIONS.md` says to deploy that page. | `supabase/functions/_shared/razorpay.ts:20,122-127`, `supabase/functions/razorpay-mock/index.ts:25-46`, `supabase/config.toml:441-442`, `docs/OPERATIONS.md:19` | Verified |
| High | Phone confirmations are off and signup is open in the local config. If the hosted project matches, someone can sign up with phone + password, the phone counts as confirmed with no code, and `claim_invites` hands them a pending staff or rider invite. | `supabase/config.toml:261,263`, `tenancy.sql:341-345` | Follow-up, spot-checked |
| High | There is no owner phone change, account recovery or session revoke. A lost or recycled owner SIM means losing the kitchen, or a stranger taking it over. | no `updateUser` or transfer RPC anywhere | Follow-up, spot-checked |
| High (Phase 2) | When a customer's phone number is reassigned, the WhatsApp conversation stays linked to the old customer. The new holder can see their balance, skip or pause their meals and get a 7-day link to their page. | `whatsapp.sql:298-302,345,399,497-501` | Verified, corrected (narrower trigger) |
| High | Customer erasure is undone by the append-only audit log, which keeps name, address, GPS and health tags. Conversation phone numbers are never cleared. | `foundation.sql:87-125`, `customers_plans.sql:446-470`, `p5.sql:1688-1692` | Verified |
| Medium | `seed.sql` and `config.toml` would plant the known dev Vault keys, the demo service-role JWT and test OTP logins (including the admin number) if they were ever applied to a hosted project, through `db reset --linked`, `db push --include-seed` or `config push`. | `seed.sql:11-12,351-363`, `config.toml:273-287` | Follow-up, spot-checked |
| Medium | CI supply chain: the job has `contents: write`, checkout keeps its token, a `:latest` third-party Android image runs with the repo and the keystore mounted, and actions are pinned only to major tags. | `.github/workflows/android-apk.yml:20-21,30`, `apps/mobile/scripts/build-apk.sh:14,44,89-92` | Not verified (medium) |
| Medium | The App Store Connect API key is requested with the **Admin** role. App Manager is enough. | `.github/workflows/ios-testflight.yml:8`, `docs/RELEASE.md:116` | Not verified (medium) |
| Medium | Public forms have no CAPTCHA or IP limit and can trigger WhatsApp messages to any number. `lead_choose` reveals whether a phone number exists. | `acquisition.sql:1552-1553` | Not verified (medium) |
| Medium | Customer magic links cannot be revoked, and every new link adds another live token. | `whatsapp.sql:956-971` | Not verified (medium) |
| Medium | The delivery OTP, hidden by column grants, can still be read through `audit_log` and the outbox. | `foundation.sql:96-125` | Follow-up, not verified |
| Low | No security headers, so admin pages can be framed. `whatsapp-outbox` can be triggered by anyone holding the anon key. Sentry tags carry raw error text. | apps/web config; `supabase/functions/whatsapp-outbox` | Not verified (low) |
| Low | `pnpm audit --prod`: 0 critical, 7 high, 5 moderate, 4 low. All are under `expo > @expo/cli`, which is build-time tooling. Nothing is in the web runtime. | lockfile | Audit agent |
| Info | The repo is **public**. Commit messages carry claude.ai session URLs, two commits carry a local author email, `docs/SECURITY.md` lists open findings publicly, and there is no LICENSE. | GitHub API | Audit agent |

Nothing in this report includes a secret value.

---

## Verified vs. refuted

### Numbers

| | Count |
|---|---|
| Defects reported by the 11 readers and walkthroughs | 215, of which 67 critical/high and 148 medium/low |
| Exact-title duplicates removed | 0. But many are the same issue reported by several readers; for example, the prepaid suspension was reported 6 times. This report merges them. |
| Critical/high findings sent to skeptics (13 got 3 votes, 54 got 2) | 67 |
| **Refuted (a majority voted "not real")** | **0** |
| Confirmed by every skeptic | 24 |
| Confirmed with corrections (at least one "partially confirmed") | 43 |
| Severity lowered by majority | 22 (8 critical → high, 14 high → medium) |
| Medium/low findings kept without verification | 148 |
| Follow-up defects (5 deep dives, after the verification stage) | 69 (8 critical, 25 high, 28 medium, 8 low). Not verified by the panel. I checked the six most important in the code myself. |

**Nothing was dropped as false.** When several reports of the same issue disagreed on severity, this report takes the majority severity of the strongest instance:
- The prepaid suspension is Critical, by majority on two of its six reports.
- The OTP login gap is Critical, by majority on two of its five reports.

### Corrections that changed what a finding means

| Finding | What the skeptics corrected |
|---|---|
| No production OTP channel | It is **configuration, not missing code**. A provider Supabase supports natively, enabled in the hosted dashboard, makes login work with no code change. Only a WhatsApp-OTP hook would need code. A closed pilot can bridge with dashboard test numbers. Critical → high on 3 of 5 reports. Still a launch blocker. |
| Prepaid suspension | It is worse than reported: suspension can happen **before the first meal**, at any sync. There is a workaround: the owner can raise the kitchen-wide credit limit and grace period in web Settings, but then every monthly customer sits permanently in "low balance". |
| Rider queue drops actions | Confirmed. The list of temporary errors that trigger it is longer than reported: PGRST000/001/002 (503 and schema cache), 57014 (timeout), 28000/42501 (anon fallback after a failed token refresh) and PGRST301/303 (JWT). Critical → high by 2 of 3. The release-safety follow-up rates it critical again, because a migration can trigger it. |
| Dues at the current price | It is not *silent* loss: the web form lets the owner override the number of meals. The issue holds clearly when lunch and dinner are priced differently, and less strongly for price changes over time. |
| "Code sent" hint to riders | The cause is that rider_today counts **pending rows as sent**, not a missing opt-in check. The worker already cancels rows for customers who have not opted in. |
| Outbox has no expiry | A backlog builds **only if the outbox worker is not running**. In mock mode it marks rows "sent" every minute, which is the real Phase 1 problem: alerts look delivered. High → medium. |
| Mock payment page | Payment links are blocked until an admin marks a payout account verified, so the free-meal hole opens only after that admin action. One report stays high, one went to medium. |
| Customer actions not two taps | True for the **web** dashboard. The **mobile** owner app already has one-tap skip, pause and resume chips plus Confirm. High → medium. |
| Rider sent to login after an offline restart | Confirmed. But `startAutoRefresh()` is **not** the fix: auth-js already starts it in React Native. Also, when the network returns, memberships are not reloaded. |
| Owner who delivers sees nothing | There is a one-time web workaround: create a route for each slot with yourself as default rider, before the first lock. |
| Late skip of a locked meal | Overstated for the web: the owner can post a separate manual credit. That credit is not linked to the meal, and it is worth 0 for valuation. |
| Suspended customers vanish | The vendor can fix it on the phone by recording cash with the chips, and a partial "Customers at risk" card exists. There is still no alert and no status shown. |
| `accepts_platform_leads = true` | It only matters after an admin marks a kitchen active, because kitchens start in draft. High → medium. It is still a dangerous default. |
| Phone reassignment over WhatsApp | The trigger is narrower: the vendor has to register another customer under the old number. |
| Owner-only actions | This is deliberate, per SPEC.md:31 and D-022, so changing it is a product decision. Riders *can* record cash at the door; it stays pending. |
| Backups | The docs do name Supabase daily backups or PITR as the primary safeguard. The real gaps are a hosted restore runbook and storage objects (photos), which no backup covers. High → medium. |
| No month-end statement | The gap is confirmed. The impact was overstated, because a weekly register and a per-payment receipt exist. |
| No Odia | This is the documented pending decision D-006, not an oversight. High → medium. |
| Route money model | It does not block Phase 1, because no online payments are taken. High → medium. |
| No CI | Confirmed by both votes, with severity set to medium. This report keeps it high in the work order, because every Phase 1 change depends on it. |

The other 24 findings were confirmed exactly as written. The full reasoning of every vote is in the raw result file kept with the founder's local research folder (`docs/audit-2-raw.json` in "southeast Mealbox", not in this repo).

### Follow-up claims I checked in the code

| Claim | Result |
|---|---|
| `run_due_locks` locks every kitchen inside one transaction, with no error handling per kitchen; catch-up starts from `v_today - 1` | ✔ `money.sql:377-405` |
| Cancelling a subscription locks and charges the kitchen-wide slot for any of its unlocked slots already past cutoff | ✔ `money.sql:339-358` |
| Run-building and stock failures inside a lock are only `raise warning` | ✔ `delivery.sql:633`, `inventory.sql:333` |
| Phone confirmations off, signup open | ✔ `config.toml:261,263` |
| No phone-change or ownership-transfer flow | ✔ no `updateUser`, transfer or phone-change code anywhere in apps, functions or migrations |
| `seed.sql` creates the dev Vault keys and the demo service-role JWT | ✔ `seed.sql:11-12,351-363` |

**Not checked:**
- The storage-growth numbers (a simulation on a throw-away Postgres; the photo sizes are estimates).
- The Supabase plan quotas (confirm them on supabase.com/pricing).
- The OTA and APK-tag analysis.

---

## Recommended work order

The order is smallest first, adjusted only where one item depends on another. Item 9 is a founder action rather than code. Each item names the founder decision it needs (if any), the files it touches and how to test it.
- **Size:** S is under half a day, M is 1–3 days, L is more than 3 days.
- **P1-blocker** means a pilot cannot run without it.

Everything that changes the database comes with pgTAP tests, and existing suites stay green. Once item 3 exists, every change goes through it.

### Base (no product behaviour change)

1. **Pin Node 22.** S.
   - *Files:* `.nvmrc` (new: `22`); `package.json:5-7` (`engines.node` `>=22.13`); `CLAUDE.md` (the "Node 20+" line); `apps/mobile/scripts/ios-testflight.sh:16`.
   - *Test:* `nvm use && pnpm test:integration` passes 121/121. `pnpm lint` stops printing Expo's Node warning.
2. **Fix the date-dependent database tests.** S.
   - *Files:* `supabase/tests/05_whatsapp.test.sql:96-103` and `supabase/tests/07_acquisition.test.sql:301-302`: use `private.now()`. Optionally, a new migration making the `notifications_outbox.send_after` default `private.now()` (`daily_engine.sql:193`). Grep every test for other `now()` / `app.now` mixes.
   - *Test:* `pnpm db:test` passes 882/882. Move `app.now` one month later and it still passes.
3. **CI.** S. Needs items 1 and 2.
   - *Files:* `.github/workflows/ci.yml` (new). It runs on `push` and `pull_request` (never `pull_request_target`, no secrets), with Node 22, a frozen install, typecheck, lint, core tests, `supabase start`, `supabase db reset`, `supabase test db` and `pnpm test:integration`. Also drop the `apk/**` and `ios/**` branch triggers (`.github/workflows/android-apk.yml:19`, `ios-testflight.yml:17`).
   - *Test:* a draft PR is green. A deliberately broken test turns it red.
4. **Never deploy the mock payment page.** S.
   - *Files:* `docs/OPERATIONS.md:19` (remove razorpay-mock and use an explicit function allowlist); `supabase/functions/razorpay-mock/index.ts:25-26` (return 404 unless `SUPABASE_URL` is local).
   - *Test:* integration m3 still passes locally. With a non-local `SUPABASE_URL` the function answers 404.
5. **Remove "Starts as Trial" from the vendor add-subscription form.** S.
   - *Files:* `apps/web/src/app/(app)/customers/[id]/add-subscription.tsx:55-59`.
   - *Test:* typecheck. A new subscription is created `active`.
6. **Remove UI text that promises things Phase 1 will not do.** S.
   - *Files:*
     - `apps/web/src/app/(app)/customers/[id]/money-panel.tsx:214` ("receipt is sent on WhatsApp")
     - `apps/web/src/app/(app)/money/page.tsx:103-104` ("reminders on day 1, 3 and 7")
     - `apps/web/src/app/(app)/menu/specials/special-form.tsx:15,35`
     - `apps/web/src/app/(app)/customers/[id]/subscription-actions.tsx:155`
     - `apps/web/src/app/(public)/vendors/page.tsx:11-18,30,42`
   - *Test:* look at each page.
7. **Safe defaults migration.** S.
   - *Files:* a new migration with:
     - `kitchens.accepts_platform_leads` default **false**, plus backfill (`acquisition.sql:20`)
     - `kitchen_settings.auto_credit_first_complaint` default **false**, plus backfill (`p5.sql:47`)
   - *Test:* a new pgTAP check that a new kitchen has both false. Tests 07 and 10 now switch the flag on where they need it, instead of off (`07_acquisition.test.sql:11`, `10_lead_channels.test.sql:8`).
8. **Rider proof for offline customers.** S.
   - *Files:*
     - a new migration redefining `rider_today` so that `otp_sent` counts only rows with status `sent` (`p6.sql:1299-1300`)
     - `apps/mobile/src/app/stop/[id].tsx:220-225` and `apps/web/src/app/(field)/rider/rider-app.tsx:256,450-461`: Photo / Delivered becomes the main action, and the OTP field shows only when a code was sent
     - `apps/mobile/src/i18n/en.ts:193,210-211` (wording)
   - *Test:* pgTAP 06 with a pending outbox row gives `otp_sent = false`. The rider screen shows Delivered first.
9. **Stop-gap pilot settings (founder action, not code).** Until item 20 lands, set each pilot kitchen's credit limit to about 120 meals and grace to about 60 days, in web Settings (`apps/web/src/app/(app)/settings/settings-form.tsx:128-129`).
   - *Limitation:* every monthly customer will then show as "low balance". This does **not** fix the dinner late rule, which needs item 11.
   - *Test:* a zero-balance customer is still in tomorrow's count after the lock.
10. **Mock modes fail closed.** S–M.
    - *Files:*
      - `supabase/functions/_shared/razorpay.ts:20` and `supabase/functions/_shared/whatsapp.ts:21`: throw on mock when the new `PLATFORM_ENV` secret is not `local`
      - `_shared/whatsapp.ts:156` and `supabase/functions/whatsapp-outbox/index.ts:52-53`: record mock sends as `mock`, not `sent`
      - `supabase/functions/notebook-import/index.ts`: refuse when no AI key is set, instead of returning fixture customers
      - `supabase/functions/.env.example` (add `PLATFORM_ENV`, and mark every value "local only")
    - *Test:* integration passes with `PLATFORM_ENV=local`. With `PLATFORM_ENV=staging` and no keys, a payment link returns 503 `payments_not_configured`, notebook import refuses, and no outbox row is marked `sent`.

### Phase 1 correctness

11. **Vendor-entered changes use the real slot cutoff; mobile gets a waive toggle.** S–M. Needs decision 2. P1-important.
    - *Files:*
      - a new migration making `phone_pause_close_time` nullable with default null (`tenancy.sql:51`, grant `:453`)
      - redefine the lateness rule in `private.apply_change` (`daily_engine.sql:686-690`)
      - `apps/web/src/app/(app)/settings/settings-form.tsx:98`
      - `apps/mobile/src/app/customer/[id].tsx:56-58,67-69,190-192`
      - update `supabase/tests/03_daily_engine.test.sql:137-163`
    - *Test:*
      - A vendor skip of the same day's dinner at 09:00 is not charged.
      - At 12:01 it is late.
      - A lunch skip at 20:00 the evening before is not charged.
12. **Lock job: errors handled per kitchen, a longer catch-up, recorded failures.** M. P1-blocker.
    - *Files:*
      - a new migration redefining `private.run_due_locks` (`money.sql:377-405`) with a `begin … exception` block around each kitchen and a catch-up window of a few days
      - a new `engine_errors` table
      - write the build_runs and stock failures there (`delivery.sql:623-640`, `inventory.sql:332-333`)
      - make the cancel trigger lock only the cancelled subscription's own slots (`money.sql:339-358`)
    - *Test:*
      - A kitchen with deliberately bad data fails, and the others still lock, with an `engine_errors` row recorded.
      - A simulated 3-day outage locks each missed slot once.
      - Cancelling one subscription does not charge other customers for an old slot.
13. **Outbox expiry and a gate for customer messages, plus the phase-flag keys.** M.
    - *Files:* a new migration with:
      - `notifications_outbox.expires_at` (`daily_engine.sql:183-198`)
      - `wa_claim_outbox` skipping expired rows (`acquisition.sql:759-780`)
      - the `route_outbox_to_payer` BEFORE INSERT trigger extended to cancel customer, lead and vendor_application rows while `customer_whatsapp` is off (`p5.sql:130-164`)
      - new `platform_settings` keys, all false: `customer_whatsapp`, `customer_portal`, `online_payments`, `marketplace`, `growth`, `extras` (`p6.sql:203-215`)
      - growth crons check their flag: `tiffin-growth`, `tiffin-ad-conversions`, `tiffin-tomorrow-nudge`, `tiffin-escalate-complaints`, and the customer part of `tiffin-weather`
    - *Test:*
      - A receipt for an offline customer comes out `cancelled / customer_messages_off`.
      - A member alert stays `pending`.
      - An expired row is never claimed.
14. **Address fixes.** M. P1-important (riders go to the wrong address).
    - *Files:*
      - `private.apply_change` (`daily_engine.sql:731-740`): do not move `subscriptions.address_id` before the from-date
      - the `refresh_orders` fallback (`p5.sql:378`)
      - `apps/web/src/app/(app)/customers/[id]/address-manager.tsx:56`: "make default" offers to apply the change
      - the first address backfills the customer's subscriptions
      - address fields in `apps/mobile/src/app/customer/new.tsx:40-50`
    - *Test:*
      - A pgTAP version of the test-run scenario: a move dated 11 Nov leaves 7–10 Nov on the old address.
      - "Make default" then apply moves future meals.
15. **Undo a specific skip or pause; Resume honours its end date.** M.
    - *Files:*
      - `private.active_hold` (`daily_engine.sql:253-276`): honour `to_date` and add a `revoke` change type
      - `apps/web/src/app/(app)/customers/[id]/subscription-actions.tsx:56-59,136-138`: list upcoming holds with Undo
      - mobile chips
    - *Test:*
      - A pause from 20 Nov to 5 Dec, recorded on 1 Nov, is undone on 6 Nov, and 20 Nov–5 Dec are delivered.
      - Undoing one skip does not end another pause.
16. **Reactivate a cancelled subscription.** S–M.
    - *Files:*
      - a new RPC `reactivate_subscription` (see `daily_engine.sql:643-645`, `money.sql:283-284`)
      - a button on the web customer page and on mobile
    - *Test:* cancelled → reactivated, orders regenerated, an event logged.
17. **Kitchen closure days and weekly off per slot.** M. P1-important (festivals).
    - *Files:*
      - a new `kitchen_closures(date, slot null)` table
      - redefine `refresh_orders` (`p5.sql:356-450`) and `lock_slot` (`daily_engine.sql:471-521`)
      - a "Closed tomorrow" action on Today (web `(app)/page.tsx`, mobile `(tabs)/index.tsx`)
      - weekly off for each slot in `settings-form.tsx:109-122`
    - *Test:*
      - A closure date generates no orders and no charges.
      - Removing the closure brings the orders back.
      - "Sunday dinner off" works.
18. **Changes after lock reach the runs and the rider.** M. P1-important.
    - *Files:*
      - the end of `private.apply_change` (`daily_engine.sql:756`) calls `build_runs` for locked dates
      - `build_runs` (`p6.sql:1124-1232`) updates pending stops on `out` runs and fixes the office ON CONFLICT double hit (`p6.sql:1210-1216`)
      - `rider_today` (`p6.sql:1290-1320`) gets a `changed` flag
      - both rider apps show it
    - *Test (pgTAP 06):*
      - A late skip after lock removes the pending stop.
      - An address change updates the stop.
      - A billing customer with their own order to the office address still builds runs.
19. **Skip a locked meal with "charge / don't charge".** M. Needs items 11 and 18.
    - *Files:*
      - the charged logic in `private.apply_change` (`daily_engine.sql:706`)
      - an idempotent credit linked to the meal_order
      - mobile shows locked meals as chips (`apps/mobile/src/app/customer/[id].tsx:157-158`)
    - *Test:*
      - "Don't charge" posts exactly one credit, even on retry.
      - The stop leaves the run.

### Phase 1 money and roles

20. **Billing mode for each customer, with a rupee ledger.** L. Needs decisions 1 and 8. P1-blocker. This is the biggest Phase 1 item.
    - *Files:*
      - `customers.billing_mode` and `kitchen_settings.default_billing_mode`
      - `private.sync_balance_status` (`money.sql:210-245`) and `private.nightly` (`money.sql:409-438`): no suspend or cancel for monthly customers
      - `private.dues` (`money.sql:510`) and `private.customer_unit_price` (`money.sql:132-143`): rupees from `amount_paise`
      - `record_payment` (`money.sql:737-781`) and the rider cash path (`p5.sql:1795-1799`)
      - import (`money.sql:984-1155`)
      - `refund_on_cancel` (`money.sql:339-372`) behind a setting
      - web add-subscription and money screens, mobile customer screens
      - `supabase/tests/04_money.test.sql:204-223`
      - `supabase/seed.sql:246-252`: add zero-balance monthly customers so the demo shows real behaviour
    - *Test (pgTAP):*
      - A monthly customer with no payments stays active for 31 days, with dues = Σ `amount_paise`.
      - Lunch at ₹60 and dinner at ₹40 are billed correctly.
      - A price change mid-month only affects later meals.
      - Paying the exact dues leaves 0 owed, and the customer stays active.
      - A prepaid customer still suspends when the kitchen opts in.
21. **Monthly statement, CSV exports and the register built on the server.** M. Needs item 20.
    - *Files:*
      - a new RPC `customer_statement(customer, month)` modelled on `office_statement` (`p6.sql:729-774`)
      - a new `/print/statement` page with a wa.me share link
      - "Bills for this month" on Money
      - CSV RPCs (payments by date range, dues aging, rider cash)
      - a register RPC replacing the direct query in `apps/web/src/app/print/register/page.tsx:19-20`
    - *Test:*
      - The statement reconciles with the ledger.
      - The register for 180 customers × 2 slots × 7 days, which is more than 1,000 rows, is complete.
22. **Void, backdate and idempotency for payments, purchases and waste.** M.
    - *Files:*
      - `record_payment` (`money.sql:737-781`): `p_client_op` and `p_paid_at`
      - a new `void_payment(payment, reason)` that reverses the balance entries
      - the same idempotency for `record_purchase` and `record_waste` (inventory)
      - web and mobile buttons
    - *Test:*
      - The same key twice creates one payment.
      - A void restores the balance, with an audit row that carries the reason.
23. **Manager and accountant roles; requests recorded by riders.** L. Needs decision 3. P1-blocker.
    - *Files:*
      - the role enum (`foundation.sql:27`)
      - `private.require_role` callers (`daily_engine.sql:885`; `customers_plans.sql:237-262,380,414`; `money.sql:760,828,877`) and the RLS policies
      - `invite_member` (`tenancy.sql:279-322`)
      - web nav (`apps/web/src/app/(app)/layout.tsx:15-37`), `customers/new/page.tsx:7`, `customers/[id]/page.tsx:176,220`, `money/page.tsx:18`
      - mobile role checks (`apps/mobile/src/app/customer/[id].tsx:22,40-42,120,155`; `(tabs)/customers.tsx:39`)
      - a new `rider_request_change` RPC on channel `rider` (`daily_engine.sql:62`)
      - alerts sent to managers too (`notify_owners`, `whatsapp.sql:122`)
    - *Test:*
      - pgTAP for each role in `01_rls` and `02_rpcs`.
      - Integration: a manager records a skip and cash, and an accountant can read money but not write.

### Phase 1 riders and screens

24. **Rider queue never loses data.** L. P1-blocker.
    - *Files:*
      - `apps/mobile/src/lib/rider-store.ts:104-109,181-254,293` and `apps/web/src/lib/rider-store.ts:265-333`:
        - only the listed business errors are final
        - everything else is retried with backoff
        - a refused action moves to a saved "needs attention" list with its photo and cash
        - `act()` returns once the action is saved locally
      - `apps/mobile/src/lib/supabase.ts:8-11`: a fetch with a timeout
      - `apps/mobile/src/lib/session.tsx:58-67` and `apps/mobile/src/app/_layout.tsx:20-30`: stay signed in while offline, and reload memberships on refresh
      - block sign-out while the queue is non-empty
      - resize photos in `apps/mobile/src/app/stop/[id].tsx` and upload them separately
      - sync on reconnect, not only on the Rider tab
      - a new `rider_sync_rejects` table
    - *Test:*
      - Unit tests (`tests/integration/rider-queue`) for 503, PGRST301, PGRST002, 57014 and 413: the action is kept every time.
      - On a real phone: data off for 65 minutes, the app killed and restarted, and rider mode opens from cache with the queue intact.
25. **Default rider, routes by area, owner tools on the live board.** M–L.
    - *Files:*
      - `private.route_for_address` (`delivery.sql:432-477`): fall back to the owner
      - `rider_today` (`p6.sql:1306-1312`): show unassigned runs to owners
      - a bulk assign-by-area RPC, plus a Route column in import
      - an owner RPC to correct a stop
      - kitchen-fault credits recorded by a rider go to the owner for approval (`do_fail_stop` in `p6.sql`)
      - a cash handover view for each rider
    - *Test (pgTAP 06):*
      - In a kitchen with no rider, the owner sees the runs.
      - 180 imported customers split by area into 3 routes.
26. **App version identity, a minimum-version gate and stable signing.** M. Needs the keystore secret (founder). P1-blocker for the signing part.
    - *Files:*
      - an `x-app-version` header in `apps/mobile/src/lib/supabase.ts:8-11`
      - a minimum version in `platform_settings`
      - an "update required" guard in `apps/mobile/src/app/_layout.tsx` that sends the queue first
      - `.github/workflows/android-apk.yml:41-46`: fail, don't warn, on tag builds without the keystore
      - the version-bump rule in `apps/mobile/app.json`
      - `docs/RELEASE.md:44`: add `--environment production` to `eas update`
    - *Test:*
      - Two APKs built with the same key upgrade in place and keep the queue.
      - An old build sees "update required" only after its queue has been sent.
27. **Phase flags in the UI.** M. Needs item 13.
    - *Files:*
      - `apps/web/src/lib/session.ts:22-48` reads the flags
      - `apps/web/src/app/(app)/layout.tsx:15-37` filters the nav
      - gated pages call `notFound()`: inbox, insights, `/find`, `/kitchens`, `/k/[slug]`, `/vendors`, `/c/[token]`, `/menu/specials`
      - settings `listing-form.tsx` and `care-form.tsx`, and the customer-page cards
      - admin nav `apps/web/src/app/admin/admin-nav.tsx:6-18`
      - mobile `(tabs)/_layout.tsx:19-20` and the home cards `(tabs)/index.tsx:37-68`
      - `apps/web/src/lib/checklist.ts:6,11,14`
      - RPCs through `private.require_feature` (`p6.sql:227-239`)
    - *Test:*
      - With every flag off, the public pages return 404, inbox and payment links are hidden, and gated RPCs raise `feature_disabled`.
      - With the flags on, the existing integration suites still pass.
28. **Mobile parity, a web "phone desk", proper lists.** L. Needs items 20–23.
    - *Files:*
      - `apps/mobile/src/app/customer/new.tsx`: address, billing mode or opening balance, diet
      - `apps/mobile/src/app/customer/[id].tsx`: cancel, address, any-amount Cash/UPI/Bank, waive, status badge, confirm rider cash
      - new dues and settings screens
      - offline and error states with cached data (`sheet.tsx`, `(tabs)/customers.tsx`, `(tabs)/index.tsx`)
      - a new web phone-desk page
      - customer list paging, filters and the real total (`apps/web/src/app/(app)/customers/page.tsx:11,18`; `search_customers` at `customers_plans.sql:474-510`)
    - *Test:*
      - Run Sujata's week by hand on a low-end Android phone.
      - Integration tests for any new RPCs.
29. **Owner notifications without WhatsApp.** M. Needs an EAS build.
    - *Files:*
      - expo-notifications in apps/mobile
      - a `member_devices` table
      - a push sender for outbox channel `push` (`daily_engine.sql:186`)
      - an in-app notifications list
    - *Test:*
      - A completed lock produces a push on a real phone.
      - Mock WhatsApp no longer counts as delivered.
30. **Make engine health visible.** M. Needs item 12. P1-blocker.
    - *Files:*
      - a heartbeat table and health function
      - a new `ops-health` Edge Function for a free uptime pinger
      - an engine tile on `apps/web/src/app/admin/page.tsx`
      - a "count not frozen" banner with "Freeze now" (`apps/web/src/components/slot-card.tsx:20-27`, `apps/mobile/src/components/slot-card.tsx:25-29`)
    - *Test:* unschedule the lock cron locally. After the cutoff the banner shows, and `ops-health` returns 503.

### Go-live readiness

31. **Retention, a smaller audit log and real erasure.** M–L. A P1-blocker on Supabase Free; important on Pro.
    - *Files:*
      - `private.audit_row` (`foundation.sql:96-125`): store only changed keys for personal-data tables, and skip rider pings
      - purge jobs for `cron.job_run_details` and old outbox rows
      - storage retention for proof photos
      - `erase_customer` (`customers_plans.sql:446-470`) and `customer_erased_cleanup` (`p6.sql:879-891`) also scrub `audit_log`, conversations and `import_rows`
    - *Test:*
      - After an erase, no name or address for that customer remains in `audit_log`.
      - A rerun of the growth simulation shows the audit volume down.
32. **Hosted deploy script, backups and a restore runbook.** M. Needs the founder's Pro plan and projects. P1-blocker.
    - *Files:* `scripts/deploy.sh` (new: migrations, function allowlist, secret and Vault checks); `scripts/restore-drill.sh:7-27` (take a `DB_URL`); `docs/OPERATIONS.md`.
    - *Test:*
      - A clean deploy to staging works.
      - A restore drill into a staging copy works.
      - `decrypt_phone` works afterwards, and `cron.job` has rows.
33. **Legal wiring.** S–M. Needs the founder's legal text. P1-blocker before any outside vendor.
    - *Files:*
      - `apps/web/src/components/legal.tsx:5-20`
      - `apps/web/src/app/(public)/privacy/page.tsx:64-81`, plus the terms page
      - `NEXT_PUBLIC_GRIEVANCE_CONTACT` required in production builds
      - vendor terms and DPA accepted at onboarding, recorded in `consents`
    - *Test:*
      - A production build fails without the grievance contact.
      - Onboarding records the acceptance.
34. **Founder support tools.** L.
    - *Files:*
      - admin RPCs for: owner phone change (audited, with a reason), adding a co-owner or manager, voiding a lock, recording a closed day, voiding a payment
      - admin kitchen view with owner and roster (`apps/web/src/app/admin/kitchens/page.tsx`; `admin_kitchens` in `admin_hardening.sql:97-127`)
      - the admin as actor, with a reason, on every admin fix
      - a real support contact in both apps
      - demo data separated from `supabase/seed.sql`
    - *Test:* pgTAP for the admin role. Every support case is rehearsed on staging.
35. **Odia (then Hindi).** M plus translation. Needs a native reviewer.
    - *Files:*
      - `apps/mobile/src/i18n/index.ts:6-11` and `apps/mobile/src/i18n/en.ts`
      - hard-coded literals in `(tabs)/index.tsx:16,78`, `components/ui.tsx:64`, `components/slot-card.tsx:33`, `(tabs)/rider.tsx:144`, `stop/[id].tsx:40`, `packages/core/src/time.ts:60-69`
      - a language picker in `account.tsx`
      - web i18n set-up
      - `create_kitchen` slug for Odia names (`tenancy.sql:224-275`)
    - *Test:* switch to Odia and walk through rider mode, Today and the phone desk.

### Before Phase 2 is switched on (after the Phase 1 pilot)

36. **Re-link the conversation when a phone changes; one conversation per customer.**
    - *Files:* `whatsapp.sql:298-302,345`; `customers_plans.sql:400-470`; a unique index.
    - *Test:* number reassignment gives the new holder nothing.
37. **Revocable magic links.**
    - *Files:* `whatsapp.sql:956-971` and the portal RPCs.
    - *Test:* after a revoke the old link returns 404.
38. **Claim the refund row before calling Razorpay.**
    - *Files:* `supabase/functions/razorpay-refund/index.ts:26-34`; `money.sql:948-975`.
    - *Test:* two calls at once produce one gateway refund.
39. **CAPTCHA and IP limits on public forms; stop `lead_choose` revealing phone numbers.**
    - *Files:* the `acquisition.sql:1552` grants; `apps/web/src/app/(public)/find`.
40. **Confirm Route payouts; apply commission on the WhatsApp payment path.**
    - *Files:* `supabase/functions/_shared/razorpay.ts:95-115`; the webhook.
41. **Separate "verified" from "listed"; recover outbox rows stuck in `sending`.**

---

## Things only the founder can do

### Decisions (they block the items noted)

1. **Billing:** monthly pay-later as the Phase 1 default, with no automatic suspend or cancel (D-002, D-048, D-056, D-024). Blocks item 20.
2. **Late rule:** vendor-entered changes follow the real cutoff. After the lock, should the default be charge or don't charge (D-031)? Blocks items 11 and 19.
3. **Roles:** a Manager role (changes, cash, confirming rider cash) and an Accountant role (read-only money). This changes SPEC.md:31 and D-022. Blocks item 23.
4. **Login channel** (D-004): SMS through a natively supported provider, with DLT registration, and test numbers only for a closed pilot.
5. **Repo:**
   - Make it private? It is public today; no secrets were found.
   - Fast-forward `master` to `34c5877` and protect it?
   - Retire the `apk-build-2` and `apk-build-3` public pre-releases?
6. **Pilot kitchen.** Suggested: your own Sundarpada kitchen first, then one home cook.
7. **Customers without their own phone**, such as siblings or elderly people on a family number: allowed or not? Blocks part of item 20.
8. **Breakfast slot** (D-007). This needs an enum migration.
9. **App name and package id** (`Tiffin OS`, `in.tiffinos.vendor`, `apps/mobile/app.json:3,12,27`). They become permanent once signed builds go out.
10. **Phase 2, later:** the Razorpay model (D-003). Route makes the platform the merchant of record; get a CA's advice on GST e-commerce-operator duties. Also autopay (D-052), the WhatsApp cost model, and the AI model and its budget.

### Accounts, keys and approvals

| What | Why | Lead time |
|---|---|---|
| **TRAI DLT registration** (entity, sender header, OTP content template), plus an **SMS provider** Supabase supports natively (Twilio / Twilio Verify, MessageBird, Textlocal or Vonage), configured in the hosted Supabase dashboard | Without it nobody can log in on a hosted project | 1–3 weeks. **Start now.** |
| Hosted auth settings: phone confirmations **on**, signup limited to invited numbers, rate limits, CAPTCHA once both apps support it, test OTP numbers removed at launch | Stops fake signups claiming invites and SMS pumping | same day |
| **Supabase Pro** (about US$25/month; confirm on supabase.com/pricing) with a **staging** and a **production** project; daily backups (PITR optional) | Free is outgrown in the first month and has no restorable backups | same day |
| **Vault secrets** in each project: `phone_encryption_key` and `phone_hash_key` (fresh random values, **kept offline in a password manager**; losing the encryption key makes every stored phone unreadable), `functions_base_url`, `service_role_key`, `public_web_url` | The database refuses to store phones without them | same day |
| `supabase secrets set` with freshly generated values, not the `.env.example` ones. Leave `RAZORPAY_ALLOW_LIVE` unset. **Never** run `supabase config push`, `db reset --linked` or `db push --include-seed` against hosted. | Keeps dev keys and test logins out of production | same day |
| **Domain and web hosting** (Vercel or a VPS) with HTTPS; set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The PWA and rider web mode need HTTPS | 1–2 days |
| **Android upload keystore**: create it once, keep it and its password in a password manager, and set `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_ALIAS`, `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` as GitHub Actions secrets | Without a stable key every update means uninstalling, which wipes rider data | same day |
| Expo environment variables on expo.dev for the `production` and `preview` environments | Store builds otherwise ship pointing at `127.0.0.1` | same day |
| Google Play Console (optional for the pilot; sideloaded APKs work). New personal accounts must run a roughly 14-day closed test. | Store distribution and managed signing | days to weeks |
| **Apple** (only if iOS is wanted for vendors): Apple Developer Program membership (US$99/year; an organisation needs a D-U-N-S number), an App Store Connect API key with the **App Manager** role (not Admin), and the `APPLE_*` / `EXPO_TOKEN` secrets. All 3 TestFlight runs failed at "Check secrets". Apple 2FA prompts can be done on this Mac. | iOS builds | about 1 week for an organisation |
| GitHub settings: private visibility (decision 5), branch protection on `master`, Dependabot security updates on | Hygiene | same day |
| **Legal:** the operator's legal name and address, a grievance officer (DPDP requirement), retention periods, a lawyer's review of `/privacy` and `/terms`, **vendor terms and a data processing agreement**, and the processor list (SMS provider, hosting, Google; Anthropic if notebook import is used) | Needed before real vendors upload customers' phone numbers | 1–2 weeks |
| **CA advice:** GST posture of the free vendor OS now; e-commerce-operator duties if Route is used in Phase 2 | Tax exposure | 1–2 weeks |
| A native **Odia** reviewer for about 150 strings (rider, Today, phone desk) | The vendor app is English-only | — |
| Optional: a Sentry project (`SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_SENTRY_DSN`) and a free uptime monitor for `ops-health` | Otherwise pilot errors are invisible | same day |
| Optional: an **Anthropic API key**, only if notebook-photo import is wanted. It sends register photos containing customer names and phones to a third party, so it must be disclosed. | Onboarding helper | same day |
| **Phase 2 only:** Razorpay account and KYC with Route activation, and written answers from Razorpay on merchant of record and Route with Subscriptions (**live keys only after your explicit approval**); **Meta Business verification**, a WhatsApp Business number and about 33 templates, including `otp_v1` | Customer payments and WhatsApp | weeks. Starting Meta verification early shortens Phase 2. |

**Not needed for Phase 1:** Razorpay, Meta and WhatsApp templates, Google or Ola maps keys, a VROOM server, Google Ads, Justdial or Sulekha, PostHog.

---

## Appendix: where the evidence is

- **Raw audit output** (the code map with about 377 feature entries, every defect, every skeptic's reasoning, the follow-ups and the test-run record): `docs/audit-2-raw.json` in the founder's local research folder "southeast Mealbox". It is deliberately not committed here.
- **The earlier founder-facing synthesis:** `docs/AUDIT-2-vendor-first.md` in the same folder.
- **Probe scripts** (`vendor_flow.mjs`, `address_probe.mjs`, the pgTAP probe copies), the **secret-scan script**, the data-growth simulation SQL and the **test logs** were copied to `docs/audit-2-evidence/` in the same folder. The large temporary copies (the 1.4 GB test copy and the throw-away Postgres) were deleted. The relevant failure text is reproduced above.
- **Earlier repo audit:** `docs/AUDIT.md` on `master` (commit `c3d4174`).
