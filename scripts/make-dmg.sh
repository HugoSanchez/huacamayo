#!/usr/bin/env bash
#
# make-dmg.sh
# ───────────
# Wrap the notarized verso.app in a drag-to-Applications DMG using
# `create-dmg`. Run this AFTER notarize-app.sh has stapled the .app —
# DMGs themselves don't get notarized, the .app inside them does, and
# Gatekeeper validates by reading the stapled ticket inside.
#
# One-time setup:
#   brew install create-dmg
#
# Usage:
#   ./scripts/make-dmg.sh                       # uses default Release path
#   ./scripts/make-dmg.sh /path/to/verso.app    # custom path
#
# Output:
#   ./dist/verso-<MARKETING_VERSION>.dmg
#
# The version is read from Contents/Info.plist (CFBundleShortVersionString)
# so we never have to remember to bump it in two places.

set -euo pipefail

DEFAULT_APP="${HOME}/Library/Developer/Xcode/DerivedData/verso-atniuskgwblnkdhajoplsblizihs/Build/Products/Release/verso.app"
APP_PATH="${1:-${DEFAULT_APP}}"

if [ ! -d "${APP_PATH}" ]; then
    echo "error: app bundle not found at ${APP_PATH}" >&2
    exit 1
fi

if ! command -v create-dmg >/dev/null 2>&1; then
    echo "error: create-dmg not installed" >&2
    echo "       run: brew install create-dmg" >&2
    exit 1
fi

# Read the marketing version from Info.plist so the DMG name matches what
# the user sees in About verso. CFBundleShortVersionString is the visible
# version ("1.0"); CFBundleVersion is the build number ("1") which doesn't
# belong in the user-facing DMG name.
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP_PATH}/Contents/Info.plist")"
if [ -z "${VERSION}" ]; then
    echo "error: could not read CFBundleShortVersionString from ${APP_PATH}/Contents/Info.plist" >&2
    exit 1
fi

# Sanity-check that the .app is signed + stapled. Cheap to verify; saves
# a friend from downloading a DMG that pops a Gatekeeper warning.
echo "[make-dmg] verifying notarization staple"
if ! xcrun stapler validate "${APP_PATH}" >/dev/null 2>&1; then
    echo "error: ${APP_PATH} is not stapled. Run ./scripts/notarize-app.sh first." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${REPO_ROOT}/dist"
DMG_PATH="${DIST_DIR}/verso-${VERSION}.dmg"

mkdir -p "${DIST_DIR}"
rm -f "${DMG_PATH}"

echo "[make-dmg] building ${DMG_PATH} from ${APP_PATH}"

# Stage in a temp dir so create-dmg only sees verso.app — without this
# it'd also pick up whatever else is in the staging dir (other .apps,
# .DS_Store, ...). We copy rather than symlink because create-dmg writes
# only the symlink (not the target) into the DMG, producing a tiny
# broken bundle. ~200MB copy completes in seconds on SSD.
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "${STAGE_DIR}"' EXIT
echo "[make-dmg] staging .app (this copies ~200MB)"
/bin/cp -R "${APP_PATH}" "${STAGE_DIR}/verso.app"

# Window geometry: 600x380 is the canonical drag-to-Applications size most
# users have muscle memory for. Two icons: the app on the left, the
# Applications symlink on the right with an arrow between (create-dmg
# draws this for us when both --icon and --app-drop-link are set).
create-dmg \
    --volname "Verso ${VERSION}" \
    --window-pos 200 120 \
    --window-size 600 380 \
    --icon-size 100 \
    --icon "verso.app" 175 190 \
    --app-drop-link 425 190 \
    --hide-extension "verso.app" \
    --no-internet-enable \
    "${DMG_PATH}" \
    "${STAGE_DIR}" >/dev/null

# Sign the DMG itself with Developer ID. Optional for Gatekeeper (the
# .app inside is the one being checked) but it's a freebie and means the
# DMG opens without any "downloaded from internet" prompts beyond the
# standard quarantine flag.
echo "[make-dmg] signing DMG"
IDENTITY="Developer ID Application: Hugo Sanchez (2T2JL5F698)"
/usr/bin/codesign --force --sign "${IDENTITY}" --timestamp "${DMG_PATH}"

dmg_size=$(du -h "${DMG_PATH}" | cut -f1)
echo "[make-dmg] done — ${DMG_PATH} (${dmg_size})"
