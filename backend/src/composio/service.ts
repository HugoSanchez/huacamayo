import { Composio } from '@composio/core';

export type ConnectionRequestStatus = 'pending' | 'connected' | 'failed' | 'expired';
export type ConnectionStatus = 'active' | 'inactive';

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

interface ComposioToolView {
  slug: string;
  name: string;
  description: string | null;
  toolkit: { slug?: string | null; name?: string | null } | null;
  inputParameters: Record<string, unknown> | null;
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

  private readonly toolRouterSessionCache = new Map<string, CachedToolRouterSession>();

  private readonly toolSchemaCache = new Map<string, ComposioToolView>();

  private readonly allowedToolkits: Set<string> | null;

  constructor(apiKey = process.env.COMPOSIO_API_KEY?.trim() || '') {
    this.apiKey = apiKey || null;
    this.client = this.apiKey ? new Composio({ apiKey: this.apiKey }) : null;
    this.allowedToolkits = parseAllowedToolkits(process.env.VERSO_COMPOSIO_ALLOWED_TOOLKITS);
  }

  get configured(): boolean {
    return Boolean(this.client);
  }

  async listConnections(userId: string): Promise<BridgeConnectionView[]> {
    this.assertConfigured();
    const normalizedUserId = normalizeUserId(userId);
    const response = await this.client!.connectedAccounts.list({
      userIds: [normalizedUserId],
      statuses: ['ACTIVE', 'INACTIVE'],
    });

    // Composio's DELETE /connected_accounts/:id is a soft-delete that's
    // eventually consistent — a just-deleted account can still appear here
    // as ACTIVE for several seconds. We pair the delete with an immediate
    // `disable()` call that flips `isDisabled` synchronously, then filter
    // disabled rows out here so the sidebar reflects the change on the
    // very next refresh instead of waiting for Composio to catch up.
    const items = await Promise.all(response.items
      .filter((item) => !item.isDisabled)
      .map(async (item) => {
        const toolkitMeta = await this.getToolkitMetadata(item.toolkit.slug);
        return {
          connectedAccountId: item.id,
          toolkitSlug: item.toolkit.slug,
          toolkitName: toolkitMeta.toolkitName,
          logoUrl: toolkitMeta.logoUrl,
          status: item.status === 'INACTIVE' ? 'inactive' : 'active',
        } satisfies BridgeConnectionView;
      }));

    return items.sort((a, b) => a.toolkitName.localeCompare(b.toolkitName));
  }

