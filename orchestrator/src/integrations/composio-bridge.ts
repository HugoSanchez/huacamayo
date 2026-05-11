import { Composio } from '@composio/core';
import { ConnectionsStore } from '../http/connections-store.ts';
import {
  RemoteComposioBridgeClient,
  type RemoteBridgeSearchToolResult,
  type RemoteBridgeToolExecutionView,
  type RemoteBridgeToolSchemaView,
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

export interface ComposioBridgeSearchToolView extends RemoteBridgeSearchToolResult {}
export interface ComposioBridgeToolSchemaView extends RemoteBridgeToolSchemaView {}
export interface ComposioBridgeToolExecutionView extends RemoteBridgeToolExecutionView {}

interface CachedSession {
  view: ComposioBridgeSessionView;
}

export class ComposioBridgeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ComposioBridgeHttpError';
    this.status = status;
  }
}

export class ComposioBridgeService {
  private readonly store: ConnectionsStore;

  private readonly bridgeClient: RemoteComposioBridgeClient;

  private readonly apiKey: string | null;

  private readonly client: Composio | null;

  private cachedSession: CachedSession | null = null;

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

    const userId = this.store.ensureVervoUserId();
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
      const userId = this.store.getVervoUserId();
      if (userId) {
        void this.bridgeClient.resetSession(userId).catch(() => {});
      }
    }
    this.cachedSession = null;
  }

  async searchTools(query: string, toolkits?: string[]): Promise<ComposioBridgeSearchToolView[]> {
    this.assertConfigured();
    const userId = this.store.ensureVervoUserId();

    if (this.bridgeClient.configured) {
      return this.bridgeClient.searchTools(userId, query, toolkits);
    }

    const normalizedToolkits = normalizeToolkits(toolkits);
    if (normalizedToolkits && normalizedToolkits.length > 0) {
      return this.searchToolsDirect(normalizedToolkits, query);
    }

    const session = await this.client!.create(userId, { manageConnections: false });
    const response = await session.search({ query, toolkits });
    const slugs = Array.from(new Set(response.results.flatMap((result) => [
      ...result.primaryToolSlugs,
      ...result.relatedToolSlugs,
    ])));
    return Promise.all(slugs.map(async (slug) => toSearchToolView(await this.fetchToolBySlug(slug))));
  }

  async getToolSchemas(toolSlugs: string[]): Promise<ComposioBridgeToolSchemaView[]> {
    this.assertConfigured();
    const userId = this.store.ensureVervoUserId();

    if (this.bridgeClient.configured) {
      return this.bridgeClient.getToolSchemas(userId, toolSlugs);
    }

    return Promise.all(toolSlugs.map(async (slug) => {
      const tool = await this.fetchToolBySlug(slug);
      return {
        slug: tool.slug,
        name: tool.name,
        description: tool.description ?? null,
        toolkitSlug: tool.toolkit?.slug ?? null,
        toolkitName: tool.toolkit?.name ?? null,
        inputParameters: asRecord(tool.inputParameters),
      };
    }));
  }

  async executeTool(toolSlug: string, arguments_: Record<string, unknown> | undefined): Promise<ComposioBridgeToolExecutionView> {
    this.assertConfigured();
    const userId = this.store.ensureVervoUserId();

    if (this.bridgeClient.configured) {
      const connectedAccountId = await this.resolveConnectedAccountIdForTool(toolSlug);
      return this.bridgeClient.executeTool(userId, toolSlug, arguments_, connectedAccountId);
    }

    const connectedAccountId = await this.resolveConnectedAccountIdForTool(toolSlug);
    const result = await this.executeToolRaw(userId, toolSlug, arguments_ ?? {}, connectedAccountId);
    return {
      data: result.data ?? null,
      error: typeof result.error === 'string' ? result.error : null,
      logId: typeof result.logId === 'string' ? result.logId : null,
    };
  }

  private assertConfigured(): void {
    if (this.bridgeClient.configured || this.client) return;
    throw new ComposioBridgeHttpError(
      503,
      'Composio bridge is unavailable. Set VERVO_COMPOSIO_BRIDGE_URL or COMPOSIO_API_KEY to enable it.',
    );
  }

  private async resolveConnectedAccountIdForTool(toolSlug: string): Promise<string | undefined> {
    const toolkitSlug = await this.getToolkitSlugForTool(toolSlug).catch(() => null);
    if (!toolkitSlug) return undefined;
    return this.store.findActiveConnectionByToolkit(toolkitSlug)?.connectedAccountId ?? undefined;
  }

  private async getToolkitSlugForTool(toolSlug: string): Promise<string | null> {
    if (this.client) {
      const tool = await this.fetchToolBySlug(toolSlug);
      return tool.toolkit?.slug?.trim().toLowerCase() ?? null;
    }

    const userId = this.store.ensureVervoUserId();
    const [tool] = await this.bridgeClient.getToolSchemas(userId, [toolSlug]);
    return tool?.toolkitSlug?.trim().toLowerCase() ?? null;
  }

  private async searchToolsDirect(toolkits: string[], query: string): Promise<ComposioBridgeSearchToolView[]> {
    const normalizedQuery = normalizeSearchQuery(query);
    const results: ComposioBridgeSearchToolView[] = [];

    for (const toolkit of toolkits) {
      const items = await this.listToolkitTools(toolkit);
      const matches = items.filter((tool) => matchesToolQuery(tool, normalizedQuery));
      const target = matches.length > 0 ? matches : items;
      results.push(...target.map(toSearchToolView));
    }

    return dedupeSearchToolViews(results);
  }

  private async listToolkitTools(toolkitSlug: string): Promise<Array<{
    slug: string;
    name: string;
    description?: string | null;
    toolkit?: { slug?: string | null; name?: string | null } | null;
    inputParameters?: Record<string, unknown> | null;
  }>> {
    const response = await fetch(`https://backend.composio.dev/api/v3/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&toolkit_versions=latest&limit=200`, {
      headers: {
        'x-api-key': this.apiKey!,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new ComposioBridgeHttpError(response.status, `Failed to list tools for toolkit ${toolkitSlug}`);
    }
    const body = await response.json() as {
      items?: Array<{
        slug: string;
        name: string;
        description?: string | null;
        toolkit?: { slug?: string | null; name?: string | null } | null;
        input_parameters?: Record<string, unknown> | null;
      }>;
    };
    return Array.isArray(body.items) ? body.items.map((tool) => ({
      slug: tool.slug,
      name: tool.name,
      description: tool.description ?? null,
      toolkit: tool.toolkit ?? null,
      inputParameters: asRecord(tool.input_parameters),
    })) : [];
  }

  private async fetchToolBySlug(toolSlug: string): Promise<{
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
      throw new ComposioBridgeHttpError(response.status, `Failed to load tool metadata for ${toolSlug}`);
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

  private async executeToolRaw(
    userId: string,
    toolSlug: string,
    arguments_: Record<string, unknown>,
    connectedAccountId?: string,
  ): Promise<{
    data?: unknown;
    error?: string | null;
    logId?: string | null;
  }> {
    const response = await fetch(`https://backend.composio.dev/api/v3/tools/execute/${encodeURIComponent(toolSlug)}`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey!,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        arguments: arguments_,
        user_id: userId,
        version: 'latest',
        ...(connectedAccountId ? { connected_account_id: connectedAccountId } : {}),
      }),
    });
    if (!response.ok) {
      throw new ComposioBridgeHttpError(response.status, `Failed to execute tool ${toolSlug}`);
    }
    return response.json() as Promise<{
      data?: unknown;
      error?: string | null;
      logId?: string | null;
    }>;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeToolkits(toolkits: string[] | undefined): string[] | undefined {
  if (!toolkits || toolkits.length === 0) return undefined;
  const normalized = toolkits.map((toolkit) => toolkit.trim().toLowerCase()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function matchesToolQuery(
  tool: {
    slug?: string;
    name?: string;
    description?: string | null;
  },
  normalizedQuery: string,
): boolean {
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const haystacks = [
    tool.slug?.toLowerCase() ?? '',
    tool.slug?.toLowerCase().replace(/[_-]+/g, '') ?? '',
    tool.name?.toLowerCase() ?? '',
    tool.description?.toLowerCase() ?? '',
  ];
  return haystacks.some((value) => value.includes(normalizedQuery) || value.includes(compactQuery));
}

function toSearchToolView(tool: {
  slug: string;
  name: string;
  description?: string | null;
  toolkit?: { slug?: string | null; name?: string | null } | null;
}): ComposioBridgeSearchToolView {
  return {
    slug: tool.slug,
    name: tool.name,
    description: tool.description ?? null,
    toolkitSlug: tool.toolkit?.slug ?? null,
    toolkitName: tool.toolkit?.name ?? null,
  };
}

function dedupeSearchToolViews(items: ComposioBridgeSearchToolView[]): ComposioBridgeSearchToolView[] {
  const seen = new Set<string>();
  const deduped: ComposioBridgeSearchToolView[] = [];
  for (const item of items) {
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    deduped.push(item);
  }
  return deduped;
}
