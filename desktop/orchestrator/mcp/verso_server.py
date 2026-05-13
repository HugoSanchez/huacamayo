#!/usr/bin/env python3
"""verso MCP bridge for Hermes.

This server exposes verso's local tool gateway to Hermes: connection flows,
connection state, app/action discovery, schema inspection, and action execution.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import anyio
import mcp.types as types
from mcp.server.fastmcp import FastMCP
from mcp.server.stdio import stdio_server


SERVER_NAME = "verso"
ORCHESTRATOR_BASE_URL = os.environ.get("VERSO_ORCHESTRATOR_BASE_URL", "").rstrip("/")

mcp = FastMCP(
    SERVER_NAME,
    instructions=(
        "verso app bridge. For external app work, use the app gateway tools: "
        "apps_list_connections to inspect available connections, "
        "apps_find_action(app?, intent) to discover a small set of actions, "
        "apps_get_action_schema(action_id) when you need exact parameters, "
        "and apps_execute_action(action_id, arguments) to run the selected "
        "action. Do not guess provider tool slugs or call raw Composio tools.\n\n"
        "Connection management for ALL apps goes through verso, not Composio. "
        "If action discovery or execution reports that no active connection exists, "
        "call verso.request_connection({toolkit: <slug>}) instead. After it "
        "returns, tell the user to use the verso connection card that appears "
        "in chat — never paste the raw authentication URL into the "
        "conversation.\n\n"
        "Use search_toolkits only to resolve an ambiguous app name to a "
        "Composio toolkit slug, and get_connection_status to poll an "
        "in-flight connection request."
    ),
)


@mcp.tool()
def request_connection(toolkit: str, reason: str | None = None) -> types.CallToolResult:
    """Start a user-facing connection flow for a service like Gmail or Slack.

    Use this whenever you need authentication for a Composio toolkit — either
    because the user explicitly asked to connect a service, or because a
    Composio tool returned a status_message asking for COMPOSIO_MANAGE_CONNECTIONS.
    The toolkit input can be an exact Composio slug like "googlecalendar" or a
    human name like "Google Calendar" when it resolves unambiguously.
    After calling this tool, tell the user to use the verso connection card.
    Do not paste authentication URLs into the chat.
    Returns structured connection request data including the request id, current
    status, and enough metadata for verso to render a connect button.
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

    Use this when the user wants to connect an app but the exact toolkit slug is
    unknown. Results include whether the current user already has that toolkit
    connected.
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
    """List the user's known verso connections and whether they are active."""

    payload = _request("GET", "/connections")
    return _structured_result(payload)


@mcp.tool()
def apps_list_connections() -> types.CallToolResult:
    """List connected external apps available to the app action gateway."""

    payload = _request("GET", "/connections")
    return _structured_result(payload)


@mcp.tool()
def get_connection_status(request_id: str) -> types.CallToolResult:
    """Get the latest status for a previously created connection request."""

    payload = _request("GET", f"/connections/requests/{urllib.parse.quote(request_id)}")
    return _structured_result(payload)


@mcp.tool()
def apps_find_action(
    intent: str,
    app: str | None = None,
    limit: int | None = None,
) -> types.CallToolResult:
    """Find provider-backed app actions by natural-language intent.

    Use this before any external app operation. Provide app when known (for
    example "slack", "gmail", "google drive", or "calendar"). The result
    contains opaque action_id values; pass those to apps_get_action_schema and
    apps_execute_action instead of raw provider tool names.
    """

    payload = _request(
        "POST",
        "/apps/actions/find",
        {
            "intent": intent,
            "app": app,
            "limit": limit,
        },
    )
    return _structured_result(payload)


@mcp.tool()
def apps_get_action_schema(action_id: str) -> types.CallToolResult:
    """Get the exact JSON input schema for an action returned by apps_find_action."""

    payload = _request(
        "POST",
        "/apps/actions/schema",
        {
            "action_id": action_id,
        },
    )
    return _structured_result(payload)


@mcp.tool()
def apps_execute_action(
    action_id: str,
    arguments: dict[str, Any] | None = None,
) -> types.CallToolResult:
    """Execute an app action returned by apps_find_action.

    Arguments are validated and sanitized by verso's gateway before provider
    execution. If a required argument is missing, inspect the schema and retry.
    """

    payload = _request(
        "POST",
        "/apps/actions/execute",
        {
            "action_id": action_id,
            "arguments": arguments or {},
        },
    )
    return _structured_result(payload)


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    if not ORCHESTRATOR_BASE_URL:
        raise RuntimeError("VERSO_ORCHESTRATOR_BASE_URL is not set")

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
        raise RuntimeError(f"Failed to reach verso orchestrator at {ORCHESTRATOR_BASE_URL}") from exc


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


async def _run_stdio_async() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await mcp._mcp_server.run(  # noqa: SLF001
            read_stream,
            write_stream,
            mcp._mcp_server.create_initialization_options(),
        )


def main() -> None:
    anyio.run(_run_stdio_async)


if __name__ == "__main__":
    main()