  async deleteConnection(userId: string, connectedAccountId: string): Promise<void> {
    this.assertConfigured();
    const normalizedUserId = normalizeUserId(userId);
    const trimmedId = connectedAccountId.trim();
    if (!trimmedId) {
      throw new ComposioServiceError(400, 'Missing "connectedAccountId"');
    }

    // The SDK's `connectedAccounts.delete` takes an id alone and does not
    // verify that the account belongs to the caller. Without an ownership
    // check, an authenticated user who guessed an id could revoke someone
    // else's account. Listing by the authed user's id and checking
    // membership keeps the API key-scoped check entirely server-side and
    // returns 404 (rather than 403) on a miss so we don't leak whether the
    // id exists under a different user.
    const owned = await this.client!.connectedAccounts.list({
      userIds: [normalizedUserId],
      statuses: ['ACTIVE', 'INACTIVE'],
    });
    const isOwned = owned.items.some((item) => item.id === trimmedId);
    if (!isOwned) {
      throw new ComposioServiceError(404, `Connected account "${trimmedId}" not found.`);
    }

    // Disable first so `isDisabled` flips synchronously — Composio's API
    // confirms the change before returning, so the very next list() will
    // exclude this account (we filter `isDisabled` out in listConnections).
    // Without this, the soft-delete that follows is eventually consistent
    // and the sidebar would show the just-disconnected toolkit again for a
    // few seconds. We swallow disable errors (e.g. already-disabled) and
    // proceed to the delete: the delete is the security-critical step
    // that revokes the OAuth tokens.
    try {
      await this.client!.connectedAccounts.disable(trimmedId);
    } catch {
      // Continue to delete — disable is best-effort UX prep.
    }

    await this.client!.connectedAccounts.delete(trimmedId);

    // The tool router session is cached per-user with a 10-minute TTL. Drop
    // the entry so the next tool call rebuilds the session and Composio
    // stops listing the (now-revoked) toolkit as connected.
    this.toolRouterSessionCache.delete(normalizedUserId);
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

  async listTools(userId: string, toolkits: string[]): Promise<BridgeSearchToolResult[]> {
    this.assertConfigured();
    normalizeUserId(userId);
    const normalizedToolkits = normalizeToolkits(toolkits);
    if (!normalizedToolkits || normalizedToolkits.length === 0) {
      throw new ComposioServiceError(400, 'Missing "toolkits"');
    }

    const results: BridgeSearchToolResult[] = [];
    for (const toolkitInput of normalizedToolkits) {
      const toolkit = await this.resolveToolkit(toolkitInput);
      const items = await this.listToolkitTools(toolkit.slug);
      results.push(...items
        .filter((tool) => {
          const toolkitSlug = tool.toolkit?.slug ?? toolkit.slug;
          return !toolkitSlug || this.isAllowedToolkit(toolkitSlug);
        })
        .map((tool) => ({
          slug: tool.slug,
          name: tool.name,
          description: tool.description ?? null,
          toolkitSlug: tool.toolkit?.slug ?? toolkit.slug,
          toolkitName: tool.toolkit?.name ?? toolkit.name,
        } satisfies BridgeSearchToolResult)));
    }

    return dedupeSearchToolResults(results);
  }

  async searchTools(userId: string, query: string, toolkits?: string[]): Promise<BridgeSearchToolResult[]> {
    this.assertConfigured();
    const normalizedUserId = normalizeUserId(userId);
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new ComposioServiceError(400, 'Missing "query"');
    }
    const normalizedToolkits = normalizeToolkits(toolkits);

    try {
      const session = await this.getToolRouterSession(normalizedUserId);
      const response = await session.search({
        query: normalizedQuery,
        ...(normalizedToolkits ? { toolkits: normalizedToolkits } : {}),
      });
      const slugs = parseToolRouterToolSlugs(response);

      if (slugs.length > 0) {
        const tools = await Promise.all(slugs.map(async (slug) => this.getToolBySlug(slug).catch(() => null)));
        const filtered = tools
          .filter((tool): tool is NonNullable<typeof tool> => tool !== null)
          .filter((tool) => !normalizedToolkits || normalizedToolkits.includes(tool.toolkit?.slug?.trim().toLowerCase() ?? ''))
          .filter((tool) => !tool.toolkit?.slug || this.isAllowedToolkit(tool.toolkit.slug))
          .map((tool) => toSearchToolView(tool));
        if (filtered.length > 0) {
          return dedupeSearchToolResults(filtered);
        }
      }
    } catch (error: unknown) {
      if (!shouldFallbackToolkitToolSearch(normalizedToolkits, error)) {
        throw error;
      }
    }

    if (normalizedToolkits && normalizedToolkits.length > 0) {
      const fallbackResults = await this.searchToolkitToolsDirect(normalizedToolkits, normalizedQuery);
      if (fallbackResults.length > 0) {
        return fallbackResults;
      }
    }

    return [];
  }

