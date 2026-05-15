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

External-service tools in verso come through the `verso` MCP server. The Composio API key stays on the backend. Hermes sees a small bridge:

1. `verso.search_composio_tools`
2. `verso.get_composio_tool_schemas`
3. `verso.execute_composio_tool`

## Cardinal Rule

For anything that touches a connected third-party app, use the verso Composio bridge. Do not use shell CLIs (`gws`, `gh`, `himalaya`, `slack-cli`, etc.) or direct provider APIs. Those paths bypass verso's connection UX and do not match the user's Composio connection state.

## Tool Flow

1. If you need to know what is connected, call `verso.list_connections`.
2. Search for the right Composio tool:
   `verso.search_composio_tools({ query: "<specific use case>", toolkits: ["<slug>"] })`
3. Pick the best returned `slug`, for example `SLACK_SEARCH_MESSAGES`.
4. Fetch the exact schema:
   `verso.get_composio_tool_schemas({ tool_slugs: ["SLACK_SEARCH_MESSAGES"] })`
5. Execute the same slug:
   `verso.execute_composio_tool({ tool_slug: "SLACK_SEARCH_MESSAGES", arguments: { ... } })`

Do not invent arguments. Use the schema from `get_composio_tool_schemas`.

## Reuse Within a Conversation

Discovery is expensive. Before calling `verso.search_composio_tools` or `verso.get_composio_tool_schemas`, check your earlier tool results in this conversation:

- If you have already retrieved a schema for a slug (e.g. `GRANOLA_MCP_GET_MEETING_TRANSCRIPT`), reuse that schema from the prior `get_composio_tool_schemas` result and go straight to `execute_composio_tool`. Do not re-search and do not re-fetch the schema.
- If you have already seen `list_connections` output earlier in the conversation, do not call it again unless the user is asking about connection state, you suspect a connection just changed, or a tool call failed with a missing-connection error.
- If the user's request is clearly the same kind of action as a prior turn (e.g. "fetch my latest Granola transcript" after you already did one), reuse the same slug. Only re-discover if the requested action is genuinely new or the prior slug failed.

When in doubt about whether a prior slug applies, prefer reusing it and executing — a failed execution is cheaper than re-running the full discovery flow.

## Reuse Across Conversations — Save What You Learn

Within a conversation, the schemas live in your context. Across conversations, they don't — unless you save them as a skill. After you have successfully discovered and used Composio tools for a toolkit, persist what you learned via `skill_manage` so future sessions skip the discovery flow entirely:

```
skill_manage({
  action: "create",
  name: "<toolkit>-quick-actions",   // e.g. "granola-meeting-notes", "slack-quick-actions"
  category: "productivity",
  content: "<SKILL.md body — see below>"
})
```

Capture in the SKILL.md body:

- The Composio toolkit slug (e.g. `granola_mcp`, `slack`, `gmail`).
- The specific tool slugs you used and a one-line description of each (e.g. `GRANOLA_MCP_GET_MEETING_TRANSCRIPT — verbatim transcript by meeting UUID`).
- A short "when to use this skill" sentence so it activates on the right user intents.
- Any non-obvious gotchas you hit and resolved (parameter quirks, validation errors, fallback paths). Real failures you overcame are the most valuable part.
- Brief examples of `verso.execute_composio_tool` calls with realistic arguments.

If you later use a skill and find it incomplete or wrong (e.g. a slug renamed, a parameter shape changed), patch it immediately with `skill_manage({ action: "patch", ... })` — do not wait to be asked. The goal is that the second time a user asks for a given kind of task, you go straight from `skill_view` to `execute_composio_tool`, with no `search_composio_tools` or `get_composio_tool_schemas` in between.

Note: the verso MCP server is named `verso`, so its tools appear as `mcp_verso_*` (e.g. `mcp_verso_list_connections`). When writing skills, refer to tools by these current names.

## Connection Management

If a tool reports no active connection, or the user asks to connect a service, call:

```
verso.request_connection({ toolkit: "<slug>" })
```

