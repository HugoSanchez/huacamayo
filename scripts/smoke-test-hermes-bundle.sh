#!/usr/bin/env bash
#
# smoke-test-hermes-bundle.sh
# ───────────────────────────
# Boots the Hermes gateway straight from desktop/runtime-bundles/ (the exact
# bytes that ship inside Verso.app) with a throwaway HERMES_HOME and drives one
# streaming POST /v1/responses — the same request shape the orchestrator sends
# for every chat message.
#
# Why this exists: "patches apply cleanly + modules byte-compile" does not
# catch a mis-anchored hunk. The 1.0.15 release shipped with
# verso-request-overrides.patch passing kwargs to a function that doesn't
# accept them — a TypeError on every streaming request, i.e. every chat
# message returned HTTP 500 for every user. This script fails on that class
# of bug in ~30 seconds, with no model credentials required: a healthy
# handler answers HTTP 200 with SSE events (response.failed is fine — provider
# auth errors happen inside the agent); a broken handler answers a raw 500
# before the stream starts.
#
# Run after build-runtime-bundles.sh, before archiving a Release build:
#   ./scripts/build-runtime-bundles.sh && ./scripts/smoke-test-hermes-bundle.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUNDLE_DIR="${REPO_ROOT}/desktop/runtime-bundles"

ARCH="arm64"
PYTHON_BIN="${BUNDLE_DIR}/python/${ARCH}/python/bin/python3.11"
SITE_PACKAGES="${BUNDLE_DIR}/site-packages/${ARCH}/site-packages"
HERMES_SCRIPT="${BUNDLE_DIR}/site-packages/${ARCH}/bin/hermes"
DEFAULTS_DIR="${BUNDLE_DIR}/hermes-defaults"

for path in "${PYTHON_BIN}" "${SITE_PACKAGES}" "${HERMES_SCRIPT}" "${DEFAULTS_DIR}/config.yaml"; do
    if [ ! -e "${path}" ]; then
        echo "[smoke] ERROR: missing ${path} — run ./scripts/build-runtime-bundles.sh first" >&2
        exit 1
    fi
done

PORT="${SMOKE_PORT:-18977}"
API_KEY="$(openssl rand -hex 32)"
HOME_DIR="$(mktemp -d /tmp/verso-smoke-hermes-home.XXXXXX)"
LOG_FILE="${HOME_DIR}/smoke-gateway.log"
GATEWAY_PID=""

cleanup() {
    if [ -n "${GATEWAY_PID}" ] && kill -0 "${GATEWAY_PID}" 2>/dev/null; then
        kill "${GATEWAY_PID}" 2>/dev/null || true
        wait "${GATEWAY_PID}" 2>/dev/null || true
    fi
    rm -rf "${HOME_DIR}"
}
trap cleanup EXIT

# Seed a virgin home the same way the supervisor does on first launch. No
# auth.json on purpose — the smoke test asserts handler health, not provider
# reachability.
cp "${DEFAULTS_DIR}/config.yaml" "${HOME_DIR}/config.yaml"
cp "${DEFAULTS_DIR}/SOUL.md" "${HOME_DIR}/SOUL.md" 2>/dev/null || true
mkdir -p "${HOME_DIR}/memories"

echo "[smoke] starting bundled gateway (port ${PORT}, home ${HOME_DIR})"
HERMES_HOME="${HOME_DIR}" \
PYTHONPATH="${SITE_PACKAGES}" \
PYTHONUNBUFFERED=1 \
API_SERVER_ENABLED=true \
API_SERVER_HOST=127.0.0.1 \
API_SERVER_PORT="${PORT}" \
API_SERVER_KEY="${API_KEY}" \
    "${PYTHON_BIN}" "${HERMES_SCRIPT}" gateway run > "${LOG_FILE}" 2>&1 &
GATEWAY_PID=$!

deadline=$(( $(date +%s) + 90 ))
until curl -sf -o /dev/null -H "Authorization: Bearer ${API_KEY}" "http://127.0.0.1:${PORT}/v1/models"; do
    if ! kill -0 "${GATEWAY_PID}" 2>/dev/null; then
        echo "[smoke] FAIL: gateway process died during startup; log tail:" >&2
        tail -20 "${LOG_FILE}" >&2
        exit 1
    fi
    if [ "$(date +%s)" -ge "${deadline}" ]; then
        echo "[smoke] FAIL: gateway did not become ready within 90s; log tail:" >&2
        tail -20 "${LOG_FILE}" >&2
        exit 1
    fi
    sleep 2
done
echo "[smoke] gateway ready; sending streaming /v1/responses request"

# Mirror the orchestrator's buildHermesRequestBody, including the per-request
# model/reasoning overrides so the verso-request-overrides code path runs.
body='{"input":"smoke test","conversation":"smoke-test-1","truncation":"auto","stream":true,"store":true,"model":"gpt-5.5","reasoning":{"effort":"low"}}'
response_file="${HOME_DIR}/smoke-response.txt"
status="$(curl -s -N --max-time 60 -o "${response_file}" -w "%{http_code}" \
    -X POST "http://127.0.0.1:${PORT}/v1/responses" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d "${body}")"

if [ "${status}" != "200" ]; then
    echo "[smoke] FAIL: /v1/responses returned HTTP ${status} (expected 200 + SSE)" >&2
    echo "[smoke] response body:" >&2
    head -5 "${response_file}" >&2
    echo "[smoke] gateway errors:" >&2
    tail -30 "${HOME_DIR}/logs/errors.log" 2>/dev/null >&2 || tail -20 "${LOG_FILE}" >&2
    exit 1
fi

if ! grep -q "^event: " "${response_file}"; then
    echo "[smoke] FAIL: HTTP 200 but no SSE events in response" >&2
    head -5 "${response_file}" >&2
    exit 1
fi

if ! grep -Eq "^event: response\.(completed|failed)" "${response_file}"; then
    echo "[smoke] FAIL: SSE stream never reached a terminal event" >&2
    grep "^event: " "${response_file}" >&2
    exit 1
fi

terminal="$(grep -Eo "^event: response\.(completed|failed)" "${response_file}" | tail -1)"
echo "[smoke] PASS: HTTP 200, SSE stream terminated with ${terminal#event: }"
echo "[smoke] (response.failed is expected without model credentials — the handler is healthy either way)"
