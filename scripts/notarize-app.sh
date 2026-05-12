#!/usr/bin/env bash
#
# notarize-app.sh
# ───────────────
# Submit a signed .app to Apple's notary service and staple the result.
# Run this AFTER a Release `xcodebuild` produces a signed bundle. The script
# does not build — it just notarizes what's already on disk.
#
# Usage:
#   ./scripts/notarize-app.sh [/path/to/verso.app]
#
# If no path is given we use the standard Xcode Release output path.
#
# One-time setup before this script will work:
#   1. Generate an app-specific password at https://appleid.apple.com → Sign-In
#      and Security → App-Specific Passwords. Label it "Verso notarytool".
#   2. Store it in the keychain under the profile name "Verso":
#         xcrun notarytool store-credentials "Verso" \
#             --apple-id   you@example.com \
#             --team-id    2T2JL5F698 \
#             --password   <app-specific-password>
#
# Behavior:
#   • Zips the .app with `ditto` (the format notarytool expects).
#   • Submits and waits (notarytool blocks until Apple responds — usually
#     30s–10min depending on Apple's queue).
#   • On Accepted: staples the notarization ticket into the .app so Gatekeeper
#     accepts the bundle even offline.
#   • On Rejected: prints the log and exits non-zero. You can re-fetch with:
#         xcrun notarytool log <submission-id> --keychain-profile Verso

set -euo pipefail

DEFAULT_APP="${HOME}/Library/Developer/Xcode/DerivedData/verso-atniuskgwblnkdhajoplsblizihs/Build/Products/Release/verso.app"
APP_PATH="${1:-${DEFAULT_APP}}"
PROFILE="${VERSO_NOTARY_PROFILE:-Verso}"

if [ ! -d "${APP_PATH}" ]; then
    echo "error: app bundle not found at ${APP_PATH}" >&2
    echo "       hint: build the Release configuration first:" >&2
    echo "         DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \\" >&2
    echo "             -project verso.xcodeproj -scheme verso -configuration Release build" >&2
    exit 1
fi

# Sanity-check the signature locally before paying for the round trip.
echo "[notarize] verifying local signature"
if ! codesign --verify --deep --strict --verbose=2 "${APP_PATH}" 2>&1 | tail -5; then
    echo "error: codesign verification failed for ${APP_PATH}" >&2
    exit 1
fi

# Confirm we have a notarytool profile to use. `notarytool history` is cheap
# and exits non-zero if the profile name is unknown.
if ! xcrun notarytool history --keychain-profile "${PROFILE}" --output-format json >/dev/null 2>&1; then
    echo "error: notarytool profile '${PROFILE}' not found in keychain" >&2
    echo "       run the one-time setup from the script header" >&2
    exit 1
fi

ZIP_PATH="$(mktemp -d)/verso.zip"
trap 'rm -rf "$(dirname "${ZIP_PATH}")"' EXIT

echo "[notarize] zipping bundle for upload"
/usr/bin/ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"
zip_size=$(/usr/bin/du -h "${ZIP_PATH}" | cut -f1)
echo "[notarize] zip size: ${zip_size}"

echo "[notarize] submitting to Apple (this blocks until they respond — usually a few minutes)"
submission_output="$(xcrun notarytool submit "${ZIP_PATH}" \
    --keychain-profile "${PROFILE}" \
    --wait \
    --output-format json)"

echo "${submission_output}" | python3 -m json.tool

status="$(echo "${submission_output}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))")"
submission_id="$(echo "${submission_output}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")"

if [ "${status}" != "Accepted" ]; then
    echo ""
    echo "[notarize] submission ${submission_id} ended with status=${status}; fetching log"
    xcrun notarytool log "${submission_id}" --keychain-profile "${PROFILE}" || true
    exit 1
fi

echo "[notarize] stapling ticket into ${APP_PATH}"
xcrun stapler staple "${APP_PATH}"
xcrun stapler validate "${APP_PATH}"

echo "[notarize] verifying Gatekeeper accepts the notarized bundle"
spctl --assess --type execute --verbose=2 "${APP_PATH}"

echo "[notarize] done — ${APP_PATH} is signed, notarized, and stapled"
