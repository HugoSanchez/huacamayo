/**
 * Agent HTTP endpoints — wraps the Claude Agent SDK.
 *
 * POST /agent/query  — start a streaming agent query (SSE)
 *   Body: { prompt: string, sessionId?: string, contextId?: string }
 *   Response: Server-Sent Events stream
 *
 * POST /agent/stop    — abort the current query
 * GET  /agent/status  — current agent state
 */

import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { BrainEngine } from '../engine/engine.ts';
import { createMcpServer, RESEARCH_CORE_MCP_TOOL_NAMES } from '../mcp/server.ts';
import type { Route } from './router.ts';
import { route, json } from './router.ts';

// Active query handle — one query at a time
let activeQuery: ReturnType<typeof sdkQuery> | null = null;
let agentStatus: 'idle' | 'running' | 'error' = 'idle';
let lastError: string | null = null;

type AgentQuery = ReturnType<typeof sdkQuery>;
const MCP_SERVER_NAME = 'research-core';
const SDK_TOOL_PREFIXED_NAMES = RESEARCH_CORE_MCP_TOOL_NAMES.map(
  (tool) => `mcp__${MCP_SERVER_NAME}__${tool}`,
);
const NO_KB_INFO_MESSAGE = "I couldn't find information about that in your knowledge base right now.";
const activeContextBySession = new Map<string, string>();

type ContextResolution =
  | { kind: 'resolved'; contextId: string; source: 'request' | 'session' | 'default' | 'single' | 'latest' | 'bootstrap' }
  | { kind: 'invalid_requested_context'; requestedContextId: string }
  | { kind: 'no_contexts' }
  | { kind: 'empty_context'; contextId: string };

/** Resolve the repo root from this file's location. */
function getRepoRoot(): string {
  // This file is at <repo>/research-core/src/http/agent.ts
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), '../../../');
}

