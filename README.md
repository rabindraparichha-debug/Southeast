# Tiffin OS

A free operating system for small tiffin vendors in Bhubaneswar: daily counts, pauses, balances, payments, riders, inventory and WhatsApp. The vendor software stays free; the platform earns later from customers it brings.

- **Spec:** [`docs/SPEC.md`](docs/SPEC.md)
- **Status:** [`docs/PLAN.md`](docs/PLAN.md)
- **Decisions and open questions:** [`docs/DECISIONS.md`](docs/DECISIONS.md)
- **Commands and conventions:** [`CLAUDE.md`](CLAUDE.md)
- **Security review:** [`docs/SECURITY.md`](docs/SECURITY.md) · **Operations:** [`docs/OPERATIONS.md`](docs/OPERATIONS.md) · **Play Store release:** [`docs/RELEASE.md`](docs/RELEASE.md) · **WhatsApp templates:** [`docs/WHATSAPP_TEMPLATES.md`](docs/WHATSAPP_TEMPLATES.md)

## What's in it

| Area | For whom | Where |
|---|---|---|
| Daily counts, cutoffs, locks, production sheet, packing list | Owner, staff | Web dashboard, mobile app |
| Prepaid meal balances, Razorpay links (test mode), cash, dues, refunds | Owner | Web `/money`, mobile customer screen |
| WhatsApp bot (pause/skip/pay/menu/complaints, 3 languages), inbox, customer page | Customers, owner | One platform number, `/c/<token>` |
| Rider mode: stops, navigation, OTP/photo proof, offline sync, tiffins; live board, routes | Riders, owner | Mobile "My stops", web `/delivery` |
| Inventory: purchases, recipes, auto-deduction at lock, stock-take, alerts, cost per meal | Owner, staff | Web `/inventory`, `/reports/costs`, mobile "Stock" |
| New customers: website, WhatsApp bot, Google Ads, Justdial; matching; paid trials | Customers, platform | Web `/find`, `/kitchens`, `/k/<slug>` |
| New vendors: sign-up page and WhatsApp, onboarding checklist and nudges | Kitchen owners | Web `/vendors` |
| Admin: kitchens, leads, funnel, demand gaps, vendor applications, audit | Platform team | Web `/admin` |

## Quick start (local)

```bash
pnpm install
pnpm db:start && pnpm db:reset      # Supabase in Docker, with seeded kitchens, a week of meals, deliveries and stock
cp apps/web/.env.example apps/web/.env.local   # paste the anon key from `pnpm supabase status`
pnpm --filter @tiffin/web dev       # http://localhost:3000. Log in with 90000 00001, OTP 123456
```

## Checks

```bash
pnpm db:test                    # pgTAP: RLS, money, counts, delivery, acquisition, inventory, security
pnpm --filter @tiffin/core test
pnpm test:integration           # API end to end (needs a fresh db:reset)
pnpm db:loadtest                # 21:00 lock for 5,000 subscriptions (< 60 s)
pnpm db:restore-drill           # back up, restore, compare counts and ledger totals
```
