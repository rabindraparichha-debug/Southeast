# Security review (M8)

Reviewed on 2026-10-30, at the end of M7. Scope: database, API, Edge Functions, web and mobile apps, secrets and data handling. The schema-wide rules are automated in `supabase/tests/09_security.test.sql`, so a future migration that breaks one fails `pnpm db:test`.

## How data is protected

| Layer | Control | Checked by |
|---|---|---|
| Tenancy | RLS on every table; policies use the caller's kitchen memberships; composite foreign keys `(x_id, kitchen_id)` stop cross-kitchen references | `09_security` (RLS everywhere), `01_rls_isolation`, `tests/integration/m1.test.ts` (raw REST) |
| Grants | Fail-closed: new tables and functions get nothing; columns granted one by one; no direct writes to ledgers, money, orders, leads or customers | `09_security` |
| Privileged code | Every `SECURITY DEFINER` function sets `search_path = ''`, qualifies every name, and checks the caller (role, admin, magic-link token or run access) | `09_security` |
| Anonymous access | Only the public website functions, the customer page (token checked in each function) and the area list | `09_security` allowlist |
| Service-only | WhatsApp/Razorpay/lead webhook functions run only with the service role, after signature or key checks | `09_security`, `m3`, `m4`, `m7` integration tests |
| Phone numbers | Encrypted at rest (pgcrypto, key in Vault), looked up by HMAC hash, shown as the last 4 digits; full number only to owners, to a rider for their active stop, and to admins; every reveal is logged | `09_security`, `01`, `06`, `07` |
| Ledgers | Append-only triggers on audit log, balance entries, schedule changes, count snapshots, stock moves, supplier payments, tiffin ledger, lead events | `09_security` |
| Audit | `private.audit_row()` on every table with money, counts, membership or customer data; explicit `ACCESS` rows for reveals | pgTAP per milestone |
| Webhooks | Razorpay HMAC + event-id dedupe; Meta HMAC + message-id dedupe; Google Ads `google_key`; Justdial/generic shared key (constant-time compare) | `m3`, `m4`, `m7`, unit tests |
| Payments | Razorpay test/mock only; live keys refused unless `RAZORPAY_ALLOW_LIVE=true` (owner approval); money settles to each kitchen's Route account, never to us | `razorpay-shared` unit tests |
| Storage | Private buckets per kitchen folder (receipts, proofs, bills); only kitchen photos are public | `09_security` |
| AI | Money questions never reach the model; replies with prices or promises are replaced by a hand-off | `bot.test.ts` |
| Monitoring | Edge Function errors go to Sentry only when configured, with phone numbers masked | `monitor.test.ts` |

## Findings and fixes

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | An owner could change the FSSAI number of a kitchen already listed (verified by the platform). | Medium | **Fixed**: trigger `kitchens_fssai_guard`; admins correct it with `admin_set_fssai`. Test in `09_security`. |
| 2 | Route "Optimise" could return a longer route than the current one. | Low (correctness) | **Fixed** in `20261101000200_route_optimizer_never_worse.sql`. |
| 3 | First-ever route build was quadratic (31 s for 50 kitchens × 100 at the 21:00 lock). | Low (performance) | **Fixed** in `20261103000200_route_build_speed.sql` (now about 12 s; a normal day 1.8 s). |
| 4 | Website lead form could be used to spam enquiries. | Low | Mitigated: 5 enquiries per phone per day; consent required; no data returned except public kitchen cards. A CAPTCHA (e.g. Cloudflare Turnstile) is recommended before running ads at scale. |
| 5 | Magic links (customer page) are bearer tokens. | Accepted | 256-bit random, stored as SHA-256, valid 7–14 days, one customer each; the page can't cancel or reveal other data. |
| 6 | Rider calls reveal the real number to the rider's dialer. | Accepted (D-069) | Only for their own pending stop on a run that is out, logged. Virtual numbers need a telephony provider. |
| 7 | WhatsApp leads are treated as opted in for follow-ups. | Open (D-081) | Needs your decision; Meta policy check before going live. |
| 8 | No rate limit on authenticated RPCs beyond Supabase's defaults. | Low | Supabase API gateway limits apply in hosted projects; revisit if abuse appears. |
| 9 | Seed and local config contain fixed test OTPs and dev keys. | Info | Local only (`seed.sql`, `config.toml` test OTPs). Production uses Vault keys created once per project and a real OTP channel (D-004). |

## Before going live (checklist)

- [ ] Create the Vault secrets in the hosted project (`phone_encryption_key`, `phone_hash_key`, `functions_base_url`, `service_role_key`, `public_web_url`) from a password manager; keep the two phone keys backed up offline.
- [ ] Remove all `test_otp` entries; configure the production OTP channel (D-004). Only exception: one app-store reviewer number with a random code and a short expiry during a review, removed afterwards (D-114).
- [ ] Set Edge Function secrets with `supabase secrets set` (never in code); keep `RAZORPAY_ALLOW_LIVE` unset until the owner approves live keys.
- [ ] Restrict the Supabase dashboard to named team members with 2FA; use separate projects for staging and production.
- [ ] Enable Supabase PITR or daily backups and run `pnpm db:restore-drill` against a copy monthly (docs/OPERATIONS.md).
- [ ] Add a CAPTCHA to `/find` and `/vendors` before paid ads.
- [ ] Publish the privacy policy and terms (`/privacy`, `/terms`) and the grievance contact; answer data-deletion requests with `erase_customer` (DPDP).
- [ ] Set `SENTRY_DSN` for web, mobile and Edge Functions; set `NEXT_PUBLIC_POSTHOG_KEY` only after the privacy policy mentions analytics.
