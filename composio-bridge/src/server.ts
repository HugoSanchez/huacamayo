import 'dotenv/config';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { dispatch, json, route, type Route } from './router.ts';
import { BridgeHttpError, ComposioBridgeBackendService } from './service.ts';

function buildRoutes(service: ComposioBridgeBackendService): Route[] {
  return [
    route('GET', '/health', async (_req, res) => {
      json(res, 200, {
        status: 'ok',
        configured: service.configured,
        timestamp: Date.now(),
      });
    }),

    route('POST', '/v1/composio/session', async (req, res, _params, body) => {
      try {
        assertAuthorized(req);
        const userId = getRequiredString(body, 'userId');
        const session = await service.getSession(userId);
        json(res, 200, { session });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),

    route('POST', '/v1/composio/session/reset', async (req, res, _params, body) => {
      try {
        assertAuthorized(req);
        const userId = getRequiredString(body, 'userId');
        service.resetSession(userId);
        json(res, 200, { ok: true });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),

    route('GET', '/v1/connections', async (req, res, params) => {
      try {
        assertAuthorized(req);
        const userId = getRequiredParam(params, 'user_id');
        const connections = await service.listConnections(userId);
        json(res, 200, { connections });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),

    route('GET', '/v1/toolkits', async (req, res, params) => {
      try {
        assertAuthorized(req);
        const userId = getRequiredParam(params, 'user_id');
        const query = getOptionalParam(params, 'query');
        const limit = getOptionalNumberParam(params, 'limit');
        const toolkits = await service.listToolkits(userId, { query, limit });
        json(res, 200, { toolkits });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),

    route('POST', '/v1/connections/request', async (req, res, _params, body) => {
      try {
        assertAuthorized(req);
        const userId = getRequiredString(body, 'userId');
        const toolkit = getRequiredString(body, 'toolkit');
        const callbackUrl = getRequiredString(body, 'callbackUrl');
        const request = await service.requestConnection(userId, toolkit, callbackUrl);
        json(res, 201, { request });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),

    route('GET', '/v1/connections/requests/:id', async (req, res, params) => {
      try {
        assertAuthorized(req);
        const request = await service.getRequest(params.id);
        json(res, 200, { request });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),

    route('POST', '/v1/tools/search', async (req, res, _params, body) => {
      try {
        assertAuthorized(req);
        const userId = getRequiredString(body, 'userId');
        const query = getRequiredString(body, 'query');
        const toolkits = getOptionalStringArray(body, 'toolkits');
        const results = await service.searchTools(userId, query, toolkits);
        json(res, 200, { results });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),

    route('POST', '/v1/tools/schemas', async (req, res, _params, body) => {
      try {
        assertAuthorized(req);
        const userId = getRequiredString(body, 'userId');
        const toolSlugs = getRequiredStringArray(body, 'toolSlugs');
        const tools = await service.getToolSchemas(userId, toolSlugs);
        json(res, 200, { tools });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),

    route('POST', '/v1/tools/execute', async (req, res, _params, body) => {
      try {
        assertAuthorized(req);
        const userId = getRequiredString(body, 'userId');
        const toolSlug = getRequiredString(body, 'toolSlug');
        const arguments_ = getOptionalRecord(body, 'arguments');
        const connectedAccountId = getOptionalString(body, 'connectedAccountId');
        const result = await service.executeTool(userId, toolSlug, arguments_ ?? undefined, connectedAccountId);
        json(res, 200, { result });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),
  ];
}

export async function startServer(opts: { port?: number } = {}): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  const service = new ComposioBridgeBackendService();
  const routes = buildRoutes(service);

  const server = http.createServer((req, res) => {
    dispatch(routes, req, res);
  });

  const port = opts.port ?? parseInt(process.env.PORT || '0', 10);
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, port: address.port, close });
    });
  });
}

function assertAuthorized(req: IncomingMessage): void {
  const expected = process.env.VERVO_COMPOSIO_BRIDGE_TOKEN?.trim() || '';
  if (!expected) return;

  const fromHeader = req.headers['x-vervo-bridge-token'];
  const token = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  if (token === expected) return;

  throw new BridgeHttpError(401, 'Unauthorized bridge request');
}

function getRequiredString(body: unknown, key: string): string {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeHttpError(400, `Missing "${key}"`);
  }
  return value.trim();
}

function getOptionalString(body: unknown, key: string): string | undefined {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getRequiredParam(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (!value || value.trim().length === 0) {
    throw new BridgeHttpError(400, `Missing "${key}"`);
  }
  return value.trim();
}

function getOptionalParam(params: Record<string, string>, key: string): string | undefined {
  const value = params[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function getOptionalNumberParam(params: Record<string, string>, key: string): number | undefined {
  const value = getOptionalParam(params, key);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new BridgeHttpError(400, `Invalid "${key}"`);
  }
  return parsed;
}

function getRequiredStringArray(body: unknown, key: string): string[] {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new BridgeHttpError(400, `Missing "${key}"`);
  }
  return value.map((item) => (item as string).trim());
}

function getOptionalStringArray(body: unknown, key: string): string[] | undefined {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BridgeHttpError(400, `Invalid "${key}"`);
  }
  return value.map((item) => (item as string).trim()).filter(Boolean);
}

function getOptionalRecord(body: unknown, key: string): Record<string, unknown> | null {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeHttpError(400, `Invalid "${key}"`);
  }
  return value as Record<string, unknown>;
}

function handleError(res: ServerResponse, error: unknown): void {
  if (error instanceof BridgeHttpError) {
    json(res, error.status, { error: 'request_failed', message: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { error: 'internal_error', message });
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/server.ts') ||
  process.argv[1].endsWith('/server.js')
);

if (isMain) {
  // Match the orchestrator: swallow EPIPE so a closed parent pipe can't pin
  // a CPU on stdio retries.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  startServer().then(({ close, port }) => {
    console.log(JSON.stringify({ port, status: 'ready', pid: process.pid }));

    const shutdown = (reason: string) => {
      console.error(`[composio-bridge] ${reason}, shutting down`);
      void close().finally(() => process.exit(0));
    };

    process.on('SIGINT', () => shutdown('received SIGINT'));
    process.on('SIGTERM', () => shutdown('received SIGTERM'));
    process.on('SIGHUP', () => shutdown('received SIGHUP'));

    // Match the orchestrator's parent-death watcher so this process can never
    // outlive the orchestrator and re-parent to launchd as an orphan.
    const raw = process.env.VERVO_PARENT_PID;
    const parentPid = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(parentPid) && parentPid > 1) {
      const interval = setInterval(() => {
        try {
          process.kill(parentPid, 0);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') {
            clearInterval(interval);
            shutdown(`parent pid=${parentPid} no longer exists`);
          }
        }
      }, 2_000);
      interval.unref();
    }
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      status: 'error',
      code: 'startup_failed',
      message,
      recoverable: false,
    }));
    process.exit(1);
  });
}
