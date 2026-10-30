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
- [ ] **Login for reviewers:** Google asks for test credentials. A store build only reaches the production backend, so add one reviewer number with a random code and a short expiry in the production Supabase dashboard, and remove it after the review (D-114; see "Reviewer login" under iOS).

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

iOS builds run on EAS (Expo's cloud Macs), started from GitHub Actions
(`.github/workflows/ios-testflight.yml`). **No Mac is needed at any point**: the Apple sites are web
pages, the one interactive step below runs on Windows or Linux (or a GitHub Codespace in the browser),
and testing needs an iPhone with the TestFlight app. Checked against eas-cli 27.2.0 and Apple's pages
on 2026-10-30.

### One-time setup, in this order

1. **Enrol in the Apple Developer Program** (Account Holder only).
   - In India, enrolment works only in the **Apple Developer app on an iPhone or iPad** (or an
     Apple-silicon Mac); use the same device from start to finish.
   - The Apple Account needs two-factor authentication, and its first and last name must match your
     legal name exactly.
   - 99 USD a year, charged in rupees (around ₹8,700).
   - **Individual** (also the only option for a sole proprietorship): no D-U-N-S number; your legal
     name is shown as the seller. **Organisation** (Pvt Ltd, LLP, partnership): needs a D-U-N-S number
     (free, about a week), a public website and email on the company's domain; the company is shown as
     the seller. Switching later needs Apple Developer Support.
2. **Accept the agreements** (Account Holder): the Program License Agreement on developer.apple.com,
   and App Store Connect → Business (Agreements). Uploads fail with "a required agreement is missing"
   until this is done, and again whenever Apple updates them.
3. **Turn on API access** (Account Holder): App Store Connect → Users and Access → Integrations →
   App Store Connect API → **Request Access**. Apple reviews it, so do this early.
4. **Create a Team API key**: same page → **Team Keys** → Generate API Key, access **Admin**. Note the
   **Issuer ID** (top of the page) and the **Key ID**, and **download the `.p8` file** (Apple allows one
   download only: keep it in a password manager, never in the repository). Do not use an "Individual"
   key: it cannot create signing certificates.
5. **Expo**: create an account at expo.dev (free plan works; it has a monthly iOS build allowance) and an
   access token (Account settings → Access tokens). Use **the same Expo account** for everything below.
6. **One interactive command, on any computer** (needs Git, Node 20+, pnpm 10). EAS never creates the
   iOS distribution certificate in an automated run, so this is required once (and again when the
   certificate expires, about yearly):

   ```bash
   git clone https://github.com/rabindraparichha-debug/Southeast && cd Southeast
   git checkout m9-p5-p6        # or master once this work is merged
   pnpm install
   cd apps/mobile
   npx eas-cli@latest login
   npx eas-cli@latest init      # links the project; commit and push the app.json change (owner + projectId)
   # Log in with the API key from step 4 (or skip these four lines and log in with your Apple ID + 2FA):
   export EXPO_ASC_API_KEY_PATH=/path/to/AuthKey_XXXXXXXXXX.p8
   export EXPO_ASC_KEY_ID=XXXXXXXXXX EXPO_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   export EXPO_APPLE_TEAM_ID=XXXXXXXXXX
   npx eas-cli@latest credentials:configure-build -p ios -e production
   ```

   Answer **Yes** to generating the distribution certificate and provisioning profile. This also
   registers the bundle id `in.tiffinos.vendor` with Apple (if another team already owns that id, pick a
   new one in `app.json` for iOS and Android).
7. **Create the app record**: App Store Connect → Apps → + → New App: platform iOS, name "Tiffin OS"
   (must be free on the App Store; pick another if not), bundle id `in.tiffinos.vendor`, SKU `tiffin-os`.
   Open App Information and copy the numeric **Apple ID**.
8. **Backend for the build** (same Expo account):

   ```bash
   npx eas-cli@latest env:create --name EXPO_PUBLIC_SUPABASE_URL --value https://<project>.supabase.co --environment production --visibility plaintext
   npx eas-cli@latest env:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key> --environment production --visibility plaintext
   npx eas-cli@latest env:create --name EXPO_PUBLIC_WEB_URL --value https://<web app> --environment production --visibility plaintext
   ```

   Without the first two the app installs but cannot log in. `EXPO_PUBLIC_WEB_URL` shows the privacy
   policy and terms links Apple requires inside the app.
9. **GitHub → Settings → Secrets and variables → Actions → Repository secrets:**

   | Secret | Value |
   |---|---|
   | `EXPO_TOKEN` | the Expo access token (step 5) |
   | `APPLE_ASC_APP_ID` | the app's Apple ID, digits only (step 7) |
   | `APPLE_ASC_KEY_ID`, `APPLE_ASC_ISSUER_ID` | from step 4 |
   | `APPLE_ASC_KEY_P8` | the whole `.p8` file, including the BEGIN/END PRIVATE KEY lines |
   | `APPLE_TEAM_ID` | developer.apple.com → Account → Membership details |

   For an individual account also add the **Variable** (Variables tab, not Secrets)
   `APPLE_TEAM_TYPE=INDIVIDUAL`.

### Each release

Push a branch named `ios/<anything>` (or a `mobile-v*` tag; the Actions "Run workflow" button appears
once the workflow is on the default branch). The workflow builds on EAS (20–40 minutes, longer in the
free queue) and uploads to App Store Connect with the API key. Apple then processes the build (usually
minutes to half an hour, no guarantee).

### Testers

- **Internal (no review, up to 100):** on the first upload EAS creates an internal TestFlight group
  "Team (Expo)" that gets every build and invites Admin-role users. Anyone else (staff, riders) must
  first be invited as an App Store Connect user (Users and Access, Developer or Marketing role), then
  added to that group. Testers install the TestFlight app on their iPhone and accept the invite.
- **External (up to 10,000, email or public link):** fill in TestFlight → Test Information (description,
  feedback email, contact, privacy policy URL, sign-in details), add the build to an external group and
  Submit for Review. The first build of each version gets Apple's beta review (usually 24–48 hours).
- **Reviewer login:** Apple's reviewer cannot receive an SMS, and a store build only talks to the
  production backend. Add **one** reviewer number in the production Supabase dashboard (Authentication →
  Providers → Phone → Test phone numbers) with a **random** code (never `123456`) and a short expiry
  covering the review, owned by a demo kitchen in draft with sample customers on numbers you own.
  Remove it after the review (D-114). Never run `supabase config push` with this repo's `config.toml`:
  it would copy the local seed test numbers to the hosted project.
- Builds expire after 90 days. Export compliance is pre-answered (`ITSAppUsesNonExemptEncryption = false`).

### Before external testing or the App Store

- In-app **account deletion** is required by Apple guideline 5.1.1(v) for apps where people create
  accounts; it is not built yet (internal TestFlight testing does not need it).
- The privacy policy page must be final (operator name, address and grievance contact in
  `apps/web/src/components/legal.tsx`, `NEXT_PUBLIC_GRIEVANCE_CONTACT`) and publicly deployed.
- Real OTP delivery (D-004) must work on the production project, or testers cannot log in with their
  own numbers.

iOS settings already in `app.json`: bundle id, build number (EAS auto-increments it remotely),
`ITSAppUsesNonExemptEncryption = false` (only standard HTTPS), camera and location texts.
