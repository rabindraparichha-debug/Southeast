# Mobile releases: Play Store, test APK, TestFlight

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

## Test APK without EAS (M9)

`apps/mobile/scripts/build-apk.sh` builds a signed APK on any Linux/macOS machine with Docker and
Node (no Android Studio): `expo prebuild`, then Gradle inside `reactnativecommunity/react-native-android`.

```bash
apps/mobile/scripts/build-apk.sh                      # test APK → apps/mobile/dist/tiffin-os-<version>-test.apk
APP_VARIANT=store apps/mobile/scripts/build-apk.sh    # no server switch
MAVEN_MIRROR=https://maven-central.storage-download.googleapis.com/maven2/ apps/mobile/scripts/build-apk.sh  # if Maven Central rate-limits
```

- **Test builds** (`APP_VARIANT=test`, the default) show "Server: … (tap to change)" on the login
  screen: enter a Supabase URL and anon key (your laptop's LAN IP, or a staging project), save and
  restart the app. Store builds never show it (`EXPO_PUBLIC_ALLOW_SERVER_SWITCH` unset).
- **Signing:** the first run creates `~/.tiffin/upload.keystore` and its password in
  `~/.tiffin/keystore.pass`. Android only installs an update signed with the same key, so keep both
  in your password manager; never commit them. For the Play Store, EAS signing is still the plan.
- **CI:** `.github/workflows/android-apk.yml` (Actions → Android APK → Run workflow, or push a tag
  `mobile-v1.0.1`, or push a branch named `apk/<anything>`) runs the same script, attaches the APK to the run and publishes it as a pre-release `apk-build-<n>` (open the release page on the phone to install). Secrets:
  `ANDROID_KEYSTORE_BASE64` (`base64 -w0 ~/.tiffin/upload.keystore`), `ANDROID_KEY_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`.

## iOS and TestFlight (M9)

iOS builds need macOS and an Apple Developer account, so they run on EAS (Expo's cloud Macs),
triggered from GitHub Actions: `.github/workflows/ios-testflight.yml`.

One-time setup:

1. **Apple Developer Program** (paid yearly; an organisation needs a D-U-N-S number).
2. **App Store Connect → Apps → +:** platform iOS, name "Tiffin OS", bundle id `in.tiffinos.vendor`
   (register it first under Certificates, Identifiers & Profiles → Identifiers), SKU `tiffin-os`.
   Note the app's **Apple ID** (App Information, digits).
3. **App Store Connect API key:** Users and Access → Integrations → App Store Connect API → generate
   a key with the *App Manager* role. Download the `.p8` (only once), note the Key ID and Issuer ID.
4. **Expo:** `npx eas-cli@latest init` in `apps/mobile` (commit the `projectId` it writes to
   `app.json`), then create an access token at expo.dev → Account settings → Access tokens.
5. **First build once from your computer** so EAS creates and stores the distribution certificate
   and provisioning profile: `cd apps/mobile && npx eas-cli@latest build -p ios --profile production`
   (answer "yes" to letting EAS manage credentials; log in with your Apple ID).
6. **Backend for the build:** `eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value … --environment production`
   and the same for `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
7. **GitHub → Settings → Secrets and variables → Actions:**

   | Secret | Value |
   |---|---|
   | `EXPO_TOKEN` | the Expo access token |
   | `APPLE_ASC_APP_ID` | the app's Apple ID (digits) |
   | `APPLE_ASC_KEY_ID`, `APPLE_ASC_ISSUER_ID` | from step 3 |
   | `APPLE_ASC_KEY_P8` | the whole contents of the `.p8` file |
   | `APPLE_TEAM_ID` | developer.apple.com → Membership |

   Variable `APPLE_TEAM_TYPE=INDIVIDUAL` if it is a personal developer account.

Each release: Actions → **iOS TestFlight** → Run workflow (or push a `mobile-v*` tag). The build takes
20–40 minutes; the upload then appears in TestFlight after Apple's processing (about 10–30 minutes).
Add testers in App Store Connect → TestFlight (internal testers need no review; external testers
need a one-time beta review with a test login: a staging project with a `test_otp` number).

iOS-specific settings already in `app.json`: bundle id, build number (EAS auto-increments it),
`ITSAppUsesNonExemptEncryption = false` (only standard HTTPS), camera and location texts.
