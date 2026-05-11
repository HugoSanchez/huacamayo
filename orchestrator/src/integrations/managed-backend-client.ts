export interface ManagedSessionRecord {
  token: string;
  expiresAt: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  receivedAt: string;
}

export interface ManagedBackendUserView {
  id: string;
  privyUserId: string;
  email: string | null;
  displayName: string | null;
}

export interface ManagedBackendDeviceView {
  id: string;
  label: string;
  platform: string;
  lastSeenAt: string;
}

export interface ManagedBackendEntitlementView {
  id: string;
  mode: string;
  status: string;
  allowedModels: string[];
  monthlyUsdLimit: number | null;
  dailyUsdLimit: number | null;
}

export interface ManagedBackendSessionView {
  id: string;
  issuedAt: string;
  expiresAt: string;
}

export type ManagedAccountState =
  | 'signed_out'
  | 'expired'
  | 'authenticated'
  | 'invalid_session'
  | 'backend_unavailable';

export interface ManagedAccountView {
  backend: {
    configured: boolean;
    baseUrl: string | null;
  };
  session: {
    present: boolean;
    userId: string | null;
    email: string | null;
    displayName: string | null;
    expiresAt: string | null;
    receivedAt: string | null;
    expired: boolean;
  };
  account: {
    state: ManagedAccountState;
    error: string | null;
    user: ManagedBackendUserView | null;
    device: ManagedBackendDeviceView | null;
    session: ManagedBackendSessionView | null;
    entitlements: ManagedBackendEntitlementView[];
  };
}

export interface ManagedRuntimeConfig {
  defaultModel: string;
  allowedModels: string[];
}

export interface ManagedUsageSummary {
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
  };
  mode: string;
  usage: {
    monthToDateUsd: number;
    dayToDateUsd: number;
    monthStart: string;
    dayStart: string;
  };
  limits: {
    monthlyUsdLimit: number | null;
    dailyUsdLimit: number | null;
  };
}

export interface InferenceRequestPayload {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string }>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  localSessionId?: string | null;
}

export interface InferenceStreamResult {
  body: ReadableStream<Uint8Array>;
  inferenceRequestId: string | null;
}

interface ManagedMeResponse {
  user: ManagedBackendUserView;
  device: ManagedBackendDeviceView;
  session: ManagedBackendSessionView;
  entitlements: ManagedBackendEntitlementView[];
}

interface ManagedBackendErrorBody {
  error?: string;
  message?: string;
}

export class ManagedBackendError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ManagedBackendError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The session is held in process memory only. The macOS app pushes it over
 * loopback IPC after sign-in (POST /managed/session) so we never write the
 * bearer token to disk on the orchestrator side. At launch the env vars below
 * carry the session forward across sidecar restarts where the app is still
 * running.
 */
export class ManagedBackendClient {
  private readonly baseUrl: string;

  private currentSession: ManagedSessionRecord | null;

  constructor(
    baseUrl = process.env.VERVO_BACKEND_URL?.trim() || 'http://127.0.0.1:8788',
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.currentSession = readSessionFromEnv();
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  /** Read-only accessor so peer integrations can build their own URLs against the same host. */
  get backendBaseUrl(): string {
    return this.baseUrl;
  }

  setSession(record: ManagedSessionRecord | null): void {
    this.currentSession = record;
  }

  getStoredSession(): ManagedSessionRecord | null {
    return this.currentSession;
  }

  async getAccount(): Promise<ManagedAccountView> {
    const stored = this.currentSession;
    const expired = stored ? isIsoExpired(stored.expiresAt) : false;

    const view: ManagedAccountView = {
      backend: {
        configured: this.configured,
        baseUrl: this.configured ? this.baseUrl : null,
      },
      session: {
        present: Boolean(stored),
        userId: stored?.userId ?? null,
        email: stored?.email ?? null,
        displayName: stored?.displayName ?? null,
        expiresAt: stored?.expiresAt ?? null,
        receivedAt: stored?.receivedAt ?? null,
        expired,
      },
      account: {
        state: 'signed_out',
        error: null,
        user: null,
        device: null,
        session: null,
        entitlements: [],
      },
    };

    if (!stored) {
      return view;
    }

    if (expired) {
      view.account.state = 'expired';
      view.account.error = 'Managed session has expired locally.';
      return view;
    }

    if (!this.configured) {
      view.account.state = 'backend_unavailable';
      view.account.error = 'Managed backend URL is not configured.';
      return view;
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/me`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${stored.token}`,
        },
      });

      if (response.ok) {
        const body = await response.json() as ManagedMeResponse;
        view.account = {
          state: 'authenticated',
          error: null,
          user: body.user,
          device: body.device,
          session: body.session,
          entitlements: Array.isArray(body.entitlements) ? body.entitlements : [],
        };
        view.session.email = body.user.email ?? view.session.email;
        view.session.displayName = body.user.displayName ?? view.session.displayName;
        return view;
      }

      const errorBody = await readErrorBody(response);
      if (response.status === 401 || response.status === 403) {
        view.account.state = errorBody.error === 'expired_session' ? 'expired' : 'invalid_session';
        view.account.error = errorBody.message ?? 'Managed session is not valid.';
        return view;
      }

