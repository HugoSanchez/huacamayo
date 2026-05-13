/**
 * Probe Composio's Single Toolkit MCP (mcp.create + mcp.generate), as
 * opposed to the Tool Router we currently use. The Tool Router exposes 6
 * meta-tools and requires the agent to follow SEARCH→GET_SCHEMAS→EXECUTE; in
 * practice gpt-5.4 keeps skipping GET_SCHEMAS, so EXECUTE fails with
 * "Required field 'query' missing".
 *
 * Single Toolkit MCP should expose each Composio tool (e.g.
 * SLACK_SEARCH_MESSAGES) as a first-class MCP tool with its own input schema.
 * Hermes' MCP client will then surface that schema to the model and the model
 * can't omit a required arg.
 *
 * Goal of this probe: confirm that exact shape — tools listed directly,
 * inputSchema declares `query` required, execute succeeds with proper args.
 *
 *   COMPOSIO_API_KEY=ak_... PROBE_USER_ID=usr_... \
 *     npx tsx scripts/probe-composio-direct-mcp.ts
 */

import 'dotenv/config';
import { Composio } from '@composio/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PROBE_USER_ID = process.env.PROBE_USER_ID?.trim() || 'verso-mcp-probe';

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
  if (!apiKey) throw new Error('COMPOSIO_API_KEY must be set');

  log(`Probe userId: ${PROBE_USER_ID}`);

  const composio = new Composio({ apiKey });

  // 1. Create a Single Toolkit MCP server config (one-time per server name).
  //    `allowedTools` is the allowlist — the LLM only sees these.
  log('Creating Single Toolkit MCP server config…');
  let server: { id: string; allowedTools?: string[]; name?: string };
  try {
    const mcpAny = (composio as unknown as { mcp?: Record<string, unknown> }).mcp;
    if (!mcpAny || typeof (mcpAny as { create?: unknown }).create !== 'function') {
      throw new Error('composio.mcp.create is not available — SDK may need an experimental flag');
    }
    server = await (mcpAny as {
      create: (name: string, opts: Record<string, unknown>) => Promise<{
        id: string; allowedTools?: string[]; name?: string;
      }>;
    }).create('verso-probe-slack', {
      toolkits: [{ toolkit: 'slack' }],
      allowedTools: ['SLACK_SEARCH_MESSAGES', 'SLACK_LIST_ALL_CHANNELS', 'SLACK_SEARCH_USERS'],
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log('mcp.create failed', { msg });
    throw error;
  }
  log('Server config', { id: server.id, name: server.name, allowedTools: server.allowedTools });

  // 2. Generate a per-user MCP URL against that server config.
  log('Generating per-user MCP URL…');
  const mcpAny = (composio as unknown as { mcp: { generate: (uid: string, sid: string) => Promise<Record<string, unknown>> } }).mcp;
  const instance = await mcpAny.generate(PROBE_USER_ID, server.id);
  log('Instance', instance);

  // Find the URL on the instance — different SDK versions surface it under
  // different keys (url, mcp.url, serverUrl). Try a few.
  const instanceRec = instance as Record<string, unknown>;
  const url = (typeof instanceRec.url === 'string' && instanceRec.url)
    || (typeof (instanceRec.mcp as { url?: unknown })?.url === 'string' && (instanceRec.mcp as { url: string }).url)
    || (typeof instanceRec.serverUrl === 'string' && instanceRec.serverUrl)
    || null;
  if (!url || typeof url !== 'string') {
    log('Could not find URL on instance — dump above for inspection');
    return;
  }

  // 3. Open MCP connection and list tools — this is the moment of truth.
  log(`Connecting to ${url}`);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { 'x-api-key': apiKey },
    },
  });
  const client = new Client(
    { name: 'verso-direct-probe', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);

  log('Server info', { serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities() });

  const tools = await client.listTools();
  log(`Tools exposed: ${tools.tools.length}`);
  for (const tool of tools.tools) {
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    } | undefined;
    console.log(`  - ${tool.name}`);
    console.log(`      desc: ${tool.description?.replace(/\s+/g, ' ').slice(0, 220)}`);
    if (schema?.properties) {
      console.log(`      inputs: ${Object.keys(schema.properties).join(', ')}`);
    }
    if (schema?.required && schema.required.length > 0) {
      console.log(`      required: ${schema.required.join(', ')}`);
    }
  }

  // 4. Try executing one with proper args.
  log('Executing SLACK_SEARCH_MESSAGES with query="Will Button"');
  try {
    const exec = await client.callTool({
      name: 'SLACK_SEARCH_MESSAGES',
      arguments: { query: 'Will Button' },
    });
    const text = Array.isArray(exec.content)
      ? exec.content.map((c) => ('text' in c ? String((c as { text: string }).text) : JSON.stringify(c))).join('\n')
      : JSON.stringify(exec);
    console.log('--- execute response ---');
    console.log(text.slice(0, 4000));
    console.log('--- end execute response ---');
  } catch (error) {
    log('execute failed', { msg: error instanceof Error ? error.message : String(error) });
  }

  await client.close();
  log('Done.');
}

main().catch((err) => {
  console.error('Direct-MCP probe failed:', err);
  process.exit(1);
});
