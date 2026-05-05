import { Composio } from '@composio/core';
import { ConnectionsStore } from '../http/connections-store.ts';
import {
  RemoteComposioBridgeClient,
  type RemoteBridgeSearchToolResult,
  type RemoteBridgeToolExecutionView,
  type RemoteBridgeToolSchemaView,
} from './composio-bridge-client.ts';

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

  constructor(store = new ConnectionsStore(), apiKey = process.env.COMPOSIO_API_KEY?.trim() || '') {
    this.store = store;
    this.bridgeClient = new RemoteComposioBridgeClient();
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

    const session = await this.client!.create(userId, { manageConnections: false });
    const response = await session.search({ query, toolkits });
    const slugs = Array.from(new Set(response.results.flatMap((result) => [
      ...result.primaryToolSlugs,
      ...result.relatedToolSlugs,
    ])));
    return Promise.all(slugs.map(async (slug) => {
      const tool = await this.client!.tools.getRawComposioToolBySlug(slug);
      return {
        slug: tool.slug,
        name: tool.name,
        description: tool.description ?? null,
        toolkitSlug: tool.toolkit?.slug ?? null,
        toolkitName: tool.toolkit?.name ?? null,
      };
    }));
  }

  async getToolSchemas(toolSlugs: string[]): Promise<ComposioBridgeToolSchemaView[]> {
    this.assertConfigured();
    const userId = this.store.ensureVervoUserId();

    if (this.bridgeClient.configured) {
      return this.bridgeClient.getToolSchemas(userId, toolSlugs);
    }

    return Promise.all(toolSlugs.map(async (slug) => {
      const tool = await this.client!.tools.getRawComposioToolBySlug(slug);
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
      return this.bridgeClient.executeTool(userId, toolSlug, arguments_);
    }

    const session = await this.client!.create(userId, { manageConnections: false });
    const result = await session.execute(toolSlug, arguments_ ?? {});
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
