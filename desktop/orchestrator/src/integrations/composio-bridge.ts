import { Composio } from '@composio/core';
import { ConnectionsStore } from '../http/connections-store.ts';
import {
  RemoteComposioBridgeClient,
  type RemoteBridgeActionCandidateView,
  type RemoteBridgeActionExecutionView,
  type RemoteBridgeActionSchemaView,
} from './composio-bridge-client.ts';
import { ManagedBackendClient } from './managed-backend-client.ts';

export interface ComposioBridgeSessionView {
  userId: string;
  sessionId: string;
  mcp: {
    url: string;
    headers: Record<string, string>;
  };
}

interface CachedSession {
  view: ComposioBridgeSessionView;
}

interface ToolRouterSessionLike {
  search: (params: { query: string; toolkits?: string[] }) => Promise<unknown>;
  execute: (toolSlug: string, arguments_: Record<string, unknown>) => Promise<unknown>;
}

interface CachedToolRouterSession {
  session: ToolRouterSessionLike;
  expiresAt: number;
}

export class ComposioBridgeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ComposioBridgeHttpError';
    this.status = status;
  }
}

/**
 * Mints (and caches) the per-user Composio MCP session URL. That URL is
 * handed directly to Hermes' MCP client at launch — see
 * HermesSupervisor.refreshComposioMcpSession.
 *
 * Tool search / execution previously lived on this class; they now come from
 * Composio's hosted MCP server, so Hermes talks to Composio directly. The
 * orchestrator is only responsible for resolving the session URL.
 */
export class ComposioBridgeService {
  private readonly store: ConnectionsStore;

  private readonly bridgeClient: RemoteComposioBridgeClient;

  private readonly apiKey: string | null;

  private readonly client: Composio | null;

  private cachedSession: CachedSession | null = null;

  private cachedToolRouterSession: CachedToolRouterSession | null = null;

  constructor(
    managedBackend: ManagedBackendClient,
    store = new ConnectionsStore(),
    apiKey = process.env.COMPOSIO_API_KEY?.trim() || '',
  ) {
    this.store = store;
    this.bridgeClient = new RemoteComposioBridgeClient(managedBackend);
    this.apiKey = apiKey || null;
    this.client = !this.bridgeClient.configured && this.apiKey ? new Composio({ apiKey: this.apiKey }) : null;
  }

  get configured(): boolean {
    return this.bridgeClient.configured || Boolean(this.client);
  }

  async getDefaultSession(): Promise<ComposioBridgeSessionView> {
    this.assertConfigured();
    if (this.cachedSession) return this.cachedSession.view;

    const userId = this.store.ensureversoUserId();
    if (this.bridgeClient.configured) {
      const session = await this.bridgeClient.getSession(userId);
      this.cachedSession = { view: session };
      return session;
    }

    const session = await this.client!.create(userId, {
      manageConnections: false,
    });

    const view: ComposioBridgeSessionView = {
      userId,
      sessionId: session.sessionId,
      mcp: {
        url: session.mcp.url,
        headers: normalizeHeaders(session.mcp.headers),
      },
    };

    this.cachedSession = { view };
    return view;
  }

  reset(): void {
    if (this.bridgeClient.configured) {
      const userId = this.store.getversoUserId();
      if (userId) {
        void this.bridgeClient.resetSession(userId).catch(() => {});
      }
    }
    this.cachedSession = null;
    this.cachedToolRouterSession = null;
  }

  async findActions(request: {
    app?: string;
    intent: string;
    limit?: number;
  }): Promise<RemoteBridgeActionCandidateView[]> {
    this.assertConfigured();
    const intent = request.intent.trim();
    if (!intent) throw new ComposioBridgeHttpError(400, 'Missing "intent"');

    const userId = this.store.ensureversoUserId();
    if (this.bridgeClient.configured) {
      return this.bridgeClient.findActions(userId, { ...request, intent });
    }

    if (!this.client) throw new ComposioBridgeHttpError(503, 'Composio API key is not configured.');
    const session = await this.getLocalToolRouterSession(userId);
    const appToolkits = normalizeActionToolkits(request.app);
    const response = await session.search({
      query: intent,
      ...(appToolkits ? { toolkits: appToolkits } : {}),
    });
    const parsed = parseToolRouterSearchResponse(response);
    const limit = normalizeActionLimit(request.limit);
    const actions: RemoteBridgeActionCandidateView[] = [];
    for (const item of parsed.actions) {
      if (actions.length >= limit) break;
      const schema = await this.getActionSchema(item.slug).catch(() => null);
      if (!schema) continue;
      if (appToolkits && schema.appSlug && !appToolkits.includes(schema.appSlug)) continue;
      actions.push({
        ...schema,
        guidance: item.guidance,
        connection: null,
      });
    }
    return actions;
  }

