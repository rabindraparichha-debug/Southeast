#!/usr/bin/env bash
# Builds an installable Android APK without EAS: `expo prebuild` on this machine, then Gradle inside
# a Docker image that has the Android SDK (no Android Studio needed).
#
#   apps/mobile/scripts/build-apk.sh                # test APK (server can be chosen on the login screen)
#   APP_VARIANT=store apps/mobile/scripts/build-apk.sh   # no server switch; uses .env.production values
#
# Signing: a local upload keystore at $ANDROID_KEYSTORE (default ~/.tiffin/upload.keystore) is created
# on first run. Keep it (and its password) in your password manager; never commit it. Store
# releases are normally signed by EAS instead (docs/RELEASE.md).
set -euo pipefail
MOBILE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$MOBILE/../.." && pwd)"
IMAGE="${ANDROID_IMAGE:-reactnativecommunity/react-native-android:latest}"
KEYSTORE="${ANDROID_KEYSTORE:-$HOME/.tiffin/upload.keystore}"
KEY_ALIAS="${ANDROID_KEY_ALIAS:-tiffin-upload}"
KEY_PASS="${ANDROID_KEY_PASSWORD:-}"
GRADLE_CACHE="${GRADLE_CACHE:-$HOME/.tiffin/gradle}"
# Optional Maven Central mirror, tried first (e.g. when repo.maven.apache.org rate-limits with 429):
#   MAVEN_MIRROR=https://maven-central.storage-download.googleapis.com/maven2/
MAVEN_MIRROR="${MAVEN_MIRROR:-}"
VARIANT="${APP_VARIANT:-test}"

if [[ -z "$KEY_PASS" ]]; then
  [[ -f "$HOME/.tiffin/keystore.pass" ]] || { mkdir -p "$HOME/.tiffin"; head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$HOME/.tiffin/keystore.pass"; }
  KEY_PASS="$(cat "$HOME/.tiffin/keystore.pass")"
fi
if [[ ! -f "$KEYSTORE" ]]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -v -storetype PKCS12 -keystore "$KEYSTORE" -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KEY_PASS" -keypass "$KEY_PASS" -dname "CN=Tiffin OS, O=Tiffin OS, L=Bhubaneswar, C=IN"
  echo "created upload keystore $KEYSTORE (password in ~/.tiffin/keystore.pass)"
fi

cd "$MOBILE"
if [[ "$VARIANT" == "test" ]]; then export EXPO_PUBLIC_ALLOW_SERVER_SWITCH=true; fi
EXPO_OFFLINE=1 CI=1 npx expo prebuild --platform android --clean --no-install
git -C "$REPO" checkout -- apps/mobile/package.json 2>/dev/null || true   # prebuild rewrites the "android" script

# Use the NDK the build image ships with (React Native asks for an older one Google won't let us download here).
NDK="$(docker run --rm "$IMAGE" bash -lc 'ls $ANDROID_HOME/ndk | sort -V | tail -1')"
sed -i "s|^apply plugin: \"expo-root-project\"|ext { ndkVersion = \"$NDK\" }\napply plugin: \"expo-root-project\"|" android/build.gradle
# Release signing with the upload keystore.
cp "$KEYSTORE" android/app/upload.keystore
python3 - "$KEY_ALIAS" "$KEY_PASS" <<'PY'
import sys, re
alias, pw = sys.argv[1], sys.argv[2]
p = 'android/app/build.gradle'; s = open(p).read()
s = s.replace("""    signingConfigs {
        debug {""", f"""    signingConfigs {{
        release {{
            storeFile file('upload.keystore')
            storePassword System.getenv('TIFFIN_KEY_PASS') ?: ''
            keyAlias '{alias}'
            keyPassword System.getenv('TIFFIN_KEY_PASS') ?: ''
        }}
        debug {{""", 1)
s = re.sub(r"(release \{\n\s+// Caution![^\n]*\n[^\n]*\n\s+)signingConfig signingConfigs.debug", r"\1signingConfig signingConfigs.release", s, 1)
open(p, 'w').write(s)
PY

mkdir -p "$GRADLE_CACHE"
rm -f "$GRADLE_CACHE/init.d/maven-mirror.gradle"
if [[ -n "$MAVEN_MIRROR" ]]; then
  mkdir -p "$GRADLE_CACHE/init.d"
  cat > "$GRADLE_CACHE/init.d/maven-mirror.gradle" <<GRADLE
def mirror = '$MAVEN_MIRROR'
// Every Maven Central repository (mavenCentral(), "MavenRepo") is pointed at the mirror.
def redirect = { repos -> repos.configureEach { r ->
  if (r instanceof MavenArtifactRepository && r.url.toString().contains('repo.maven.apache.org')) r.url = mirror
} }
beforeSettings { s ->
  redirect(s.pluginManagement.repositories)
  redirect(s.dependencyResolutionManagement.repositories)
  s.pluginManagement.repositories { maven { url mirror } }
}
beforeProject { p ->
  redirect(p.buildscript.repositories)
  redirect(p.repositories)
}
GRADLE
fi
PROXY_ARGS=()
[[ -n "${JAVA_TOOL_OPTIONS:-}" ]] && PROXY_ARGS+=(-e JAVA_TOOL_OPTIONS)
[[ -f /etc/ssl/certs/java/cacerts ]] && PROXY_ARGS+=(-v /etc/ssl/certs/java/cacerts:/etc/ssl/certs/java/cacerts:ro)
for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy NODE_EXTRA_CA_CERTS; do [[ -n "${!v:-}" ]] && PROXY_ARGS+=(-e "$v"); done
[[ -n "${NODE_EXTRA_CA_CERTS:-}" && -f "${NODE_EXTRA_CA_CERTS}" ]] && PROXY_ARGS+=(-v "$NODE_EXTRA_CA_CERTS:$NODE_EXTRA_CA_CERTS:ro")

docker run --rm --network host -v "$REPO:$REPO" -v "$GRADLE_CACHE:/root/.gradle" -e GRADLE_USER_HOME=/root/.gradle -w "$MOBILE/android" \
  -e TIFFIN_KEY_PASS="$KEY_PASS" -e EXPO_PUBLIC_ALLOW_SERVER_SWITCH="${EXPO_PUBLIC_ALLOW_SERVER_SWITCH:-}" -e CI=1 -e EXPO_OFFLINE=1 \
  "${PROXY_ARGS[@]}" "$IMAGE" \
  bash -lc 'ls $ANDROID_HOME/platforms | grep -q "^android-37$" || ln -sfn $ANDROID_HOME/platforms/android-37.0 $ANDROID_HOME/platforms/android-37 2>/dev/null; for i in 1 2 3 4 5; do ./gradlew --no-daemon assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a && exit 0; echo "gradle failed (attempt $i), retrying"; sleep 20; done; exit 1'

VERSION="$(node -p "require('./app.json').expo.version")"
mkdir -p "$MOBILE/dist"
OUT="$MOBILE/dist/tiffin-os-$VERSION-$VARIANT.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT"
echo "APK: $OUT ($(du -h "$OUT" | cut -f1))"
