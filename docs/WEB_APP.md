# Installable web app (M9)

The web dashboard (`apps/web`) is also an installable app (PWA). Everything the Expo vendor app does
works in the browser, including rider mode with an offline queue and quick stock entry, so a vendor
can start without installing anything from a store.

## Installing

- **Android / desktop Chrome or Edge:** the "Install app" button (sidebar, or the banner on the phone
  pages) opens the browser's install prompt.
- **iPhone / iPad (Safari):** Share → Add to Home Screen (the app shows these steps; iOS has no prompt).
- Needs HTTPS in production (localhost is exempt). The service worker registers only in production
  builds (`pnpm --filter @tiffin/web build && pnpm --filter @tiffin/web start` to try it locally).

## What works offline

| Page | Offline |
|---|---|
| `/rider` (riders, and owners via "Deliver") | Yes. Opens offline; deliveries, failures, tiffin counts and cash are queued with the tap time and photos, and synced when the connection returns (every 30 s, on reconnect and when the app comes back to the front). |
| `/stock-entry` (owners and staff) | The list opens offline with the last data; purchases, waste and stock-takes need a connection. |
| Other dashboard pages and `/c/*` customer pages | No, on purpose (they hold customer data). Offline they show "You are offline". |

The rider queue (`apps/web/src/lib/rider-store.ts`) is a port of the mobile one
(`apps/mobile/src/lib/rider-store.ts`): every action carries a client op id (idempotent on the server)
and the device time (`p_at`). Photos are kept as bytes in IndexedDB until uploaded (downscaled in the
browser: 1280 px for proofs, 1600 px for bills). Log-out is blocked while actions are still queued.

## Pieces

- `src/app/manifest.ts`, `public/icons/`: name, theme colour, shortcuts to `/rider` and `/stock-entry`.
- `public/sw.js`: network-first with a cached copy for `/rider` and `/stock-entry`; build files
  stale-while-revalidate (max 300); Supabase calls, `/c/*`, `/api/*` and other pages never cached;
  cache cleared on log-out. **Bump `VERSION` in `sw.js` whenever its logic changes.**
- `src/components/pwa.tsx`: install button and iOS instructions.
- `src/app/(field)/`: phone-first layout, `rider/` and `stock-entry/`.
- Role routing: riders always land on `/rider`; owners get "Deliver"; owners and staff get "Stock entry".

## Limits

- No background sync on the web: the queue syncs only while the app is open; location pings only with
  the page in front.
- Safari may clear storage of sites that are not installed after about 7 days unused; installed apps keep it.
- Two open tabs may both sync; safe, because every action is idempotent on its client op id.
