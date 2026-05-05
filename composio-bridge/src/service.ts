import { Composio } from '@composio/core';

export type ConnectionRequestStatus = 'pending' | 'connected' | 'failed' | 'expired';
export type ConnectionStatus = 'active' | 'inactive';

export interface BridgeSessionView {
  userId: string;
  sessionId: string;
  mcp: {
    url: string;
    headers: Record<string, string>;
  };
}

export interface BridgeConnectionRequestView {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionRequestStatus;
  redirectUrl: string | null;
  connectedAccountId: string | null;
  errorMessage: string | null;
}

export interface BridgeConnectionView {
  connectedAccountId: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionStatus;
}

export interface BridgeToolkitView {
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  categories: string[];
  authSchemes: string[];
  composioManagedAuthSchemes: string[];
  connected: boolean;
  connectedAccountId: string | null;
  noAuth: boolean;
}

export interface BridgeSearchToolResult {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string | null;
  toolkitName: string | null;
}

export interface BridgeToolSchemaView {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string | null;
  toolkitName: string | null;
  inputParameters: Record<string, unknown> | null;
}

export interface BridgeToolExecutionView {
  data: unknown;
  error: string | null;
  logId: string | null;
}

interface CatalogToolkitItem {
  slug: string;
  name: string;
  meta: {
    description?: string;
    logo?: string;
    categories?: Array<{ slug: string; name: string }>;
  };
  authSchemes?: string[];
  composioManagedAuthSchemes?: string[];
  noAuth?: boolean;
}

export class BridgeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'BridgeHttpError';
    this.status = status;
  }
}

export class ComposioBridgeBackendService {
  private readonly apiKey: string | null;

  private readonly client: Composio | null;

  private readonly sessionCache = new Map<string, BridgeSessionView>();

  private readonly allowedToolkits: Set<string> | null;

  constructor(apiKey = process.env.COMPOSIO_API_KEY?.trim() || '') {
    this.apiKey = apiKey || null;
    this.client = this.apiKey ? new Composio({ apiKey: this.apiKey }) : null;
    this.allowedToolkits = parseAllowedToolkits(process.env.VERVO_COMPOSIO_ALLOWED_TOOLKITS);
  }

  get configured(): boolean {
    return Boolean(this.client);
  }

  async getSession(userId: string): Promise<BridgeSessionView> {
    this.assertConfigured();
    const normalizedUserId = normalizeUserId(userId);
    const cached = this.sessionCache.get(normalizedUserId);
    if (cached) return cached;

    const session = await this.client!.create(normalizedUserId, {
      manageConnections: false,
    });

    const view: BridgeSessionView = {
      userId: normalizedUserId,
      sessionId: session.sessionId,
      mcp: {
        url: session.mcp.url,
        headers: normalizeHeaders(session.mcp.headers),
      },
    };

    this.sessionCache.set(normalizedUserId, view);
    return view;
  }

  resetSession(userId: string): void {
    this.sessionCache.delete(normalizeUserId(userId));
  }

  async listConnections(userId: string): Promise<BridgeConnectionView[]> {
    this.assertConfigured();
    const normalizedUserId = normalizeUserId(userId);
    const response = await this.client!.connectedAccounts.list({
      userIds: [normalizedUserId],
      statuses: ['ACTIVE', 'INACTIVE'],
    });

    const items = await Promise.all(response.items.map(async (item) => {
      const toolkitMeta = await this.getToolkitMetadata(item.toolkit.slug);
      return {
        connectedAccountId: item.id,
        toolkitSlug: item.toolkit.slug,
        toolkitName: toolkitMeta.toolkitName,
        logoUrl: toolkitMeta.logoUrl,
        status: item.isDisabled || item.status === 'INACTIVE' ? 'inactive' : 'active',
      } satisfies BridgeConnectionView;
    }));

    return items.sort((a, b) => a.toolkitName.localeCompare(b.toolkitName));
  }

