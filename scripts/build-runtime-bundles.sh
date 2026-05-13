#!/usr/bin/env bash
#
# build-runtime-bundles.sh
# ────────────────────────
# Populates ./desktop/runtime-bundles/ with the runtime components that get embedded
# inside Verso.app for Release builds:
#
#   desktop/runtime-bundles/
#   ├── node/bin/node                     Node.js (universal arm64 + x86_64)
#   ├── orchestrator/                     Source + node_modules, ready to run
#   ├── python/{arm64,x86_64}/python/...  python-build-standalone (one per arch)
#   ├── hermes-agent/                     NousResearch/hermes-agent snapshot
#   ├── wheels/{arm64,x86_64}/*.whl       Pre-downloaded pip wheels for Hermes
#   ├── hermes-defaults/                  Seed config.yaml + memory templates
#   └── BUNDLE_VERSION                    Stamp used by the orchestrator to
#                                         decide when to rebuild the user venv
#
# This script is needed only for Archive (Release) builds. Cmd+R in Xcode
# uses the developer's system Node + system Hermes install directly (see
# SidecarManager.swift's #if DEBUG branches).
#
# Run this whenever:
#   • First clone of the repo
#   • You change desktop/orchestrator/package.json (deps changed)
#   • You bump NODE_VERSION, PYTHON_TAG, or HERMES_REF below
#   • Hermes upstream releases a new commit you want to ship
#
# Idempotent: each stage no-ops if the right artifact is already present.

set -euo pipefail

NODE_VERSION="24.15.0"

# python-build-standalone release tag (https://github.com/astral-sh/python-build-standalone/releases).
# We pin both the tag and the CPython version it ships so reproducible.
PBS_TAG="20260510"
PYTHON_VERSION="3.11.15"

# NousResearch/hermes-agent commit to snapshot. Pin to a specific SHA so
# Release builds don't drift with upstream main. Bump intentionally.
HERMES_REPO="https://github.com/NousResearch/hermes-agent.git"
HERMES_REF="edff2fbe7efd7d1798b6f6116d2e4b55b3ce69f9"

# Optional extras to install with Hermes. Keep lean — voice/messaging are huge
# and not needed for the macOS UI flow.
HERMES_EXTRAS="mcp,cli,cron"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DESKTOP_ROOT="${REPO_ROOT}/desktop"
BUNDLE_DIR="${DESKTOP_ROOT}/runtime-bundles"
NODE_DIR="${BUNDLE_DIR}/node"
ORCHESTRATOR_BUNDLE="${BUNDLE_DIR}/orchestrator"
PYTHON_DIR="${BUNDLE_DIR}/python"
HERMES_BUNDLE="${BUNDLE_DIR}/hermes-agent"
WHEELS_DIR="${BUNDLE_DIR}/wheels"
DEFAULTS_DIR="${BUNDLE_DIR}/hermes-defaults"
BUNDLE_VERSION_FILE="${BUNDLE_DIR}/BUNDLE_VERSION"

mkdir -p "${BUNDLE_DIR}"

# ── Node.js universal binary ────────────────────────────────────────────────

needs_node_install=true
if [ -x "${NODE_DIR}/bin/node" ]; then
    installed_version="$("${NODE_DIR}/bin/node" --version 2>/dev/null || echo "")"
    if [ "${installed_version}" = "v${NODE_VERSION}" ]; then
        # Check it's actually universal (not arch-specific from a previous run).
        if /usr/bin/lipo -info "${NODE_DIR}/bin/node" 2>/dev/null | grep -q "arm64 x86_64\|x86_64 arm64"; then
            needs_node_install=false
            echo "[bundle] node v${NODE_VERSION} (universal) already installed"
        else
            echo "[bundle] node v${NODE_VERSION} installed but not universal, rebuilding"
        fi
    else
        echo "[bundle] node version mismatch (${installed_version} vs v${NODE_VERSION}), reinstalling"
    fi
fi

