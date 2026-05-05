export interface RemoteBridgeSessionView {
  userId: string;
  sessionId: string;
  mcp: {
    url: string;
    headers: Record<string, string>;
  };
}

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

export class RemoteComposioBridgeClient {
  private readonly baseUrl: string;

  private readonly token: string | null;

  constructor(
    baseUrl = process.env.VERVO_COMPOSIO_BRIDGE_URL?.trim() || '',
    token = process.env.VERVO_COMPOSIO_BRIDGE_TOKEN?.trim() || '',
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token || null;
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  async getSession(userId: string): Promise<RemoteBridgeSessionView> {
    const body = await this.request<{ session: RemoteBridgeSessionView }>('POST', '/v1/composio/session', { userId });
    return body.session;
  }

  async resetSession(userId: string): Promise<void> {
    await this.request('POST', '/v1/composio/session/reset', { userId });
  }

  async listConnections(userId: string): Promise<RemoteBridgeConnectionView[]> {
    const body = await this.request<{ connections: RemoteBridgeConnectionView[] }>(
      'GET',
      `/v1/connections?user_id=${encodeURIComponent(userId)}`,
    );
    return body.connections;
  }

  async listToolkits(userId: string, query?: string, limit?: number): Promise<RemoteBridgeToolkitView[]> {
    const params = new URLSearchParams({ user_id: userId });
    if (query && query.trim().length > 0) params.set('query', query.trim());
    if (typeof limit === 'number' && Number.isFinite(limit)) params.set('limit', String(Math.floor(limit)));
    const body = await this.request<{ toolkits: RemoteBridgeToolkitView[] }>(
      'GET',
      `/v1/toolkits?${params.toString()}`,
    );
    return body.toolkits;
  }

  async requestConnection(
    userId: string,
    toolkit: string,
    callbackUrl: string,
  ): Promise<RemoteBridgeConnectionRequestView> {
    const body = await this.request<{ request: RemoteBridgeConnectionRequestView }>(
      'POST',
      '/v1/connections/request',
      { userId, toolkit, callbackUrl },
    );
    return body.request;
  }

  async getRequest(requestId: string): Promise<RemoteBridgeConnectionRequestView> {
    const body = await this.request<{ request: RemoteBridgeConnectionRequestView }>(
      'GET',
      `/v1/connections/requests/${encodeURIComponent(requestId)}`,
    );
    return body.request;
  }

  async searchTools(userId: string, query: string, toolkits?: string[]): Promise<RemoteBridgeSearchToolResult[]> {
    const body = await this.request<{ results: RemoteBridgeSearchToolResult[] }>(
      'POST',
      '/v1/tools/search',
      { userId, query, ...(toolkits && toolkits.length > 0 ? { toolkits } : {}) },
    );
    return body.results;
  }

  async getToolSchemas(userId: string, toolSlugs: string[]): Promise<RemoteBridgeToolSchemaView[]> {
    const body = await this.request<{ tools: RemoteBridgeToolSchemaView[] }>(
      'POST',
      '/v1/tools/schemas',
      { userId, toolSlugs },
    );
    return body.tools;
  }

  async executeTool(
    userId: string,
    toolSlug: string,
    arguments_: Record<string, unknown> | undefined,
  ): Promise<RemoteBridgeToolExecutionView> {
    const body = await this.request<{ result: RemoteBridgeToolExecutionView }>(
      'POST',
      '/v1/tools/execute',
      { userId, toolSlug, arguments: arguments_ ?? {} },
    );
    return body.result;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured) {
      throw new RemoteBridgeHttpError(503, 'Remote Composio bridge is not configured.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (this.token) {
      headers['X-Vervo-Bridge-Token'] = this.token;
    }

    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload,
    });

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