  async getActionSchema(providerAction: string): Promise<RemoteBridgeActionSchemaView> {
    this.assertConfigured();
    const action = providerAction.trim();
    if (!action) throw new ComposioBridgeHttpError(400, 'Missing "providerAction"');

    const userId = this.store.ensureversoUserId();
    if (this.bridgeClient.configured) {
      return this.bridgeClient.getActionSchema(userId, action);
    }

    const tool = await this.getLocalToolBySlug(action);
    return {
      provider: 'composio',
      providerAction: tool.slug,
      appSlug: tool.toolkit?.slug ?? null,
      appName: tool.toolkit?.name ?? null,
      name: tool.name,
      description: tool.description ?? null,
      inputSchema: asRecord(tool.inputParameters),
    };
  }

  async executeAction(
    providerAction: string,
    arguments_: Record<string, unknown>,
  ): Promise<RemoteBridgeActionExecutionView> {
    this.assertConfigured();
    const action = providerAction.trim();
    if (!action) throw new ComposioBridgeHttpError(400, 'Missing "providerAction"');

    const userId = this.store.ensureversoUserId();
    if (this.bridgeClient.configured) {
      return this.bridgeClient.executeAction(userId, action, arguments_);
    }

    if (!this.client) throw new ComposioBridgeHttpError(503, 'Composio API key is not configured.');
    const session = await this.getLocalToolRouterSession(userId);
    const result = await session.execute(action, arguments_);
    const record = asRecord(result);
    return {
      provider: 'composio',
      providerAction: action,
      data: record?.data ?? result ?? null,
      error: asString(record?.error),
      logId: asString(record?.logId ?? record?.log_id),
      successful: typeof record?.successful === 'boolean' ? record.successful : null,
    };
  }

  private assertConfigured(): void {
    if (this.bridgeClient.configured || this.client) return;
    throw new ComposioBridgeHttpError(
      503,
      'Composio bridge is unavailable. Set VERSO_BACKEND_URL (managed) or COMPOSIO_API_KEY (direct) to enable it.',
    );
  }

  private async getLocalToolRouterSession(userId: string): Promise<ToolRouterSessionLike> {
    if (this.cachedToolRouterSession && this.cachedToolRouterSession.expiresAt > Date.now()) {
      return this.cachedToolRouterSession.session;
    }

    const session = await this.client!.create(userId, {
      manageConnections: false,
    }) as unknown as ToolRouterSessionLike;
    this.cachedToolRouterSession = {
      session,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    return session;
  }

  private async getLocalToolBySlug(toolSlug: string): Promise<{
    slug: string;
    name: string;
    description?: string | null;
    toolkit?: { slug?: string | null; name?: string | null } | null;
    inputParameters?: Record<string, unknown> | null;
  }> {
    const response = await fetch(`https://backend.composio.dev/api/v3/tools/${encodeURIComponent(toolSlug)}?toolkit_versions=latest`, {
      headers: {
        'x-api-key': this.apiKey!,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ComposioBridgeHttpError(
        response.status,
        `Composio tool lookup failed (${response.status}): ${body || response.statusText}`,
      );
    }

    const body = await response.json() as {
      slug: string;
      name: string;
      description?: string | null;
      toolkit?: { slug?: string | null; name?: string | null } | null;
      input_parameters?: Record<string, unknown> | null;
    };

    return {
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      toolkit: body.toolkit ?? null,
      inputParameters: asRecord(body.input_parameters),
    };
  }
}

function normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value.length > 0) {
      normalized[key] = value;
    }
  }

  return normalized;
}

function normalizeActionToolkits(app: string | undefined): string[] | undefined {
  const value = app?.trim().toLowerCase();
  if (!value) return undefined;
  return Array.from(new Set([
    value,
    value.replace(/\s+/g, '_'),
    value.replace(/\s+/g, ''),
    value.replace(/[_-]+/g, ' '),
  ].filter(Boolean)));
}

function normalizeActionLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 3;
  return Math.max(1, Math.min(8, Math.floor(limit)));
}

function parseToolRouterSearchResponse(response: unknown): {
  actions: Array<{
    slug: string;
    guidance: {
      executionGuidance: string | null;
      recommendedPlanSteps: string[];
      knownPitfalls: string[];
    } | null;
  }>;
} {
  const record = asRecord(response) ?? {};
  const results = Array.isArray(record.results) ? record.results : [];
  const actions: Array<{
    slug: string;
    guidance: {
      executionGuidance: string | null;
      recommendedPlanSteps: string[];
      knownPitfalls: string[];
    } | null;
  }> = [];
  const seen = new Set<string>();

  for (const result of results) {
    const item = asRecord(result);
    if (!item) continue;
    const slugs = [
      ...asStringArray(item.primaryToolSlugs ?? item.primary_tool_slugs),
      ...asStringArray(item.relatedToolSlugs ?? item.related_tool_slugs),
    ];
    const guidance = {
      executionGuidance: asString(item.executionGuidance ?? item.execution_guidance),
      recommendedPlanSteps: asStringArray(item.recommendedPlanSteps ?? item.recommended_plan_steps),
      knownPitfalls: asStringArray(item.knownPitfalls ?? item.known_pitfalls),
    };
    for (const slug of slugs) {
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      actions.push({
        slug,
        guidance: guidance.executionGuidance || guidance.recommendedPlanSteps.length > 0 || guidance.knownPitfalls.length > 0
          ? guidance
          : null,
      });
    }
  }

  return { actions };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}
