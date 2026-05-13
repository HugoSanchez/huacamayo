---
name: verso-composio
description: How to reach external services (Gmail, Slack, Google Workspace, Notion, GitHub, Linear, …) through verso's local app action gateway. Always prefer this over raw Composio tools or shell CLIs like `gws`, `gh`, or `himalaya` — those bypass the verso connection card UX.
version: 1.0.0
author: verso
license: MIT
metadata:
  hermes:
    tags: [Composio, MCP, Gmail, Slack, Google, Notion, GitHub, Linear, OAuth, verso]
---

# Verso Composio integration

External-service tools in verso come through the **local app action gateway** exposed by the `verso` MCP server. Hermes does not call raw Composio tools directly. Instead, it asks verso to find an action by intent, receives opaque `actionId` values, inspects schemas when needed, and executes actions through the gateway.

## The cardinal rule

**For anything that touches a connected third-party app, use the verso app action gateway.** Do not call raw Composio tools, shell CLIs (`gws`, `gh`, `himalaya`, `slack-cli`, etc.), or Python that calls Google APIs directly. Those paths bypass verso's connection UX, require manual OAuth setup, and break the in-chat connection card.

## How to use app actions

1. Call `verso.apps_list_connections` if you need to know what is connected.
2. Call `verso.apps_find_action({ app?, intent })` with a concrete use case.
3. Pick the best returned `actionId`. If the arguments are not obvious, call `verso.apps_get_action_schema({ action_id })`.
4. Call `verso.apps_execute_action({ action_id, arguments })`. Pass only fields in the schema. If the gateway returns a validation error, inspect the schema and retry once.

## Connection management

If a tool returns "no active connection" or you need a new toolkit authorized, **always call** `verso.request_connection({toolkit: <slug>})`. That renders a styled connection card in chat. **Never paste raw OAuth URLs into the conversation** — they don't redirect properly outside the verso shell.

To check connection state without starting a flow, call `verso.list_connections` or `verso.get_connection_status({request_id})`.

## Common toolkits and their slugs

| Service | Toolkit slug | Gateway usage |
|---|---|---|
| Gmail | `gmail` | `apps_find_action(app: "gmail", intent: "...")` |
| Google Calendar | `googlecalendar` | `apps_find_action(app: "googlecalendar", intent: "...")` |
| Google Drive | `googledrive` | `apps_find_action(app: "googledrive", intent: "...")` |
| Google Docs | `googledocs` | `apps_find_action(app: "googledocs", intent: "...")` |
| Google Sheets | `googlesheets` | `apps_find_action(app: "googlesheets", intent: "...")` |
| Slack | `slack` | `apps_find_action(app: "slack", intent: "...")` |
| Notion | `notion` | `apps_find_action(app: "notion", intent: "...")` |
| GitHub | `github` | `apps_find_action(app: "github", intent: "...")` |
| Linear | `linear` | `apps_find_action(app: "linear", intent: "...")` |

If the user names a service that isn't in this table, look up the slug with `verso.search_toolkits({query: "<service name>"})`.

## What NOT to do

- Do **not** call `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_INITIATE_CONNECTION`, or any Composio-native helper directly. Use the gateway tools.
- Do **not** fabricate provider tool slugs or arguments. Use `actionId` values returned by `apps_find_action`.
- Do **not** write `subprocess.run(["gws", ...])`, `gh issue create`, `himalaya send`, or similar shell invocations for services that have a Composio toolkit. The user has not set up those CLIs, and even if they had, the auth wouldn't match verso's connection state.
- Do **not** paste raw OAuth `https://composio.dev/...` URLs into chat. The user clicks the verso connection card; not a link.

## Error patterns and how to recover

| Error | Cause | Fix |
|---|---|---|
| `Missing required argument "X"` | You skipped a required input from the action schema | Call `apps_get_action_schema`, fill that field, retry |
| `Unknown action_id` | The action cache expired or you guessed an id | Call `apps_find_action` again |
| `No Active connection for toolkit=X` | User hasn't connected this toolkit yet | Call `verso.request_connection({toolkit: "X"})` and tell the user to use the card |
| `Rate limit exceeded` | Composio throttled the call | Backoff once, then retry; do not loop |

## Workflow examples

**"Search Slack for messages from Will Button about Katana"**

```
verso.apps_find_action({ app: "slack", intent: "search Slack messages from Will Button about Katana" })
verso.apps_get_action_schema({ action_id: "<returned actionId>" })
verso.apps_execute_action({
  action_id: "<returned actionId>",
  arguments: { query: "from:Will Button Katana", count: 10 }
})
```

Pass Slack search modifiers directly in `query` — `from:`, `in:`, `before:`, `after:`, etc. work natively.

**"Find Google Drive files with Lido in the title"**

```
verso.apps_find_action({ app: "googledrive", intent: "find Google Drive files with Lido in the title" })
verso.apps_get_action_schema({ action_id: "<returned actionId>" })
verso.apps_execute_action({
  action_id: "<returned actionId>",
  arguments: { q: "name contains 'Lido' and trashed = false", pageSize: 10 }
})
```

**"Send an email to alice@example.com with subject Hello"**

```
verso.apps_find_action({ app: "gmail", intent: "send an email" })
verso.apps_get_action_schema({ action_id: "<returned actionId>" })
verso.apps_execute_action({
  action_id: "<returned actionId>",
  arguments: {
    recipient_email: "alice@example.com",
    subject: "Hello",
    body: "<the user's intended body>"
  }
})
```

Always confirm subject + body + recipient with the user before calling — sends are irreversible.

**"List my unread emails from this week"**

```
verso.apps_find_action({ app: "gmail", intent: "list unread Gmail messages from this week" })
verso.apps_execute_action({
  action_id: "<returned actionId>",
  arguments: { query: "is:unread newer_than:7d", max_results: 25 }
})
```

Gmail search syntax works inside `query`.

**"User asks for something that needs Notion, and Notion isn't connected"**

```
verso.request_connection({ toolkit: "notion" })
→ tell the user: "I've opened a connection card in this chat — click Connect Notion to authorize, then I'll continue."
```
