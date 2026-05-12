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

export class ComposioServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ComposioServiceError';
    this.status = status;
  }
}

export class ComposioService {
  private readonly apiKey: string | null;

  private readonly client: Composio | null;

  private readonly sessionCache = new Map<string, BridgeSessionView>();

  private readonly allowedToolkits: Set<string> | null;

  constructor(apiKey = process.env.COMPOSIO_API_KEY?.trim() || '') {
    this.apiKey = apiKey || null;
    this.client = this.apiKey ? new Composio({ apiKey: this.apiKey }) : null;
    this.allowedToolkits = parseAllowedToolkits(process.env.VERSO_COMPOSIO_ALLOWED_TOOLKITS);
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
    const normalizedToolkits = normalizeToolkits(toolkits);

    try {
      const routerSession = await this.createToolRouterSession(normalizeUserId(userId));
      const response = await routerSession.search({
        query,
        toolkits: normalizedToolkits,
      });
      const slugs = Array.from(new Set(response.results.flatMap((result) => [
        ...result.primaryToolSlugs,
        ...result.relatedToolSlugs,
      ])));

      if (slugs.length > 0) {
        const tools = await Promise.all(slugs.map(async (slug) => this.getToolBySlug(slug).catch(() => null)));
        const filtered = tools
          .filter((tool): tool is NonNullable<typeof tool> => tool !== null)
          .filter((tool) => !normalizedToolkits || normalizedToolkits.includes(tool.toolkit?.slug?.trim().toLowerCase() ?? ''))
          .map((tool) => toSearchToolView(tool));
        if (filtered.length > 0) {
          return filtered;
        }
      }
    } catch (error: unknown) {
      if (!shouldFallbackToolkitToolSearch(normalizedToolkits, error)) {
        throw error;
      }
    }

    if (normalizedToolkits && normalizedToolkits.length > 0) {
      const fallbackResults = await this.searchToolkitToolsDirect(normalizedToolkits, query);
      if (fallbackResults.length > 0) {
        return fallbackResults;
      }
    }

    return [];
  }

