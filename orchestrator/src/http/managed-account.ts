import { json, route, type Route } from './router.ts';
import {
  ManagedBackendClient,
  ManagedBackendError,
  type ManagedRuntimeConfig,
  type ManagedSessionRecord,
  type ManagedUsageSummary,
} from '../integrations/managed-backend-client.ts';
import type { RuntimeMode } from '../integrations/runtime-mode.ts';

export interface ManagedRuntimeView {
  mode: RuntimeMode;
  backend: { configured: boolean; baseUrl: string | null };
  runtimeConfig: ManagedRuntimeConfig | null;
  error: string | null;
}

export function buildManagedAccountRoutes(
  managedBackend: ManagedBackendClient,
  runtimeMode: RuntimeMode,
): Route[] {
  return [
    route('GET', '/managed/account', async (_req, res) => {
      const account = await managedBackend.getAccount();
      json(res, 200, account);
    }),

    route('GET', '/managed/usage', async (_req, res) => {
      try {
        const summary: ManagedUsageSummary = await managedBackend.getUsageSummary();
        json(res, 200, summary);
      } catch (error) {
        if (error instanceof ManagedBackendError) {
          json(res, error.status, { error: error.code, message: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        json(res, 500, { error: 'internal_error', message });
      }
    }),

    route('GET', '/managed/runtime', async (_req, res) => {
      const view: ManagedRuntimeView = {
        mode: runtimeMode,
        backend: {
          configured: managedBackend.configured,
          baseUrl: managedBackend.configured ? (await managedBackend.getAccount()).backend.baseUrl : null,
        },
        runtimeConfig: null,
        error: null,
      };

      if (!managedBackend.configured) {
        view.error = 'Managed backend URL is not configured.';
        json(res, 200, view);
        return;
      }

      try {
        view.runtimeConfig = await managedBackend.getRuntimeConfig();
      } catch (error) {
        view.error = error instanceof ManagedBackendError
          ? `${error.code}: ${error.message}`
          : error instanceof Error ? error.message : String(error);
      }

      json(res, 200, view);
    }),

    route('POST', '/managed/session', async (_req, res, _params, body) => {
      const parsed = parseSessionBody(body);
      if (parsed === 'invalid') {
        json(res, 400, { error: 'bad_request', message: 'Invalid managed session payload.' });
        return;
      }
      managedBackend.setSession(parsed);
      json(res, 200, { ok: true });
    }),

    route('DELETE', '/managed/session', async (_req, res) => {
      // Best-effort server-side revoke before we drop the in-memory token.
      // If the backend is unreachable or rejects, we still clear locally so
      // the user is effectively signed out from the app's perspective.
      try {
        await managedBackend.revokeSession();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[managed] revoke failed during sign-out (clearing local anyway):', message);
      }
      managedBackend.setSession(null);
      json(res, 200, { ok: true });
    }),
  ];
}

function parseSessionBody(body: unknown): ManagedSessionRecord | null | 'invalid' {
  if (body === null || body === undefined) return null;
  if (typeof body !== 'object') return 'invalid';
  const candidate = body as Record<string, unknown>;
  if (candidate.session === null) return null;

  const source = (candidate.session && typeof candidate.session === 'object')
    ? candidate.session as Record<string, unknown>
    : candidate;

  const token = typeof source.token === 'string' ? source.token.trim() : '';
  const expiresAt = typeof source.expiresAt === 'string' ? source.expiresAt.trim() : '';
  const userId = typeof source.userId === 'string' ? source.userId.trim() : '';
  if (!token || !expiresAt || !userId) return 'invalid';

  return {
    token,
    expiresAt,
    userId,
    email: optionalString(source.email),
    displayName: optionalString(source.displayName),
    receivedAt: typeof source.receivedAt === 'string' && source.receivedAt.trim().length > 0
      ? source.receivedAt
      : new Date().toISOString(),
  };
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