  async getToolSchemas(_userId: string, toolSlugs: string[]): Promise<BridgeToolSchemaView[]> {
    this.assertConfigured();
    const wanted = new Set(toolSlugs.map((slug) => slug.trim()).filter(Boolean));
    if (wanted.size === 0) {
      throw new ComposioServiceError(400, 'Missing "toolSlugs"');
    }

    const schemas = await Promise.all(
      Array.from(wanted).map(async (slug) => {
        try {
          const tool = await this.getToolBySlug(slug);
          const toolkitSlug = tool.toolkit?.slug ?? null;
          if (toolkitSlug && !this.isAllowedToolkit(toolkitSlug)) {
            throw new ComposioServiceError(400, `Toolkit "${toolkitSlug}" is not allowed by policy.`);
          }
          return {
            slug: tool.slug,
            name: tool.name,
            description: tool.description ?? null,
            toolkitSlug,
            toolkitName: tool.toolkit?.name ?? null,
            inputParameters: compactInputParameters(tool.inputParameters),
          } satisfies BridgeToolSchemaView;
        } catch (error: unknown) {
          if (!isComposioSchemaValidationError(error)) throw error;
          this.logToolEvent('composio.getSchemas.schemaUnavailable', {
            toolSlug: slug,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            slug,
            name: slug,
            description: 'Schema unavailable from Composio (malformed upstream). Call the tool with best-guess arguments.',
            toolkitSlug: null,
            toolkitName: null,
            inputParameters: null,
          } satisfies BridgeToolSchemaView;
        }
      }),
    );

    return schemas;
  }

  async executeTool(
    userId: string,
    toolSlug: string,
    arguments_: Record<string, unknown> | undefined,
    _connectedAccountId?: string,
  ): Promise<BridgeToolExecutionView> {
    this.assertConfigured();
    const normalizedUserId = normalizeUserId(userId);
    const slug = toolSlug.trim();
    if (!slug) {
      throw new ComposioServiceError(400, 'Missing "toolSlug"');
    }
    const argumentRecord = asRecord(arguments_);
    if (!argumentRecord) {
      this.logToolEvent('composio.execute.rejected', {
        toolSlug: slug,
        reason: 'missing_arguments',
      });
      throw new ComposioServiceError(400, 'Missing required object "arguments".');
    }

    // When Composio's SDK fails to validate the tool's schema (some toolkits
    // ship malformed outputParameters), fall back to executing without the
    // local schema precheck. The session-level toolkit scope at Composio
    // (buildToolRouterToolkitScope) still enforces which toolkits this user
    // may invoke, so policy isn't lost — only the missing-required-args
    // precheck is. Composio's API will return its own validation error if
    // the arguments are malformed.
    let tool: ComposioToolView | null = null;
    try {
      tool = await this.getToolBySlug(slug);
    } catch (error: unknown) {
      if (!isComposioSchemaValidationError(error)) throw error;
      this.logToolEvent('composio.execute.schemaUnavailable', {
        toolSlug: slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const executionSlug = tool?.slug ?? slug;
    const toolkitSlug = tool?.toolkit?.slug ?? null;
    if (toolkitSlug && !this.isAllowedToolkit(toolkitSlug)) {
      throw new ComposioServiceError(400, `Toolkit "${toolkitSlug}" is not allowed by policy.`);
    }

    if (tool) {
      const missingRequiredFields = getMissingRequiredToolArguments(tool.inputParameters, argumentRecord);
      if (missingRequiredFields.length > 0) {
        this.logToolEvent('composio.execute.rejected', {
          toolSlug: tool.slug,
          reason: 'missing_required_arguments',
          missingFields: missingRequiredFields,
          argKeys: Object.keys(argumentRecord),
        });
        throw new ComposioServiceError(
          400,
          `Missing required argument${missingRequiredFields.length === 1 ? '' : 's'} ${
            missingRequiredFields.map((field) => `"${field}"`).join(', ')
          } for ${tool.slug}.`,
        );
      }
    }

    try {
      const session = await this.getToolRouterSession(normalizedUserId);
      const result = await session.execute(executionSlug, argumentRecord);
      const resultRecord = asRecord(result);
      const error = resultRecord ? asString(resultRecord.error) : null;
      const logId = resultRecord ? asString(resultRecord.logId ?? resultRecord.log_id) : null;
      this.logToolEvent('composio.execute.completed', {
        toolSlug: executionSlug,
        argKeys: Object.keys(argumentRecord),
        hasError: Boolean(error),
        logId,
      });
      return {
        data: resultRecord && 'data' in resultRecord ? resultRecord.data : result ?? null,
        error,
        logId,
      };
    } catch (error: unknown) {
      this.logToolEvent('composio.execute.failed', {
        toolSlug: executionSlug,
        argKeys: Object.keys(argumentRecord),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private logToolEvent(event: string, details: Record<string, unknown>): void {
    try {
      console.info(JSON.stringify({
        event,
        source: 'composio_service',
        ...details,
      }));
    } catch {
      // Diagnostics should never affect the tool call path.
    }
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

  private async getToolBySlug(toolSlug: string): Promise<ComposioToolView> {
    const slug = toolSlug.trim();
    const cached = this.toolSchemaCache.get(slug);
    if (cached) return cached;

    const rawTool = await this.client!.tools.getRawComposioToolBySlug(slug) as unknown;
    const record = asRecord(rawTool);
    if (!record) {
      throw new ComposioServiceError(502, `Composio returned an invalid schema for ${slug}.`);
    }

    const toolkitRecord = asRecord(record.toolkit);
    const normalizedTool: ComposioToolView = {
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

    this.toolSchemaCache.set(slug, normalizedTool);
    this.toolSchemaCache.set(normalizedTool.slug, normalizedTool);
    return normalizedTool;
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

function normalizeToolkits(toolkits: string[] | undefined): string[] | undefined {
  if (!toolkits || toolkits.length === 0) return undefined;
  const normalized = toolkits
    .flatMap((toolkit) => toolkitInputCandidates(toolkit))
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
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
  return isComposioSchemaValidationError(error);
}

// Composio's SDK runs Zod validation on the raw tool schemas the upstream API
// returns. Some toolkits (e.g. GRANOLA_MCP_*) ship malformed `outputParameters`
// blocks, which makes the SDK throw before we ever get the input schema we
// actually care about. This predicate identifies that error class so callers
// can degrade gracefully (skip the precheck, return a stub schema) instead of
// failing the entire tool call.
function isComposioSchemaValidationError(error: unknown): boolean {
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
