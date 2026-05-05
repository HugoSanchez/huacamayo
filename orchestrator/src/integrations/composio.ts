import { Composio } from '@composio/core';
import {
  ConnectionsStore,
  type ConnectionRecord,
  type ConnectionRequestRecord,
  type ConnectionRequestStatus,
} from '../http/connections-store.ts';
import {
  RemoteComposioBridgeClient,
  type RemoteBridgeToolkitView,
} from './composio-bridge-client.ts';

export interface ConnectionRequestView {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionRequestStatus;
  redirectUrl: string | null;
  connectedAccountId: string | null;
  errorMessage: string | null;
}

export interface ConnectionView {
  connectedAccountId: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: 'active' | 'inactive';
}

export interface ToolkitView {
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

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class ConnectionsService {
  private readonly store: ConnectionsStore;

  private readonly bridgeClient: RemoteComposioBridgeClient;

  private readonly apiKey: string | null;

  private readonly client: Composio | null;

  private readonly allowedToolkits: Set<string> | null;

  constructor(store = new ConnectionsStore(), apiKey = process.env.COMPOSIO_API_KEY?.trim() || '') {
    this.store = store;
    this.bridgeClient = new RemoteComposioBridgeClient();
    this.apiKey = apiKey || null;
    this.client = this.apiKey ? new Composio({ apiKey: this.apiKey }) : null;
    this.allowedToolkits = parseAllowedToolkits(process.env.VERVO_COMPOSIO_ALLOWED_TOOLKITS);
  }

  get configured(): boolean {
    return this.bridgeClient.configured || Boolean(this.client);
  }

  get storePath(): string {
    return this.store.path;
  }

  async listConnections(): Promise<ConnectionView[]> {
    if (this.bridgeClient.configured) {
      const userId = this.store.ensureVervoUserId();
      const items = await this.bridgeClient.listConnections(userId);
      syncRemoteConnectionsIntoStore(this.store, items);
      return items.map((item) => ({ ...item }));
    }

    await this.syncConnections().catch(() => {});
    return this.store.listConnections().map(toConnectionView);
  }

  async listToolkits(opts: { query?: string; cursor?: string; limit?: number } = {}): Promise<{
    toolkits: ToolkitView[];
    nextCursor: string | null;
  }> {
    this.assertConfigured();

    if (this.bridgeClient.configured && this.client === null) {
      const userId = this.store.ensureVervoUserId();
      const items = await this.bridgeClient.listToolkits(userId, opts.query, opts.limit);
      return { toolkits: items, nextCursor: null };
    }

    if (this.client === null || !this.apiKey) {
      throw new HttpError(503, 'Composio API key is not configured.');
    }

    this.store.ensureVervoUserId();
    const query = opts.query?.trim() || undefined;
    const limit = normalizeToolkitLimit(opts.limit);

    const params = new URLSearchParams();
    params.set('managed_by', 'all');
    params.set('limit', String(limit));
    if (query) {
      params.set('search', query);
      params.set('sort_by', 'alphabetically');
    } else {
      params.set('sort_by', 'usage');
    }
    if (opts.cursor) params.set('cursor', opts.cursor);

    const response = await fetch(`https://backend.composio.dev/api/v3/toolkits?${params.toString()}`, {
      headers: {
        'x-api-key': this.apiKey,
        'Accept': 'application/json',
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpError(response.status, `Composio toolkits request failed (${response.status}): ${body || response.statusText}`);
    }
    const body = await response.json() as {
      items: CatalogToolkitItem[];
      next_cursor?: string | null;
    };

    const connections = await this.listConnections();
    const connectedByToolkit = new Map(connections.map((item) => [item.toolkitSlug, item]));

    const toolkits = (body.items ?? [])
      .filter((toolkit) => this.isAllowedToolkit(toolkit.slug))
      .map((toolkit) => {
        const connected = connectedByToolkit.get(toolkit.slug);
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
        } satisfies ToolkitView;
      });

    return {
      toolkits,
      nextCursor: body.next_cursor ?? null,
    };
  }

  createUnavailableRequest(toolkitSlug: string, message: string): ConnectionRequestView {
    const { toolkitName } = defaultToolkitMetadata(toolkitSlug);
    return {
      id: `local-${toolkitSlug}`,
      toolkitSlug,
      toolkitName,
      logoUrl: null,
      status: 'failed',
      redirectUrl: null,
      connectedAccountId: null,
      errorMessage: message,
    };
  }

  async requestConnection(toolkitSlug: string, baseUrl: string): Promise<ConnectionRequestView> {
    this.assertConfigured();

    if (this.bridgeClient.configured) {
      const userId = this.store.ensureVervoUserId();
      const request = await this.bridgeClient.requestConnection(userId, toolkitSlug, `${baseUrl}/connections/callback`);
      syncRemoteRequestIntoStore(this.store, request);
      return request;
    }

    const resolvedToolkit = await this.resolveToolkit(toolkitSlug);
    const existing = this.store.findActiveConnectionByToolkit(resolvedToolkit.slug);
    if (existing) {
      const now = new Date().toISOString();
      const requestRecord: ConnectionRequestRecord = {
        id: existing.connectedAccountId,
        toolkitSlug: existing.toolkitSlug,
        toolkitName: existing.toolkitName,
        logoUrl: existing.logoUrl,
        status: 'connected',
        redirectUrl: null,
        connectedAccountId: existing.connectedAccountId,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.upsertRequest(requestRecord);
      return toRequestView(requestRecord);
    }

    const toolkitMeta = {
      toolkitName: resolvedToolkit.name,
      logoUrl: resolvedToolkit.logoUrl,
    };
    const userId = this.store.ensureVervoUserId();
    const session = await this.client!.create(userId, {
      toolkits: [resolvedToolkit.slug],
      manageConnections: false,
    });
    const connectionRequest = await session.authorize(resolvedToolkit.slug, {
      callbackUrl: `${baseUrl}/connections/callback`,
    });

    const now = new Date().toISOString();
    const requestRecord: ConnectionRequestRecord = {
      id: connectionRequest.id,
      toolkitSlug: resolvedToolkit.slug,
      toolkitName: toolkitMeta.toolkitName,
      logoUrl: toolkitMeta.logoUrl,
      status: mapConnectedAccountStatus(connectionRequest.status),
      redirectUrl: connectionRequest.redirectUrl ?? null,
      connectedAccountId: connectionRequest.status === 'ACTIVE' ? connectionRequest.id : null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertRequest(requestRecord);

    if (requestRecord.status === 'connected') {
      this.store.upsertConnection({
        connectedAccountId: requestRecord.id,
        toolkitSlug: resolvedToolkit.slug,
        toolkitName: requestRecord.toolkitName,
        logoUrl: requestRecord.logoUrl,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    }

    return toRequestView(requestRecord);
  }

  async getRequest(requestId: string): Promise<ConnectionRequestView | null> {
    if (this.bridgeClient.configured) {
      try {
        const request = await this.bridgeClient.getRequest(requestId);
        syncRemoteRequestIntoStore(this.store, request);
        return request;
      } catch {
        return this.store.getRequest(requestId) ? toRequestView(this.store.getRequest(requestId)!) : null;
      }
    }

    const request = this.store.getRequest(requestId);
    if (!request) return null;
    await this.refreshRequestStatus(requestId).catch(() => {});
    return toRequestView(this.store.getRequest(requestId) ?? request);
  }

  getRequestRedirectUrl(requestId: string): string | null {
    return this.store.getRequest(requestId)?.redirectUrl ?? null;
  }

  async refreshRequestStatus(requestId: string): Promise<ConnectionRequestView | null> {
    const request = this.store.getRequest(requestId);
    if (!request) return null;
    if (!this.client) return toRequestView(request);

    try {
      const connectedAccount = await this.client.connectedAccounts.get(requestId);
      const toolkitMeta = await this.getToolkitMetadata(request.toolkitSlug);
      const now = new Date().toISOString();
      const nextRequest: ConnectionRequestRecord = {
        ...request,
        toolkitName: toolkitMeta.toolkitName,
        logoUrl: toolkitMeta.logoUrl,
        status: mapConnectedAccountStatus(connectedAccount.status),
        connectedAccountId: connectedAccount.status === 'ACTIVE' ? connectedAccount.id : null,
        errorMessage: connectedAccount.statusReason ?? null,
        updatedAt: now,
      };
      this.store.upsertRequest(nextRequest);

      if (nextRequest.status === 'connected') {
        const existingConnection = this.store.listConnections()
          .find((item) => item.connectedAccountId === connectedAccount.id);
        this.store.upsertConnection({
          connectedAccountId: connectedAccount.id,
          toolkitSlug: request.toolkitSlug,
          toolkitName: toolkitMeta.toolkitName,
          logoUrl: toolkitMeta.logoUrl,
          status: connectedAccount.isDisabled ? 'inactive' : 'active',
          createdAt: existingConnection?.createdAt ?? connectedAccount.createdAt ?? now,
          updatedAt: connectedAccount.updatedAt ?? now,
        });
      }

      return toRequestView(nextRequest);
    } catch {
      return toRequestView(request);
    }
  }

  private async syncConnections(): Promise<void> {
    if (!this.client) return;
    const userId = this.store.getVervoUserId();
    if (!userId) return;

    const response = await this.client.connectedAccounts.list({
      userIds: [userId],
      statuses: ['ACTIVE', 'INACTIVE'],
    });

    for (const item of response.items) {
      const toolkitMeta = await this.getToolkitMetadata(item.toolkit.slug);
      const existingConnection = this.store.listConnections()
        .find((connection) => connection.connectedAccountId === item.id);
      this.store.upsertConnection({
        connectedAccountId: item.id,
        toolkitSlug: item.toolkit.slug,
        toolkitName: toolkitMeta.toolkitName,
        logoUrl: toolkitMeta.logoUrl,
        status: item.isDisabled || item.status === 'INACTIVE' ? 'inactive' : 'active',
        createdAt: existingConnection?.createdAt ?? item.createdAt,
        updatedAt: item.updatedAt,
      });
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
    if (this.bridgeClient.configured || this.client) return;
    throw new HttpError(
      503,
      'Composio is unavailable. Set VERVO_COMPOSIO_BRIDGE_URL or COMPOSIO_API_KEY to enable connections.',
    );
  }

  private async resolveToolkit(toolkitInput: string): Promise<ToolkitView> {
    const normalizedInput = toolkitInput.trim().toLowerCase();
    if (!normalizedInput) {
      throw new HttpError(400, 'Missing "toolkit"');
    }

    const matches = await this.listToolkits({ query: toolkitInput, limit: 8 });
    const ranked = rankToolkits(matches.toolkits, normalizedInput);
    const best = ranked[0];
    if (best && (ranked.length === 1 || best.score > ranked[1].score)) {
      return best.toolkit;
    }

    if (ranked.length === 0) {
      throw new HttpError(404, `No Composio toolkit found for "${toolkitInput}".`);
    }

    const suggestions = ranked.slice(0, 4).map(({ toolkit }) => `${toolkit.name} (${toolkit.slug})`).join(', ');
    throw new HttpError(400, `Toolkit "${toolkitInput}" is ambiguous. Try one of: ${suggestions}`);
  }

  private isAllowedToolkit(toolkitSlug: string): boolean {
    if (!this.allowedToolkits) return true;
    return this.allowedToolkits.has(toolkitSlug.trim().toLowerCase());
  }
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

function normalizeToolkitLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(1000, Math.floor(limit)));
}

function parseAllowedToolkits(value: string | undefined): Set<string> | null {
  const items = value
    ?.split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean) ?? [];
  return items.length > 0 ? new Set(items) : null;
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

function toRequestView(record: ConnectionRequestRecord): ConnectionRequestView {
  return {
    id: record.id,
    toolkitSlug: record.toolkitSlug,
    toolkitName: record.toolkitName,
    logoUrl: record.logoUrl,
    status: record.status,
    redirectUrl: record.redirectUrl,
    connectedAccountId: record.connectedAccountId,
    errorMessage: record.errorMessage,
  };
}

function toConnectionView(record: ConnectionRecord): ConnectionView {
  return {
    connectedAccountId: record.connectedAccountId,
    toolkitSlug: record.toolkitSlug,
    toolkitName: record.toolkitName,
    logoUrl: record.logoUrl,
    status: record.status,
  };
}

function syncRemoteConnectionsIntoStore(
  store: ConnectionsStore,
  connections: ConnectionView[],
): void {
  const now = new Date().toISOString();
  for (const connection of connections) {
    const existing = store.listConnections().find((item) => item.connectedAccountId === connection.connectedAccountId);
    store.upsertConnection({
      connectedAccountId: connection.connectedAccountId,
      toolkitSlug: connection.toolkitSlug,
      toolkitName: connection.toolkitName,
      logoUrl: connection.logoUrl,
      status: connection.status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
}

function syncRemoteRequestIntoStore(
  store: ConnectionsStore,
  request: ConnectionRequestView,
): void {
  const now = new Date().toISOString();
  const existingRequest = store.getRequest(request.id);
  store.upsertRequest({
    id: request.id,
    toolkitSlug: request.toolkitSlug,
    toolkitName: request.toolkitName,
    logoUrl: request.logoUrl,
    status: request.status,
    redirectUrl: request.redirectUrl ?? existingRequest?.redirectUrl ?? null,
    connectedAccountId: request.connectedAccountId,
    errorMessage: request.errorMessage,
    createdAt: existingRequest?.createdAt ?? now,
    updatedAt: now,
  });

  if (request.status === 'connected' && request.connectedAccountId) {
    const existingConnection = store.listConnections()
      .find((item) => item.connectedAccountId === request.connectedAccountId);
    store.upsertConnection({
      connectedAccountId: request.connectedAccountId,
      toolkitSlug: request.toolkitSlug,
      toolkitName: request.toolkitName,
      logoUrl: request.logoUrl,
      status: 'active',
      createdAt: existingConnection?.createdAt ?? now,
      updatedAt: now,
    });
  }
}

function rankToolkits(
  toolkits: ToolkitView[] | RemoteBridgeToolkitView[],
  normalizedInput: string,
): Array<{ toolkit: ToolkitView; score: number }> {
  return toolkits
    .map((toolkit) => ({
      toolkit: toolkit as ToolkitView,
      score: scoreToolkit(toolkit, normalizedInput),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.toolkit.name.localeCompare(right.toolkit.name);
    });
}

function scoreToolkit(toolkit: { slug: string; name: string }, normalizedInput: string): number {
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
