#!/usr/bin/env bash
#
# Build and run the macOS app under Conductor control. Keep the app in the
# foreground so Conductor Stop can terminate the process it launched.

set -euo pipefail

WORKSPACE_PATH="${CONDUCTOR_WORKSPACE_PATH:-$(pwd)}"
cd "${WORKSPACE_PATH}"

export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"

if [ ! -d "${DEVELOPER_DIR}" ]; then
    echo "[conductor-run] ERROR: Xcode not found at ${DEVELOPER_DIR}" >&2
    exit 1
fi

if pgrep -x "verso" >/dev/null 2>&1; then
    cat >&2 <<'EOF'
[conductor-run] ERROR: a Verso app process is already running.

Quit the current app before starting this Conductor run. Verso/Hermes currently
share user account and Hermes state, and this run script intentionally refuses
to launch a second instance against that state.
EOF
    exit 1
fi

"${WORKSPACE_PATH}/scripts/conductor-setup.sh"

xcodebuild \
    -project "${WORKSPACE_PATH}/verso.xcodeproj" \
    -scheme "verso" \
    -configuration "Debug" \
    -derivedDataPath "${WORKSPACE_PATH}/DerivedData" \
    build

app_path="$(
    xcodebuild \
        -project "${WORKSPACE_PATH}/verso.xcodeproj" \
        -scheme "verso" \
        -configuration "Debug" \
        -derivedDataPath "${WORKSPACE_PATH}/DerivedData" \
        -showBuildSettings \
        2>/dev/null \
        | awk -F ' = ' '
            $1 ~ /^[[:space:]]*TARGET_BUILD_DIR$/ { target=$2 }
            $1 ~ /^[[:space:]]*WRAPPER_NAME$/ { wrapper=$2 }
            END {
                if (target != "" && wrapper != "") {
                    print target "/" wrapper
                }
            }
        '
)"

binary_path="${app_path}/Contents/MacOS/verso"
if [ ! -x "${binary_path}" ]; then
    echo "[conductor-run] ERROR: built app binary not found at ${binary_path}" >&2
    exit 1
fi

echo "[conductor-run] launching ${binary_path}"
exec "${binary_path}"
