import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserConnection, BrowserConnectionsStore, BrowserLeaseOutcome } from './browser-connections-store.ts';

export interface BrowserSessionLease {
  leaseId: string;
  connectionId: string;
  mode: 'setup' | 'run';
  headed: boolean;
  cdpUrl: string;
  startedAt: number;
  expiresAt: number;
}

export interface BrowserSessionManagerOptions {
  /** Resolve the Chromium executable to launch. Null when not installed yet. */
  resolveChromium: () => string | null;
  /** Called with the CDP URL when a session starts and null when it ends —
   * wired to the supervisor's live `browser.cdp_url` config write. */
  onCdpChange: (cdpUrl: string | null) => void;
  /** Path of the per-lease domain-allowlist file the Hermes domain-guard
   * patch reads (inside the managed Hermes home). */
  guardFilePath: string;
  port?: number;
  /** Hard cap on a run lease; the orchestrator kills the browser at expiry
   * regardless of what the agent does. Setup leases wait on the user, so they
   * get a longer leash. */
  runTtlMs?: number;
  setupTtlMs?: number;
}

const DEFAULT_PORT = 9223;
const DEFAULT_RUN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SETUP_TTL_MS = 30 * 60 * 1000;
const CDP_READY_TIMEOUT_MS = 20_000;
const SIGKILL_GRACE_MS = 3_000;

export class BrowserSessionBusyError extends Error {
  constructor(public readonly active: BrowserSessionLease) {
    super(`A browser session is already active for connection ${active.connectionId}`);
  }
}

/**
 * Owns the lifecycle of the one Chromium instance Verso drives for browser
 * automation. One lease at a time: routines serialize, and teardown is this
 * manager's job — the agent-facing stop call is the polite path, lease expiry
 * is the guarantee.
 */
export class BrowserSessionManager {
  private active: { lease: BrowserSessionLease; child: ChildProcess; expiryTimer: NodeJS.Timeout } | null = null;

  constructor(
    private readonly store: BrowserConnectionsStore,
    private readonly options: BrowserSessionManagerOptions,
  ) {}

  get port(): number {
    return this.options.port ?? DEFAULT_PORT;
  }

  activeLease(): BrowserSessionLease | null {
    return this.active?.lease ?? null;
  }

  async start(connection: BrowserConnection, mode: 'setup' | 'run'): Promise<BrowserSessionLease> {
    if (this.active) throw new BrowserSessionBusyError(this.active.lease);

    const chromium = this.options.resolveChromium();
    if (!chromium) throw new Error('Chromium is not installed — run browser setup first');

    await this.assertPortFree();

    mkdirSync(connection.profileDir, { recursive: true });
    const headed = mode === 'setup';
    const args = [
      `--user-data-dir=${connection.profileDir}`,
      `--remote-debugging-port=${this.port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      ...(headed ? [] : ['--headless=new']),
      ...(connection.startUrl && !headed ? [connection.startUrl] : []),
      ...(headed ? [connection.startUrl ?? 'about:blank'] : []),
    ];

    const child = spawn(chromium, args, { stdio: 'ignore' });
    const spawnError = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(new Error(`Chromium failed to start: ${err.message}`)));
    });

    try {
      await Promise.race([this.waitForCdp(), spawnError]);
    } catch (error) {
      this.killChild(child);
      throw error;
    }

    const ttl = mode === 'run'
      ? this.options.runTtlMs ?? DEFAULT_RUN_TTL_MS
      : this.options.setupTtlMs ?? DEFAULT_SETUP_TTL_MS;
    const lease: BrowserSessionLease = {
      leaseId: randomBytes(8).toString('hex'),
      connectionId: connection.id,
      mode,
      headed,
      cdpUrl: `http://127.0.0.1:${this.port}`,
      startedAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };
    const expiryTimer = setTimeout(() => {
      void this.end(lease.leaseId, 'expired', 'Session hit its time cap and was closed by Verso.');
    }, ttl);
    expiryTimer.unref();
    this.active = { lease, child, expiryTimer };
    this.store.logLeaseStart(lease.leaseId, connection.id, mode);

    // Run leases get the domain guard + the live CDP override so Hermes'
    // browser tools attach to this profile. Setup leases are user-driven —
    // no agent is connected, so neither applies.
    if (mode === 'run') {
      this.writeGuardFile(connection);
      this.options.onCdpChange(lease.cdpUrl);
    }

    child.once('exit', () => {
      if (this.active?.lease.leaseId === lease.leaseId) {
        this.cleanupAfterExit(lease, 'error', 'Chromium exited unexpectedly.');
      }
    });

    return lease;
  }

