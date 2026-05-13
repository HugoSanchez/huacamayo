/**
 * Probe Composio's per-user MCP server to answer three questions before
 * we cut over to talking to it directly from Hermes:
 *
 *   1. Transport flavor (Streamable HTTP vs SSE)
 *   2. Auth header behavior (what key, does it rotate)
 *   3. Whether the server fires notifications/tools/list_changed when a
 *      new connection lands on the user, so we know if Hermes will see
 *      newly-authorized toolkits without a session refresh.
 *
 * Run with:
 *   COMPOSIO_API_KEY=ak_... tsx backend/scripts/probe-composio-mcp.ts
 *
 * The probe mints a session for a deterministic probe user, opens an MCP
 * connection, lists tools, then idles for 90s logging every notification
 * it receives. During that window, manually authorize a Composio toolkit
 * (Gmail is fastest) for the probe user via the Composio dashboard or a
 * second tab — we want to see whether the open MCP session learns about
 * the new toolkit on its own.
 */

import 'dotenv/config';
import { Composio } from '@composio/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PROBE_USER_ID = process.env.PROBE_USER_ID?.trim() || 'verso-mcp-probe';
const IDLE_SECONDS = Number(process.env.PROBE_IDLE_SECONDS ?? 90);

function log(label: string, payload?: unknown): void {
  const ts = new Date().toISOString();
  if (payload === undefined) {
    console.log(`[${ts}] ${label}`);
  } else {
    console.log(`[${ts}] ${label}`, JSON.stringify(payload, null, 2));
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('COMPOSIO_API_KEY must be set');
  }

  log(`Probe userId: ${PROBE_USER_ID}`);
  log('Minting Composio session…');

  const composio = new Composio({ apiKey });
  const manageConnectionsOpt = process.env.PROBE_MANAGE_CONNECTIONS === 'false'
    ? false
    : true;
  log(`manageConnections = ${manageConnectionsOpt}`);
  const session = await composio.create(PROBE_USER_ID, {
    manageConnections: manageConnectionsOpt,
  });

  const apiKeyHeader = (session.mcp?.headers as Record<string, string> | undefined)?.['x-api-key'];
  log('Session created', {
    sessionId: session.sessionId,
    mcpUrl: session.mcp?.url,
    mcpHeaders: session.mcp?.headers
      ? Object.keys(session.mcp.headers)
      : null,
    apiKeyHeaderMatchesEnv: apiKeyHeader === apiKey,
    apiKeyHeaderPrefix: apiKeyHeader?.slice(0, 8) ?? null,
    envApiKeyPrefix: apiKey.slice(0, 8),
  });

  if (!session.mcp?.url) {
    throw new Error('Session has no mcp.url');
  }

  const url = new URL(session.mcp.url);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: session.mcp.headers ?? {},
    },
  });

  const client = new Client(
    { name: 'verso-probe', version: '0.0.1' },
    { capabilities: {} },
  );

  // Surface every notification the server emits so we can see whether
  // tools/list_changed (or anything else) gets pushed when connections
  // change mid-session.
  client.fallbackNotificationHandler = async (notification) => {
    log('notification', notification);
  };

  log('Connecting to MCP server…');
  await client.connect(transport);

  const serverInfo = client.getServerVersion();
  const serverCapabilities = client.getServerCapabilities();
  log('Server info', { serverInfo, serverCapabilities });

  // Probe: does the server declare tools.listChanged in its capabilities?
  // (This is the spec way to advertise that it will push tool-list updates.)
  const listChangedAdvertised = Boolean(
    serverCapabilities?.tools?.listChanged ?? false,
  );
  log(`capabilities.tools.listChanged = ${listChangedAdvertised}`);

  // Initial tool inventory.
  log('Listing tools…');
  const initialList = await client.listTools();
  log(`Initial tools: ${initialList.tools.length}`);
  for (const tool of initialList.tools) {
    console.log(`  - ${tool.name}`);
    if (tool.description) {
      console.log(`      desc: ${tool.description.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
    if (tool.inputSchema) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      if (props) {
        console.log(`      inputs: ${Object.keys(props).join(', ')}`);
      }
    }
  }

  // Probe COMPOSIO_SEARCH_TOOLS for a toolkit we haven't connected — this is
  // what Hermes would call to discover Gmail tools mid-conversation.
  log('Trying COMPOSIO_SEARCH_TOOLS for "send email" / gmail…');
  try {
    const searchResult = await client.callTool({
      name: 'COMPOSIO_SEARCH_TOOLS',
      arguments: { query: 'send email', toolkits: ['gmail'] },
    });
    const text = Array.isArray(searchResult.content)
      ? searchResult.content
          .map((c) => ('text' in c ? String((c as { text: string }).text) : JSON.stringify(c)))
          .join('\n')
      : JSON.stringify(searchResult);
    console.log(text.slice(0, 4000));
  } catch (error) {
    log('search failed', { error: error instanceof Error ? error.message : String(error) });
  }

  // Did the server return a session id header for state? (Streamable HTTP)
  // The transport exposes it via the response headers it remembers.
  const sessionIdHeader = (transport as unknown as {
    sessionId?: string;
  }).sessionId;
  log(`Streamable HTTP session id: ${sessionIdHeader ?? '(none)'}`);

  log(
    `Idling for ${IDLE_SECONDS}s — authorize a Composio toolkit (e.g. Gmail) `
      + `for user "${PROBE_USER_ID}" now to test live tool-list updates.`,
  );

  // Optionally exercise an actual tool execution end-to-end. Set
  // PROBE_EXECUTE_SLUG (and PROBE_EXECUTE_ARGS_JSON if the tool needs args)
  // to see the raw response Composio's MCP server returns for a real
  // tool invocation — useful when COMPOSIO_MULTI_EXECUTE_TOOL is failing
  // mid-conversation and we want to see the unmangled error body.
  const executeSlug = process.env.PROBE_EXECUTE_SLUG?.trim();
  if (executeSlug) {
    const rawArgs = process.env.PROBE_EXECUTE_ARGS_JSON?.trim() || '{}';
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch (error) {
      log('PROBE_EXECUTE_ARGS_JSON is not valid JSON', { rawArgs, error: String(error) });
    }
    log(`Trying COMPOSIO_MULTI_EXECUTE_TOOL with ${executeSlug}`);
    try {
      const execResult = await client.callTool({
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        arguments: {
          tools: [
            {
              tool_slug: executeSlug,
              arguments: parsedArgs,
            },
          ],
          thought: 'probe-composio-mcp execution test',
        },
      });
      const text = Array.isArray(execResult.content)
        ? execResult.content
            .map((c) => ('text' in c ? String((c as { text: string }).text) : JSON.stringify(c)))
            .join('\n')
        : JSON.stringify(execResult);
      console.log('--- execute response ---');
      console.log(text.slice(0, 8000));
      console.log('--- end execute response ---');
    } catch (error) {
      log('execute call threw', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000));

  log('Re-listing tools after idle window…');
  const finalList = await client.listTools();
  log(`Final tools: ${finalList.tools.length}`);

  const initialNames = new Set(initialList.tools.map((t) => t.name));
  const added = finalList.tools.filter((t) => !initialNames.has(t.name));
  log(`Tools added during idle: ${added.length}`);
  for (const tool of added) {
    console.log(`  + ${tool.name}`);
  }

  await client.close();
  log('Done.');
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
