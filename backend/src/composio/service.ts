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

export interface BridgeFindActionsRequest {
  app?: string;
  intent?: string;
  limit?: number;
}

export interface BridgeActionCandidateView {
  provider: 'composio';
  providerAction: string;
  appSlug: string | null;
  appName: string | null;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  guidance: BridgeActionGuidanceView | null;
  connection: {
    connected: boolean | null;
    connectedAccountId: string | null;
    status: string | null;
  } | null;
}

export interface BridgeActionGuidanceView {
  executionGuidance: string | null;
  recommendedPlanSteps: string[];
  knownPitfalls: string[];
}

export interface BridgeActionSchemaView {
  provider: 'composio';
  providerAction: string;
  appSlug: string | null;
  appName: string | null;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
}

export interface BridgeExecuteActionRequest {
  providerAction?: string;
  arguments?: Record<string, unknown>;
}

export interface BridgeActionExecutionView {
  provider: 'composio';
  providerAction: string;
  data: unknown;
  error: string | null;
  logId: string | null;
  successful: boolean | null;
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

interface ToolRouterSessionLike {
  sessionId?: string;
  search: (params: { query: string; toolkits?: string[] }) => Promise<unknown>;
  execute: (toolSlug: string, arguments_: Record<string, unknown>) => Promise<unknown>;
}

interface CachedToolRouterSession {
  session: ToolRouterSessionLike;
  expiresAt: number;
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

  private readonly toolRouterSessionCache = new Map<string, CachedToolRouterSession>();

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

    // Tool Router MCP keeps Hermes' tool surface small and lets Composio
    // provide discovery, schemas, execution guidance, and workbench support
    // at runtime. Do not use Single Toolkit direct MCP here: it exposes raw
    // app-action schemas up front and makes broad assistants brittle.
    const session = await this.client!.create(normalizedUserId, {
      ...buildToolRouterToolkitScope(),
      manageConnections: false,
    });

    const view: BridgeSessionView = {
      userId: normalizedUserId,
      sessionId: session.sessionId,
      mcp: {
        url: session.mcp.url,
        headers: normalizeHeaders(session.mcp.headers as Record<string, unknown> | undefined),
      },
    };

    this.sessionCache.set(normalizedUserId, view);
    return view;
  }