if ${needs_node_install}; then
    rm -rf "${NODE_DIR}"
    mkdir -p "${NODE_DIR}/bin"

    # Node.js doesn't ship a single universal tarball, so we download both
    # architectures and `lipo` them together. Result is one binary that runs
    # natively on Apple Silicon and Intel.
    tmp="$(mktemp -d)"
    trap 'rm -rf "${tmp}"' EXIT

    for arch in arm64 x64; do
        tarball="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
        echo "[bundle] downloading ${tarball}"
        curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" -o "${tmp}/${tarball}"
        tar -xzf "${tmp}/${tarball}" -C "${tmp}"
    done

    echo "[bundle] stitching universal node binary with lipo"
    /usr/bin/lipo -create \
        "${tmp}/node-v${NODE_VERSION}-darwin-arm64/bin/node" \
        "${tmp}/node-v${NODE_VERSION}-darwin-x64/bin/node" \
        -output "${NODE_DIR}/bin/node"
    chmod +x "${NODE_DIR}/bin/node"

    echo "[bundle] node $(/usr/bin/lipo -info "${NODE_DIR}/bin/node")"
fi

# ── Orchestrator source + node_modules ──────────────────────────────────────

echo "[bundle] preparing orchestrator snapshot"
rm -rf "${ORCHESTRATOR_BUNDLE}"
mkdir -p "${ORCHESTRATOR_BUNDLE}"

# Copy orchestrator source. Exclude things that don't belong in a release
# bundle: tests, .env files, the existing dev node_modules (we'll reinstall
# fresh below), and any local-only scripts.
rsync -a --delete \
    --exclude 'node_modules' \
    --exclude 'test' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude '*.log' \
    --exclude '.DS_Store' \
    "${DESKTOP_ROOT}/orchestrator/" "${ORCHESTRATOR_BUNDLE}/"

echo "[bundle] installing orchestrator dependencies (npm ci --include=dev for tsx)"
# tsx lives in devDependencies, but we need it at runtime in the bundled app
# (the orchestrator's entrypoint is `tsx src/http/server.ts`). --include=dev
# pulls it in regardless of NODE_ENV.
( cd "${ORCHESTRATOR_BUNDLE}" && npm ci --include=dev --no-audit --no-fund --loglevel=error )

# Sanity check: tsx should be present.
if [ ! -x "${ORCHESTRATOR_BUNDLE}/node_modules/.bin/tsx" ]; then
    echo "[bundle] ERROR: tsx not found at ${ORCHESTRATOR_BUNDLE}/node_modules/.bin/tsx" >&2
    exit 1
fi

# ── Python (per-arch) ───────────────────────────────────────────────────────
# python-build-standalone ships a relocatable CPython per architecture. We
# bundle both and pick at runtime via `uname -m` because Python is not
# lipo-friendly: many extension modules ship as arch-specific .so files.

# Map our short names → python-build-standalone arch slug.
# (No `declare -A` — macOS ships bash 3.2 which lacks associative arrays.)
pbs_arch_for() {
    case "$1" in
        arm64) echo "aarch64" ;;
        x86_64) echo "x86_64" ;;
        *) echo "" ;;
    esac
}

for arch in arm64 x86_64; do
    target_dir="${PYTHON_DIR}/${arch}"
    bin="${target_dir}/python/bin/python3.11"
    if [ -x "${bin}" ]; then
        installed="$("${bin}" --version 2>/dev/null || echo "")"
        if [ "${installed}" = "Python ${PYTHON_VERSION}" ]; then
            echo "[bundle] python ${PYTHON_VERSION} (${arch}) already installed"
            continue
        else
            echo "[bundle] python (${arch}) version mismatch (${installed} vs ${PYTHON_VERSION}), reinstalling"
        fi
    fi

    rm -rf "${target_dir}"
    mkdir -p "${target_dir}"

    pbs_arch="$(pbs_arch_for "${arch}")"
    tarball="cpython-${PYTHON_VERSION}+${PBS_TAG}-${pbs_arch}-apple-darwin-install_only_stripped.tar.gz"
    url="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${tarball}"

    echo "[bundle] downloading ${tarball}"
    tmp_pbs="$(mktemp -d)"
    trap 'rm -rf "${tmp_pbs}"' EXIT
    curl -fsSL "${url}" -o "${tmp_pbs}/${tarball}"
    tar -xzf "${tmp_pbs}/${tarball}" -C "${target_dir}"
    rm -rf "${tmp_pbs}"

    if [ ! -x "${bin}" ]; then
        echo "[bundle] ERROR: expected ${bin} after extracting ${tarball}" >&2
        exit 1
    fi

    echo "[bundle] python ${arch}: $("${bin}" --version)"
