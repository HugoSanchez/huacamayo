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

# ── MCP OAuth routes (verso-gateway-mcp-oauth.patch) ─────────────────────
# The patch adds three routes to the gateway. A mis-anchored or missing patch
# means aiohttp's default 404 on all of them; a healthy patch is
# distinguishable on each route without running a real OAuth flow:
#   - flows/<id> unauthenticated  → 401 (route exists, auth enforced;
#                                   missing route would 404)
#   - callback/<name>             → 404 BUT with the handler's own
#                                   "OAuth flow expired" body, not aiohttp's
#                                   default "404: Not Found"
#   - servers/<name>/auth (auth'd)→ handler JSON "Server ... not found"
echo "[smoke] checking MCP OAuth routes from the runtime patch"

flows_status="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/mcp/oauth/flows/smoke-nonexistent")"
if [ "${flows_status}" != "401" ]; then
    echo "[smoke] FAIL: GET /api/mcp/oauth/flows/… unauthenticated returned ${flows_status} (expected 401; 404 means verso-gateway-mcp-oauth.patch did not register its routes)" >&2
    exit 1
fi

callback_body="${HOME_DIR}/smoke-oauth-callback.txt"
curl -s -o "${callback_body}" "http://127.0.0.1:${PORT}/api/mcp/oauth/callback/smoke_nonexistent?state=abc"
if ! grep -q "OAuth flow expired" "${callback_body}"; then
    echo "[smoke] FAIL: OAuth callback route did not answer with the patch's handler; body:" >&2
    head -3 "${callback_body}" >&2
    exit 1
fi

auth_body="${HOME_DIR}/smoke-oauth-start.txt"
auth_status="$(curl -s -o "${auth_body}" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer ${API_KEY}" \
    "http://127.0.0.1:${PORT}/api/mcp/servers/smoke_nonexistent/auth")"
if [ "${auth_status}" != "404" ] || ! grep -q "not found" "${auth_body}"; then
    echo "[smoke] FAIL: POST /api/mcp/servers/…/auth returned ${auth_status}; body:" >&2
    head -3 "${auth_body}" >&2
    exit 1
fi
tools_status="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/mcp/tools")"
if [ "${tools_status}" != "401" ]; then
    echo "[smoke] FAIL: GET /api/mcp/tools unauthenticated returned ${tools_status} (expected 401; 404 means the registry route is missing — connector status will never show connected)" >&2
    exit 1
fi
tools_body="${HOME_DIR}/smoke-mcp-tools.txt"
curl -s -o "${tools_body}" -H "Authorization: Bearer ${API_KEY}" "http://127.0.0.1:${PORT}/api/mcp/tools"
if ! grep -q '"servers"' "${tools_body}"; then
    echo "[smoke] FAIL: /api/mcp/tools did not return a servers map; body:" >&2
    head -3 "${tools_body}" >&2
    exit 1
fi
echo "[smoke] PASS: MCP OAuth routes registered and dispatching"

# ── Pin-liveness contract ────────────────────────────────────────────────
# Hermes silently ignores pinned tool names that match nothing registered,
# so a drift in the MCP naming convention (0.19 renamed mcp_verso_* to
# mcp__verso__*) strips memory/product-core tools from the model with no
# error anywhere. Ask THIS bundle's own naming function what wire name each
# core tool gets, and assert the orchestrator's pinned list contains it.
echo "[smoke] checking pinned-tool naming contract against the bundle"
CORE_TOOLS="request_connection search_toolkits list_connections get_connection_status propose_message_draft search_memory get_memory_page write_memory_page request_browser_connection browser_session_start browser_session_stop"

expected_names="$(PYTHONPATH="${SITE_PACKAGES}" "${PYTHON_BIN}" - "${CORE_TOOLS}" <<'PYEOF'
import sys
try:
    from tools.mcp_tool import mcp_prefixed_tool_name
except ImportError:  # pre-0.19 bundles: single-underscore convention
    def mcp_prefixed_tool_name(server, tool):
        return f"mcp_{server}_{tool}"
for tool in sys.argv[1].split():
    print(mcp_prefixed_tool_name("verso", tool))
PYEOF
)"

pinned_names="$(node --experimental-strip-types --no-warnings -e "
import('${REPO_ROOT}/desktop/orchestrator/src/http/hermes-pinned-tools.ts').then((m) => {
  console.log(m.computePinnedToolNames('/nonexistent-manifest', { includeMemoryTools: true }).join('\n'));
});")"

missing=""
while IFS= read -r name; do
    if ! printf '%s\n' "${pinned_names}" | grep -qx "${name}"; then
        missing="${missing} ${name}"
    fi
done <<< "${expected_names}"

if [ -n "${missing}" ]; then
    echo "[smoke] FAIL: bundle registers core tools under names the orchestrator does not pin:${missing}" >&2
    echo "[smoke] update PIN_PREFIXES in desktop/orchestrator/src/http/hermes-pinned-tools.ts" >&2
    exit 1
fi
echo "[smoke] PASS: all core pins match the bundle's MCP naming convention"

# ── Browser domain guard (verso-browser-domain-guard.patch) ──────────────
# The guard gates every browser command behind a per-lease allowlist file.
# `patch --batch` at bundle time already fails hard on a mis-anchored hunk;
# this asserts the guard actually landed in THIS bundle's browser_tool and
# that the file still parses after patching.
echo "[smoke] checking browser domain-guard runtime patch"
PYTHONPATH="${SITE_PACKAGES}" "${PYTHON_BIN}" - "${SITE_PACKAGES}/tools/browser_tool.py" <<'PYEOF'
import ast, sys

source = open(sys.argv[1], "rt", encoding="utf-8").read()
tree = ast.parse(source)
names = {node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
required = {"_verso_domain_guard_check", "_verso_domain_allowed", "_verso_guard_config"}
missing = required - names
if missing:
    raise SystemExit(f"domain-guard patch did not land: missing {sorted(missing)}")
if "guard_block = _verso_domain_guard_check(task_id, command, args)" not in source:
    raise SystemExit("domain-guard patch landed but _run_browser_command does not call it")
PYEOF
echo "[smoke] PASS: browser domain guard present in bundled browser_tool"

# Record the pass, keyed to the exact site-packages build we just validated.
# The marker is a copy of the venv stage's .stamp; a rebuild wipes the arch
# dir (marker included), so a stale pass can never vouch for new bytes.
# make-dmg.sh refuses to package an .app whose embedded stamp has no
# matching smoke pass.
stamp_file="${BUNDLE_DIR}/site-packages/${ARCH}/.stamp"
if [ -f "${stamp_file}" ]; then
    cp "${stamp_file}" "${BUNDLE_DIR}/site-packages/${ARCH}/.smoke-pass"
    echo "[smoke] recorded pass marker for bundle stamp"
fi
