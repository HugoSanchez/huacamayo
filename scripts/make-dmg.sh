#!/usr/bin/env bash
#
# make-dmg.sh
# ───────────
# Wrap the notarized verso.app in a drag-to-Applications DMG using
# `create-dmg`. Run this AFTER notarize-app.sh has stapled the .app.
# The DMG is signed, submitted to Apple's notary service, and stapled too
# so the downloaded disk image itself passes Gatekeeper assessment.
#
# One-time setup:
#   brew install create-dmg
#
# Usage:
#   ./scripts/make-dmg.sh                       # uses default Release path
#   ./scripts/make-dmg.sh /path/to/verso.app    # custom path
#
# Optional env:
#   VERSO_NOTARY_PROFILE default: Verso
#   VERSO_NOTARIZE_DMG   default: 1; set to 0 for local-only unsigned testing
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

# create-dmg normally uses AppleScript to ask Finder to position icons and
# hide extensions. That is fragile in CI/sandboxed terminals because macOS
# TCC may block Apple Events to Finder (-1743). Default to the Finder-free
# path; set VERSO_DMG_USE_FINDER_STYLING=1 locally if you explicitly want the
# pretty Finder layout and have granted Automation permission.
CREATE_DMG_ARGS=(
    --volname "Verso ${VERSION}"
    --app-drop-link 425 190
    --no-internet-enable
)

if [ "${VERSO_DMG_USE_FINDER_STYLING:-0}" = "1" ]; then
    CREATE_DMG_ARGS+=(
        --window-pos 200 120
        --window-size 600 380
        --icon-size 100
        --icon "verso.app" 175 190
        --hide-extension "verso.app"
    )
else
    CREATE_DMG_ARGS+=(--skip-jenkins)
fi

# Clean up temporary read-write images left behind by interrupted or failed
# create-dmg runs, e.g. Finder AppleScript authorization failures.
rm -f "${DIST_DIR}/rw."*"$(basename "${DMG_PATH}")"

create-dmg \
    "${CREATE_DMG_ARGS[@]}" \
    "${DMG_PATH}" \
    "${STAGE_DIR}" >/dev/null

# Sign the DMG itself with Developer ID before submitting it for notarization.
echo "[make-dmg] signing DMG"
IDENTITY="Developer ID Application: Hugo Sanchez (2T2JL5F698)"
/usr/bin/codesign --force --sign "${IDENTITY}" --timestamp "${DMG_PATH}"

if [ "${VERSO_NOTARIZE_DMG:-1}" = "1" ]; then
    PROFILE="${VERSO_NOTARY_PROFILE:-Verso}"
    if ! xcrun notarytool history --keychain-profile "${PROFILE}" --output-format json >/dev/null 2>&1; then
        echo "error: notarytool profile '${PROFILE}' not found in keychain" >&2
        echo "       run the one-time setup from scripts/notarize-app.sh" >&2
        exit 1
    fi

    echo "[make-dmg] submitting DMG for notarization"
    submission_output="$(xcrun notarytool submit "${DMG_PATH}" \
        --keychain-profile "${PROFILE}" \
        --wait \
        --output-format json)"
    echo "${submission_output}" | python3 -m json.tool

    status="$(echo "${submission_output}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))")"
    submission_id="$(echo "${submission_output}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")"
    if [ "${status}" != "Accepted" ]; then
        echo ""
        echo "[make-dmg] submission ${submission_id} ended with status=${status}; fetching log"
        xcrun notarytool log "${submission_id}" --keychain-profile "${PROFILE}" || true
        exit 1
    fi

    echo "[make-dmg] stapling ticket into DMG"
    xcrun stapler staple "${DMG_PATH}"
    xcrun stapler validate "${DMG_PATH}"
    spctl --assess --type open --context context:primary-signature --verbose=2 "${DMG_PATH}"
fi

dmg_size=$(du -h "${DMG_PATH}" | cut -f1)
echo "[make-dmg] done — ${DMG_PATH} (${dmg_size})"