done

# ── Hermes source snapshot ──────────────────────────────────────────────────

needs_hermes_clone=true
if [ -d "${HERMES_BUNDLE}/.git" ]; then
    current_ref="$(git -C "${HERMES_BUNDLE}" rev-parse HEAD 2>/dev/null || echo "")"
    if [ "${current_ref}" = "${HERMES_REF}" ]; then
        echo "[bundle] hermes-agent already at ${HERMES_REF:0:9}"
        needs_hermes_clone=false
    else
        echo "[bundle] hermes-agent at ${current_ref:0:9}, want ${HERMES_REF:0:9}, refreshing"
    fi
fi

if ${needs_hermes_clone}; then
    rm -rf "${HERMES_BUNDLE}"
    echo "[bundle] cloning hermes-agent @ ${HERMES_REF:0:9}"
    git clone --quiet "${HERMES_REPO}" "${HERMES_BUNDLE}"
    git -C "${HERMES_BUNDLE}" checkout --quiet "${HERMES_REF}"
fi

# Drop the .git dir from the snapshot so the bundle is smaller and unambiguous
# (the .git/index we'd ship wouldn't match the user's filesystem anyway).
rm -rf "${HERMES_BUNDLE}/.git"

# ── Hermes wheels (per-arch, offline-installable) ───────────────────────────
# pip download with --platform + --only-binary=:all: pulls binary wheels for
# the target macOS arch. Pure-Python deps fall back to their `py3-none-any`
# wheels. First launch installs from this dir with --no-index so users never
# hit PyPI.
#
# We use a temporary native venv to run `pip download` — host pip works fine
# even though the target wheels are for a different arch.

mkdir -p "${WHEELS_DIR}"

pip_tmp="$(mktemp -d)"
trap 'rm -rf "${pip_tmp}"' EXIT

# Bootstrap a tiny "host" venv just for pip download (uses the bundled arm64
# Python on Apple Silicon dev machines; either arch works because we'll
# cross-download both wheel sets from it).
host_python="${PYTHON_DIR}/arm64/python/bin/python3.11"
if [ ! -x "${host_python}" ]; then
    host_python="${PYTHON_DIR}/x86_64/python/bin/python3.11"
fi
"${host_python}" -m venv "${pip_tmp}/venv"
"${pip_tmp}/venv/bin/pip" install --quiet --upgrade pip

# Map our arch name → pip's --platform tag. Cover several macOS minor
# versions so pip picks a wheel even when a package only publishes a newer
# tag like `macosx_14_0_arm64`.
pip_platform_flags_for() {
    case "$1" in
        arm64)
            echo "--platform macosx_11_0_arm64 --platform macosx_12_0_arm64 --platform macosx_13_0_arm64 --platform macosx_14_0_arm64 --platform macosx_15_0_arm64"
            ;;
        x86_64)
            echo "--platform macosx_11_0_x86_64 --platform macosx_12_0_x86_64 --platform macosx_13_0_x86_64 --platform macosx_14_0_x86_64 --platform macosx_15_0_x86_64"
            ;;
        *)
            echo ""
            ;;
    esac
}

expected_stamp="${HERMES_REF}|${HERMES_EXTRAS}|${PYTHON_VERSION}"

