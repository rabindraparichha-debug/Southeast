# Play Store release (M8, package 4.7)

The vendor app (owners, staff and rider mode) ships to Android first. Builds run on Expo's EAS service. Nothing here has been run yet: it needs your Expo and Google Play accounts. expo.dev was unreachable from the build sandbox, so no build has been made.

## What is already set up in the repo

- `apps/mobile/eas.json`:
  - `development`: dev-client APK for testing on a phone;
  - `preview`: internal APK for pilot vendors;
  - `production`: app bundle with auto-incremented version code; submits to the internal testing track as a draft.
- `apps/mobile/app.json`:
  - package `in.tiffinos.vendor`, `versionCode` 1, `runtimeVersion` from the app version (for OTA updates);
  - permission texts for the camera (delivery proof, supplier bills) and location (where a delivery was marked);
  - unused permissions are blocked (microphone, media library, storage, background location).
- Error reporting: set `EXPO_PUBLIC_SENTRY_DSN` (optional).

## One-time setup (your accounts)

1. **Expo account:** `npx eas-cli@latest login`, then in `apps/mobile`: `npx eas-cli@latest init` (creates the EAS project and writes `extra.eas.projectId` into `app.json`; commit it).
2. **Environment for builds:**

   ```bash
   eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value https://<project>.supabase.co --environment production
   eas env:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key> --environment production
   ```

   Add the same for `preview` (staging project).
3. **Signing:** let EAS create and keep the Android upload keystore on the first build. Download a copy into your password manager (`eas credentials`).
4. **Google Play Console:**
   - Create the developer account (one-time fee; organisation accounts need a D-U-N-S number) and the app "Tiffin OS".
   - Create a service account with release permissions for `eas submit`, and save its JSON key outside the repo.

## Each release

```bash
cd apps/mobile
pnpm typecheck && pnpm lint
npx eas-cli@latest build --platform android --profile production
npx eas-cli@latest submit --platform android --profile production   # internal track, draft
```

Then promote internal → closed testing (pilot vendors) → production in the Play Console.

**JavaScript-only fixes** can go out without a store release: `npx eas-cli@latest update --channel production`. The runtime version follows the app version, so bump `version` in `app.json` whenever native code or permissions change.

## Store listing checklist

- [ ] Privacy policy URL: `https://<web>/privacy`. Terms: `https://<web>/terms`.
- [ ] **Data safety form.** Data collected:
  - phone number (login, customers' numbers stored encrypted);
  - precise location (only when a delivery is marked, and the kitchen pin);
  - photos (delivery proof, supplier bills, kitchen photos);
  - app activity (crash logs, if Sentry is on).

  Not sold, not shared for ads. Encrypted in transit. Deletion on request.
- [ ] **Permissions declaration:** camera and foreground location only; no background location.
- [ ] **Target audience:** adults (business users); not designed for children.
- [ ] **Content rating questionnaire:** utility/business.
- [ ] **Screenshots:** Today counts, customer list, rider stops, stock. Use the seed data, not real customers.
- [ ] **Login for reviewers:** Google asks for test credentials. Use a staging project with a test OTP number (Supabase `test_otp`), never production.

## Before the first production release

- Production Supabase project with Vault keys, the real OTP channel (D-004), no `test_otp` numbers (docs/SECURITY.md checklist).
- WhatsApp templates approved by Meta (docs/WHATSAPP_TEMPLATES.md).
- Odia/Hindi texts reviewed by a native speaker (D-006, D-057).
- Test on two or three low-end Android phones (2–3 GB RAM, Android 10+), including rider mode with mobile data switched off mid-run.
