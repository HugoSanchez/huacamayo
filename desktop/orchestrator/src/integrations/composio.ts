import { ManagedBackendClient } from './managed-backend-client.ts';
import {
  RemoteBridgeHttpError,
  RemoteComposioBridgeClient,
  type RemoteBridgeToolkitView,
} from './composio-bridge-client.ts';
import {
  ConnectionsStore,
  type ConnectionRecord,
  type ConnectionRequestRecord,
  type ConnectionRequestStatus,
} from '../http/connections-store.ts';

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

  constructor(
    managedBackend: ManagedBackendClient,
    store = new ConnectionsStore(),
  ) {
    this.store = store;
    this.bridgeClient = new RemoteComposioBridgeClient(managedBackend);
  }

  get configured(): boolean {
    return this.bridgeClient.configured;
  }

  get storePath(): string {
    return this.store.path;
  }

  async listConnections(): Promise<ConnectionView[]> {
    try {
      const remote = await this.bridgeClient.listConnections();
      // Composio's delete is soft + eventually consistent: an account we
      // just disconnected can still come back in the list for a few
      // seconds. The tombstone filter keeps disconnected accounts out of
      // the sidebar until Composio's view catches up, so the row doesn't
      // pop back with an "Active" tag right after the user removes it.
      const filtered = remote.filter((item) => !this.store.isTombstoned(item.connectedAccountId));
      syncRemoteConnectionsIntoStore(this.store, filtered);
      return mergeConnectionViews(filtered, this.store.listConnections().map(toConnectionView));
    } catch {
      return this.store.listConnections().map(toConnectionView);
    }
  }

  async listToolkits(opts: { query?: string; cursor?: string; limit?: number } = {}): Promise<{
    toolkits: ToolkitView[];
    nextCursor: string | null;
  }> {
    this.assertConfigured();
    const localConnections = this.store.listConnections().map(toConnectionView);

    try {
      const items = await this.bridgeClient.listToolkits(opts.query, opts.limit);
      return {
        toolkits: mergeToolkitViewsWithStoredConnections(items, localConnections, opts.query),
        nextCursor: null,
      };
    } catch {
      return {
        toolkits: mergeToolkitViewsWithStoredConnections([], localConnections, opts.query),
        nextCursor: null,
      };
    }
  }

  async deleteConnection(connectedAccountId: string): Promise<void> {
    this.assertConfigured();
    const trimmedId = connectedAccountId.trim();
    if (!trimmedId) {
      throw new HttpError(400, 'Missing "connectedAccountId"');
    }

    try {
      await this.bridgeClient.deleteConnection(trimmedId);
    } catch (error) {
      if (!(error instanceof RemoteBridgeHttpError && error.status === 404)) {
        throw mapRemoteBridgeError(error);
      }
      // DELETE is idempotent from the sidebar's point of view. If the
      // backend no longer finds the account for this user, remove any stale
      // local cache row so an old persisted connection cannot keep showing.
    }

    this.store.deleteConnection(trimmedId);
  }

  async requestConnection(toolkitSlug: string, baseUrl: string): Promise<ConnectionRequestView> {
    this.assertConfigured();

    try {
      const request = await this.bridgeClient.requestConnection(toolkitSlug, `${baseUrl}/connections/callback`);
      syncRemoteRequestIntoStore(this.store, request);
      return request;
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  async getRequest(requestId: string): Promise<ConnectionRequestView | null> {
    try {
      const request = await this.bridgeClient.getRequest(requestId);
      syncRemoteRequestIntoStore(this.store, request);
      return request;
    } catch {
      const cached = this.store.getRequest(requestId);
      return cached ? toRequestView(cached) : null;
    }
  }

  getRequestRedirectUrl(requestId: string): string | null {
    return this.store.getRequest(requestId)?.redirectUrl ?? null;
  }

  private assertConfigured(): void {
    if (this.bridgeClient.configured) return;
    throw new HttpError(503, 'Managed backend URL is not configured.');
  }
}

function mapRemoteBridgeError(error: unknown): HttpError {
  if (error instanceof RemoteBridgeHttpError) {
    return new HttpError(error.status, error.message);
  }
  return new HttpError(500, error instanceof Error ? error.message : String(error));
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
  const existingById = new Map(store.listConnections().map((item) => [item.connectedAccountId, item]));
  const records = connections.map((connection) => {
    const existing = existingById.get(connection.connectedAccountId);
    return {
      connectedAccountId: connection.connectedAccountId,
      toolkitSlug: connection.toolkitSlug,
      toolkitName: connection.toolkitName,
      logoUrl: connection.logoUrl,
      status: connection.status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } satisfies ConnectionRecord;
  });
  store.replaceConnections(records);
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

function mergeConnectionViews(remote: ConnectionView[], local: ConnectionView[]): ConnectionView[] {
  const merged = new Map<string, ConnectionView>();

  for (const connection of local) {
    merged.set(connection.connectedAccountId, connection);
  }

  for (const connection of remote) {
    merged.set(connection.connectedAccountId, { ...connection });
  }

  return Array.from(merged.values()).sort((left, right) => left.toolkitName.localeCompare(right.toolkitName));
}

function mergeToolkitViewsWithStoredConnections(
  remote: RemoteBridgeToolkitView[],
  localConnections: ConnectionView[],
  query?: string,
): ToolkitView[] {
  const merged = new Map(remote.map((toolkit) => [toolkit.slug, { ...toolkit }]));

  for (const connection of localConnections) {
    const existing = merged.get(connection.toolkitSlug);
    if (existing) {
      merged.set(connection.toolkitSlug, {
        ...existing,
        connected: connection.status === 'active',
        connectedAccountId: connection.connectedAccountId,
        logoUrl: existing.logoUrl ?? connection.logoUrl,
      });
      continue;
    }

    if (query && !matchesStoredConnectionQuery(connection, normalizeSearchQuery(query))) {
      continue;
    }

    merged.set(connection.toolkitSlug, {
      slug: connection.toolkitSlug,
      name: connection.toolkitName,
      description: null,
      logoUrl: connection.logoUrl,
      categories: [],
      authSchemes: [],
      composioManagedAuthSchemes: [],
      connected: connection.status === 'active',
      connectedAccountId: connection.connectedAccountId,
      noAuth: false,
    });
  }

  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function matchesStoredConnectionQuery(connection: ConnectionView, normalizedQuery: string): boolean {
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const haystacks = [
    connection.toolkitSlug.toLowerCase(),
    connection.toolkitSlug.toLowerCase().replace(/[_-]+/g, ''),
    connection.toolkitName.toLowerCase(),
  ];
  return haystacks.some((value) => value.includes(normalizedQuery) || value.includes(compactQuery));
}
