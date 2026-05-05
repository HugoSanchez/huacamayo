#!/usr/bin/env python3
"""Vervo MCP bridge for Hermes.

This server exposes a small set of app-coordination tools over stdio so Hermes can
request connections and inspect connection state without knowing anything about the
desktop app internals.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import mcp.types as types
from mcp.server.fastmcp import FastMCP


SERVER_NAME = "vervo"
ORCHESTRATOR_BASE_URL = os.environ.get("VERVO_ORCHESTRATOR_BASE_URL", "").rstrip("/")

mcp = FastMCP(
    SERVER_NAME,
    instructions=(
        "Vervo app bridge. Use search_toolkits to find the right app first when needed, "
        "then request_connection/list_connections/get_connection_status for auth and connection state. "
        "For Composio-backed apps, use "
        "search_composio_tools to find the right tool, get_composio_tool_schemas to inspect "
        "its arguments, then execute_composio_tool to run it."
    ),
)


@mcp.tool()
def request_connection(toolkit: str, reason: str | None = None) -> types.CallToolResult:
    """Start a user-facing connection flow for a service like Gmail or Slack.

    Use this when the user explicitly asks Hermes to connect or authorize a service.
    The toolkit input can be an exact Composio slug like "googlecalendar" or a human name
    like "Google Calendar" when it resolves unambiguously.
    After calling this tool, tell the user to use the Vervo connection card. Do not paste
    authentication URLs into the chat.
    Returns structured connection request data including the request id, current status,
    and enough metadata for Vervo to render a connect button.
    """

    del reason
    toolkit_query = toolkit.strip()

    try:
        payload = _request(
            "POST",
            "/connections/request",
            {"toolkit": toolkit_query},
        )
        request = _sanitize_connection_request(payload["request"])
        return _structured_result(
            {
                "kind": "connection_request",
                "request": request,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return _structured_result(
            {
                "kind": "connection_request",
                "request": {
                    "id": f"local-{toolkit_query.lower().replace(' ', '-')}",
                    "toolkitSlug": toolkit_query.strip().lower(),
                    "toolkitName": _toolkit_title(toolkit_query),
                    "logoUrl": None,
                    "status": "failed",
                    "redirectUrl": None,
                    "connectedAccountId": None,
                    "errorMessage": str(exc),
                },
            }
        )


@mcp.tool()
def search_toolkits(query: str, limit: int | None = None) -> types.CallToolResult:
    """Search Composio app/toolkit catalog by human name or use case.

    Use this when the user wants to connect an app but the exact toolkit slug is unknown.
    Results include whether the current user already has that toolkit connected.
    """

    payload = _request(
        "GET",
        _with_query("/connections/toolkits", {
            "query": query,
            **({"limit": limit} if isinstance(limit, int) else {}),
        }),
    )
    return _structured_result(payload)


@mcp.tool()
def list_connections() -> types.CallToolResult:
    """List the user's known Vervo connections and whether they are active."""

    payload = _request("GET", "/connections")
    return _structured_result(payload)


@mcp.tool()
def get_connection_status(request_id: str) -> types.CallToolResult:
    """Get the latest status for a previously created connection request."""

    payload = _request("GET", f"/connections/requests/{urllib.parse.quote(request_id)}")
    return _structured_result(payload)


@mcp.tool()
def search_composio_tools(query: str, toolkits: list[str] | None = None) -> types.CallToolResult:
    """Search Composio tools by use case.

    Use this before attempting a third-party app action when you do not yet know the best
    tool slug. Optionally narrow results to specific toolkits like ['gmail'] or ['slack'].
    """

    payload = _request(
        "POST",
        "/composio/tools/search",
        {
            "query": query,
            **({"toolkits": toolkits} if toolkits else {}),
        },
    )
    return _structured_result(payload)


@mcp.tool()
def get_composio_tool_schemas(tool_slugs: list[str]) -> types.CallToolResult:
    """Fetch input schemas for Composio tools by slug.

    Call this after search_composio_tools and before execute_composio_tool when you need the
    exact parameter schema for one or more tool slugs.
    """

    payload = _request(
        "POST",
        "/composio/tools/schemas",
        {
            "toolSlugs": tool_slugs,
        },
    )
    return _structured_result(payload)


@mcp.tool()
def execute_composio_tool(tool_slug: str, arguments: dict[str, Any] | None = None) -> types.CallToolResult:
    """Execute a Composio-backed tool through Vervo's bridge.

    Use this only after identifying the right tool slug and argument schema. The result is the
    raw Composio execution payload: data, error, and logId.
    """

    payload = _request(
        "POST",
        "/composio/tools/execute",
        {
            "toolSlug": tool_slug,
            "arguments": arguments or {},
        },
    )
    return _structured_result(payload)


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    if not ORCHESTRATOR_BASE_URL:
        raise RuntimeError("VERVO_ORCHESTRATOR_BASE_URL is not set")

    request = urllib.request.Request(
        f"{ORCHESTRATOR_BASE_URL}{path}",
        method=method,
        headers={"Content-Type": "application/json"},
    )

    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    try:
        with urllib.request.urlopen(request, data=data, timeout=30) as response:
            raw = response.read().decode("utf-8")
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
            raise RuntimeError(f"Unexpected response payload for {path}")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace").strip()
        raise RuntimeError(details or f"HTTP {exc.code} while calling {path}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to reach Vervo orchestrator at {ORCHESTRATOR_BASE_URL}") from exc


def _structured_result(payload: dict[str, Any]) -> types.CallToolResult:
    text = json.dumps(payload, ensure_ascii=True)
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=text)],
        structuredContent=payload,
    )


def _toolkit_title(toolkit_slug: str) -> str:
    normalized = toolkit_slug.strip().lower()
    if normalized == "gmail":
        return "Gmail"
    return toolkit_slug.replace("_", " ").replace("-", " ").title()


def _with_query(path: str, params: dict[str, Any]) -> str:
    query = urllib.parse.urlencode({
        key: value for key, value in params.items()
        if value is not None and str(value).strip() != ""
    })
    return f"{path}?{query}" if query else path


def _sanitize_connection_request(request: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(request)
    sanitized["redirectUrl"] = None
    return sanitized


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
