#!/usr/bin/env bash
#
# build-runtime-bundles.sh
# ────────────────────────
# Populates ./desktop/runtime-bundles/ with the runtime components that get embedded
# inside Verso.app for Release builds:
#
#   desktop/runtime-bundles/
#   ├── node/bin/node                              Node.js (universal arm64 + x86_64)
#   ├── orchestrator/                              Source + node_modules, ready to run
#   ├── python/arm64/python/...                    python-build-standalone (arm64)
#   ├── hermes-agent/                              NousResearch/hermes-agent snapshot
#   ├── site-packages/arm64/                       Pre-installed Hermes + deps
#   │   ├── site-packages/                           Python packages (add to PYTHONPATH)
#   │   └── bin/hermes                               Console-script entry (run via python)
#   ├── hermes-defaults/                           Seed config.yaml + memory templates
#   └── BUNDLE_VERSION                             Stamp used by the orchestrator to
#                                                  decide when to invalidate caches
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
#
# arm64-only for F&F v1 — see .context/attachments/ff-installation-plan.md.

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

# Extra packages we install alongside Hermes. aiohttp is required by Hermes'
# api_server adapter — the orchestrator talks to Hermes over the HTTP API
# (API_SERVER_ENABLED=true), so without aiohttp the gateway boots in
# cron-only mode and the orchestrator can't reach it. Not in mcp/cli/cron
# extras (only listed under messaging/homeassistant/sms), so we pin it
# directly. Without this, hermes logs "API Server: aiohttp not installed".
HERMES_EXTRA_PINS=("aiohttp>=3.9,<4")

# Target architecture(s) we ship. arm64-only for v1 — add "x86_64" back here
# (and to the per-arch loops below) when we have Intel-Mac friends to support.
SUPPORTED_ARCHES=("arm64")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DESKTOP_ROOT="${REPO_ROOT}/desktop"
BUNDLE_DIR="${DESKTOP_ROOT}/runtime-bundles"
NODE_DIR="${BUNDLE_DIR}/node"
ORCHESTRATOR_BUNDLE="${BUNDLE_DIR}/orchestrator"
PYTHON_DIR="${BUNDLE_DIR}/python"
HERMES_BUNDLE="${BUNDLE_DIR}/hermes-agent"
SITE_PACKAGES_DIR="${BUNDLE_DIR}/site-packages"
DEFAULTS_DIR="${BUNDLE_DIR}/hermes-defaults"
BUNDLE_VERSION_FILE="${BUNDLE_DIR}/BUNDLE_VERSION"
HERMES_RUNTIME_PATCHES_DIR="${DESKTOP_ROOT}/runtime-patches/hermes-agent"

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
# python-build-standalone ships a relocatable CPython per architecture. The
# `SUPPORTED_ARCHES` loop downloads the right one(s) — arm64-only for v1.

# Map our short names → python-build-standalone arch slug.
# (No `declare -A` — macOS ships bash 3.2 which lacks associative arrays.)
pbs_arch_for() {
    case "$1" in
        arm64) echo "aarch64" ;;
        x86_64) echo "x86_64" ;;
        *) echo "" ;;
    esac
}

for arch in "${SUPPORTED_ARCHES[@]}"; do
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

