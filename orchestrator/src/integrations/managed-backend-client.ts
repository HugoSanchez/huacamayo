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
      message: `Managed backend returned HTTP ${response.status}.`,
    };
  }
}

function isIsoExpired(value: string): boolean {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  return timestamp <= Date.now();
}