  async listToolkits(
    userId: string,
    opts: {
      query?: string;
      limit?: number;
    } = {},
  ): Promise<BridgeToolkitView[]> {
    this.assertConfigured();
    const normalizedUserId = normalizeUserId(userId);
    const query = opts.query?.trim() || undefined;
    const limit = normalizeToolkitLimit(opts.limit);
    const items = await this.searchToolkitCatalog(query, limit);
    const connectedByToolkit = await this.listConnectedAccountsByToolkit(normalizedUserId);

    return items
      .filter((toolkit) => this.isAllowedToolkit(toolkit.slug))
      .map((toolkit) => {
        const connected = connectedByToolkit.get(toolkit.slug) ?? null;
        return {
          slug: toolkit.slug,
          name: toolkit.name,
          description: toolkit.meta.description ?? null,
          logoUrl: toolkit.meta.logo ?? null,
          categories: toolkit.meta.categories?.map((category: { slug: string }) => category.slug) ?? [],
          authSchemes: toolkit.authSchemes ?? [],
          composioManagedAuthSchemes: toolkit.composioManagedAuthSchemes ?? [],
          connected: connected?.status === 'active',
          connectedAccountId: connected?.connectedAccountId ?? null,
          noAuth: toolkit.noAuth ?? false,
        } satisfies BridgeToolkitView;
      });
  }

  async requestConnection(userId: string, toolkitSlug: string, callbackUrl: string): Promise<BridgeConnectionRequestView> {
    this.assertConfigured();

    const normalizedUserId = normalizeUserId(userId);
    const toolkit = await this.resolveToolkit(toolkitSlug);
    const normalizedToolkitSlug = toolkit.slug;

    const activeConnections = await this.listConnections(normalizedUserId);
    const existing = activeConnections.find((connection) =>
      connection.toolkitSlug === normalizedToolkitSlug && connection.status === 'active');
    if (existing) {
      return {
        id: existing.connectedAccountId,
        toolkitSlug: existing.toolkitSlug,
        toolkitName: existing.toolkitName,
        logoUrl: existing.logoUrl,
        status: 'connected',
        redirectUrl: null,
        connectedAccountId: existing.connectedAccountId,
        errorMessage: null,
      };
    }

    const session = await this.client!.create(normalizedUserId, {
      toolkits: [normalizedToolkitSlug],
      manageConnections: false,
    });
    const connectionRequest = await session.authorize(normalizedToolkitSlug, {
      callbackUrl,
    });

    return {
      id: connectionRequest.id,
      toolkitSlug: normalizedToolkitSlug,
      toolkitName: toolkit.name,
      logoUrl: toolkit.logoUrl,
      status: mapConnectedAccountStatus(connectionRequest.status),
      redirectUrl: connectionRequest.redirectUrl ?? null,
      connectedAccountId: connectionRequest.status === 'ACTIVE' ? connectionRequest.id : null,
      errorMessage: null,
    };
  }

  async getRequest(requestId: string): Promise<BridgeConnectionRequestView> {
    this.assertConfigured();
    const connectedAccount = await this.client!.connectedAccounts.get(requestId);
    const toolkitMeta = await this.getToolkitMetadata(connectedAccount.toolkit.slug);
    return {
      id: connectedAccount.id,
      toolkitSlug: connectedAccount.toolkit.slug,
      toolkitName: toolkitMeta.toolkitName,
      logoUrl: toolkitMeta.logoUrl,
      status: mapConnectedAccountStatus(connectedAccount.status),
      redirectUrl: null,
      connectedAccountId: connectedAccount.status === 'ACTIVE' ? connectedAccount.id : null,
      errorMessage: connectedAccount.statusReason ?? null,
    };
  }

