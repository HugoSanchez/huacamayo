---
name: verso-composio
description: How to reach external services (Gmail, Slack, Google Workspace, Notion, GitHub, Linear, etc.) through verso's backend-backed Composio bridge. Always prefer this over shell CLIs like `gws`, `gh`, or `himalaya`; those bypass the verso connection card UX.
version: 1.0.0
author: verso
license: MIT
metadata:
  hermes:
    tags: [Composio, MCP, Gmail, Slack, Google, Notion, GitHub, Linear, OAuth, verso]
---

# Verso Composio Integration

External-service tools in verso come through the `verso` MCP server. The Composio API key stays on the backend. Hermes uses the native `mcp_verso_*` connected-app tools, discovered through Hermes tool search when not directly visible.

## Cardinal Rule

For anything that touches a connected third-party app, use the verso Composio bridge. Do not use shell CLIs (`gws`, `gh`, `himalaya`, `slack-cli`, etc.) or direct provider APIs. Those paths bypass verso's connection UX and do not match the user's Composio connection state.

## Tool Flow

1. Prefer a directly visible native `mcp_verso_*` connected-app tool when one matches the request.
2. If the right tool is not visible, call Hermes `tool_search` with the app and action, for example `tool_search({ query: "gmail send email" })`.
3. Top `tool_search` matches include the tool's `parameters` schema inline. When a match has `parameters`, skip `tool_describe` and invoke directly.
4. Use `tool_describe({ name: "<returned tool name>" })` only when the match did not include `parameters` and the arguments are not already known.
5. Invoke the deferred native tool with `tool_call({ name: "<returned tool name>", arguments: { ... } })`.
6. If no native tool exists for the app, the user likely has not connected it — check `mcp_verso_list_connections` and use the connection flow below.

Do not invent arguments. Use the native tool schema from the visible tool list, the `tool_search` match, or `tool_describe`.

## Reuse Within a Conversation

Discovery is expensive. Before calling `tool_search` or `tool_describe`, check earlier tool results in this conversation:

- If you already used or described a native tool, reuse that tool name and argument schema.
- If you already saw `mcp_verso_list_connections` output, do not call it again unless the user asks about connection state, a connection just changed, or a tool failed with a missing-connection error.
- If the user's request is the same kind of action as a prior turn, reuse the same native tool. Only rediscover if the action is genuinely new or the prior tool failed.

When in doubt about whether a prior native tool applies, prefer reusing it and executing once. A failed execution is cheaper than repeating discovery.

## Connection Management

If a tool reports no active connection, or the user asks to connect a service, call:

```
mcp_verso_request_connection({ toolkit: "<slug>" })
```

Then tell the user to use the connection card in chat. Do not paste raw OAuth URLs into the conversation.

To check state without starting a flow, call `mcp_verso_list_connections` or `mcp_verso_get_connection_status({ request_id })`.

## Common Toolkit Slugs

| Service | Toolkit slug | Native discovery query |
|---|---|---|
| Gmail | `gmail` | `tool_search({ query: "gmail send email" })` |
| Google Calendar | `googlecalendar` | `tool_search({ query: "google calendar create event" })` |
| Google Drive | `googledrive` | `tool_search({ query: "google drive find file" })` |
| Google Docs | `googledocs` | `tool_search({ query: "google docs read document" })` |
| Google Sheets | `googlesheets` | `tool_search({ query: "google sheets read values" })` |
| Slack | `slack` | `tool_search({ query: "slack search messages" })` |
| Notion | `notion` | `tool_search({ query: "notion search pages" })` |
| GitHub | `github` | `tool_search({ query: "github find issue" })` |
| Linear | `linear` | `tool_search({ query: "linear find issue" })` |

If the user names a service that is not in this table, resolve it with `mcp_verso_search_toolkits({ query: "<service name>" })`.

## What Not To Do

- Do not call Composio hosted MCP helper tools such as `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_MANAGE_CONNECTIONS`, or `COMPOSIO_INITIATE_CONNECTION`.
- Do not fabricate tool names or slugs.
- Do not execute a tool with `{}` when the schema has required fields.
- Do not retry the same failed tool call with the same arguments.
- Do not paste raw OAuth URLs into chat.

## Error Recovery

| Error | Cause | Fix |
|---|---|---|
| `Missing required argument "X"` | Execution skipped a required schema field | Fill that exact field from the schema and retry once |
| `No Active connection for toolkit=X` | User has not connected the toolkit | Call `mcp_verso_request_connection({ toolkit: "X" })` |
| `Rate limit exceeded` | Composio throttled the call | Back off once; do not loop |
