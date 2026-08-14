import { json, route, type Route } from './router.ts';
import { HermesSupervisor } from './hermes-supervisor.ts';
import { HermesCronsClient, type HermesCronJob } from './hermes-crons-client.ts';
import type { BrowserConnection, BrowserConnectionsStore } from './browser-connections-store.ts';
import { BrowserSessionBusyError, type BrowserSessionManager } from './browser-sessions.ts';
import type { BrowserRuntime } from './browser-runtime.ts';

// Routine prompts reference their website connection with this token. It is
// the (deliberately derivable) cron↔connection relation: scanning prompts
// can never drift from what the routines actually use, and there is no
// linking step the model can forget.
export function connectionToken(connectionId: string): string {
  return `browser-connection:${connectionId}`;
}

type SetupPhase =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'launching' }
  | { kind: 'waiting_login' }
  | { kind: 'error'; message: string };

interface SetupState {
  phase: SetupPhase;
  leaseId: string | null;
}

/** What a completed connection looks like to the chat UI and detail page. */
function connectionView(connection: BrowserConnection, store: BrowserConnectionsStore) {
  return {
    id: connection.id,
    name: connection.name,
    domain: connection.domain,
    startUrl: connection.startUrl,
    title: connection.title,
    status: connection.status,
    lastLease: store.lastLease(connection.id),
  };
}

// Common multi-part public suffixes; enough that `login.example.co.uk` maps
// to `example.co.uk` rather than `co.uk`. Not the full PSL — for exotic
// suffixes we fall back to the last two labels, which errs broader (still
// scoped to the connected site's registrar domain, never to everything).
const MULTIPART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'com.br', 'com.mx', 'com.ar', 'com.co', 'com.pe',
  'co.in', 'co.za', 'co.kr', 'com.sg', 'com.hk', 'com.tw', 'com.cn', 'com.my',
]);

/** eTLD+1-ish capture: sign-in flows regularly hop subdomains
 * (app.example.com → auth.example.com), so the stored domain must be the
 * registrable domain, not the exact host the setup window landed on. */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase();
  // IP literals and single-label hosts (localhost) have no registrable parent.
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTIPART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

function registrableHost(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return registrableDomain(url.hostname);
  } catch {
    return null;
  }
}