      view.account.state = 'backend_unavailable';
      view.account.error = errorBody.message ?? `Managed backend returned HTTP ${response.status}.`;
      return view;
    } catch (error) {
      view.account.state = 'backend_unavailable';
      view.account.error = error instanceof Error ? error.message : String(error);
      return view;
    }
  }

  /**
   * Server-side sign-out: marks the current session token revoked on the
   * backend so it can never be reused, even before its natural expiry. Safe
   * to call when no session is loaded (no-op). Best-effort: callers should
   * still clear their local session even if this throws.
   */
  async revokeSession(): Promise<void> {
    if (!this.configured) return;
    const stored = this.currentSession;
    if (!stored) return;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/auth/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${stored.token}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ManagedBackendError(502, 'backend_unreachable', message);
    }

    // 204 (revoked), 401 invalid_session (already gone, treat as success).
    if (response.status === 204 || response.status === 401) return;

    const body = await readErrorBody(response);
    throw new ManagedBackendError(
      response.status,
      body.error ?? 'backend_error',
      body.message ?? `Backend returned HTTP ${response.status}.`,
    );
  }

  /**
   * Auth'd GET /v1/usage/summary on the backend. Surfaces the current user's
   * month-to-date / day-to-date spend, the active mode, and any monthly /
   * daily caps from their entitlement.
   */
  async getUsageSummary(): Promise<ManagedUsageSummary> {
    if (!this.configured) {
      throw new ManagedBackendError(503, 'backend_unconfigured', 'Managed backend URL is not configured.');
    }
    const stored = this.currentSession;
    if (!stored) {
      throw new ManagedBackendError(401, 'missing_session', 'No managed session is loaded.');
    }
    if (isIsoExpired(stored.expiresAt)) {
      throw new ManagedBackendError(401, 'expired_session', 'Managed session has expired locally.');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/usage/summary`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${stored.token}`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ManagedBackendError(502, 'backend_unreachable', message);
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new ManagedBackendError(
        response.status,
        body.error ?? 'backend_error',
        body.message ?? `Backend returned HTTP ${response.status}.`,
      );
    }

    return await response.json() as ManagedUsageSummary;
  }

  /**
   * Fetch the backend's published model allowlist + default model. Unauth — the
   * runtime-config endpoint does not require a session and returns the same
   * shape for everyone.
   */
  async getRuntimeConfig(): Promise<ManagedRuntimeConfig> {
    if (!this.configured) {
      throw new ManagedBackendError(503, 'backend_unconfigured', 'Managed backend URL is not configured.');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/runtime-config`, {
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ManagedBackendError(502, 'backend_unreachable', message);
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new ManagedBackendError(
        response.status,
        body.error ?? 'backend_error',
        body.message ?? `Backend returned HTTP ${response.status}.`,
      );
    }

    const body = await response.json() as Partial<ManagedRuntimeConfig>;
    if (typeof body.defaultModel !== 'string' || !Array.isArray(body.allowedModels)) {
      throw new ManagedBackendError(502, 'malformed_response', 'Backend runtime-config response is malformed.');
    }
    return {
      defaultModel: body.defaultModel,
      allowedModels: body.allowedModels.filter((entry): entry is string => typeof entry === 'string'),
    };
  }

  /**
   * Low-level proxy: POSTs the given body verbatim to /v1/chat/completions
   * with the in-memory bearer token, returns the raw upstream Response so the
   * caller (the local LLM proxy) can pipe both headers and body unchanged.
   * No body parsing, no validation — the backend is the authority on schema.
   */
  async forwardChatCompletion(body: Record<string, unknown>): Promise<Response> {
    if (!this.configured) {
      throw new ManagedBackendError(503, 'backend_unconfigured', 'Managed backend URL is not configured.');
    }
    const stored = this.currentSession;
    if (!stored) {
      throw new ManagedBackendError(401, 'missing_session', 'No managed session is loaded.');
    }
    if (isIsoExpired(stored.expiresAt)) {
      throw new ManagedBackendError(401, 'expired_session', 'Managed session has expired locally.');
    }

    return fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stored.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * POST a managed inference request and return the upstream SSE stream so the
   * caller can pipe bytes downstream without buffering. Uses the in-memory
   * session token; throws if no session is present or it has expired locally.
   */
  async streamInference(payload: InferenceRequestPayload): Promise<InferenceStreamResult> {
    if (!this.configured) {
      throw new ManagedBackendError(503, 'backend_unconfigured', 'Managed backend URL is not configured.');
    }

    const stored = this.currentSession;
    if (!stored) {
      throw new ManagedBackendError(401, 'missing_session', 'No managed session is loaded.');
    }
    if (isIsoExpired(stored.expiresAt)) {
      throw new ManagedBackendError(401, 'expired_session', 'Managed session has expired locally.');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stored.token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ManagedBackendError(502, 'backend_unreachable', message);
    }

    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      throw new ManagedBackendError(
        response.status,
        errorBody.error ?? 'backend_error',
        errorBody.message ?? `Backend returned HTTP ${response.status}.`,
      );
    }

    if (!response.body) {
      throw new ManagedBackendError(502, 'empty_stream', 'Backend inference response had no body.');
    }

    return {
      body: response.body,
      inferenceRequestId: response.headers.get('x-inference-request-id'),
    };
  }
}

function readSessionFromEnv(): ManagedSessionRecord | null {
  const token = process.env.VERVO_MANAGED_SESSION_TOKEN?.trim() || '';
  const expiresAt = process.env.VERVO_MANAGED_SESSION_EXPIRES_AT?.trim() || '';
  const userId = process.env.VERVO_MANAGED_USER_ID?.trim() || '';
  if (!token || !expiresAt || !userId) return null;

  return {
    token,
    expiresAt,
    userId,
    email: null,
    displayName: null,
    receivedAt: new Date().toISOString(),
  };
}

async function readErrorBody(response: Response): Promise<ManagedBackendErrorBody> {
  try {
    return await response.json() as ManagedBackendErrorBody;
  } catch {
    return {
      message: `Backend returned HTTP ${response.status}.`,
    };
  }
}

function isIsoExpired(value: string): boolean {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  return timestamp <= Date.now();
}