  /** End the active session. Mismatched lease ids are rejected so a stale
   * caller can never kill another run's browser. */
  async end(leaseId: string, outcome: BrowserLeaseOutcome, summary: string | null): Promise<void> {
    const current = this.active;
    if (!current || current.lease.leaseId !== leaseId) {
      throw new Error('No active browser session with that lease id');
    }
    this.active = null;
    clearTimeout(current.expiryTimer);
    this.teardownSharedState(current.lease);
    this.store.logLeaseEnd(leaseId, outcome, summary);
    await this.stopChild(current.child);
  }

  /** Current top-level page of the active session, via the CDP HTTP endpoint. */
  async currentPage(): Promise<{ url: string; title: string } | null> {
    if (!this.active) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return null;
      const targets = await res.json() as Array<{ type?: string; url?: string; title?: string }>;
      const page = targets.find((t) => t.type === 'page' && t.url
        && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
      if (!page?.url) return null;
      return { url: page.url, title: page.title ?? '' };
    } catch {
      return null;
    }
  }

  /** Called once at orchestrator startup: a previous process may have died
   * mid-lease, leaving the CDP override and guard file behind. */
  clearStaleState(): void {
    if (this.active) return;
    this.options.onCdpChange(null);
    rmSync(this.options.guardFilePath, { force: true });
  }

  async shutdown(): Promise<void> {
    const current = this.active;
    if (!current) return;
    await this.end(current.lease.leaseId, 'error', 'Verso shut down while the session was active.').catch(() => {});
  }

  private cleanupAfterExit(lease: BrowserSessionLease, outcome: BrowserLeaseOutcome, summary: string): void {
    const current = this.active;
    if (!current || current.lease.leaseId !== lease.leaseId) return;
    this.active = null;
    clearTimeout(current.expiryTimer);
    this.teardownSharedState(lease);
    this.store.logLeaseEnd(lease.leaseId, outcome, summary);
  }

  private teardownSharedState(lease: BrowserSessionLease): void {
    if (lease.mode === 'run') {
      this.options.onCdpChange(null);
      rmSync(this.options.guardFilePath, { force: true });
    }
  }

  private writeGuardFile(connection: BrowserConnection): void {
    const domains = connection.domain ? [connection.domain] : [];
    mkdirSync(path.dirname(this.options.guardFilePath), { recursive: true });
    // Atomic write (tmp + rename): the Hermes-side guard treats an
    // unreadable file as absent, so a torn read must never be possible.
    const tmpPath = `${this.options.guardFilePath}.tmp`;
    writeFileSync(
      tmpPath,
      JSON.stringify({
        connection_id: connection.id,
        domains,
        start_url: connection.startUrl,
      }),
      'utf8',
    );
    renameSync(tmpPath, this.options.guardFilePath);
  }

  private async waitForCdp(): Promise<void> {
    const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (res.ok) return;
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Chromium did not expose its DevTools endpoint in time');
  }

  private async assertPortFree(): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        throw new Error(
          `Port ${this.port} is already serving a DevTools endpoint Verso does not own — refusing to launch`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('refusing to launch')) throw error;
      // Connection refused/timeout: port is free.
    }
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // SIGTERM first so Chromium flushes the profile (cookies live there),
    // SIGKILL only if it lingers.
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => this.killChild(child), SIGKILL_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  private killChild(child: ChildProcess): void {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}

/** True when a Chromium profile dir looks like it has been used before. */
export function profileExists(profileDir: string): boolean {
  return existsSync(path.join(profileDir, 'Default'));
}
