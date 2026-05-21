#!/usr/bin/env bash
#
# test-as-fresh-install.sh
# ────────────────────────
# Simulate a fresh-Mac install of the notarized Verso .app so you can
# repro friend-bound bugs locally before shipping. Backs up your dev
# state, wipes the per-user Verso footprint, opens the bundled .app,
# and provides a restore subcommand to put things back when you're done.
#
# Usage:
#   ./scripts/test-as-fresh-install.sh start    # Stash dev state + launch the bundled .app
#   ./scripts/test-as-fresh-install.sh restore  # Restore your dev state and quit Verso
#   ./scripts/test-as-fresh-install.sh status   # Show whether a stash is currently active
#
# What gets stashed (so a fresh-install run can't see your dev creds):
#   ~/.hermes/                                                 (your dev Hermes home)
#   ~/Library/Application Support/Verso/                       (Verso's per-user state)
#   ~/Library/Logs/verso/                                      (Verso's logs)
#
# Everything moves to ~/.verso-test-stash/<timestamp>/ — nothing is
# deleted. Restoring puts the directories back exactly as they were.

set -euo pipefail

CMD="${1:-help}"

STASH_ROOT="${HOME}/.verso-test-stash"
ACTIVE_STASH="${STASH_ROOT}/active"

DEV_HERMES="${HOME}/.hermes"
APP_SUPPORT="${HOME}/Library/Application Support/Verso"
LOGS_DIR="${HOME}/Library/Logs/verso"

APP_PATH="${HOME}/Library/Developer/Xcode/DerivedData/verso-atniuskgwblnkdhajoplsblizihs/Build/Products/Release/verso.app"

quit_verso() {
    # Try a graceful quit first; fall back to kill if it's stuck.
    osascript -e 'tell application "verso" to quit' 2>/dev/null || true
    sleep 1
    pkill -x verso 2>/dev/null || true
}

cmd_status() {
    if [ -L "${ACTIVE_STASH}" ]; then
        target="$(readlink "${ACTIVE_STASH}")"
        echo "stash ACTIVE → ${target}"
        echo "your dev state is currently moved aside; run \`restore\` to put it back"
    else
        echo "stash inactive — dev state is in place"
    fi
}

cmd_start() {
    if [ -L "${ACTIVE_STASH}" ]; then
        echo "error: a stash is already active (${ACTIVE_STASH} → $(readlink "${ACTIVE_STASH}"))" >&2
        echo "       run \`restore\` first before starting a new fresh-install test" >&2
        exit 1
    fi

    if [ ! -d "${APP_PATH}" ]; then
        echo "error: notarized .app not found at:" >&2
        echo "       ${APP_PATH}" >&2
        echo "       build the Release configuration first." >&2
        exit 1
    fi

    quit_verso

    timestamp="$(date -u +%Y%m%d-%H%M%S)"
    stash_dir="${STASH_ROOT}/${timestamp}"
    mkdir -p "${stash_dir}"

    moved=()
    for src in "${DEV_HERMES}" "${APP_SUPPORT}" "${LOGS_DIR}"; do
        if [ -e "${src}" ]; then
            base="$(basename "${src}")"
            # Use parent-dir-prefix so we don't collide (e.g. two ".hermes"
            # named things wouldn't, but be safe).
            target="${stash_dir}/${base}"
            # If there's a collision, suffix with a counter.
            n=1
            while [ -e "${target}" ]; do
                target="${stash_dir}/${base}.${n}"
                n=$((n + 1))
            done
            mv "${src}" "${target}"
            moved+=("${src} → ${target}")
        fi
    done

    # Record what we moved so restore knows exactly what to do.
    {
        echo "stash_dir=${stash_dir}"
        echo "timestamp=${timestamp}"
        for line in "${moved[@]}"; do
            echo "moved=${line}"
        done
    } > "${stash_dir}/manifest.txt"

    ln -s "${stash_dir}" "${ACTIVE_STASH}"

    echo "[fresh-install] stashed dev state → ${stash_dir}"
    for line in "${moved[@]}"; do
        echo "[fresh-install]   ${line}"
    done

    echo "[fresh-install] launching ${APP_PATH}"
    open "${APP_PATH}"
    echo ""
    echo "Now you're running the notarized .app with a virgin home. Do your fresh-install test."
    echo "When done, run:  ./scripts/test-as-fresh-install.sh restore"
}

cmd_restore() {
    if [ ! -L "${ACTIVE_STASH}" ]; then
        echo "no active stash to restore (nothing to do)"
        exit 0
    fi

    stash_dir="$(readlink "${ACTIVE_STASH}")"
    if [ ! -d "${stash_dir}" ]; then
        echo "error: active stash points at ${stash_dir} but it doesn't exist" >&2
        exit 1
    fi

    quit_verso

    # Wipe anything the test run created so we can restore cleanly.
    for src in "${DEV_HERMES}" "${APP_SUPPORT}" "${LOGS_DIR}"; do
        if [ -e "${src}" ]; then
            rm -rf "${src}"
        fi
    done

    # Move each stashed dir back to its original path.
    while IFS= read -r line; do
        case "${line}" in
            moved=*)
                pair="${line#moved=}"
                src_path="${pair%% → *}"
                stash_path="${pair##* → }"
                if [ -e "${stash_path}" ]; then
                    parent="$(dirname "${src_path}")"
                    mkdir -p "${parent}"
                    mv "${stash_path}" "${src_path}"
                    echo "[fresh-install] restored ${src_path}"
                fi
                ;;
        esac
    done < "${stash_dir}/manifest.txt"

    # Clean up the (now-empty) stash dir and the active symlink.
    rmdir "${stash_dir}" 2>/dev/null || echo "[fresh-install] stash dir not empty, leaving for inspection: ${stash_dir}"
    rm -f "${ACTIVE_STASH}"

    echo "[fresh-install] done — dev state restored"
}

case "${CMD}" in
    start)   cmd_start ;;
    restore) cmd_restore ;;
    status)  cmd_status ;;
    help|--help|-h|*)
        cat <<EOF
test-as-fresh-install.sh — simulate a fresh-Mac install of the notarized .app

Commands:
  start      Stash your dev Hermes / Verso state and launch the bundled .app
  restore    Put your dev state back and quit Verso
  status     Show whether a stash is currently active

The stash lives at ${STASH_ROOT}/<timestamp>/. Nothing is deleted —
your dev state is moved, not destroyed.
EOF
        ;;
esac