  async searchTools(userId: string, query: string, toolkits?: string[]): Promise<BridgeSearchToolResult[]> {
    this.assertConfigured();
    const routerSession = await this.createToolRouterSession(normalizeUserId(userId));
    const response = await routerSession.search({
      query,
      toolkits: normalizeToolkits(toolkits),
    });
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
      } satisfies BridgeSearchToolResult;
    }));
  }

  async getToolSchemas(userId: string, toolSlugs: string[]): Promise<BridgeToolSchemaView[]> {
    this.assertConfigured();
    const wanted = new Set(toolSlugs.map((slug) => slug.trim()).filter(Boolean));

    const schemas = await Promise.all(
      Array.from(wanted).map(async (slug) => {
        const tool = await this.client!.tools.getRawComposioToolBySlug(slug);
        return {
          slug: tool.slug,
          name: tool.name,
          description: tool.description ?? null,
          toolkitSlug: tool.toolkit?.slug ?? null,
          toolkitName: tool.toolkit?.name ?? null,
          inputParameters: asRecord(tool.inputParameters),
        } satisfies BridgeToolSchemaView;
      }),
    );

    return schemas;
  }

  async executeTool(userId: string, toolSlug: string, arguments_: Record<string, unknown> | undefined): Promise<BridgeToolExecutionView> {
    this.assertConfigured();
    const routerSession = await this.createToolRouterSession(normalizeUserId(userId));
    const result = await routerSession.execute(toolSlug, arguments_ ?? {});
    return {
      data: result.data ?? null,
      error: typeof result.error === 'string' ? result.error : null,
      logId: typeof result.logId === 'string' ? result.logId : null,
    };
  }

  private async getToolkitMetadata(toolkitSlug: string): Promise<{ toolkitName: string; logoUrl: string | null }> {
    const fallback = defaultToolkitMetadata(toolkitSlug);
    if (!this.client) return fallback;

    try {
      const toolkit = await this.client.toolkits.get(toolkitSlug);
      return {
        toolkitName: toolkit.name || fallback.toolkitName,
        logoUrl: toolkit.meta.logo ?? fallback.logoUrl,
      };
    } catch {
      return fallback;
    }
  }

  private assertConfigured(): void {
    if (this.client) return;
    throw new BridgeHttpError(503, 'Composio bridge backend is unavailable. Set COMPOSIO_API_KEY to enable it.');
  }

  private async createToolRouterSession(userId: string) {
    return this.client!.create(userId, {
      manageConnections: false,
    });
  }

  private async searchToolkitCatalog(query: string | undefined, limit: number) {
    const response = await this.client!.toolkits.get({
      managedBy: 'all',
      sortBy: query ? 'usage' : 'alphabetically',
      limit: query ? 200 : limit,
    }) as unknown as CatalogToolkitItem[] | { items: CatalogToolkitItem[] };
    const items = Array.isArray(response) ? response : (response.items ?? []);
    if (!query) return items.slice(0, limit);

    const normalizedQuery = normalizeSearchQuery(query);
    return items
      .filter((toolkit: CatalogToolkitItem) => matchesToolkitQuery(toolkit, normalizedQuery))
      .slice(0, limit);
  }

  private async listConnectedAccountsByToolkit(userId: string): Promise<Map<string, BridgeConnectionView>> {
    const connections = await this.listConnections(userId);
    const items = new Map<string, BridgeConnectionView>();
    for (const connection of connections) {
      if (!items.has(connection.toolkitSlug) || connection.status === 'active') {
        items.set(connection.toolkitSlug, connection);
      }
    }
    return items;
  }

  private async resolveToolkit(toolkitInput: string): Promise<BridgeToolkitView> {
    const normalizedInput = toolkitInput.trim().toLowerCase();
    if (!normalizedInput) {
      throw new BridgeHttpError(400, 'Missing "toolkit"');
    }

    try {
      const toolkit = await this.client!.toolkits.get(normalizedInput);
      if (!this.isAllowedToolkit(toolkit.slug)) {
        throw new BridgeHttpError(400, `Toolkit "${toolkitInput}" is not allowed by policy.`);
      }
      return {
        slug: toolkit.slug,
        name: toolkit.name,
        description: toolkit.meta.description ?? null,
        logoUrl: toolkit.meta.logo ?? null,
        categories: toolkit.meta.categories?.map((category: { slug: string }) => category.slug) ?? [],
        authSchemes: toolkit.authConfigDetails?.map((detail) => detail.name).filter(isNonEmptyString) ?? [],
        composioManagedAuthSchemes: toolkit.composioManagedAuthSchemes ?? [],
        connected: false,
        connectedAccountId: null,
        noAuth: false,
      };
    } catch {
      const response = await this.searchToolkitCatalog(toolkitInput, 8);
      const matches = response
        .filter((toolkit: CatalogToolkitItem) => this.isAllowedToolkit(toolkit.slug))
        .map((toolkit) => ({
          slug: toolkit.slug,
          name: toolkit.name,
          description: toolkit.meta.description ?? null,
          logoUrl: toolkit.meta.logo ?? null,
          categories: toolkit.meta.categories?.map((category: { slug: string }) => category.slug) ?? [],
          authSchemes: toolkit.authSchemes ?? [],
          composioManagedAuthSchemes: toolkit.composioManagedAuthSchemes ?? [],
          connected: false,
          connectedAccountId: null,
          noAuth: toolkit.noAuth ?? false,
        } satisfies BridgeToolkitView));
      const ranked = rankToolkits(matches, normalizedInput);
      const best = ranked[0];
      if (best && (ranked.length === 1 || best.score > ranked[1].score)) {
        return best.toolkit;
      }

      if (ranked.length === 0) {
        throw new BridgeHttpError(404, `No Composio toolkit found for "${toolkitInput}".`);
      }

      const suggestions = ranked.slice(0, 4).map(({ toolkit }) => `${toolkit.name} (${toolkit.slug})`).join(', ');
      throw new BridgeHttpError(
        400,
        `Toolkit "${toolkitInput}" is ambiguous. Try one of: ${suggestions}`,
      );
    }
  }

  private isAllowedToolkit(toolkitSlug: string): boolean {
    if (!this.allowedToolkits) return true;
    return this.allowedToolkits.has(toolkitSlug.trim().toLowerCase());
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

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new BridgeHttpError(400, 'Missing "userId"');
  }
  return normalized;
}