# Step 1: build hermes-agent into a pure-Python wheel (universal — Hermes
# itself ships no compiled code). Stashed in pip_tmp/hermes_wheel/.
echo "[bundle] building hermes-agent wheel from snapshot"
hermes_wheel_tmp="${pip_tmp}/hermes_wheel"
mkdir -p "${hermes_wheel_tmp}"
"${pip_tmp}/venv/bin/pip" wheel \
    --quiet \
    --no-deps \
    --wheel-dir "${hermes_wheel_tmp}" \
    "${HERMES_BUNDLE}"

# Step 2: for each arch, copy in the hermes wheel + `pip download` its deps
# cross-arch. We point pip at the hermes wheel via --find-links so it doesn't
# try to rebuild from source (which would fail with --only-binary=:all:).
for arch in arm64 x86_64; do
    target="${WHEELS_DIR}/${arch}"
    stamp="${target}/.stamp"
    if [ -f "${stamp}" ] && [ "$(cat "${stamp}")" = "${expected_stamp}" ]; then
        wheel_count=$(find "${target}" -name '*.whl' | wc -l | tr -d ' ')
        echo "[bundle] wheels (${arch}) already current (${wheel_count} wheels)"
        continue
    fi

    echo "[bundle] downloading dep wheels for ${arch}"
    rm -rf "${target}"
    mkdir -p "${target}"

    cp "${hermes_wheel_tmp}"/hermes_agent-*.whl "${target}/"

    pip_platform_flags="$(pip_platform_flags_for "${arch}")"
    # shellcheck disable=SC2086  # we want the platform flags word-split
    "${pip_tmp}/venv/bin/pip" download \
        --quiet \
        --dest "${target}" \
        --find-links "${hermes_wheel_tmp}" \
        --python-version 3.11 \
        --implementation cp \
        --abi cp311 \
        ${pip_platform_flags} \
        --only-binary=:all: \
        "hermes-agent[${HERMES_EXTRAS}]"

    wheel_count=$(find "${target}" -name '*.whl' | wc -l | tr -d ' ')
    echo "[bundle] wheels (${arch}): ${wheel_count} files"
    echo "${expected_stamp}" > "${stamp}"
done

rm -rf "${pip_tmp}"

# ── Hermes default configs ──────────────────────────────────────────────────
# Seed files the orchestrator copies into ~/Library/Application Support/Verso/
# hermes-home/ on first launch. We copy from the snapshotted hermes-agent
# source so the defaults stay in lockstep with the pinned Hermes version.

rm -rf "${DEFAULTS_DIR}"
mkdir -p "${DEFAULTS_DIR}"

# Hermes' canonical example config is checked in at the repo root.
if [ -f "${HERMES_BUNDLE}/cli-config.yaml.example" ]; then
    cp "${HERMES_BUNDLE}/cli-config.yaml.example" "${DEFAULTS_DIR}/config.yaml"
else
    echo "[bundle] ERROR: cli-config.yaml.example missing from hermes-agent snapshot" >&2
    exit 1
fi

# Minimal SOUL.md + empty memories so first-launch Hermes has a coherent home.
cat > "${DEFAULTS_DIR}/SOUL.md" <<'EOF'
# Verso

You are a helpful research assistant running inside the Verso macOS app.
EOF

mkdir -p "${DEFAULTS_DIR}/memories"
: > "${DEFAULTS_DIR}/memories/MEMORY.md"
: > "${DEFAULTS_DIR}/memories/USER.md"

# ── Bundle version stamp ────────────────────────────────────────────────────
# The orchestrator reads this on first spawn and compares to a stamp written
# beside the user venv. Mismatch ⇒ rebuild venv (e.g. Hermes upgraded).

echo "node=${NODE_VERSION} python=${PYTHON_VERSION} hermes=${HERMES_REF} extras=${HERMES_EXTRAS}" \
    > "${BUNDLE_VERSION_FILE}"

bundle_size=$(du -sh "${BUNDLE_DIR}" | cut -f1)
echo "[bundle] done — desktop/runtime-bundles/ is ${bundle_size}"