Then tell the user to use the connection card in chat. Do not paste raw OAuth URLs into the conversation.

To check state without starting a flow, call `verso.list_connections` or `verso.get_connection_status({ request_id })`.

## Common Toolkit Slugs

| Service | Toolkit slug | Search example |
|---|---|---|
| Gmail | `gmail` | `search_composio_tools(query: "send Gmail email", toolkits: ["gmail"])` |
| Google Calendar | `googlecalendar` | `search_composio_tools(query: "create calendar event", toolkits: ["googlecalendar"])` |
| Google Drive | `googledrive` | `search_composio_tools(query: "find Google Drive file", toolkits: ["googledrive"])` |
| Google Docs | `googledocs` | `search_composio_tools(query: "read Google Doc", toolkits: ["googledocs"])` |
| Google Sheets | `googlesheets` | `search_composio_tools(query: "read spreadsheet values", toolkits: ["googlesheets"])` |
| Slack | `slack` | `search_composio_tools(query: "search Slack messages", toolkits: ["slack"])` |
| Notion | `notion` | `search_composio_tools(query: "search Notion pages", toolkits: ["notion"])` |
| GitHub | `github` | `search_composio_tools(query: "find GitHub issue", toolkits: ["github"])` |
| Linear | `linear` | `search_composio_tools(query: "find Linear issue", toolkits: ["linear"])` |

If the user names a service that is not in this table, resolve it with `verso.search_toolkits({ query: "<service name>" })`.

## What Not To Do

- Do not call Composio hosted MCP helper tools such as `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_MANAGE_CONNECTIONS`, or `COMPOSIO_INITIATE_CONNECTION`.
- Do not fabricate tool slugs. Search first, then use returned slugs.
- Do not execute a tool with `{}` when the schema has required fields.
- Do not retry the same failed tool call with the same arguments.
- Do not paste raw OAuth URLs into chat.

## Error Recovery

| Error | Cause | Fix |
|---|---|---|
| `Missing "query"` | The search call was empty | Retry `search_composio_tools` with a concrete use case |
| `Missing "toolSlugs"` | Schema lookup had no slug | Use a slug returned by search |
| `Missing required argument "X"` | Execution skipped a required schema field | Fill that exact field from the schema and retry once |
| `No Active connection for toolkit=X` | User has not connected the toolkit | Call `verso.request_connection({ toolkit: "X" })` |
| `Rate limit exceeded` | Composio throttled the call | Back off once; do not loop |

## Examples

**Search Slack for messages from Will Button about Katana**

```
verso.search_composio_tools({
  query: "search Slack messages from Will Button about Katana CTO introduction",
  toolkits: ["slack"]
})
verso.get_composio_tool_schemas({ tool_slugs: ["SLACK_SEARCH_MESSAGES"] })
verso.execute_composio_tool({
  tool_slug: "SLACK_SEARCH_MESSAGES",
  arguments: { query: "\"Will Button\" Katana CTO", count: 10 }
})
```

Slack search modifiers such as `from:`, `in:`, `before:`, and `after:` belong inside `query` when the schema accepts a query string.

**Find Google Drive files with Lido in the title**

```
verso.search_composio_tools({
  query: "find Google Drive files by title",
  toolkits: ["googledrive"]
})
verso.get_composio_tool_schemas({ tool_slugs: ["GOOGLEDRIVE_FIND_FILE"] })
verso.execute_composio_tool({
  tool_slug: "GOOGLEDRIVE_FIND_FILE",
  arguments: { q: "name contains 'Lido' and trashed = false", pageSize: 10 }
})
```

**Send an email**

```
verso.search_composio_tools({ query: "send Gmail email", toolkits: ["gmail"] })
verso.get_composio_tool_schemas({ tool_slugs: ["<returned Gmail send slug>"] })
verso.execute_composio_tool({
  tool_slug: "<returned Gmail send slug>",
  arguments: {
    recipient_email: "alice@example.com",
    subject: "Hello",
    body: "<the user's intended body>"
  }
})
```

Confirm recipient, subject, and body with the user before sending.
