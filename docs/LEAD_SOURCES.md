# Lead sources: Google Ads, Justdial, Sulekha

Every lead, from any channel, lands in the same place: `public.leads` (admin-only), deduplicated on
`(source, external_id)` and on one open lead per phone (`private.upsert_lead`). From there the lead
bot asks the person what they need on WhatsApp, matches kitchens (`private.match_kitchens`, D-078)
and converts them when they pick one. Nothing below needs code changes, only account setup.

| Channel | How it reaches us | Endpoint |
|---|---|---|
| Google Ads lead form | Google's webhook, instant | `lead-intake?source=google_ads` |
| Google Ads click to website | `?gclid=` on the landing page, kept with the `/find` form | web `/find` → `lead_attach_gclid` |
| Justdial | Lead push API (ask your account manager), or the enquiry email | `lead-intake?source=justdial` or `lead-email` |
| Sulekha | Enquiry email forwarding (no public API), or CSV upload | `lead-email`, admin CSV import |
| Anything else (Meta lead ads via Zapier/Make, partners) | Our JSON format | `lead-intake?source=instagram|website|referral|sulekha|other` |

`<project>` below is your Supabase project ref. All keys are Edge Function secrets
(`supabase secrets set NAME=value`), never in code.

## 1. Google Ads

### a. Lead form assets (people fill a form inside the ad)

1. Set a long random key: `supabase secrets set GOOGLE_ADS_LEAD_KEY=<32+ random chars>`.
2. Google Ads → the campaign → Assets → Lead form → **Lead delivery** → Webhook integration:
   - Webhook URL: `https://<project>.functions.supabase.co/lead-intake?source=google_ads`
   - Key: the same value as `GOOGLE_ADS_LEAD_KEY`.
   - Press **Send test data**. A test lead appears in Admin → Leads with the note "Google Ads test lead".
3. Form questions: name, phone (required), area or postal code, and two custom questions:
   "Lunch, dinner or both?" and "Veg or non-veg?". Add a WhatsApp consent question
   ("Can we message you on WhatsApp?") so the bot can start the conversation.

The click id (`gcl_id`) in each webhook is stored on the lead.

### b. Website clicks

Turn on **auto-tagging** (Admin → Account settings). Point ads at `https://<web>/find`. The page
keeps `?gclid=` and attaches it to the lead after the form is submitted (`lead_attach_gclid`, the
lead's own token is required, so nobody can attach a click id to someone else's lead).

### c. Offline conversions: tell Google who actually paid

Bidding on form fills buys form fills. We report three events back with their value in rupees:

| Stage | When | Value |
|---|---|---|
| `trial` | the lead's first recharge (paid trial) | that payment |
| `plan` | the first full plan bought | that payment |
| `renewal` | the month-2 renewal | that payment |

How it runs: the lead status trigger queues a row in `ad_conversions` (only for leads with a click
id). The cron `tiffin-ad-conversions` calls the `ads-conversions` Edge Function every 15 minutes; it
uploads with `customers/{id}:uploadClickConversions` and marks each row sent, failed or skipped.
Admin → Leads → Ad conversions shows the queue.

Setup:

1. In Google Ads → Goals → Conversions → **New conversion action** → Import → *Other data sources or
   CRMs* → *Track conversions from clicks*. Create three actions: "Tiffin trial", "Tiffin plan",
   "Tiffin renewal" (category Purchase, value "use different values", count "one").
   The action id is the `ctId=` number in the URL of each action.