# Wipe any stale per-arch Python dirs from previous (multi-arch) runs. Keeps
# the bundle clean and prevents lingering x86_64 binaries from confusing
# notarization or bloating the .app.
for arch_dir in "${PYTHON_DIR}"/*; do
    [ -d "${arch_dir}" ] || continue
    arch_name="$(basename "${arch_dir}")"
    keep=false
    for supported in "${SUPPORTED_ARCHES[@]}"; do
        if [ "${supported}" = "${arch_name}" ]; then keep=true; break; fi
    done
    if ! ${keep}; then
        echo "[bundle] removing stale unused python arch: ${arch_name}"
        rm -rf "${arch_dir}"
    fi
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

# ── Pre-installed Hermes + deps (per-arch site-packages) ────────────────────
# Instead of shipping raw wheels and pip-installing on first launch, we
# install Hermes into a throwaway venv at bundle time using the bundled
# Python, then copy out site-packages/ and bin/hermes. The runtime can then
# point PYTHONPATH at site-packages/ and exec the bundled python on the
# bin/hermes script directly — no first-launch network, no pip, and (the
# whole reason for this approach) every .so on disk is loose and signable
# so Apple notarization passes.

mkdir -p "${SITE_PACKAGES_DIR}"

pip_tmp="$(mktemp -d)"
trap 'rm -rf "${pip_tmp}"' EXIT

# Step 1: build the hermes-agent wheel once from our snapshotted source.
# Reused across arches (it's pure-Python).
echo "[bundle] building hermes-agent wheel from snapshot"
hermes_wheel_tmp="${pip_tmp}/hermes_wheel"
mkdir -p "${hermes_wheel_tmp}"

# Bootstrap a host venv with pip — we use the bundled arm64 Python so the
# wheel-build environment exactly matches what the app will use at runtime.
host_python="${PYTHON_DIR}/arm64/python/bin/python3.11"
if [ ! -x "${host_python}" ]; then
    # Fall back to whatever bundled Python we have if arm64 isn't (shouldn't
    # happen with the current SUPPORTED_ARCHES, but cheap to keep).
    for arch in "${SUPPORTED_ARCHES[@]}"; do
        candidate="${PYTHON_DIR}/${arch}/python/bin/python3.11"
        if [ -x "${candidate}" ]; then host_python="${candidate}"; break; fi
    done
fi
"${host_python}" -m venv "${pip_tmp}/host_venv"
"${pip_tmp}/host_venv/bin/pip" install --quiet --upgrade pip
"${pip_tmp}/host_venv/bin/pip" wheel \
    --quiet \
    --no-deps \
    --wheel-dir "${hermes_wheel_tmp}" \
    "${HERMES_BUNDLE}"

# Stamp keyed on inputs that would force a rebuild. Includes the extra pins
# and local Hermes runtime patches so adding/removing/changing them re-triggers
# an install.
hermes_runtime_patch_stamp="none"
if [ -d "${HERMES_RUNTIME_PATCHES_DIR}" ]; then
    hermes_runtime_patch_stamp="$(
        find "${HERMES_RUNTIME_PATCHES_DIR}" -type f -name '*.patch' -print \
            | LC_ALL=C sort \
            | while IFS= read -r patch_file; do shasum -a 256 "${patch_file}"; done \
            | shasum -a 256 \
            | awk '{print $1}'
    )"
fi
expected_stamp="${HERMES_REF}|${HERMES_EXTRAS}|${HERMES_EXTRA_PINS[*]}|${PYTHON_VERSION}|patches:${hermes_runtime_patch_stamp}"

# Step 2: per-arch venv install + copy out. We pip-install hermes-agent into
# a throwaway venv per arch using that arch's Python, then rsync site-packages/
# and bin/hermes out into our bundle layout.
for arch in "${SUPPORTED_ARCHES[@]}"; do
    target="${SITE_PACKAGES_DIR}/${arch}"
    stamp="${target}/.stamp"
    if [ -f "${stamp}" ] && [ "$(cat "${stamp}")" = "${expected_stamp}" ]; then
        sp_count=$(find "${target}/site-packages" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ')
        echo "[bundle] site-packages (${arch}) already current (${sp_count} top-level entries)"
        continue
    fi

    echo "[bundle] installing hermes-agent[${HERMES_EXTRAS}] into ${arch} venv"
    rm -rf "${target}"
    mkdir -p "${target}/site-packages" "${target}/bin"

    arch_python="${PYTHON_DIR}/${arch}/python/bin/python3.11"
    if [ ! -x "${arch_python}" ]; then
        echo "[bundle] ERROR: python for arch ${arch} missing at ${arch_python}" >&2
        exit 1
    fi

    # Cross-arch install on Apple Silicon hosts requires Rosetta. Today
    # SUPPORTED_ARCHES=(arm64) so this branch never fires, but it's here for
    # the day we add x86_64 back.
    prefix=""
    host_arch="$(uname -m)"
    if [ "${arch}" != "${host_arch}" ] && [ "${arch}" = "x86_64" ] && [ "${host_arch}" = "arm64" ]; then
        prefix="arch -x86_64"
    fi

    venv_tmp="${pip_tmp}/venv_${arch}"
    rm -rf "${venv_tmp}"
    ${prefix} "${arch_python}" -m venv "${venv_tmp}"
    ${prefix} "${venv_tmp}/bin/pip" install --quiet --upgrade pip
    ${prefix} "${venv_tmp}/bin/pip" install \
        --quiet \
        --find-links "${hermes_wheel_tmp}" \
        "hermes-agent[${HERMES_EXTRAS}]" \
        "${HERMES_EXTRA_PINS[@]}"

    # Copy the venv's site-packages out flat. Use rsync so we preserve perms /
    # symlinks (some packages ship symlinked .so aliases).
    venv_site="${venv_tmp}/lib/python3.11/site-packages"
    if [ ! -d "${venv_site}" ]; then
        echo "[bundle] ERROR: expected venv site-packages at ${venv_site}" >&2
        exit 1
    fi
    rsync -a --delete "${venv_site}/" "${target}/site-packages/"

    if [ -d "${HERMES_RUNTIME_PATCHES_DIR}" ]; then
        while IFS= read -r patch_file; do
            [ -n "${patch_file}" ] || continue
            echo "[bundle] applying Hermes runtime patch: $(basename "${patch_file}")"
            patch -d "${target}/site-packages" -p1 --batch < "${patch_file}" >/dev/null
        done < <(find "${HERMES_RUNTIME_PATCHES_DIR}" -type f -name '*.patch' -print | LC_ALL=C sort)
    fi

    # Drop __pycache__ — Python regenerates these at runtime and Apple gets
    # noisy about per-build path differences inside .pyc magic numbers.
    find "${target}/site-packages" -type d -name '__pycache__' -prune -exec rm -rf {} +

    # Copy bin/hermes (the pip-generated console-script). Its shebang points
    # at the *temporary* venv's python and would break after copy; we don't
    # care because the runtime invokes it as `python3.11 bin/hermes ...`,
    # which makes the shebang irrelevant.
    if [ ! -x "${venv_tmp}/bin/hermes" ]; then
        echo "[bundle] ERROR: expected venv bin/hermes at ${venv_tmp}/bin/hermes" >&2
        exit 1
    fi
    cp "${venv_tmp}/bin/hermes" "${target}/bin/hermes"
    chmod +x "${target}/bin/hermes"

    sp_count=$(find "${target}/site-packages" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ')
    echo "[bundle] site-packages (${arch}): ${sp_count} top-level entries"
    echo "${expected_stamp}" > "${stamp}"
done

# Wipe any stale arch dirs from previous (multi-arch) runs.
for arch_dir in "${SITE_PACKAGES_DIR}"/*; do
    [ -d "${arch_dir}" ] || continue
    arch_name="$(basename "${arch_dir}")"
    keep=false
    for supported in "${SUPPORTED_ARCHES[@]}"; do
        if [ "${supported}" = "${arch_name}" ]; then keep=true; break; fi
    done
    if ! ${keep}; then
        echo "[bundle] removing stale unused site-packages arch: ${arch_name}"
        rm -rf "${arch_dir}"
    fi
done

# Wipe the legacy wheels/ dir if it's still hanging around from before this
# script switched from wheels-at-first-launch to pre-installed site-packages.
if [ -d "${BUNDLE_DIR}/wheels" ]; then
    echo "[bundle] removing legacy wheels/ directory (replaced by site-packages/)"
    rm -rf "${BUNDLE_DIR}/wheels"
fi

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

# Built-in skills live in Hermes' source snapshot, but the running app scans the
# mutable Hermes home. Seed them as defaults so fresh installs show the same
# skills as developer machines whose local Hermes home was already populated.
if [ -d "${HERMES_BUNDLE}/skills" ]; then
    mkdir -p "${DEFAULTS_DIR}/skills"
    rsync -a --delete "${HERMES_BUNDLE}/skills/" "${DEFAULTS_DIR}/skills/"
else
    echo "[bundle] ERROR: skills/ missing from hermes-agent snapshot" >&2
    exit 1
fi

# Minimal SOUL.md + empty memories so first-launch Hermes has a coherent home.
cat > "${DEFAULTS_DIR}/SOUL.md" <<'EOF'
# Verso

You are Hermes Agent, an intelligent AI assistant created by Nous Research operating inside Verso, a macOS app that makes it easy for non-technical users to leverage AI. You are helpful, knowledgeable, and direct. You assist users with a wide range of tasks including answering questions, analyzing information, creative and non-creative work, researching, and executing actions via your tools. You communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose unless otherwise directed below. Be targeted and efficient in your exploration and investigations.
EOF

mkdir -p "${DEFAULTS_DIR}/memories"
: > "${DEFAULTS_DIR}/memories/MEMORY.md"
: > "${DEFAULTS_DIR}/memories/USER.md"

# ── Bundle version stamp ────────────────────────────────────────────────────
# The orchestrator reads this and surfaces it in diagnostics. It used to also
# trigger first-launch venv rebuilds; now that we ship the venv pre-installed,
# the stamp is purely informational.

echo "node=${NODE_VERSION} python=${PYTHON_VERSION} hermes=${HERMES_REF} extras=${HERMES_EXTRAS} arches=${SUPPORTED_ARCHES[*]}" \
    > "${BUNDLE_VERSION_FILE}"

bundle_size=$(du -sh "${BUNDLE_DIR}" | cut -f1)
echo "[bundle] done — desktop/runtime-bundles/ is ${bundle_size}"
