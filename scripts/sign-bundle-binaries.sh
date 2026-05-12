#!/usr/bin/env bash
#
# sign-bundle-binaries.sh
# ───────────────────────
# Xcode Run Script build phase. After Bundle Runtime Components copies the
# node + python + orchestrator + wheels artifacts into Resources/, this
# script signs every Mach-O binary under Resources/ with our Developer ID
# identity + hardened runtime + entitlements. Xcode's own signing step then
# re-signs the outer .app last, which is the order codesign requires.
#
#   • Debug builds: no-op. Local "Sign to Run Locally" ad-hoc signature
#     is good enough for Cmd+R.
#
#   • Release builds: signs every node / python / *.dylib / *.so found
#     under $RESOURCES with the same identity + entitlements Xcode uses
#     for the outer app.
#
# Wheels (.whl files) are NOT signed — their .so contents extract into the
# user's venv at first launch, and Python loads them under our hardened-
# runtime + disable-library-validation entitlement, which permits unsigned
# dylibs in our process.

set -euo pipefail

if [ "${CONFIGURATION:-}" != "Release" ]; then
    echo "[sign-bundles] config=${CONFIGURATION:-unknown}, skipping"
    exit 0
fi

IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY_NAME:-${CODE_SIGN_IDENTITY:-}}"
if [ -z "${IDENTITY}" ] || [ "${IDENTITY}" = "-" ]; then
    echo "[sign-bundles] no Developer ID identity configured (got '${IDENTITY:-empty}'), skipping" >&2
    echo "                hint: set CODE_SIGN_IDENTITY=\"Developer ID Application\" in the Release build settings" >&2
    exit 0
fi

ENTITLEMENTS_REL="${CODE_SIGN_ENTITLEMENTS:-}"
if [ -z "${ENTITLEMENTS_REL}" ] || [ ! -f "${SRCROOT}/${ENTITLEMENTS_REL}" ]; then
    echo "[sign-bundles] entitlements file missing: ${SRCROOT}/${ENTITLEMENTS_REL:-<unset>}" >&2
    exit 1
fi
ENTITLEMENTS="${SRCROOT}/${ENTITLEMENTS_REL}"

RESOURCES="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Resources"
if [ ! -d "${RESOURCES}" ]; then
    echo "[sign-bundles] Resources dir not found: ${RESOURCES}" >&2
    exit 1
fi

echo "[sign-bundles] identity: ${IDENTITY}"
echo "[sign-bundles] scanning ${RESOURCES} for Mach-O binaries"

# Find every candidate file and ask `file(1)` whether it's a Mach-O. This is
# cheaper than signing every executable bit, and it skips the bash scripts
# in node_modules/.bin which set +x but aren't Mach-O.
candidates_file="$(mktemp)"
find "${RESOURCES}" \
    \( -path '*/__pycache__' -o -path '*/wheels' \) -prune -o \
    \( -name '*.dylib' -o -name '*.so' -o -type f \) -print > "${candidates_file}"

# Sign dylibs/.so first (deepest dependencies), then executables. codesign
# permits any order for siblings, but keeping it deep-first matches Apple's
# guidance and makes failures easier to diagnose.
binaries=()
while IFS= read -r path; do
    if [ ! -f "${path}" ]; then continue; fi
    # `file -b` is fast; we only care about the magic.
    kind="$(/usr/bin/file -b "${path}" 2>/dev/null || echo "")"
    case "${kind}" in
        *Mach-O*)
            binaries+=("${path}")
            ;;
    esac
done < "${candidates_file}"
rm -f "${candidates_file}"

count=${#binaries[@]}
echo "[sign-bundles] signing ${count} binaries"

# Sort: dylib/so first, then the rest.
sorted=()
for b in "${binaries[@]}"; do
    case "${b}" in
        *.dylib|*.so) sorted+=("${b}") ;;
    esac
done
for b in "${binaries[@]}"; do
    case "${b}" in
        *.dylib|*.so) ;;
        *) sorted+=("${b}") ;;
    esac
done

for path in "${sorted[@]}"; do
    /usr/bin/codesign \
        --force \
        --sign "${IDENTITY}" \
        --options runtime \
        --entitlements "${ENTITLEMENTS}" \
        --timestamp \
        "${path}" 2>&1 | sed 's/^/[sign-bundles]   /'
done

echo "[sign-bundles] done — signed ${count} binaries"