  async getToolSchemas(userId: string, toolSlugs: string[]): Promise<BridgeToolSchemaView[]> {
    this.assertConfigured();
    const wanted = new Set(toolSlugs.map((slug) => slug.trim()).filter(Boolean));

    const schemas = await Promise.all(
      Array.from(wanted).map(async (slug) => {
        const tool = await this.getToolBySlug(slug);
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

  async executeTool(
    userId: string,
    toolSlug: string,
    arguments_: Record<string, unknown> | undefined,
    connectedAccountId?: string,
  ): Promise<BridgeToolExecutionView> {
    this.assertConfigured();
    const result = await this.executeToolRaw(
      normalizeUserId(userId),
      toolSlug,
      arguments_ ?? {},
      connectedAccountId?.trim() || undefined,
    );
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
    throw new ComposioServiceError(503, 'Composio backend is unavailable. Set COMPOSIO_API_KEY to enable it.');
  }

  private async createToolRouterSession(userId: string) {
    return this.client!.create(userId, {
      manageConnections: false,
    });
  }

  private async searchToolkitCatalog(query: string | undefined, limit: number) {
    const params = new URLSearchParams();
    params.set('managed_by', 'all');
    params.set('limit', String(query ? 200 : limit));
    if (query) {
      params.set('search', query);
      params.set('sort_by', 'alphabetically');
    } else {
      params.set('sort_by', 'usage');
    }

    const response = await fetch(`https://backend.composio.dev/api/v3/toolkits?${params.toString()}`, {
      headers: {
        'x-api-key': this.apiKey!,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ComposioServiceError(
        response.status,
        `Composio toolkits request failed (${response.status}): ${body || response.statusText}`,
      );
    }

    const body = await response.json() as {
      items?: CatalogToolkitItem[];
    };
    const items = Array.isArray(body.items) ? body.items : [];
    if (!query) return items.slice(0, limit);

    const normalizedQuery = normalizeSearchQuery(query);
    const matched = items
      .filter((toolkit: CatalogToolkitItem) => matchesToolkitQuery(toolkit, normalizedQuery))
      .slice(0, limit);
    const direct = await this.tryGetToolkitCatalogItem(query);
    if (!direct) return matched;
    return dedupeToolkitCatalogItems([direct, ...matched]).slice(0, limit);
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
      throw new ComposioServiceError(400, 'Missing "toolkit"');
    }

    try {
      const toolkit = await this.getToolkitByInput(toolkitInput);
      if (!this.isAllowedToolkit(toolkit.slug)) {
        throw new ComposioServiceError(400, `Toolkit "${toolkitInput}" is not allowed by policy.`);
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
        throw new ComposioServiceError(404, `No Composio toolkit found for "${toolkitInput}".`);
      }

      const suggestions = ranked.slice(0, 4).map(({ toolkit }) => `${toolkit.name} (${toolkit.slug})`).join(', ');
      throw new ComposioServiceError(
        400,
        `Toolkit "${toolkitInput}" is ambiguous. Try one of: ${suggestions}`,
      );
    }
  }

  private isAllowedToolkit(toolkitSlug: string): boolean {
    if (!this.allowedToolkits) return true;
    return this.allowedToolkits.has(toolkitSlug.trim().toLowerCase());
  }

  private async searchToolkitToolsDirect(toolkits: string[], query: string): Promise<BridgeSearchToolResult[]> {
    const normalizedQuery = normalizeSearchQuery(query);
    const results: BridgeSearchToolResult[] = [];

    for (const toolkitInput of toolkits) {
      const toolkit = await this.resolveToolkit(toolkitInput);
      const items = await this.listToolkitTools(toolkit.slug);
      const matches = items
        .filter((tool) => matchesToolQuery(tool, normalizedQuery))
        .map((tool) => ({
          slug: tool.slug,
          name: tool.name,
          description: tool.description ?? null,
          toolkitSlug: tool.toolkit?.slug ?? toolkit.slug,
          toolkitName: tool.toolkit?.name ?? toolkit.name,
        } satisfies BridgeSearchToolResult));
      if (matches.length > 0) {
        results.push(...matches);
      } else {
        results.push(...items.map((tool) => ({
          slug: tool.slug,
          name: tool.name,
          description: tool.description ?? null,
          toolkitSlug: tool.toolkit?.slug ?? toolkit.slug,
          toolkitName: tool.toolkit?.name ?? toolkit.name,
        } satisfies BridgeSearchToolResult)));
      }
    }

    return dedupeSearchToolResults(results);
  }

  private async getToolkitByInput(toolkitInput: string) {
    const candidates = toolkitInputCandidates(toolkitInput);
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        return await this.client!.toolkits.get(candidate);
      } catch (error: unknown) {
        lastError = error;
      }
    }
    throw lastError ?? new ComposioServiceError(404, `No Composio toolkit found for "${toolkitInput}".`);
  }

  private async tryGetToolkitCatalogItem(query: string): Promise<CatalogToolkitItem | null> {
    try {
      const toolkit = await this.getToolkitByInput(query);
      return {
        slug: toolkit.slug,
        name: toolkit.name,
        meta: {
          description: toolkit.meta.description ?? undefined,
          logo: toolkit.meta.logo ?? undefined,
          categories: toolkit.meta.categories ?? [],
        },
        authSchemes: toolkit.authConfigDetails?.map((detail) => detail.name).filter(isNonEmptyString) ?? [],
        composioManagedAuthSchemes: toolkit.composioManagedAuthSchemes ?? [],
        noAuth: false,
      };
    } catch {
      return null;
    }
  }

  private async listToolkitTools(toolkitSlug: string): Promise<Array<{
    slug: string;
    name: string;
    description?: string | null;
    toolkit?: { slug?: string | null; name?: string | null } | null;
  }>> {
    const response = await fetch(`https://backend.composio.dev/api/v3/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&toolkit_versions=latest&limit=200`, {
      headers: {
        'x-api-key': this.apiKey!,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ComposioServiceError(
        response.status,
        `Composio tools request failed (${response.status}): ${body || response.statusText}`,
      );
    }

    const body = await response.json() as {
      items?: Array<{
        slug: string;
        name: string;
        description?: string | null;
        toolkit?: { slug?: string | null; name?: string | null } | null;
      }>;
    };

    return Array.isArray(body.items) ? body.items : [];
  }

  private async getToolBySlug(toolSlug: string): Promise<{
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
      throw new ComposioServiceError(
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
      const body = await response.text().catch(() => '');
      throw new ComposioServiceError(
        response.status,
        `Composio tool execute failed (${response.status}): ${body || response.statusText}`,
      );
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

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new ComposioServiceError(400, 'Missing "userId"');
  }
  return normalized;
}

function normalizeToolkits(toolkits: string[] | undefined): string[] | undefined {
  if (!toolkits || toolkits.length === 0) return undefined;
  const normalized = toolkits
    .flatMap((toolkit) => toolkitInputCandidates(toolkit))
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

function toolkitInputCandidates(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return [];

  const aliases = new Set<string>([
    normalized,
    normalized.replace(/\s+/g, '_'),
    normalized.replace(/\s+/g, ''),
    normalized.replace(/[_-]+/g, ' '),
  ]);

  if (normalized === 'granola' || normalized === 'granola mcp' || normalized === 'granola_mcp') {
    aliases.add('granola_mcp');
    aliases.add('granola mcp');
    aliases.add('granola');
  }

  return Array.from(aliases);
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

function dedupeToolkitCatalogItems(items: CatalogToolkitItem[]): CatalogToolkitItem[] {
  const seen = new Set<string>();
  const deduped: CatalogToolkitItem[] = [];
  for (const item of items) {
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    deduped.push(item);
  }
  return deduped;
}

function dedupeSearchToolResults(items: BridgeSearchToolResult[]): BridgeSearchToolResult[] {
  const seen = new Set<string>();
  const deduped: BridgeSearchToolResult[] = [];
  for (const item of items) {
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    deduped.push(item);
  }
  return deduped;
}

function shouldFallbackToolkitToolSearch(toolkits: string[] | undefined, error: unknown): boolean {
  if (!toolkits || toolkits.length === 0) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('outputParameters')
    || message.includes('invalid_literal')
    || message.includes('invalid_type');
}

function toSearchToolView(tool: {
  slug: string;
  name: string;
  description?: string | null;
  toolkit?: { slug?: string | null; name?: string | null } | null;
}): BridgeSearchToolResult {
  return {
    slug: tool.slug,
    name: tool.name,
    description: tool.description ?? null,
    toolkitSlug: tool.toolkit?.slug ?? null,
    toolkitName: tool.toolkit?.name ?? null,
  };
}
