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

interface ToolRouterSessionLike {
  search: (params: { query: string; toolkits?: string[] }) => Promise<unknown>;
  execute: (toolSlug: string, arguments_: Record<string, unknown>) => Promise<unknown>;
}

interface CachedToolRouterSession {
  session: ToolRouterSessionLike;
  expiresAt: number;
}

interface LocalComposioToolView {
  slug: string;
  name: string;
  description: string | null;
  toolkit: { slug?: string | null; name?: string | null } | null;
  inputParameters: Record<string, unknown> | null;
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
 * Thin Composio bridge used by the local MCP server. In managed mode it proxies
 * tool-router search/schema/execute calls to the backend; in local development
 * it can still use COMPOSIO_API_KEY directly.
 */
export class ComposioBridgeService {
  private readonly store: ConnectionsStore;

  private readonly bridgeClient: RemoteComposioBridgeClient;

  private readonly apiKey: string | null;

  private readonly client: Composio | null;

  private cachedSession: CachedSession | null = null;

  private cachedToolRouterSession: CachedToolRouterSession | null = null;

  private readonly localToolSchemaCache = new Map<string, LocalComposioToolView>();

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
    this.localToolSchemaCache.clear();
  }

  async searchTools(query: string, toolkits?: string[]): Promise<ComposioBridgeSearchToolView[]> {
    this.assertConfigured();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new ComposioBridgeHttpError(400, 'Missing "query"');

    const userId = this.store.ensureversoUserId();
    if (this.bridgeClient.configured) {
      return this.bridgeClient.searchTools(userId, normalizedQuery, toolkits);
    }

    if (!this.client) throw new ComposioBridgeHttpError(503, 'Composio API key is not configured.');
    const session = await this.getLocalToolRouterSession(userId);
    const response = await session.search({
      query: normalizedQuery,
      ...(toolkits && toolkits.length > 0 ? { toolkits: normalizeToolkits(toolkits) } : {}),
    });
    const slugs = parseToolRouterToolSlugs(response);
    const tools = await Promise.all(slugs.map(async (slug) => this.getLocalToolBySlug(slug).catch(() => null)));
    return tools
      .filter((tool): tool is NonNullable<typeof tool> => tool !== null)
      .map((tool) => ({
        slug: tool.slug,
        name: tool.name,
        description: tool.description ?? null,
        toolkitSlug: tool.toolkit?.slug ?? null,
        toolkitName: tool.toolkit?.name ?? null,
      }));
  }

  async getToolSchemas(toolSlugs: string[]): Promise<ComposioBridgeToolSchemaView[]> {
    this.assertConfigured();
    const wanted = Array.from(new Set(toolSlugs.map((slug) => slug.trim()).filter(Boolean)));
    if (wanted.length === 0) throw new ComposioBridgeHttpError(400, 'Missing "toolSlugs"');

    const userId = this.store.ensureversoUserId();
    if (this.bridgeClient.configured) {
      return this.bridgeClient.getToolSchemas(userId, wanted);
    }

    return Promise.all(wanted.map(async (slug) => {
      const tool = await this.getLocalToolBySlug(slug);
      return {
        slug: tool.slug,
        name: tool.name,
        description: tool.description ?? null,
        toolkitSlug: tool.toolkit?.slug ?? null,
        toolkitName: tool.toolkit?.name ?? null,
        inputParameters: compactInputParameters(tool.inputParameters),
      };
    }));
  }