  resetSession(userId: string): void {
    const normalizedUserId = normalizeUserId(userId);
    this.sessionCache.delete(normalizedUserId);
    this.toolRouterSessionCache.delete(normalizedUserId);
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

  async findActions(
    userId: string,
    request: BridgeFindActionsRequest,
  ): Promise<BridgeActionCandidateView[]> {
    this.assertConfigured();
    const normalizedUserId = normalizeUserId(userId);
    const intent = request.intent?.trim();
    if (!intent) {
      throw new ComposioServiceError(400, 'Missing "intent"');
    }

    const appToolkits = normalizeActionToolkits(request.app);
    const session = await this.getToolRouterSession(normalizedUserId);
    const response = await session.search({
      query: intent,
      ...(appToolkits ? { toolkits: appToolkits } : {}),
    });
    const parsed = parseToolRouterSearchResponse(response);
    const limit = normalizeActionLimit(request.limit);
    const connectionByToolkit = buildConnectionStatusMap(parsed.connectionStatuses);
    const candidates: BridgeActionCandidateView[] = [];

    for (const item of parsed.actions) {
      if (candidates.length >= limit) break;
      let tool: BridgeActionSchemaView;
      try {
        tool = await this.getActionSchema(normalizedUserId, item.slug);
      } catch {
        continue;
      }
      const appSlug = tool.appSlug ?? item.toolkits[0] ?? null;
      if (appToolkits && appSlug && !appToolkits.includes(appSlug)) continue;
      if (appSlug && !this.isAllowedToolkit(appSlug)) continue;
      const connection = appSlug ? connectionByToolkit.get(appSlug) ?? null : null;
      candidates.push({
        provider: 'composio',
        providerAction: item.slug,
        appSlug,
        appName: tool.appName,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        guidance: item.guidance,
        connection,
      });
    }

    return candidates;
  }

  async getActionSchema(_userId: string, providerAction: string): Promise<BridgeActionSchemaView> {
    this.assertConfigured();
    const action = providerAction.trim();
    if (!action) {
      throw new ComposioServiceError(400, 'Missing "providerAction"');
    }

    const tool = await this.getToolBySlug(action);
    const appSlug = tool.toolkit?.slug ?? null;
    if (appSlug && !this.isAllowedToolkit(appSlug)) {
      throw new ComposioServiceError(400, `Toolkit "${appSlug}" is not allowed by policy.`);
    }

    return {
      provider: 'composio',
      providerAction: tool.slug,
      appSlug,
      appName: tool.toolkit?.name ?? null,
      name: tool.name,
      description: tool.description ?? null,
      inputSchema: asRecord(tool.inputParameters),
    };
  }

  async executeAction(
    userId: string,
    request: BridgeExecuteActionRequest,
  ): Promise<BridgeActionExecutionView> {
    this.assertConfigured();
    const normalizedUserId = normalizeUserId(userId);
    const action = request.providerAction?.trim();
    if (!action) {
      throw new ComposioServiceError(400, 'Missing "providerAction"');
    }

    const schema = await this.getActionSchema(normalizedUserId, action);
    if (schema.appSlug && !this.isAllowedToolkit(schema.appSlug)) {
      throw new ComposioServiceError(400, `Toolkit "${schema.appSlug}" is not allowed by policy.`);
    }

    const session = await this.getToolRouterSession(normalizedUserId);
    const result = await session.execute(action, request.arguments ?? {});
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

  private async getToolRouterSession(userId: string): Promise<ToolRouterSessionLike> {
    const cached = this.toolRouterSessionCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.session;

    const session = await this.client!.create(userId, {
      ...buildToolRouterToolkitScope(),
      manageConnections: false,
    }) as unknown as ToolRouterSessionLike;
    this.toolRouterSessionCache.set(userId, {
      session,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return session;
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

  private async searchToolkitCatalog(query: string | undefined, limit: number): Promise<CatalogToolkitItem[]> {
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
}

function buildToolRouterToolkitScope(): { toolkits?: string[] } {
  const raw = (
    process.env.VERSO_COMPOSIO_MCP_TOOLKITS?.trim()
    || process.env.VERSO_COMPOSIO_ALLOWED_TOOLKITS?.trim()
  );
  if (!raw) return {};
  const toolkits = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return toolkits.length > 0 ? { toolkits } : {};
}

function normalizeActionToolkits(app: string | undefined): string[] | undefined {
  const value = app?.trim();
  if (!value) return undefined;
  return toolkitInputCandidates(value).filter(Boolean);
}

function normalizeActionLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 3;
  return Math.max(1, Math.min(8, Math.floor(limit)));
}

function parseToolRouterSearchResponse(response: unknown): {
  actions: Array<{
    slug: string;
    toolkits: string[];
    guidance: BridgeActionGuidanceView | null;
  }>;
  connectionStatuses: unknown[];
} {
  const record = asRecord(response) ?? {};
  const results = asArray(record.results);
  const connectionStatuses = asArray(record.toolkitConnectionStatuses ?? record.toolkit_connection_statuses);
  const actions: Array<{ slug: string; toolkits: string[]; guidance: BridgeActionGuidanceView | null }> = [];
  const seen = new Set<string>();

  for (const result of results) {
    const item = asRecord(result);
    if (!item) continue;
    const slugs = [
      ...asStringArray(item.primaryToolSlugs ?? item.primary_tool_slugs),
      ...asStringArray(item.relatedToolSlugs ?? item.related_tool_slugs),
    ];
    const toolkits = asStringArray(item.toolkits);
    const guidance: BridgeActionGuidanceView = {
      executionGuidance: asString(item.executionGuidance ?? item.execution_guidance),
      recommendedPlanSteps: asStringArray(item.recommendedPlanSteps ?? item.recommended_plan_steps),
      knownPitfalls: asStringArray(item.knownPitfalls ?? item.known_pitfalls),
    };

    for (const slug of slugs) {
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      actions.push({
        slug,
        toolkits,
        guidance: guidance.executionGuidance || guidance.recommendedPlanSteps.length > 0 || guidance.knownPitfalls.length > 0
          ? guidance
          : null,
      });
    }
  }

  return { actions, connectionStatuses };
}

function buildConnectionStatusMap(statuses: unknown[]): Map<string, BridgeActionCandidateView['connection']> {
  const items = new Map<string, BridgeActionCandidateView['connection']>();
  for (const status of statuses) {
    const record = asRecord(status);
    if (!record) continue;
    const toolkit = asString(record.toolkit);
    if (!toolkit) continue;
    const connectionDetails = asRecord(record.connectionDetails ?? record.connection_details);
    items.set(toolkit, {
      connected: typeof record.hasActiveConnection === 'boolean'
        ? record.hasActiveConnection
        : typeof record.has_active_connection === 'boolean'
          ? record.has_active_connection
          : null,
      connectedAccountId: asString(connectionDetails?.connected_account_id ?? connectionDetails?.connectedAccountId),
      status: asString(connectionDetails?.status),
    });
  }
  return items;
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new ComposioServiceError(400, 'Missing "userId"');
  }
  return normalized;
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
