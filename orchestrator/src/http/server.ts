import 'dotenv/config';
import http from 'node:http';
import { buildChatDiagnostics, buildChatRoutes } from './chat.ts';
import { ChatStore } from './chat-store.ts';
import { buildComposioBridgeRoutes } from './composio-bridge.ts';
import { buildConnectionsRoutes } from './connections.ts';
import { HermesSupervisor } from './hermes-supervisor.ts';
import { dispatch, json, route, type Route } from './router.ts';
import { buildSkillsRoutes } from './skills.ts';
import { SkillsStore } from './skills-store.ts';
import { ComposioBridgeService } from '../integrations/composio-bridge.ts';
import { ConnectionsService } from '../integrations/composio.ts';

function buildRoutes(store: ChatStore, hermes: HermesSupervisor): Route[] {
  return [
    route('GET', '/health', async (_req, res) => {
      json(res, 200, { status: 'ok', timestamp: Date.now() });
    }),

    route('GET', '/diagnostics', async (_req, res) => {
      json(res, 200, {
        status: 'ok',
        timestamp: Date.now(),
        runtime: {
          pid: process.pid,
          cwd: process.cwd(),
          node: process.version,
        },
        chat: buildChatDiagnostics(store),
        hermes: await hermes.getStatus(500),
      });
    }),
  ];
}

export async function startServer(opts: { port?: number } = {}): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  const store = new ChatStore();
  const hermes = new HermesSupervisor();
  const connections = new ConnectionsService();
  const composioBridge = new ComposioBridgeService();
  const skills = new SkillsStore();
  const routes = [
    ...buildRoutes(store, hermes),
    ...buildComposioBridgeRoutes(composioBridge),
    ...buildConnectionsRoutes(connections),
    ...buildSkillsRoutes(skills),
    ...buildChatRoutes(store, hermes, connections, skills),
  ];

  const server = http.createServer((req, res) => {
    dispatch(routes, req, res);
  });
  server.on('close', () => {
    void hermes.shutdown();
  });

  const port = opts.port ?? parseInt(process.env.PORT || '0', 10);
  const close = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await hermes.shutdown();
  };

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', async () => {
      const addr = server.address() as { port: number };
      hermes.setOrchestratorBaseUrl(`http://127.0.0.1:${addr.port}`);
      if (composioBridge.configured) {
        void composioBridge.getDefaultSession().catch((error) => {
          console.warn('[composio] failed to initialize bridge session:', error);
        });
      }
      hermes.prepare();
      resolve({ server, port: addr.port, close });
    });
  });
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/server.ts') ||
  process.argv[1].endsWith('/server.js')
);

if (isMain) {
  startServer().then(({ close, port }) => {
    console.log(JSON.stringify({
      port,
      status: 'ready',
      pid: process.pid,
    }));

    const shutdown = () => {
      void close().finally(() => process.exit(0));
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }).catch((error: unknown) => {
    console.error(JSON.stringify(classifyStartupError(error)));
    process.exit(1);
  });
}

function classifyStartupError(error: unknown): {
  status: 'error';
  code: 'startup_failed' | 'unknown';
  message: string;
  recoverable: boolean;
  details?: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes('eaddrinuse') || normalized.includes('address already in use')) {
    return {
      status: 'error',
      code: 'startup_failed',
      message: 'Sidecar port is already in use.',
      recoverable: false,
      details: message,
    };
  }

  return {
    status: 'error',
    code: 'unknown',
    message: 'Sidecar failed to start.',
    recoverable: false,
    details: message,
  };
}