export function buildAgentRoutes(
  engine: BrainEngine,
  opts: { databasePath?: string } = {},
): Route[] {
  // In-process MCP server bound to the same engine instance as the HTTP API.
  // This avoids spawning a second process that competes for PGLite locks.
  const researchCoreMcp = createMcpServer(engine);
  const mcpServers = {
    [MCP_SERVER_NAME]: {
      type: 'sdk' as const,
      name: MCP_SERVER_NAME,
      instance: researchCoreMcp,
    },
  };

  return [
    // --- Stream a query via SSE ---
    route('POST', '/agent/query', async (_req, res, _params, body) => {
      const { prompt, sessionId, contextId } = body as {
        prompt: string;
        sessionId?: string;
        contextId?: string;
      };

      if (!prompt) {
        return json(res, 400, { error: 'bad_request', message: 'Missing "prompt"' });
      }

      if (activeQuery) {
        return json(res, 409, { error: 'conflict', message: 'A query is already running' });
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      agentStatus = 'running';
      lastError = null;

      const resolvedContext = await resolveContext(engine, {
        requestedContextId: contextId,
        sessionId,
      });

      if (resolvedContext.kind !== 'resolved') {
        sendNoKnowledgeBaseInfo(res);
        agentStatus = 'idle';
        return;
      }

      const root = getRepoRoot();

      let systemPrompt = 'You are a research assistant with access to a knowledge base via MCP tools. ';
      systemPrompt += 'Use the research-core MCP tools to answer questions. ';
      systemPrompt += `Tool names are prefixed as: ${SDK_TOOL_PREFIXED_NAMES.join(', ')}. `;
      systemPrompt += `The active research context ID is "${resolvedContext.contextId}". Use this context_id when calling MCP tools.`;

      const q = sdkQuery({
        prompt,
        options: {
          systemPrompt,
          cwd: root,
          // Chat UI is non-interactive for permission prompts; bypass checks so
          // Claude can call research-core MCP tools without asking the user.
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          strictMcpConfig: true,
          mcpServers,
          ...(isUuid(sessionId) ? { resume: sessionId } : {}),
          maxTurns: 25,
        },
      });
      activeQuery = q;

      try {
        const researchCoreStatus = await waitForResearchCoreMcp(q);
        if (researchCoreStatus.status !== 'connected') {
          const detail = researchCoreStatus.error ? `: ${researchCoreStatus.error}` : '';
          throw new Error(`research-core MCP not connected (status=${researchCoreStatus.status})${detail}`);
        }

        for await (const message of q) {
          sendSSE(res, message);
        }
        sendSSE(res, { type: 'done' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('abort') || msg.includes('Abort')) {
          sendSSE(res, { type: 'done', reason: 'aborted' });
        } else {
          lastError = msg;
          agentStatus = 'error';
          sendSSE(res, { type: 'error', message: msg });
        }
      } finally {
        activeQuery = null;
        if (agentStatus === 'running') agentStatus = 'idle';
        res.end();
      }
    }),

    // --- Stop current query ---
    route('POST', '/agent/stop', async (_req, res) => {
      if (activeQuery) {
        activeQuery.close();
        activeQuery = null;
        agentStatus = 'idle';
        json(res, 200, { status: 'stopped' });
      } else {
        json(res, 200, { status: 'no_active_query' });
      }
    }),

    // --- Agent status ---
    route('GET', '/agent/status', async (_req, res) => {
      json(res, 200, {
        status: agentStatus,
        hasActiveQuery: activeQuery !== null,
        lastError,
      });
    }),

    // --- Agent + MCP diagnostics ---
    route('GET', '/agent/diagnostics', async (_req, res) => {
      const mcpStatuses = activeQuery ? await activeQuery.mcpServerStatus() : [];
      const researchCoreStatus = mcpStatuses.find((s) => s.name === MCP_SERVER_NAME) || null;
      json(res, 200, {
        status: 'ok',
        timestamp: Date.now(),
        databasePath: opts.databasePath ?? null,
        agent: {
          status: agentStatus,
          hasActiveQuery: activeQuery !== null,
          lastError,
        },
        mcp: {
          mode: 'in_process_sdk',
          server: MCP_SERVER_NAME,
          declaredTools: [...RESEARCH_CORE_MCP_TOOL_NAMES],
          sdkToolNames: [...SDK_TOOL_PREFIXED_NAMES],
          activeQueryServerStatus: researchCoreStatus,
          sessionContextCount: activeContextBySession.size,
        },
      });
    }),

    // --- Context resolver diagnostics ---
    route('GET', '/agent/context/resolve', async (_req, res, params) => {
      const requestedContextId = params.contextId;
      const sessionId = params.sessionId;
      const resolution = await resolveContext(engine, { requestedContextId, sessionId });
      const [stats, contexts, sources] = await Promise.all([
        engine.getStats(),
        engine.listContexts(),
        engine.listSources(),
      ]);

      json(res, 200, {
        status: 'ok',
        requestedContextId: requestedContextId ?? null,
        sessionId: sessionId ?? null,
        resolution,
        counts: {
          pages: stats.page_count,
          sources: sources.length,
          contexts: contexts.length,
        },
        contexts: contexts.map((ctx) => ({ id: ctx.id, name: ctx.name })),
      });
    }),
  ];
}

function sendSSE(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function waitForResearchCoreMcp(
  q: AgentQuery,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ status: string; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 150;
  const start = Date.now();

  let last: { status: string; error?: string } = { status: 'missing' };
  while (Date.now() - start < timeoutMs) {
    const statuses = await q.mcpServerStatus();
    const researchCore = statuses.find((s) => s.name === MCP_SERVER_NAME);
    if (researchCore) {
      last = { status: researchCore.status, error: researchCore.error };
      if (researchCore.status === 'connected') return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

async function resolveContext(
  engine: BrainEngine,
  opts: { requestedContextId?: string; sessionId?: string },
): Promise<ContextResolution> {
  const requestedContextId = opts.requestedContextId?.trim();
  const sessionId = opts.sessionId?.trim();

  if (requestedContextId) {
    const explicit = await engine.getContext(requestedContextId);
    if (!explicit) {
      return { kind: 'invalid_requested_context', requestedContextId };
    }
    if (sessionId) activeContextBySession.set(sessionId, explicit.id);
    const sourceIds = await engine.getContextSourceIds(explicit.id);
    return sourceIds.length > 0
      ? { kind: 'resolved', contextId: explicit.id, source: 'request' }
      : { kind: 'empty_context', contextId: explicit.id };
  }

  if (sessionId) {
    const active = activeContextBySession.get(sessionId);
    if (active) {
      const existing = await engine.getContext(active);
      if (existing) {
        const sourceIds = await engine.getContextSourceIds(existing.id);
        return sourceIds.length > 0
          ? { kind: 'resolved', contextId: existing.id, source: 'session' }
          : { kind: 'empty_context', contextId: existing.id };
      }
      activeContextBySession.delete(sessionId);
    }
  }

  const contexts = await engine.listContexts();
  if (contexts.length === 0) {
    const sources = await engine.listSources();
    if (sources.length === 0) return { kind: 'no_contexts' };

    // Auto-bootstrap a default context so users with imported sources don't
    // have to manually create contexts before asking questions.
    const defaultContextId = 'default';
    try {
      await engine.createContext({
        id: defaultContextId,
        name: 'Default',
        description: 'Auto-created default context',
        source_ids: sources.map((s) => s.id),
      });
    } catch {
      // Ignore races/duplicate creation and read the resulting context below.
    }

    const defaultContext = await engine.getContext(defaultContextId);
    if (!defaultContext) return { kind: 'no_contexts' };
    if (sessionId) activeContextBySession.set(sessionId, defaultContext.id);
    const sourceIds = await engine.getContextSourceIds(defaultContext.id);
    return sourceIds.length > 0
      ? { kind: 'resolved', contextId: defaultContext.id, source: 'bootstrap' }
      : { kind: 'empty_context', contextId: defaultContext.id };
  }

  const defaultCtx = contexts.find((ctx) => ctx.id === 'default');
  if (defaultCtx) {
    if (sessionId) activeContextBySession.set(sessionId, defaultCtx.id);
    const sourceIds = await engine.getContextSourceIds(defaultCtx.id);
    return sourceIds.length > 0
      ? { kind: 'resolved', contextId: defaultCtx.id, source: 'default' }
      : { kind: 'empty_context', contextId: defaultCtx.id };
  }

  if (contexts.length === 1) {
    if (sessionId) activeContextBySession.set(sessionId, contexts[0].id);
    const sourceIds = await engine.getContextSourceIds(contexts[0].id);
    return sourceIds.length > 0
      ? { kind: 'resolved', contextId: contexts[0].id, source: 'single' }
      : { kind: 'empty_context', contextId: contexts[0].id };
  }

  // Multiple contexts and no explicit choice: default to the first context
  // (listContexts is ordered by latest updated/created in the engine).
  const latest = contexts[0];
  if (sessionId) activeContextBySession.set(sessionId, latest.id);
  const sourceIds = await engine.getContextSourceIds(latest.id);
  return sourceIds.length > 0
    ? { kind: 'resolved', contextId: latest.id, source: 'latest' }
    : { kind: 'empty_context', contextId: latest.id };
}

function sendNoKnowledgeBaseInfo(res: ServerResponse): void {
  sendSSE(res, { type: 'result', result: NO_KB_INFO_MESSAGE });
  sendSSE(res, { type: 'done', reason: 'no_knowledge_base_info' });
  res.end();
}

function isUuid(value: string | undefined): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