  async executeTool(
    toolSlug: string,
    arguments_: Record<string, unknown>,
  ): Promise<ComposioBridgeToolExecutionView> {
    this.assertConfigured();
    const slug = toolSlug.trim();
    if (!slug) throw new ComposioBridgeHttpError(400, 'Missing "toolSlug"');
    const argumentRecord = asRecord(arguments_);
    if (!argumentRecord) {
      throw new ComposioBridgeHttpError(400, 'Missing required object "arguments".');
    }

    const userId = this.store.ensureversoUserId();
    if (this.bridgeClient.configured) {
      return this.bridgeClient.executeTool(userId, slug, argumentRecord);
    }

    if (!this.client) throw new ComposioBridgeHttpError(503, 'Composio API key is not configured.');
    const tool = await this.getLocalToolBySlug(slug);
    const missingRequiredFields = getMissingRequiredToolArguments(tool.inputParameters, argumentRecord);
    if (missingRequiredFields.length > 0) {
      throw new ComposioBridgeHttpError(
        400,
        `Missing required argument${missingRequiredFields.length === 1 ? '' : 's'} ${
          missingRequiredFields.map((field) => `"${field}"`).join(', ')
        } for ${tool.slug}.`,
      );
    }
    const session = await this.getLocalToolRouterSession(userId);
    const result = await session.execute(tool.slug, argumentRecord);
    const record = asRecord(result);
    return {
      data: record?.data ?? result ?? null,
      error: asString(record?.error),
      logId: asString(record?.logId ?? record?.log_id),
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

  private async getLocalToolBySlug(toolSlug: string): Promise<LocalComposioToolView> {
    const slug = toolSlug.trim();
    const cached = this.localToolSchemaCache.get(slug);
    if (cached) return cached;

    const rawTool = await this.client!.tools.getRawComposioToolBySlug(slug) as unknown;
    const record = asRecord(rawTool);
    if (!record) {
      throw new ComposioBridgeHttpError(502, `Composio returned an invalid schema for ${slug}.`);
    }

    const toolkitRecord = asRecord(record.toolkit);
    const normalizedTool: LocalComposioToolView = {
      slug: asString(record.slug) ?? slug,
      name: asString(record.name) ?? slug,
      description: asString(record.description),
      toolkit: toolkitRecord
        ? {
          slug: asString(toolkitRecord.slug),
          name: asString(toolkitRecord.name),
        }
        : null,
      inputParameters: asRecord(record.inputParameters ?? record.input_parameters),
    };

    this.localToolSchemaCache.set(slug, normalizedTool);
    this.localToolSchemaCache.set(normalizedTool.slug, normalizedTool);
    return normalizedTool;
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

function normalizeToolkits(toolkits: string[]): string[] {
  return Array.from(new Set(toolkits.flatMap((toolkit) => {
    const value = toolkit.trim().toLowerCase();
    if (!value) return [];
    return [
      value,
      value.replace(/\s+/g, '_'),
      value.replace(/\s+/g, ''),
      value.replace(/[_-]+/g, ' '),
    ];
  }).filter(Boolean)));
}

function parseToolRouterToolSlugs(response: unknown): string[] {
  const record = asRecord(response) ?? {};
  const results = Array.isArray(record.results) ? record.results : [];
  const slugs: string[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const item = asRecord(result);
    if (!item) continue;
    const candidates = [
      ...asStringArray(item.primaryToolSlugs ?? item.primary_tool_slugs),
      ...asStringArray(item.relatedToolSlugs ?? item.related_tool_slugs),
    ];
    for (const slug of candidates) {
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
  }

  return slugs;
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

function getMissingRequiredToolArguments(
  inputParameters: Record<string, unknown> | null,
  arguments_: Record<string, unknown>,
): string[] {
  const required = asStringArray(inputParameters?.required);
  return required.filter((field) => isMissingToolArgument(arguments_[field]));
}

function isMissingToolArgument(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && value.trim().length === 0;
}

function compactInputParameters(inputParameters: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!inputParameters) return null;
  const properties = asRecord(inputParameters.properties);
  if (!properties) return inputParameters;

  const compactProperties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    const property = asRecord(value);
    compactProperties[name] = property ? compactSchemaProperty(property) : value;
  }

  return {
    type: asString(inputParameters.type) ?? 'object',
    required: asStringArray(inputParameters.required),
    properties: compactProperties,
  };
}

function compactSchemaProperty(property: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  const type = property.type;
  if (typeof type === 'string' || Array.isArray(type)) compact.type = type;
  const description = asString(property.description);
  if (description) compact.description = truncateSchemaText(description);
  if ('default' in property) compact.default = property.default;
  if (Array.isArray(property.enum)) compact.enum = property.enum;
  const items = asRecord(property.items);
  if (items) compact.items = compactSchemaProperty(items);
  return compact;
}

function truncateSchemaText(value: string): string {
  return value.length <= 300 ? value : `${value.slice(0, 297)}...`;
}
