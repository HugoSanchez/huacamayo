import { ManagedBackendClient } from './managed-backend-client.ts';

export interface RemoteBridgeConnectionRequestView {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: 'pending' | 'connected' | 'failed' | 'expired';
  redirectUrl: string | null;
  connectedAccountId: string | null;
  errorMessage: string | null;
}

export interface RemoteBridgeConnectionView {
  connectedAccountId: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: 'active' | 'inactive';
}

export interface RemoteBridgeToolkitView {
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

export interface RemoteBridgeSearchToolResult {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string | null;
  toolkitName: string | null;
}

export interface RemoteBridgeToolSchemaView {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string | null;
  toolkitName: string | null;
  inputParameters: Record<string, unknown> | null;
}

export interface RemoteBridgeToolExecutionView {
  data: unknown;
  error: string | null;
  logId: string | null;
}

export class RemoteBridgeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RemoteBridgeHttpError';
    this.status = status;
  }
}

/**
 * Composio proxy client that talks to the managed backend's /v1/composio/*
 * surface. Auth uses the user's in-memory managed session token.
 *
 * Tool discovery, schema lookup, and execution are proxied through the managed
 * backend so the Composio project API key never lives in the desktop app.
 */
export class RemoteComposioBridgeClient {
  private readonly managedBackend: ManagedBackendClient;
  private readonly baseUrl: string;

  constructor(managedBackend: ManagedBackendClient) {
    this.managedBackend = managedBackend;
    this.baseUrl = managedBackend.backendBaseUrl;
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  async listConnections(): Promise<RemoteBridgeConnectionView[]> {
    const body = await this.request<{ connections: RemoteBridgeConnectionView[] }>('GET', '/v1/composio/connections');
    return body.connections;
  }

  async listToolkits(query?: string, limit?: number): Promise<RemoteBridgeToolkitView[]> {
    const params = new URLSearchParams();
    if (query && query.trim().length > 0) params.set('query', query.trim());
    if (typeof limit === 'number' && Number.isFinite(limit)) params.set('limit', String(Math.floor(limit)));
    const suffix = params.toString();
    const path = suffix ? `/v1/composio/toolkits?${suffix}` : '/v1/composio/toolkits';
    const body = await this.request<{ toolkits: RemoteBridgeToolkitView[] }>('GET', path);
    return body.toolkits;
  }

  async requestConnection(
    toolkit: string,
    callbackUrl: string,
  ): Promise<RemoteBridgeConnectionRequestView> {
    const body = await this.request<{ request: RemoteBridgeConnectionRequestView }>(
      'POST',
      '/v1/composio/connections/request',
      { toolkit, callbackUrl },
    );
    return body.request;
  }

  async getRequest(requestId: string): Promise<RemoteBridgeConnectionRequestView> {
    const body = await this.request<{ request: RemoteBridgeConnectionRequestView }>(
      'GET',
      `/v1/composio/connections/requests/${encodeURIComponent(requestId)}`,
    );
    return body.request;
  }

  async searchTools(
    query: string,
    toolkits?: string[],
  ): Promise<RemoteBridgeSearchToolResult[]> {
    const body = await this.request<{ results: RemoteBridgeSearchToolResult[] }>(
      'POST',
      '/v1/composio/tools/search',
      { query, ...(toolkits && toolkits.length > 0 ? { toolkits } : {}) },
    );
    return body.results;
  }

  async getToolSchemas(
    toolSlugs: string[],
  ): Promise<RemoteBridgeToolSchemaView[]> {
    const body = await this.request<{ tools: RemoteBridgeToolSchemaView[] }>(
      'POST',
      '/v1/composio/tools/schemas',
      { toolSlugs },
    );
    return body.tools;
  }

  async executeTool(
    toolSlug: string,
    arguments_: Record<string, unknown>,
  ): Promise<RemoteBridgeToolExecutionView> {
    const body = await this.request<{ result: RemoteBridgeToolExecutionView }>(
      'POST',
      '/v1/composio/tools/execute',
      {
        toolSlug,
        arguments: arguments_,
      },
    );
    return body.result;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured) {
      throw new RemoteBridgeHttpError(503, 'Managed backend URL is not configured.');
    }

    const session = this.managedBackend.getStoredSession();
    if (!session) {
      throw new RemoteBridgeHttpError(401, 'No managed session is loaded — sign in to use Composio.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
    };

    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { method, headers, body: payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RemoteBridgeHttpError(502, `Backend Composio request failed: ${message}`);
    }

    if (!response.ok) {
      const message = await readError(response, `${method} ${path} failed`);
      throw new RemoteBridgeHttpError(response.status, message);
    }

    return response.json() as Promise<T>;
  }
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown };
    return typeof body.message === 'string' && body.message.trim().length > 0
      ? body.message
      : fallback;
  } catch {
    return fallback;
  }
}
