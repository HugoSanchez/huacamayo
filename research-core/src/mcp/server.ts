/**
 * MCP Server for research-core
 *
 * Exposes the knowledge base as MCP tools that any compatible agent
 * (Hermes, Claude Code, etc.) can connect to via stdio transport.
 *
 * Tools: context_search, context_get, entity_lookup,
 *        graph_neighbors, graph_traverse, entity_summary
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { BrainEngine } from '../engine/engine.ts';
import { createEngine } from '../engine/engine-factory.ts';
import { loadConfig, toEngineConfig } from '../engine/config.ts';
import {
  contextSearch,
  contextGet,
  entityLookup,
  graphNeighbors,
  graphTraverse,
  entitySummary,
  ToolError,
} from './tools.ts';

export const RESEARCH_CORE_MCP_TOOL_NAMES = [
  'context_search',
  'context_get',
  'entity_lookup',
  'graph_neighbors',
  'graph_traverse',
  'entity_summary',
] as const;

function toolResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function createMcpServer(engine: BrainEngine): McpServer {
  const server = new McpServer({
    name: 'research-core',
    version: '0.1.0',
  });

  // ── context_search ──────────────────────────────────────────────

  server.tool(
    'context_search',
    'Search for documents within a research context. Returns ranked chunks with relevance scores and citation handles.',
    {
      context_id: z.string().describe('The context to search within'),
      query: z.string().describe('Natural language search query'),
      limit: z.number().optional().describe('Max results to return (default 10)'),
      mode: z.enum(['fast', 'deep']).optional().describe('fast = keyword+vector only; deep = also reranks (default deep)'),
    },
    async (params) => {
      try {
        const result = await contextSearch(engine, params);
        return toolResult(result);
      } catch (e) {
        return toolError(e instanceof ToolError ? e.message : String(e));
      }
    },
  );

  // ── context_get ─────────────────────────────────────────────────

  server.tool(
    'context_get',
    'Get the full content of a document/page by its slug. Use after search to read a full document.',
    {
      context_id: z.string().describe('The context the page belongs to'),
      slug: z.string().describe('The page slug to retrieve'),
    },
    async (params) => {
      try {
        const result = await contextGet(engine, params);
        return toolResult(result);
      } catch (e) {
        return toolError(e instanceof ToolError ? e.message : String(e));
      }
    },
  );

  // ── entity_lookup ───────────────────────────────────────────────

  server.tool(
    'entity_lookup',
    'Look up an entity (person, concept, project, etc.) by name or slug. Uses fuzzy matching. Returns the entity page plus top evidence chunks mentioning it.',
    {
      context_id: z.string().describe('The context to search within'),
      name_or_slug: z.string().describe('Entity name or slug to look up (fuzzy matched)'),
    },
    async (params) => {
      try {
        const result = await entityLookup(engine, params);
        return toolResult(result);
      } catch (e) {
        return toolError(e instanceof ToolError ? e.message : String(e));
      }
    },
  );

  // ── graph_neighbors ─────────────────────────────────────────────

  server.tool(
    'graph_neighbors',
    'Get the direct neighbors of a page in the knowledge graph. Shows what entities/documents are linked to a given page.',
    {
      context_id: z.string().describe('The context to scope results to'),
      slug: z.string().describe('The page slug to get neighbors for'),
      direction: z.enum(['outgoing', 'incoming', 'both']).optional().describe('Link direction filter (default both)'),
      edge_types: z.array(z.string()).optional().describe('Filter by link types'),
      limit: z.number().optional().describe('Max neighbors to return (default 50)'),
    },
    async (params) => {
      try {
        const result = await graphNeighbors(engine, params);
        return toolResult(result);
      } catch (e) {
        return toolError(e instanceof ToolError ? e.message : String(e));
      }
    },
  );

  // ── graph_traverse ──────────────────────────────────────────────

  server.tool(
    'graph_traverse',
    'Traverse the knowledge graph starting from a page, following links up to a specified depth (max 3). Returns the subgraph of connected pages.',
    {
      context_id: z.string().describe('The context to scope results to'),
      slug: z.string().describe('Starting page slug'),
      depth: z.number().optional().describe('How many hops to follow (1-3, default 2)'),
      edge_types: z.array(z.string()).optional().describe('Filter by link types'),
    },
    async (params) => {
      try {
        const result = await graphTraverse(engine, params);
        return toolResult(result);
      } catch (e) {
        return toolError(e instanceof ToolError ? e.message : String(e));
      }
    },
  );

  // ── entity_summary ──────────────────────────────────────────────

  server.tool(
    'entity_summary',
    'Get a summary of an entity including its content, tags, neighbor count, and top evidence from the context.',
    {
      context_id: z.string().describe('The context to scope evidence to'),
      slug: z.string().describe('The entity page slug'),
    },
    async (params) => {
      try {
        const result = await entitySummary(engine, params);
        return toolResult(result);
      } catch (e) {
        return toolError(e instanceof ToolError ? e.message : String(e));
      }
    },
  );

  return server;
}

// ── Standalone entry point (stdio transport) ──────────────────────

export async function startMcpServer(): Promise<void> {
  const config = loadConfig() || { engine: 'pglite' as const };
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  await engine.initSchema();

  const server = createMcpServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGINT', async () => {
    await engine.disconnect();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await engine.disconnect();
    process.exit(0);
  });
}

// Run if executed directly
const isDirectRun = process.argv[1]?.endsWith('mcp/server.ts') ||
                    process.argv[1]?.endsWith('mcp/server.js');
if (isDirectRun) {
  startMcpServer().catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}
