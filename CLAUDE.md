# CLAUDE.md: Tiffin Vendor Platform

A free operating system for small tiffin vendors in Bhubaneswar.

| Doc | What it holds |
|---|---|
| `docs/SPEC.md` | The spec |
| `docs/PLAN.md` | Work packages and their status |
| `docs/DECISIONS.md` | Defaults and open questions |
| `docs/AUDIT.md` | Initial audit |

**Working rules from the product owner:**
- Build one milestone at a time, then stop for review.
- Never delete or rewrite existing work without asking.
- Razorpay stays in test mode until the owner explicitly approves live keys.

## Layout
```
apps/web            Next.js 16 (App Router, Tailwind 4): vendor dashboard, /c customer pages (M4), /admin
apps/mobile         Expo SDK 58 + Expo Router (src/app): vendor app + rider mode
packages/core       Pure TS shared logic: phone, money (paise), IST time, import validation (+ Vitest)
packages/db         Generated Supabase types (src/types.ts) + aliases
supabase/           config.toml, migrations/, seed.sql, tests/ (pgTAP)
tests/integration   Vitest against the running local API (OTP login + raw REST)
docs/               SPEC, PLAN, DECISIONS, AUDIT
```

## Commands
Requirements: Node 20+, pnpm 10, Docker.

```bash
pnpm install
pnpm db:start                # local Supabase (first run pulls Docker images)
pnpm db:reset                # apply migrations + supabase/seed.sql
pnpm db:test                 # pgTAP: RLS, roles, guards, import
pnpm --filter @tiffin/core test
pnpm test:integration        # needs db:start + db:reset
pnpm db:types                # regenerate packages/db/src/types.ts after every migration

# Web
cp apps/web/.env.example apps/web/.env.local       # anon key: pnpm supabase status
pnpm --filter @tiffin/web dev                      # http://localhost:3000
pnpm --filter @tiffin/web typecheck && pnpm --filter @tiffin/web lint

# Mobile
cp apps/mobile/.env.example apps/mobile/.env.local # on a phone, use your computer's LAN IP
pnpm --filter @tiffin/mobile start                 # Expo dev server (press a for Android)
pnpm --filter @tiffin/mobile typecheck && pnpm --filter @tiffin/mobile lint
```

**Local logins:** OTP is always `123456` for the seed numbers.

| Number | Who |
|---|---|
| 90000 00001 | Owner, kitchen A (Maa Tarini Tiffin, Patia) |
| 90000 00002 | Staff, kitchen A |
| 90000 00003 | Rider, kitchen A |
| 90000 00011 | Owner, kitchen B (Saheed Nagar Mess) |
| 90000 00012 | Staff, kitchen B |
| 90000 00013 | Rider, kitchen B |
| 90000 00099 | Platform admin |
| 90000 00100 | Pending rider invite to kitchen A |
| 90000 00101, 90000 00102 | Spare |

## Conventions (follow these in every change)

**Time**
- Store `timestamptz` (UTC); display IST (`Asia/Kolkata`).
- Cutoffs are IST `time` plus a `*_prev_day` flag. Use `@tiffin/core` time helpers.

**Money**
- Integer paise only (`*_paise` columns). Use `formatPaise` / `rupeesToPaise`.

**Tenancy and access**
- Every vendor-owned table has `kitchen_id`, RLS enabled, and composite FKs `(x_id, kitchen_id)` to parents, so rows can't cross kitchens.
- Policies use `kitchen_id = any ((select private.kitchen_ids('{owner,...}'))::uuid[])`.
- **Grants are fail-closed:** new tables and functions get nothing. Add explicit `grant`s in the migration, and pgTAP tests for each role (owner, staff, rider, other kitchen, admin, anon).
- **Roles:**
  - Staff: no money, no phone numbers.
  - Riders: only their stops (M5).
  - Admins: read all; reveals are logged.

**Writes and ledgers**
- Writes that need encryption, multi-row transactions or money/count logic go through `SECURITY DEFINER` RPCs in `public`. Each one:
  - sets `search_path = ''`;
  - qualifies every name;
  - starts with `perform private.require_role(...)`.
- Internal helpers live in schema `private` (not exposed by PostgREST).
- RPCs raise short error codes (`forbidden`, `invalid_phone`, `already_exists`, …). Map them to UI text in `apps/web/src/lib/errors.ts` and `apps/mobile/src/i18n/en.ts`.
- **Ledgers are append-only:** `audit_log` now; `balance_entries` and `stock_moves` later. Use triggers raising on UPDATE/DELETE. Never store a balance or stock number.
- **Audit:** attach `private.audit_row()` to every table with money, count, membership or customer data.

**Migrations and data**
- Migrations are named `supabase/migrations/YYYYMMDDHHMMSS_name.sql`. Never edit an applied migration once it has been pushed to a shared environment; add a new one.
- Seed data lives only in `supabase/seed.sql` (local).

**Tests (required for every change)**
- Money, counts and permissions logic: pgTAP in `supabase/tests`.
- Pure logic: Vitest in `packages/core`.
- End-to-end API behaviour: `tests/integration`.

**Next.js 16**
- `src/proxy.ts`, not middleware.
- `cookies()`, `params` and `searchParams` are async.
- Read `apps/web/AGENTS.md` and `node_modules/next/dist/docs` before using unfamiliar APIs.
- Server pages read data through `@/lib/supabase/server` with the user's session. Client forms call the same RPCs the mobile app uses.

**Expo SDK 58**
- Read `apps/mobile/AGENTS.md`.
- Install native packages with `npx expo install` (in a sandbox without api.expo.dev, use `EXPO_OFFLINE=1 npx expo install …`).
- Routes live in `apps/mobile/src/app`.

## Environment variables
Every variable is documented in the root `.env.example`.

| Variable | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | apps/web | `apps/web/.env.local` |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | apps/mobile | `apps/mobile/.env.local` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | tests/integration | Optional; defaults to `supabase status` |

Later milestones add Razorpay (test keys only), WhatsApp Cloud API, Anthropic, Sentry and PostHog variables. They're listed, commented out, in `.env.example`.

## Secrets
- Never commit secrets. `.env*` files are gitignored except `.env.example`.
- Phone encryption keys live in **Supabase Vault**, never in code. Local dev keys are created by `seed.sql`.
- For each real project, run this once in the SQL editor, with values from a password manager:
  ```sql
  select vault.create_secret('<64 random chars>', 'phone_encryption_key');
  select vault.create_secret('<64 random chars>', 'phone_hash_key');
  ```
  Losing `phone_encryption_key` makes stored phone numbers unreadable. Rotating `phone_hash_key` requires re-hashing every number.

## Sandbox notes (cloud sessions)
- Start Docker with `dockerd &` if `docker info` fails.
- If image pulls from ECR or GHCR are rate-limited, pull from `mirror.gcr.io/library/<image>` and `docker tag` the result to the expected name.
- docs.expo.dev and api.expo.dev are blocked. Use the docs and types bundled in `node_modules`.
