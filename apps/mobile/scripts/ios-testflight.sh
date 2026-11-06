#!/usr/bin/env bash
# One command from any folder on a Mac/Linux/WSL computer: gets the code, links the Expo project,
# creates the iOS signing certificate (asks for your Apple ID + 2FA the first time), then builds on
# Expo's servers and uploads to TestFlight.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/rabindraparichha-debug/Southeast/m9-p5-p6/apps/mobile/scripts/ios-testflight.sh)
#
# Env (optional): REPO_DIR (default ~/Southeast), BRANCH (default m9-p5-p6).
set -euo pipefail
REPO_URL="https://github.com/rabindraparichha-debug/Southeast.git"
BRANCH="${BRANCH:-m9-p5-p6}"
REPO_DIR="${REPO_DIR:-$HOME/Southeast}"
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

command -v git >/dev/null || { echo "Install Git first (macOS: xcode-select --install)"; exit 1; }
command -v node >/dev/null || { echo "Install Node 20+ first (https://nodejs.org)"; exit 1; }
command -v pnpm >/dev/null || { step "Installing pnpm"; npm install -g pnpm@10; }

if [[ -d "$REPO_DIR/.git" ]]; then
  step "Updating $REPO_DIR"
  git -C "$REPO_DIR" fetch origin "$BRANCH"
  git -C "$REPO_DIR" checkout "$BRANCH"
  git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"
else
  step "Cloning into $REPO_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
step "Installing dependencies"
pnpm install
cd apps/mobile
EAS="npx --yes eas-cli@latest"

step "Expo login"
$EAS whoami >/dev/null 2>&1 || $EAS login

if ! node -e "process.exit(require('./app.json').expo.extra?.eas?.projectId ? 0 : 1)"; then
  step "Linking the Expo project (answer Yes)"
  $EAS init
  git add app.json
  git commit -m "Link EAS project" >/dev/null && git push origin "$BRANCH" || echo "(Could not push app.json; push it later.)"
fi

step "iOS signing certificate and profile (log in to Apple: Yes; generate: Yes)"
$EAS credentials:configure-build -p ios -e production

step "Building on Expo and uploading to TestFlight (20-40 minutes)"
$EAS build -p ios --profile production --auto-submit

step "Done. Apple processes the build (usually under 30 minutes); then open TestFlight on your iPhone."
