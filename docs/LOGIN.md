# Login codes (WhatsApp and SMS)

Owners, staff and riders log in with their mobile number and a 6-digit code. This page is the setup guide for a hosted Supabase project: which provider sends the code, how to set each one up, and the auth settings that keep login safe. The decision is D-126 (it resolves D-004).

**Contents**
- [Summary and recommendation](#summary-and-recommendation)
- [How it works](#how-it-works)
- [(a) WhatsApp codes through Twilio](#a-whatsapp-codes-through-twilio)
- [(b) SMS through Twilio, and India DLT](#b-sms-through-twilio-and-india-dlt)
- [(c) Telnyx (or automatic fallback) through the Send SMS hook](#c-telnyx-or-automatic-fallback-through-the-send-sms-hook)
- [Hosted auth settings (security)](#hosted-auth-settings-security)
- [Apps](#apps)
- [Local development and the local check](#local-development-and-the-local-check)
- [Troubleshooting](#troubleshooting)
- [Sources](#sources)

## Summary and recommendation

**Recommendation:** WhatsApp first through Twilio now, SMS after DLT.

1. **Now:** WhatsApp codes through Supabase's **built-in Twilio provider** (section a). No code runs in the login path, and a WhatsApp authentication template needs no DLT. Set both apps to `LOGIN_CHANNELS=whatsapp`.
2. **Start DLT registration today** (it takes 1 to 3 weeks). WhatsApp sender approval also needs Meta business verification, which can take 1 to 2 weeks, so start both now.
3. **Once DLT is approved:** add the DLT sender to the same Twilio Messaging Service (section b) and set `LOGIN_CHANNELS=whatsapp,sms`. People without WhatsApp then tap "Send code by SMS instead".
4. **Use the Send SMS hook** (section c) only for one of these reasons:
   - you want Telnyx for SMS (price or delivery in India);
   - you want automatic fallback across providers (WhatsApp through Twilio fails, so SMS through Telnyx is tried in the same request);
   - you want the server to refuse non-Indian numbers.

   Everything is built and tested; switching to the hook is a dashboard setting plus secrets, and `LOGIN_DELIVERY=hook` in both apps (the hook cannot honour a per-channel button, so the screens stop naming one channel).

| | Built-in Twilio (a, b) | Send SMS hook → `auth-send-sms` (c) |
|---|---|---|
| Code in the login path | None (Supabase sends) | Ours (Edge Function, 5 s budget) |
| Channel the person picks | Honoured exactly (`options.channel`) | Not passed to hooks by Supabase. The hook uses its route order, and a code asked for again within 10 minutes, while the previous one is unused, moves to the next route |
| Login screen (`LOGIN_DELIVERY`) | `channel` (default): "Get code on WhatsApp", "Send code by SMS instead" | `hook`: with two channels, one "Get code" / "Send a new code", and the text names both channels (the screen cannot know which one was used) |
| WhatsApp | Twilio, authentication template (Content SID) | Twilio, same template |
| SMS | Twilio Messaging Service | Twilio or Telnyx |
| Automatic fallback in one request | No (the person taps "SMS instead") | Yes, within the 5 s budget |
| Non-Indian numbers | Block with Twilio Geo Permissions | Refused by the function (`AUTH_SMS_ALLOWED_COUNTRY_CODES=91`), plus provider settings |

The two paths differ on the login screen: only the built-in provider honours the person's pick, so set `LOGIN_DELIVERY=hook` in both apps when the hook is on (section c, step 8). Codes are always verified with `verifyOtp({ phone, token, type: 'sms' })`, also for WhatsApp, because Supabase has only `sms` and `phone_change` as phone types.

## How it works

- The apps call `signInWithOtp({ phone, options: { channel } })` with `channel` `whatsapp` or `sms` (`apps/web/src/app/login/login-form.tsx`, `apps/mobile/src/app/login.tsx`).
- **Built-in Twilio provider:**
  - `channel: 'whatsapp'` sends `To=whatsapp:+91…`, with `ContentSid` set to your authentication template and `ContentVariables {"1": "<code>"}`.
  - `channel: 'sms'` sends the SMS template as `Body`.
  - In both cases the "Message Service SID" from the dashboard goes in `From`. With a phone number there, Supabase adds `whatsapp:` for WhatsApp.
  - Only the Twilio and Twilio Verify providers accept the WhatsApp channel.
- **Send SMS hook:**
  - When it is on, Supabase calls our HTTPS function instead of any provider.
  - The body is `{ user, sms: { otp, phone } }`, signed with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`).
  - **The body does not include the channel the app asked for.** So `auth-send-sms` works from `AUTH_SMS_ROUTES` (default `whatsapp,sms`) and moves to the next route when the previous code is less than `AUTH_SMS_ESCALATE_SECONDS` old and still unused (`user.confirmation_sent_at`, which Auth sends before updating it, later than `user.last_sign_in_at`). Auth never clears `confirmation_sent_at` when a code is used, so without the `last_sign_in_at` check someone who logged in on the web at 10:00 and opens the app at 10:04 would be moved to SMS.
  - For a phone change the hook reads `user.new_phone` and `phone_change_sent_at` (Auth's JSON names). Reauthentication codes look like login codes to the hook; the apps never ask for one.
  - Because the apps cannot know which route a code went on, they run channel-neutral in hook mode (`LOGIN_DELIVERY=hook`, see [Apps](#apps)).
- **Test numbers** (`[auth.sms.test_otp]`) never reach a provider or the hook: Supabase answers them before sending.
- **Codes** are 6 digits. A new code needs the minimum interval (`max_frequency`) to have passed. Wrong or expired codes return `otp_expired` ("Token has expired or is invalid").

## (a) WhatsApp codes through Twilio

**What you need:**
- a Twilio account (upgraded, not trial);
- a Meta Business Manager for the company, verified;
- a phone number that is not on the WhatsApp app and not on another WhatsApp API provider;
- a display name approved by Meta.

Use a different number from the Phase 2 customer WhatsApp number (M4 runs on Meta's Cloud API directly). Twilio also recommends a separate sender for codes.

1. **WhatsApp sender.** In the Twilio Console, open Messaging → Senders → WhatsApp senders → *Create new sender*. Connect your Meta Business Manager (Embedded Signup), pick the number and the display name "Tiffin OS", and wait until the sender is *Online*.
2. **Messaging Service.**
   - Go to Messaging → Services → *Create Messaging Service*, for example "Tiffin login".
   - Under *Sender pool*, add the WhatsApp sender. Later, add the DLT SMS sender here too (section b).
   - Copy the **MG…** SID.
3. **Authentication template.**
   - Go to Messaging → Content Template Builder → *Create new*. Choose type **Authentication** (Content API type `whatsapp/authentication`), name `tiffin_login_code`, language English.
   - Pick the *Copy code* button and tick *Add security recommendation*. Set the code expiry to 10 minutes.
   - Submit it for WhatsApp approval. The body text is fixed by WhatsApp (no custom text), and its one variable `{{1}}` is the code.
   - Copy the **HX…** Content SID once it is approved.
4. **Geo permissions.** Go to Messaging → Settings → Geo permissions, allow **India only**, and leave every other country off (SMS-pumping guard).
5. **Supabase dashboard** (Authentication → Sign In / Providers → Phone):
   - **Enable Phone provider:** on.
   - **SMS provider:** Twilio.
   - **Twilio Account SID:** `AC…`.
   - **Twilio Auth Token:** the account's primary Auth Token. An API key secret does **not** work: Supabase signs in to Twilio as `Account SID : Auth Token`, while an API key must sign in as `SK… : secret`, so every code would fail with `sms_send_failed` (Twilio error 20003). To rotate, create the secondary Auth Token in the Twilio Console, put it here, then promote it to primary.
   - **Twilio Message Service SID:** the `MG…` SID. While you use WhatsApp only, the WhatsApp sender's number (`+91…`) also works here.
   - **Twilio Content SID:** the `HX…` SID. Without it, WhatsApp falls back to a free-form body, which Meta refuses outside a 24-hour chat.
   - **Enable phone confirmations:** **on** (see [security](#hosted-auth-settings-security)).
   - **SMS OTP expiry:** 600 s. **SMS OTP length:** 6.
   - **SMS message:** `{{ .Code }} is your Tiffin OS login code. Do not share it with anyone.` (WhatsApp uses the template instead; this text is for SMS and must match DLT.)
   - In `config.toml` the same value is `[auth.sms.twilio] content_sid` (this repo reads it from `SUPABASE_AUTH_SMS_TWILIO_CONTENT_SID`, unset locally); the Management API field is `sms_twilio_content_sid`. CLI 2.122.0 accepts the key for `config push` but does not pass it to the local Auth container (checked: the container gets account SID, auth token and message service SID only), so a local stack cannot send the WhatsApp template.
6. **Apps:** set `NEXT_PUBLIC_LOGIN_CHANNELS=whatsapp` (web host) and `EXPO_PUBLIC_LOGIN_CHANNELS=whatsapp` (EAS `production` and `preview` environments, then rebuild).
7. **Try it:** log in with your own number. Twilio Console → Monitor → Messaging logs should show a WhatsApp message *delivered*.

**India note:** a Twilio FAQ from 2024 says Meta paused authentication templates to +91 numbers for a period. Meta's current pricing (December 2025) lists India with both authentication and "authentication-international" rates, and says codes to +91 must use an authentication template. So these templates are in use. An India-based business pays the domestic authentication rate unless it crosses Meta's volume threshold. Confirm when Twilio approves your template.

**Twilio Verify** is the other built-in option: Twilio makes and checks the code (`[auth.sms.twilio_verify]`, Verify Service SID in "Message Service SID"). Since 2024, WhatsApp through Verify needs your own WhatsApp sender attached to the Verify service. Verify bills per verification. The plain Twilio provider above is enough for us.

## (b) SMS through Twilio, and India DLT

Every commercial SMS to an Indian number, OTPs included, must come from a DLT-registered sender ("header") with a DLT-approved content template. This applies whoever sends it, including foreign providers.

1. **Register the business as a Principal Entity** on one operator's DLT portal (Jio, Airtel, Vi or BSNL). You need the company's PAN, GST or incorporation papers and an authorised person. There is a one-time fee, and approval takes days to weeks.
2. **Header:** register a 6-character sender ID, for example `TIFFOS`, for transactional/service messages.
3. **Content template:** category *Service Implicit* (OTP). Use exactly this text, with the variable where the code goes:
   `{#var#} is your Tiffin OS login code. Do not share it with anyone.`
   Note the template ID.
4. **Link it to Twilio:**
   - Follow Twilio's India SMS guidelines: submit the DLT entity ID, header and template ID to Twilio (Console regulatory form or support), and complete the chain binding (telemarketer) step on the DLT portal.
   - Once Twilio confirms, add the alphanumeric sender (`TIFFOS`) to the **same Messaging Service** as the WhatsApp sender.
5. **Supabase:** set the SMS message to the DLT text with the code in place of `{#var#}`: `{{ .Code }} is your Tiffin OS login code. Do not share it with anyone.` Any difference (even punctuation) gets the SMS blocked by the operators.
6. **Apps:** `LOGIN_CHANNELS=whatsapp,sms`.

**Until DLT is done,** do not offer SMS: Indian operators drop unregistered OTP SMS. A closed pilot can also use one Supabase test number per tester, with random codes and an expiry (D-114 rules).

## (c) Telnyx (or automatic fallback) through the Send SMS hook

`supabase/functions/auth-send-sms` (logic in `supabase/functions/_shared/auth-sms.ts`, tests in `tests/integration/auth-sms.test.ts`) does the following:
1. checks the Standard Webhooks signature with `SEND_SMS_HOOK_SECRETS`, and refuses a delivery whose `webhook-id` it has already handled (a replay) until that signature expires;
2. refuses numbers outside `AUTH_SMS_ALLOWED_COUNTRY_CODES` (default `91`);
3. sends the code on each route of `AUTH_SMS_ROUTES` until a provider accepts it (2 s per call, 4.3 s in total, because Supabase gives a hook about 5 s);
4. logs only the channel, provider, masked number (`+91******0042`) and error codes, never the code. Failures go to Sentry through `_shared/monitor.ts`.

**Before DLT is approved, set `AUTH_SMS_ROUTES=whatsapp`.** Indian operators silently drop an unregistered SMS after the provider has already answered "accepted", so an SMS route would count as a success that never arrives: the in-request fallback and the resend would both end there. Add the SMS route (and `LOGIN_CHANNELS=whatsapp,sms`) only once DLT is done.

If every route fails, Auth answers the app with `sms_send_failed`; if the function is misconfigured, with `sms_not_configured`.

**Telnyx setup:**
1. **Messaging Profile.** In the Mission Control Portal, open Messaging → *Add new profile*, for example "Tiffin login". Under *Outbound*, allow **India only** (whitelisted destinations). Copy the profile ID.
2. **Sender.** For India, the DLT path only works with a local alphanumeric sender:
   - Register your entity, header and content template on DLT (section b, steps 1 to 3).
   - Then contact Telnyx support (India DLT registration) with the DLT entity ID, headers and template IDs. International alphanumeric senders cannot be DLT-registered.
   - Add the approved sender to the profile.
3. **API key.** Go to Account settings → API keys → create one, and keep it in the password manager.
4. **Function secrets** (`supabase secrets set …` on the project):
   ```
   SEND_SMS_HOOK_SECRETS='v1,whsec_…'           # from step 6 below
   PLATFORM_ENV=production
   AUTH_SMS_MODE=live
   AUTH_SMS_ROUTES=whatsapp:twilio,sms:telnyx    # or sms:telnyx alone
   TELNYX_API_KEY=KEY…
   TELNYX_FROM=TIFFOS
   TELNYX_MESSAGING_PROFILE_ID=…
   AUTH_SMS_TEMPLATE='{code} is your Tiffin OS login code. Do not share it with anyone.'   # = DLT template
   # WhatsApp route (same Twilio objects as section a):
   TWILIO_ACCOUNT_SID=AC…  TWILIO_AUTH_TOKEN=…  TWILIO_MESSAGING_SERVICE_SID=MG…  TWILIO_WHATSAPP_CONTENT_SID=HX…
   ```
   For Twilio SMS on the hook instead of Telnyx, use `AUTH_SMS_ROUTES=whatsapp,sms` with `AUTH_SMS_PROVIDER=twilio`. Every variable is listed in `supabase/functions/.env.example`.
5. **Deploy:** `supabase functions deploy auth-send-sms --no-verify-jwt`. Auth sends no user token; the signature is the check.
6. **Supabase dashboard:**
   - Go to Authentication → Hooks → *Add hook* → **Send SMS** → **HTTPS**.
   - URL: `https://<project-ref>.supabase.co/functions/v1/auth-send-sms`.
   - Click *Generate secret* and copy the `v1,whsec_…` value into `SEND_SMS_HOOK_SECRETS` (step 4).
   - Save. While the hook is on it replaces the built-in provider, but keep the Phone provider enabled.
7. **Rotation:** Supabase signs with every secret it holds. The function accepts any of several values separated by `|` in `SEND_SMS_HOOK_SECRETS`, so add the new secret to the function first, then to the dashboard, then remove the old one.
8. **Apps:** set `LOGIN_DELIVERY=hook` and `LOGIN_CHANNELS` to the channels in `AUTH_SMS_ROUTES`, in the same order (`whatsapp` before DLT, `whatsapp,sms` after), in both apps (`NEXT_PUBLIC_…` on the web host, `EXPO_PUBLIC_…` in EAS, then rebuild).
   - With two channels the screens are channel-neutral: "Get code", "Enter the 6-digit code sent on WhatsApp or by SMS", and one "Send a new code" button. They cannot name the channel, because the hook may fall back within the request or move a resend to the next route.
   - With one channel the screen names it, which is accurate because the hook has only that route.

**Built-in safety:**
- Mock mode is refused unless the function runs on a local stack (`PLATFORM_ENV`, `_shared/platform.ts`, the same rule as every other mock).
- The published local secret from `.env.example` is refused outside a local stack.
- The function URL is public, but it does nothing without a valid signature, and the signature must be less than 5 minutes old.
- A deployed function with no `SEND_SMS_HOOK_SECRETS` (the built-in path needs none) answers every request exactly like a bad signature (401), so a caller learns nothing about its configuration. The misconfiguration is logged and sent to Sentry once per function instance, not once per request.
- Replays: each instance remembers the `webhook-id` of every signed delivery until its signature expires and refuses a second one (409). Supabase signs every attempt, its own retries included, with a new id. This lives in the instance's memory: a replay that reaches a fresh instance can still cause one more send there.

## Hosted auth settings (security)

Set these on every hosted project (staging and production) before the first outside login. They are dashboard settings; never `supabase config push` this repo's `config.toml`, which carries the local test numbers and placeholders.

- **Confirm phone: ON.** Authentication → Sign In / Providers → Phone → *Enable phone confirmations*. With it off (the local setting), two things happen:
  - A phone + password signup is marked confirmed without any code. Checked on the local stack on 2026-11-06: `POST /auth/v1/signup {phone, password}` returned a session with `phone_confirmed_at` set. Such an account could then pick up staff or rider invites for that number.
  - Supabase skips its SMS rate limit for auto-confirmed signups (`supabase/auth` `internal/api/phone.go`).

  The apps never use passwords; with confirmations on, every phone account must prove it holds the number.
  - **What the code checks.** `claim_invites` has required `phone_confirmed_at` since M1 (`tenancy.sql`), but that does not help here: an auto-confirmed password signup has it too (`supabase/auth` `signup.go` confirms the phone and opens a session). The code-side guard is that `claim_invites` only accepts a session signed in with a one-time code (JWT `amr` contains `otp`). That guard is part of the wave 2 database work (migration `20261108000200_manager_accountant_roles.sql`, with pgTAP cases for an `amr` `password` session and an `amr` `otp` session); `tests/integration/auth-sms.test.ts` pins what Supabase Auth really puts in `amr` (`otp` after `verifyOtp`, only `password` after an auto-confirmed signup). Until that migration is merged, this dashboard setting is the only protection.
  - **Not covered by code:** `invite_member` no longer adds an existing account directly (always a pending invite, claimed by `claim_invites` in a code session; D-136). But with "Confirm phone" off, a stranger can register the number with a password before the real person signs in; the real person's first code sign-in then lands in that same account, and the stranger keeps the password. The database cannot tell such an account apart (Auth gives code-only accounts a random password too). With "Confirm phone" on, the stranger's signup stays unconfirmed and cannot sign in, and the real owner's first code replaces the password (`signup.go`, existing unconfirmed user). So the setting is mandatory: a launch blocker.
- **Signup policy: ⏳ PENDING your decision (D-127).** Who may create a login is not decided yet; the current default is open.
  - Today, with **"Allow new users to sign up" ON**, invited staff and riders create their account at their first login and `claim_invites` adds them to the kitchen. With signups off, Auth refuses them (`signup_disabled`, "Signups not allowed for this instance"; the apps show "This number is not registered yet…").
  - **The risk of open signup:** Supabase's "SMS sent per hour" limit is **one bucket for the whole project**, checked before every code it sends (built-in provider or hook). A script that asks for codes for random +91 numbers, staying under the per-IP limit, uses up the hour's codes. Every real owner, staff member or rider then gets "Please wait a little before asking for another code" (`over_sms_send_rate_limit`) until the hour rolls over: a login outage, for example for a rider at the start of lunch delivery, not only an SMS bill. Each such request also creates an empty account.
  - **Options** (none is built yet):
    1. *Invited and approved numbers only* (the audit's Phase 1 recommendation): a `before_user_created` hook that allows a number only with a pending staff or rider invite, an approved vendor application or a platform allowlist entry. It stops scripts creating accounts. It does not stop code requests for numbers that already have an account, so combine it with the rate limits below.
    2. *CAPTCHA on login*: turn on Supabase's CAPTCHA (Turnstile or hCaptcha) and send `captchaToken` from both login screens. The mobile app needs a WebView-based widget.
    3. *Open* (today): rely on the rate limits and the India-only rules below, and watch the auth logs.
  - A per-number or per-IP throttle in `auth-send-sms` would not help the outage: Auth counts the code against its hourly bucket before it calls the hook.
  - Whatever you choose, keep email and anonymous sign-ins off. Any number that passes the code check can still create a *draft* kitchen; drafts are private (D-005) and visible to the founder in /admin.
- **Rate limits** (Authentication → Rate Limits):
  - SMS sent per hour: start at about 60 for the pilot. Remember this is shared by every login in the project (see above): set it above your real peak (owners, staff and riders logging in around delivery time) and watch for `over_sms_send_rate_limit` in the auth logs.
  - Token verifications: the default.
  - Minimum interval between codes (`max_frequency`): 30 s to 60 s. The apps count down 30 s and then read Supabase's "after N seconds" message.
- **Abuse limits outside Supabase:**
  - Twilio Geo Permissions: India only.
  - Telnyx whitelisted destinations: India only.
  - `AUTH_SMS_ALLOWED_COUNTRY_CODES=91` on the hook.
- **Test numbers:** remove all `test_otp` numbers at launch. The only exception is D-114's single store-review number, with a random code and an expiry.
- **Keys:** put the Twilio auth token, Telnyx API key and hook secret only in the dashboard or `supabase secrets set`, and keep them in the password manager. Never put them in the repo, `config.toml` or `.env.example`.

## Apps

- `NEXT_PUBLIC_LOGIN_CHANNELS` (web) and `EXPO_PUBLIC_LOGIN_CHANNELS` (mobile, inlined at build time) list the channels in order, for example `whatsapp,sms`. Unset means `sms`, which is what the local test numbers use.
- `NEXT_PUBLIC_LOGIN_DELIVERY` / `EXPO_PUBLIC_LOGIN_DELIVERY`: `channel` (default, the built-in provider honours the person's pick) or `hook` (the Send SMS hook picks; set it whenever the hook is on).
- **First screen:** "Get code on WhatsApp" (or "Send code by SMS" when SMS is first).
  - If WhatsApp is first and SMS is offered, a line says SMS can be asked for on the next screen.
  - If sending fails, "Send code by SMS instead" appears at once.
- **Code screen:** a 30 s countdown, then "Send code by SMS instead" and "Resend on WhatsApp". A rate-limit answer restarts the countdown with Supabase's own wait time.
- **Hook mode with two channels** (`LOGIN_DELIVERY=hook`, `LOGIN_CHANNELS=whatsapp,sms`): "Get code" with "We send it on WhatsApp or by SMS", then "Enter the 6-digit code sent on WhatsApp or by SMS" and one "Send a new code" after the countdown. No "instead" buttons: the hook cannot be told which channel was picked.
- **Errors:** mapped in `apps/web/src/lib/errors.ts` (`loginErrorText`) and `apps/mobile/src/i18n/en.ts` (`errors.*`), through `loginErrorKey` in `@tiffin/core`. The mapped errors are `over_sms_send_rate_limit`, `over_request_rate_limit`, `sms_send_failed` (also hook timeouts), `sms_not_configured`, `phone_not_allowed`, `otp_expired` (wrong or expired code), `signup_disabled` (signups off; also `otp_disabled`, which Auth uses when `create_user` is false), `phone_provider_disabled`, `validation_failed` (bad number) and network failures.
- The mobile test-build server switch on the login screen is unchanged.

## Local development and the local check

- **Default:** only the seed test numbers log in (OTP `123456`); nothing is sent.
  - `config.toml` keeps the built-in Twilio provider "on" with `env()` placeholders that stay unset locally, so the phone provider is active.
  - A non-test number would try Twilio with those placeholders and fail with `sms_send_failed`.
  - The Send SMS hook is off.
- **Local check** of the hook in mock mode (nothing leaves the machine):
  ```bash
  cp supabase/functions/.env.example supabase/functions/.env     # AUTH_SMS_MODE=mock + the published local hook secret
  grep '^SEND_SMS_HOOK_SECRETS' supabase/functions/.env > supabase/.env   # config.toml reads it from here
  pnpm db:stop
  SUPABASE_AUTH_HOOK_SEND_SMS_ENABLED=true pnpm db:start
  AUTH_SEND_SMS_E2E=1 pnpm test:integration -- auth-sms           # includes a non-test number through Auth → hook
  docker logs supabase_edge_runtime_tiffin 2>&1 | grep auth-send-sms   # {"event":"sent","mode":"mock","kind":"login","channel":"whatsapp","to":"+91******…"}
  ```
  - Without `AUTH_SEND_SMS_E2E`, the suite still runs the unit tests and checks that the local function accepts a correctly signed request and refuses a tampered one.
  - `AUTH_SMS_MOCK_FAIL=whatsapp` (in `supabase/functions/.env`, then restart) makes the mock fail WhatsApp, so you can see the fallback and error screens.
  - The hook URL in `config.toml` uses `host.docker.internal` and the `[api]` port. Auth accepts plain http only for localhost-type hosts; hosted needs https.

## Troubleshooting

| What the app or log shows | Meaning |
|---|---|
| `sms_send_failed` (built-in) | Twilio refused: a wrong SID or token, the Content SID missing for WhatsApp, Geo Permissions, or a template not approved. See Twilio's Messaging logs. |
| `sms_send_failed` (hook) | Every route failed. Function logs list the attempts, for example `whatsapp:twilio:twilio_http_400_63016`. |
| `sms_not_configured` | Hook secrets or provider secrets are missing, or mock mode is on in a hosted project. The function log says which. |
| "Hook requires authorization token" (500) | The function answered 401: `SEND_SMS_HOOK_SECRETS` is not set in the function or does not match the dashboard secret (or is the published local secret on a hosted project). The function log says `hook_secret_not_configured` for the first case. |
| `sms_send_failed` with Twilio error 20003 | Wrong Twilio credentials. The built-in provider needs the Account SID and the Auth Token; an API key secret does not work there. |
| `hook_timeout` | Providers took longer than about 5 s. Lower `AUTH_SMS_TIMEOUT_MS` or use one route. |
| WhatsApp accepted but never arrives | The number is not on WhatsApp (Twilio error 63003 in the logs, reported later, not at send time). The person taps "Send code by SMS instead". |
| `otp_expired` | Wrong code, or older than the OTP expiry. |

## Sources

Researched 2026-11-06. supabase.com, twilio.com and developers.telnyx.com were not reachable from the build machine, so the Supabase and Telnyx facts come from their source code and docs sources on GitHub, and the Twilio facts from Twilio's SDK source and search results of its docs.

**Supabase**
- Auth source, `internal/api/sms_provider/twilio.go`: WhatsApp via `ContentSid` + `ContentVariables {"1": otp}`, and the `whatsapp:` prefix.
- Auth source, `internal/api/sms_provider/sms_provider.go`: WhatsApp only on `twilio` / `twilio_verify`; any channel when the hook is on.
- Auth source, `internal/api/sms_provider/twilio_verify.go` and `internal/api/verify.go`: the `sms` / `phone_change` types; test OTPs are checked first; Verify checks the code at Twilio.
- Auth source, `internal/api/phone.go`: test OTPs skip sending; the hook gets `SMS{OTP, Phone}` with no channel; no SMS rate limit when auto-confirming; the SMS limit (`limiterOpts.Phone.Allow()`) is checked before the provider or the hook is called.
- Auth source, `internal/api/apilimiter/apilimiter.go`: the SMS limit is one `ratelimit.New(RateLimitSmsSent)` for the whole project (no per-number or per-IP key).
- Auth source, `internal/models/user.go`: `PhoneChange` is serialised as `new_phone`; `ConfirmPhone` clears only the token and sets `phone_confirmed_at` (it keeps `confirmation_sent_at`); `last_sign_in_at` is part of the user JSON.
- Auth source, `internal/api/signup.go` and `internal/api/otp.go`: an auto-confirmed phone signup confirms the phone and opens a `password` session; signing up again over an unconfirmed user replaces its password; signups off answer `signup_disabled` ("Signups not allowed for this instance"), and `otp_disabled` only when `create_user` is false; `verify.go` issues `otp` sessions (`models/factor.go`: `otp`, `password`).
- Auth source, `internal/api/sms_provider/twilio.go`: Basic auth with `AccountSid:AuthToken`.
- Checked on the local stack (2026-11-06): a test-number `verifyOtp` session has `amr` `[{"method":"otp"}]`; an auto-confirmed `signUp({phone, password})` session has `[{"method":"password"}]`; `last_sign_in_at` moves past `confirmation_sent_at` on verify.
- Auth source, `internal/hooks/v0hooks/v0hooks.go` (`SendSMSInput`) and `internal/hooks/hookshttp/hookshttp.go`: `webhook-id` / `webhook-timestamp` / `webhook-signature` joined by `", "`, a 5 s timeout, and retry only on 429/503 with `retry-after`.
- Auth source, `internal/hooks/hookserrors/hookserrors.go`: `{error: {http_code, message}}` in a 200 answer becomes that error.
- Auth source, `internal/conf/configuration.go`: `content_sid`; secrets separated by `|` in the format `v1,whsec_…`; http only for localhost, 127.0.0.1, ::1 and host.docker.internal.
- Supabase docs sources: `apps/docs/content/guides/auth/auth-hooks/send-sms-hook.mdx` (payload, example), `auth-hooks.mdx` (Standard Webhooks, the `[auth.hook.send_sms]` keys `enabled` / `uri` / `secrets = "env(…)"`, status codes) and `phone-login.mdx` (`options.channel: 'whatsapp'`, Twilio and Twilio Verify only, `verifyOtp` type `sms`).
- Supabase CLI 2.122.0 (the version in this repo):
  - `[auth.sms.twilio]` / `[auth.sms.twilio_verify]` take `account_sid`, `message_service_sid` and `auth_token`; `[auth.sms.twilio]` also takes `content_sid` (env override `SUPABASE_AUTH_SMS_TWILIO_CONTENT_SID`, Management API field `sms_twilio_content_sid`), but the local Auth container only gets `GOTRUE_SMS_TWILIO_ACCOUNT_SID`, `…_AUTH_TOKEN` and `…_MESSAGE_SERVICE_SID`.
  - In `supabase/functions/.env`, a comment after an empty value (`KEY=   # note`) becomes the value; comments go on their own line.
  - It loads `supabase/.env` for `env()` and leaves an unset `env(X)` as literal text.
  - It validates hook secrets against `^v1,whsec_[A-Za-z0-9+/=]{32,88}$`.
  - `SUPABASE_AUTH_HOOK_SEND_SMS_ENABLED` overrides the config value (all checked on the local stack).

**Standard Webhooks**
- Spec (`spec/standard-webhooks.md`): signed content `id.timestamp.body`; space-separated signatures.
- JS library: 5-minute tolerance; `whsec_` + base64 key.

**Twilio**
- twilio-node `src/rest/api/v2010/account/message.ts`: the `To`, `From`, `MessagingServiceSid`, `ContentSid`, `ContentVariables`, `ValidityPeriod` and `Body` parameters.
- Twilio docs, via search, "whatsapp/authentication" Content API: one variable (the code, under 15 characters), copy-code button, preset body, Meta approval required.
- Twilio docs, via search, "Verify WhatsApp" / "Bring your own sender": your own sender required since 2024, and the 2024 India FAQ.
- Meta "authentication-international rates" (via search): India listed (updated December 2025); +91 codes must use authentication templates.

**Telnyx**
- telnyx-node `src/resources/messages/messages.ts` and OpenAPI `openapi/spec3.yml`:
  - `POST https://api.telnyx.com/v2/messages` with `Authorization: Bearer <API key>`;
  - body `from`, `to`, `text` and `messaging_profile_id` (required for alphanumeric senders and number pools), plus `type`;
  - errors as `{errors: [{code, title, detail}]}`.
- Telnyx docs and support (via search):
  - International SMS compliance: India needs DLT entity, header and template registration, arranged through Telnyx support.
  - "India SMS guidelines": only local alpha sender IDs can be DLT-registered.
- India DLT (vendor guides via search): OTP SMS included, approved templates and chain binding required.