export function buildBrowserRoutes(
  hermes: HermesSupervisor,
  store: BrowserConnectionsStore,
  sessions: BrowserSessionManager,
  runtime: BrowserRuntime,
  profilesRoot: string,
): Route[] {
  const setupStates = new Map<string, SetupState>();

  const setupState = (id: string): SetupState => {
    let state = setupStates.get(id);
    if (!state) {
      state = { phase: { kind: 'idle' }, leaseId: null };
      setupStates.set(id, state);
    }
    // A waiting_login state is only meaningful while its lease is still the
    // active session. If the setup window expired (lease cap) or Chromium
    // died, surface that instead of leaving the card stuck on "waiting".
    if (state.phase.kind === 'waiting_login'
      && state.leaseId !== null
      && sessions.activeLease()?.leaseId !== state.leaseId) {
      state.phase = { kind: 'error', message: 'The setup window closed or timed out. Open it again to continue.' };
      state.leaseId = null;
    }
    return state;
  };

  const cronsClient = async (): Promise<HermesCronsClient> => {
    const config = await hermes.ensureReady();
    return new HermesCronsClient(config.baseUrl, config.apiKey ?? undefined);
  };

  const jobsForConnection = async (connectionId: string): Promise<HermesCronJob[]> => {
    const client = await cronsClient();
    const jobs = await client.list();
    const token = connectionToken(connectionId);
    return jobs.filter((job) => typeof job.prompt === 'string' && job.prompt.includes(token));
  };

  const pauseJobsForConnection = async (connectionId: string): Promise<string[]> => {
    const client = await cronsClient();
    const jobs = await jobsForConnection(connectionId);
    const paused: string[] = [];
    for (const job of jobs) {
      if (job.state === 'paused' || !job.enabled) continue;
      try {
        await client.pause(job.id);
        paused.push(job.id);
      } catch (error) {
        console.warn(`[browser] failed to pause job ${job.id}:`, error instanceof Error ? error.message : String(error));
      }
    }
    // Remember exactly what we paused: reconnect must not resume routines
    // the user had paused on purpose before the sign-in expired.
    store.setPausedJobs(connectionId, [...new Set([...store.pausedJobs(connectionId), ...paused])]);
    return paused;
  };

  const resumeJobsForConnection = async (connectionId: string): Promise<string[]> => {
    const client = await cronsClient();
    const ourPauses = new Set(store.pausedJobs(connectionId));
    if (ourPauses.size === 0) return [];
    const jobs = await jobsForConnection(connectionId);
    const resumed: string[] = [];
    for (const job of jobs) {
      if (job.state !== 'paused' || !ourPauses.has(job.id)) continue;
      try {
        await client.resume(job.id);
        resumed.push(job.id);
      } catch (error) {
        console.warn(`[browser] failed to resume job ${job.id}:`, error instanceof Error ? error.message : String(error));
      }
    }
    store.setPausedJobs(connectionId, []);
    return resumed;
  };

  const beginSetup = async (connection: BrowserConnection): Promise<void> => {
    const state = setupState(connection.id);
    try {
      if (!runtime.isReady()) {
        state.phase = { kind: 'installing' };
        await runtime.ensureInstalled();
      }
      state.phase = { kind: 'launching' };
      const lease = await sessions.start(connection, 'setup');
      state.leaseId = lease.leaseId;
      state.phase = { kind: 'waiting_login' };
    } catch (error) {
      const message = error instanceof BrowserSessionBusyError
        ? 'Another browser session is active. Try again when it finishes.'
        : error instanceof Error ? error.message : String(error);
      state.phase = { kind: 'error', message };
      state.leaseId = null;
    }
  };

  return [
    // ——— Agent-facing (via the verso MCP bridge) ———

    route('POST', '/browser/connections/request', async (_req, res, _params, body) => {
      const name = typeof (body as { name?: unknown })?.name === 'string'
        ? ((body as { name: string }).name.trim() || 'Website')
        : 'Website';
      const connection = store.create(name, profilesRoot);
      json(res, 200, { ok: true, connection: connectionView(connection, store) });
    }),

    route('POST', '/browser/session/start', async (_req, res, _params, body) => {
      const connectionId = String((body as { connection_id?: unknown })?.connection_id ?? '').trim();
      const connection = connectionId ? store.get(connectionId) : null;
      if (!connection) {
        json(res, 404, { ok: false, error: 'unknown_connection', message: `No browser connection ${connectionId}` });
        return;
      }
      if (connection.status !== 'connected') {
        json(res, 409, {
          ok: false,
          error: 'connection_not_ready',
          status: connection.status,
          message: connection.status === 'needs_login'
            ? 'This website connection needs the user to sign in again. Stop and report that the routine is paused until they reconnect.'
            : 'This website connection has not completed setup yet.',
        });
        return;
      }
      try {
        const lease = await sessions.start(connection, 'run');
        json(res, 200, {
          ok: true,
          lease_id: lease.leaseId,
          domain: connection.domain,
          start_url: connection.startUrl,
          expires_at: lease.expiresAt,
          message: 'Browser is running with the saved sign-in. Use the browser_* tools now; they are connected to it. '
            + 'When finished (or blocked), call browser_session_stop with this lease_id.',
        });
      } catch (error) {
        if (error instanceof BrowserSessionBusyError) {
          json(res, 409, {
            ok: false,
            error: 'browser_busy',
            message: 'Another browser session is running. Report that this run was skipped; the next scheduled run will retry.',
          });
          return;
        }
        const failId = 'launch-failed-' + Date.now().toString(16);
        store.logLeaseStart(failId, connection.id, 'run');
        store.logLeaseEnd(failId, 'launch_failed', error instanceof Error ? error.message : String(error));
        json(res, 500, {
          ok: false,
          error: 'launch_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),

    route('POST', '/browser/session/stop', async (_req, res, _params, body) => {
      const payload = (body ?? {}) as { lease_id?: unknown; outcome?: unknown; summary?: unknown };
      const leaseId = String(payload.lease_id ?? '').trim();
      const outcome = String(payload.outcome ?? 'done');
      const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 2000) : null;
      const lease = sessions.activeLease();
      if (!lease || lease.leaseId !== leaseId) {
        json(res, 404, { ok: false, error: 'unknown_lease', message: 'No active browser session with that lease id.' });
        return;
      }
      const normalized = outcome === 'needs_login' || outcome === 'error' ? outcome : 'done';
      await sessions.end(leaseId, normalized, summary);
      if (normalized === 'needs_login') {
        store.setStatus(lease.connectionId, 'needs_login');
        const paused = await pauseJobsForConnection(lease.connectionId).catch(() => [] as string[]);
        json(res, 200, {
          ok: true,
          paused_jobs: paused,
          message: 'Session closed. The routine is paused until the user signs in again from the routine page.',
        });
        return;
      }
      json(res, 200, { ok: true, message: 'Session closed.' });
    }),

    // ——— UI-facing ———

    route('GET', '/browser/connections/:id', async (_req, res, params) => {
      const connection = store.get(params.id);
      if (!connection) {
        json(res, 404, { ok: false, error: 'unknown_connection' });
        return;
      }
      json(res, 200, { ok: true, connection: connectionView(connection, store) });
    }),

    route('POST', '/browser/setup/:id/start', async (_req, res, params) => {
      const connection = store.get(params.id);
      if (!connection) {
        json(res, 404, { ok: false, error: 'unknown_connection' });
        return;
      }
      const state = setupState(connection.id);
      if (state.phase.kind === 'installing' || state.phase.kind === 'launching') {
        json(res, 200, { ok: true, phase: state.phase });
        return;
      }
      if (state.phase.kind === 'waiting_login') {
        json(res, 200, { ok: true, phase: state.phase });
        return;
      }
      state.phase = runtime.isReady() ? { kind: 'launching' } : { kind: 'installing' };
      void beginSetup(connection);
      json(res, 200, { ok: true, phase: state.phase });
    }),

    route('GET', '/browser/setup/:id/state', async (_req, res, params) => {
      const connection = store.get(params.id);
      if (!connection) {
        json(res, 404, { ok: false, error: 'unknown_connection' });
        return;
      }
      const state = setupState(connection.id);
      const page = state.phase.kind === 'waiting_login' ? await sessions.currentPage() : null;
      json(res, 200, {
        ok: true,
        phase: state.phase,
        currentUrl: page?.url ?? null,
        currentTitle: page?.title ?? null,
        connection: connectionView(connection, store),
      });
    }),

    route('POST', '/browser/setup/:id/complete', async (_req, res, params) => {
      const connection = store.get(params.id);
      if (!connection) {
        json(res, 404, { ok: false, error: 'unknown_connection' });
        return;
      }
      const state = setupState(connection.id);
      if (state.phase.kind !== 'waiting_login' || !state.leaseId) {
        json(res, 409, { ok: false, error: 'not_waiting', message: 'No setup window is open for this connection.' });
        return;
      }
      const page = await sessions.currentPage();
      const host = page ? registrableHost(page.url) : null;
      if (!page || !host) {
        json(res, 422, {
          ok: false,
          error: 'no_capturable_page',
          message: 'Could not read the current page. Make sure the site is open in the setup window, then try again.',
        });
        return;
      }
      const wasReconnect = connection.status === 'needs_login';
      store.complete(connection.id, {
        domain: host,
        startUrl: page.url,
        title: page.title || null,
        name: page.title || host,
      });
      await sessions.end(state.leaseId, 'done', 'Setup window closed after capture.');
      setupStates.delete(connection.id);
      const resumed = wasReconnect ? await resumeJobsForConnection(connection.id).catch(() => [] as string[]) : [];
      const updated = store.get(connection.id);
      json(res, 200, {
        ok: true,
        connection: updated ? connectionView(updated, store) : null,
        resumed_jobs: resumed,
      });
    }),

    route('POST', '/browser/setup/:id/cancel', async (_req, res, params) => {
      const connection = store.get(params.id);
      if (!connection) {
        json(res, 404, { ok: false, error: 'unknown_connection' });
        return;
      }
      const state = setupState(connection.id);
      if (state.leaseId) {
        await sessions.end(state.leaseId, 'done', 'Setup cancelled by the user.').catch(() => {});
      }
      setupStates.delete(connection.id);
      json(res, 200, { ok: true });
    }),
  ];
}