2. **Developer token:** Google Ads manager account → Tools → API Center. Basic access is enough.
3. **OAuth client:** Google Cloud console → APIs & Services → enable *Google Ads API* → Credentials →
   OAuth client (Desktop app). Get a refresh token for the Google user that can access the Ads account
   (for example with the OAuth Playground, scope `https://www.googleapis.com/auth/adwords`, "Use your
   own OAuth credentials").
4. Secrets:

   ```bash
   supabase secrets set GOOGLE_ADS_MODE=live \
     GOOGLE_ADS_CUSTOMER_ID=123-456-7890 \
     GOOGLE_ADS_LOGIN_CUSTOMER_ID=111-222-3333 \  # only if you use a manager (MCC) account
     GOOGLE_ADS_DEVELOPER_TOKEN=... \
     GOOGLE_ADS_CLIENT_ID=... GOOGLE_ADS_CLIENT_SECRET=... GOOGLE_ADS_REFRESH_TOKEN=... \
     GOOGLE_ADS_CONVERSION_TRIAL=<ctId> GOOGLE_ADS_CONVERSION_PLAN=<ctId> GOOGLE_ADS_CONVERSION_RENEWAL=<ctId>
   ```

5. Vault (once): `functions_base_url` and `service_role_key` (already needed for the outbox cron).

Until `GOOGLE_ADS_MODE=live` and a developer token are set, uploads run in **mock** mode: rows are
marked sent with "mock" and nothing leaves the server. A stage without a conversion action id is
marked skipped. Google accepts clicks up to 90 days old.

Privacy: only the click id, the time and the value are sent; never a name or phone number.

## 2. Justdial

Justdial sends every enquiry by SMS and email, and offers a **lead push API** on paid listings.

**Option A, push API (instant).** Ask your Justdial account manager to push leads to:

```
https://<project>.functions.supabase.co/lead-intake?source=justdial&key=<LEAD_INTAKE_KEY>
```

GET or form POST with their usual fields (`leadid`, `prefix`, `name`, `mobile`, `area`, `city`,
`category`, …). The function answers `RECEIVED` as Justdial expects. Set the key with
`supabase secrets set LEAD_INTAKE_KEY=<32+ random chars>`.

**Option B, email forwarding.** Forward the Justdial enquiry emails to the inbound address in
section 4. The sender `@justdial.com` marks them as Justdial leads.

## 3. Sulekha

Sulekha has no public lead API. Two ways in:

**Option A, email forwarding (recommended).** Sulekha emails every enquiry ("Customer Name",
"Mobile", "Location", "Requirement"). Forward them to the inbound address in section 4. Leads appear
within a minute with source `sulekha`. If Sulekha only shows the number after you "buy" the lead in
their app, forward the confirmation email that includes it.

**Option B, CSV upload.** Admin → Leads → Import: choose *Sulekha*, upload a CSV with columns
`name, phone, area, slots, diet, notes` (optional `external_id`). Up to 2,000 rows; rows with a bad
phone number are listed and skipped; uploading the same file twice creates nothing
(`admin_import_leads`).

**Option C, partner JSON.** If Sulekha (or any aggregator) enables an API push for you, use
`lead-intake?source=sulekha&key=<LEAD_INTAKE_KEY>` with our JSON body:

```json
{"external_id":"SK-123","name":"Priya","phone":"98610 00981","area":"Patia","slots":["lunch"],"diet":"veg","whatsapp_opt_in":false}
```

## 4. Inbound email address (Sulekha, Justdial, others)

The `lead-email` function reads "Label: value" lines from an enquiry email (the value may be on the
next line) and ignores emails without a mobile number (newsletters, offers).

```
https://<project>.functions.supabase.co/lead-email?key=<LEAD_INTAKE_KEY>
```

It accepts our JSON `{from, subject, text, messageId}`, Postmark inbound JSON, and SendGrid or
Mailgun inbound form posts. Pick one:

**Cloudflare Email Routing (free, if your domain is on Cloudflare).** Create a route
`leads@yourdomain.in` → *Send to a Worker* with:

```js
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).text();
    // Plain-text part only; enquiry emails are simple.
    const text = raw.split(/\r?\n\r?\n/).slice(1).join('\n\n').replace(/=\r?\n/g, '').replace(/<[^>]+>/g, ' ');
    await fetch(`${env.LEAD_EMAIL_URL}?key=${env.LEAD_INTAKE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: message.from, subject: message.headers.get('subject') ?? '', text,
        messageId: message.headers.get('message-id') }),
    });
  },
};
```

(Set `LEAD_EMAIL_URL` and `LEAD_INTAKE_KEY` as Worker secrets.)

**Postmark / SendGrid / Mailgun inbound.** Point the inbound webhook at the URL above.

Then in Gmail (or wherever the Sulekha/Justdial account emails go): Settings → Forwarding → add
`leads@yourdomain.in`, and a filter `from:(sulekha.com OR justdial.com)` → forward.

## 5. Checking it works

- Admin → Leads: new rows with their source and campaign (`sk-email`, `jd-email`, `gads-<campaign>`).
- `select source, count(*) from leads group by 1;` in the SQL editor.
- Edge Function logs for `lead-intake`, `lead-email`, `ads-conversions`; errors also go to Sentry
  (phones masked) when `SENTRY_DSN` is set.
