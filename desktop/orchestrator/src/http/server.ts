import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { buildChatDiagnostics, buildChatRoutes } from './chat.ts';
import { ChatStore } from './chat-store.ts';
import { buildComposioBridgeRoutes } from './composio-bridge.ts';
import { buildConnectionsRoutes } from './connections.ts';
import { HermesSupervisor } from './hermes-supervisor.ts';
import { dispatch, json, route, type Route } from './router.ts';
import { buildSkillsRoutes, setSkillsDir } from './skills.ts';
import { HermesSkillsConfig } from './skills-store.ts';
import { PinnedSkillsStore } from './pinned-skills-store.ts';
import { buildCronsRoutes } from './crons.ts';
import { CronDescriptionsStore } from './cron-descriptions-store.ts';
import { ComposioBridgeService } from '../integrations/composio-bridge.ts';
import { ConnectionsService } from '../integrations/composio.ts';
import { ManagedBackendClient } from '../integrations/managed-backend-client.ts';
import { readRuntimeMode } from '../integrations/runtime-mode.ts';
import { buildManagedAccountRoutes } from './managed-account.ts';

function buildRoutes(store: ChatStore, hermes: HermesSupervisor, managedBackend: ManagedBackendClient): Route[] {
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
        managed: await managedBackend.getAccount(),
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
  const runtimeMode = readRuntimeMode();
  const managedBackend = new ManagedBackendClient();
  const connections = new ConnectionsService(managedBackend);
  const composioBridge = new ComposioBridgeService(managedBackend);
  const hermes = new HermesSupervisor({ runtimeMode });
  // Point the skills scanner at the same Hermes home Hermes itself uses
  // (profile-aware, e.g. ~/.hermes/profiles/verso/skills). Without this it
  // falls back to the legacy ~/.hermes/skills path and misses any skills
  // that only live under the active profile.
  setSkillsDir(path.join(hermes.hermesHome, 'skills'));
  const skillsConfig = new HermesSkillsConfig();
  const pinnedSkills = new PinnedSkillsStore();
  const cronDescriptions = new CronDescriptionsStore();
  const routes = [
    ...buildRoutes(store, hermes, managedBackend),
    ...buildComposioBridgeRoutes(composioBridge),
    ...buildManagedAccountRoutes(managedBackend),
    ...buildConnectionsRoutes(connections),
    ...buildSkillsRoutes(skillsConfig, pinnedSkills),
    ...buildCronsRoutes(hermes, cronDescriptions),
    ...buildChatRoutes(store, hermes),
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
  installDiagnosticHandlers();

  startServer().then(({ close, port }) => {
    console.log(JSON.stringify({
      port,
      status: 'ready',
      pid: process.pid,
    }));

    const shutdown = (reason: string) => {
      console.error(`[sidecar] ${reason}, shutting down`);
      void close().finally(() => process.exit(0));
    };

    process.on('SIGTERM', () => shutdown('received SIGTERM'));
    process.on('SIGINT', () => shutdown('received SIGINT'));
    process.on('SIGHUP', () => shutdown('received SIGHUP'));
    process.on('beforeExit', (code) => {
      console.error(`[sidecar] beforeExit code=${code} — event loop drained`);
    });
    process.on('exit', (code) => {
      console.error(`[sidecar] exit code=${code}`);
    });

    installParentDeathWatcher(() => shutdown('parent process gone'));
  }).catch((error: unknown) => {
    console.error(JSON.stringify(classifyStartupError(error)));
    process.exit(1);
  });
}

/**
 * macOS has no equivalent of Linux's PR_SET_PDEATHSIG, so we poll the parent
 * pid every couple of seconds. If the parent disappears (verso crashed,
 * was force-quit, or Xcode's Stop button delivered SIGKILL), this process
 * exits cleanly instead of getting re-parented to launchd and spinning
 * forever — which is exactly what was cooking the user's laptop with three
 * orphaned orchestrators pinning CPU cores at 100%.
 */
function installParentDeathWatcher(onParentGone: () => void): void {
  const raw = process.env.VERSO_PARENT_PID;
  const parentPid = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parentPid) || parentPid <= 1) {
    console.error('[sidecar] VERSO_PARENT_PID not set; parent-death detection disabled');
    return;
  }

  console.error(`[sidecar] watching parent pid=${parentPid}`);
  const interval = setInterval(() => {
    try {
      // Signal 0 doesn't actually deliver anything — it just throws ESRCH if
      // no process with that pid exists, or EPERM if we can't signal it (in
      // which case the process is alive, just under a different uid). Either
      // way, only ESRCH means the parent is gone.
      process.kill(parentPid, 0);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        clearInterval(interval);
        console.error(`[sidecar] parent pid=${parentPid} no longer exists, exiting`);
        onParentGone();
      }
      // EPERM/other → parent is alive in another user context; keep watching.
    }
  }, 2_000);
  // Don't keep the event loop alive just for this watcher.
  interval.unref();
}

function installDiagnosticHandlers(): void {
  // Defensive: when our parent (the verso Mac app) dies, the read end of our
  // stdout/stderr pipes closes. Subsequent writes fail with EPIPE. Without an
  // 'error' handler the writable stream's internal retry loop can pin a CPU
  // core indefinitely — exactly the symptom we saw with the orphaned orchestrators
  // running for 19 hours at 100% CPU. The parent-pid watcher should make us
  // exit within a few seconds anyway, but during that window we don't want to
  // burn a core, and these listeners cost nothing.
  process.stdout.on('error', () => { /* swallow EPIPE */ });
  process.stderr.on('error', () => { /* swallow EPIPE */ });


  // We deliberately do NOT call process.exit() in either handler — Node's
  // default for unhandled rejections is to terminate the process, which
  // is what we suspect is causing the silent disappearance of the sidebar.
  // Catching and logging keeps the process alive; the next request will
  // either work or surface a real error.
  process.on('unhandledRejection', (reason, promise) => {
    const message = reason instanceof Error
      ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
      : String(reason);
    console.error(`[sidecar] unhandledRejection ${new Date().toISOString()}\n${message}`);
    // Best-effort: log promise stringification too
    try {
      console.error(`[sidecar] unhandledRejection promise: ${String(promise)}`);
    } catch { /* ignore */ }
  });

  process.on('uncaughtException', (error, origin) => {
    const message = error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error);
    console.error(`[sidecar] uncaughtException origin=${origin} ${new Date().toISOString()}\n${message}`);
  });

  // Cheap heartbeat so a long stderr log shows we were alive, then the
  // last line before death tells us roughly when things went south.
  const heartbeatInterval = 60_000;
  setInterval(() => {
    const memory = process.memoryUsage();
    const rssMb = Math.round(memory.rss / 1024 / 1024);
    const heapMb = Math.round(memory.heapUsed / 1024 / 1024);
    console.error(`[sidecar] heartbeat ${new Date().toISOString()} pid=${process.pid} rss=${rssMb}MB heap=${heapMb}MB`);
  }, heartbeatInterval).unref();
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
