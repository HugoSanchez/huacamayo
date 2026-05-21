#!/usr/bin/env bash
#
# copy-runtime-bundles.sh
# ───────────────────────
# Xcode Run Script build phase. Runs at the end of the verso target build.
#
#   • Debug builds: no-op. SidecarManager.swift falls back to the developer's
#     system `node` and `desktop/orchestrator/`, so daily Cmd+R in Xcode keeps
#     working without bundling.
#
#   • Release builds: rsyncs desktop/runtime-bundles/ into the .app's
#     Resources/ directory so the shipping bundle contains everything it needs
#     to run on a friend's Mac without `brew install node`.
#
# Inputs (from Xcode):
#   CONFIGURATION                 "Debug" or "Release"
#   SRCROOT                       repo root (xcodeproj sits there)
#   BUILT_PRODUCTS_DIR            wherever Xcode is writing the .app to
#   CONTENTS_FOLDER_PATH          e.g. "verso.app/Contents"
#
# Pre-requisite for Release: ./scripts/build-runtime-bundles.sh must have been
# run at least once. The script below fails loudly if desktop/runtime-bundles/
# is missing — much better than producing a silently-broken Release .app.

set -euo pipefail

if [ "${CONFIGURATION:-}" != "Release" ]; then
    echo "[copy-bundles] config=${CONFIGURATION:-unknown}, skipping"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUNDLE_SRC="${REPO_ROOT}/desktop/runtime-bundles"
RESOURCES_DST="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Resources"

required_paths=(
    "${BUNDLE_SRC}/node/bin"
    "${BUNDLE_SRC}/orchestrator/node_modules"
    "${BUNDLE_SRC}/python/arm64/python/bin"
    "${BUNDLE_SRC}/site-packages/arm64/site-packages"
    "${BUNDLE_SRC}/site-packages/arm64/bin/hermes"
    "${BUNDLE_SRC}/hermes-defaults"
    "${BUNDLE_SRC}/BUNDLE_VERSION"
)
for p in "${required_paths[@]}"; do
    if [ ! -e "${p}" ]; then
        echo "error: desktop/runtime-bundles/ is missing or incomplete (no ${p})." >&2
        echo "       Run: ./scripts/build-runtime-bundles.sh" >&2
        echo "       Then rebuild the Release archive." >&2
        exit 1
    fi
done

# Wipe any stale wheels/ dir from a previous bundle layout — leaving it would
# bloat the .app and re-introduce the notarization failures that motivated
# the switch to pre-installed site-packages.
rm -rf "${RESOURCES_DST}/wheels"

mkdir -p \
    "${RESOURCES_DST}/node" \
    "${RESOURCES_DST}/orchestrator" \
    "${RESOURCES_DST}/python" \
    "${RESOURCES_DST}/site-packages" \
    "${RESOURCES_DST}/hermes-defaults"

echo "[copy-bundles] copying runtime bundles into ${CONTENTS_FOLDER_PATH}/Resources/"
rsync -a --delete "${BUNDLE_SRC}/node/" "${RESOURCES_DST}/node/"
rsync -a --delete "${BUNDLE_SRC}/orchestrator/" "${RESOURCES_DST}/orchestrator/"
rsync -a --delete "${BUNDLE_SRC}/python/" "${RESOURCES_DST}/python/"
rsync -a --delete "${BUNDLE_SRC}/site-packages/" "${RESOURCES_DST}/site-packages/"
rsync -a --delete "${BUNDLE_SRC}/hermes-defaults/" "${RESOURCES_DST}/hermes-defaults/"
cp "${BUNDLE_SRC}/BUNDLE_VERSION" "${RESOURCES_DST}/BUNDLE_VERSION"

echo "[copy-bundles] done"
