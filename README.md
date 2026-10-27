# Tiffin OS

A free operating system for small tiffin vendors in Bhubaneswar: daily counts, pauses, balances, payments, riders, inventory and WhatsApp. The vendor software stays free; the platform earns later from customers it brings.

- **Spec:** [`docs/SPEC.md`](docs/SPEC.md)
- **Status:** [`docs/PLAN.md`](docs/PLAN.md)
- **Decisions and open questions:** [`docs/DECISIONS.md`](docs/DECISIONS.md)
- **Commands and conventions:** [`CLAUDE.md`](CLAUDE.md)

## Quick start (local)

```bash
pnpm install
pnpm db:start && pnpm db:reset      # Supabase in Docker, with 2 seeded kitchens
cp apps/web/.env.example apps/web/.env.local   # paste the anon key from `pnpm supabase status`
pnpm --filter @tiffin/web dev       # http://localhost:3000. Log in with 90000 00001, OTP 123456
```