function normalizeToolkits(toolkits: string[] | undefined): string[] | undefined {
  if (!toolkits || toolkits.length === 0) return undefined;
  const normalized = toolkits
    .map((toolkit) => toolkit.trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeToolkitLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function parseAllowedToolkits(value: string | undefined): Set<string> | null {
  const items = value
    ?.split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean) ?? [];
  return items.length > 0 ? new Set(items) : null;
}

function defaultToolkitMetadata(toolkitSlug: string): { toolkitName: string; logoUrl: string | null } {
  if (toolkitSlug === 'gmail') {
    return {
      toolkitName: 'Gmail',
      logoUrl: null,
    };
  }

  return {
    toolkitName: titleCase(toolkitSlug.replace(/[_-]+/g, ' ')),
    logoUrl: null,
  };
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function mapConnectedAccountStatus(status: string | undefined): ConnectionRequestStatus {
  switch (status) {
    case 'ACTIVE':
      return 'connected';
    case 'FAILED':
      return 'failed';
    case 'EXPIRED':
      return 'expired';
    default:
      return 'pending';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function rankToolkits(
  toolkits: BridgeToolkitView[],
  normalizedInput: string,
): Array<{ toolkit: BridgeToolkitView; score: number }> {
  return toolkits
    .map((toolkit) => ({
      toolkit,
      score: scoreToolkit(toolkit, normalizedInput),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.toolkit.name.localeCompare(right.toolkit.name);
    });
}

function scoreToolkit(toolkit: BridgeToolkitView, normalizedInput: string): number {
  const slug = toolkit.slug.toLowerCase();
  const name = toolkit.name.toLowerCase();
  if (slug === normalizedInput) return 100;
  if (name === normalizedInput) return 95;
  if (slug.replace(/[_-]+/g, ' ') === normalizedInput) return 90;
  if (name.startsWith(normalizedInput)) return 70;
  if (slug.startsWith(normalizedInput)) return 65;
  if (name.includes(normalizedInput)) return 50;
  if (slug.includes(normalizedInput.replace(/\s+/g, ''))) return 45;
  return 0;
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function matchesToolkitQuery(
  toolkit: {
    slug: string;
    name: string;
    meta: { description?: string | undefined };
  },
  normalizedQuery: string,
): boolean {
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const haystacks = [
    toolkit.slug.toLowerCase(),
    toolkit.slug.replace(/[_-]+/g, ''),
    toolkit.name.toLowerCase(),
    toolkit.meta.description?.toLowerCase() ?? '',
  ];
  return haystacks.some((value) => value.includes(normalizedQuery) || value.includes(compactQuery));
}
