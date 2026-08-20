import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readJsonFileOr, writeJsonFileAtomic } from './atomic-json-file.ts';
import { allocatePort, canBind, delay, hasExited, terminateChild } from './hermes-process-utils.ts';

const execFileAsync = promisify(execFile);

// Mirrors Hermes's own local-Chrome detection list (hermes_cli/browser_connect.py
// _DARWIN_APPS) so both sides agree on what counts as a usable browser.
const DARWIN_BROWSER_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

interface BrowserHostState {
  pid: number | null;
  binary: string | null;
  userDataDir: string | null;
  port: number | null;
}

export interface BrowserHostStatus {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  port: number | null;
  binary: string | null;
}

export interface BrowserHostOptions {
  /** Directory holding the profile dir and the pidfile. Defaults to the app data dir. */
  baseDir?: string;
  /** Override the browser binary (tests point this at a fake). */
  binary?: string | null;
  /** Extra args appended to the spawn (tests only). */
  extraArgs?: string[];
  logger?: Pick<Console, 'info' | 'warn'>;
}

function defaultBaseDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso');
}

function decodeState(value: unknown): BrowserHostState {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    pid: typeof record.pid === 'number' ? record.pid : null,
    binary: typeof record.binary === 'string' ? record.binary : null,
    userDataDir: typeof record.userDataDir === 'string' ? record.userDataDir : null,
    port: typeof record.port === 'number' ? record.port : null,
  };
}

function emptyState(): BrowserHostState {
  return { pid: null, binary: null, userDataDir: null, port: null };
}

/**
 * Owns the one Chromium instance the agent browses with. The profile directory
 * is dedicated to agent work (never the user's personal browser profile), and
 * doubles as the feature flag: it exists once the user has opened the agent
 * browser at least once. Hermes attaches over CDP (BROWSER_CDP_URL); this class
 * never speaks to Hermes directly.
 */
export class BrowserHost {
  readonly profileDir: string;
  private readonly stateFile: string;
  private readonly binaryOverride: string | null | undefined;
  private readonly extraArgs: string[];
  private readonly logger: Pick<Console, 'info' | 'warn'>;

  private child: ChildProcess | null = null;
  private port: number | null = null;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private desiredRunning = false;
  private respawnTimer: NodeJS.Timeout | null = null;
  private rapidExits = 0;
  private lastSpawnAt = 0;

  constructor(options: BrowserHostOptions = {}) {
    const baseDir = options.baseDir ?? defaultBaseDir();
    this.profileDir = path.join(baseDir, 'agent-browser-profile');
    this.stateFile = path.join(baseDir, 'agent-browser-host.json');
    this.binaryOverride = options.binary;
    this.extraArgs = options.extraArgs ?? [];
    this.logger = options.logger ?? console;
  }

  resolveBinary(): string | null {
    if (this.binaryOverride !== undefined) return this.binaryOverride;
    return DARWIN_BROWSER_APPS.find((candidate) => existsSync(candidate)) ?? null;
  }

  /** The feature is on once the dedicated profile exists. */
  isEnabled(): boolean {
    return existsSync(this.profileDir);
  }

  isRunning(): boolean {
    return this.child !== null && !hasExited(this.child);
  }

  /** Loopback CDP endpoint for Hermes's child env; null keeps Hermes in its default local mode. */
  cdpUrl(): string | null {
    if (!this.isEnabled() || this.port === null) return null;
    return `http://127.0.0.1:${this.port}`;
  }

  status(): BrowserHostStatus {
    return {
      supported: this.resolveBinary() !== null,
      enabled: this.isEnabled(),
      running: this.isRunning(),
      port: this.port,
      binary: this.resolveBinary(),
    };
  }

  /**
   * Start (or adopt-nothing-and-start) the browser. Coalesced; safe to call
   * repeatedly. Creates the profile on first use, which flips isEnabled().
   */
  ensureStarted(): Promise<void> {
    if (this.isRunning()) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /**
   * Open a URL for the user. Relies on Chromium's singleton behavior: invoking
   * the binary again with the same --user-data-dir forwards the URL to the
   * running instance and activates it — the only sanctioned way a window comes
   * to the foreground, and only ever from an explicit user action.
   */
  async openUrl(url?: string): Promise<void> {
    await this.ensureStarted();
    const binary = this.resolveBinary();
    if (!binary) throw new Error('No Chromium-family browser installed.');
    const target = url && /^https?:\/\//i.test(url) ? url : 'about:blank';
    const forwarder = spawn(binary, [`--user-data-dir=${this.profileDir}`, target], {
      stdio: 'ignore',
      detached: true,
    });
    forwarder.unref();
  }

  /** Stop the browser and delete the profile (signs out of everything). */
  async reset(): Promise<void> {
    await this.shutdown();
    rmSync(this.profileDir, { recursive: true, force: true });
    writeJsonFileAtomic(this.stateFile, emptyState());
    this.port = null;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.desiredRunning = false;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const child = this.child;
    this.shutdownPromise = (async () => {
      if (child && !hasExited(child)) {
        try {
          await terminateChild(child);
        } catch (error) {
          this.logger.warn('[browser-host] browser did not exit cleanly:', error instanceof Error ? error.message : String(error));
        }
      }
      this.child = null;
      writeJsonFileAtomic(this.stateFile, emptyState());
    })().finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  /**
   * Kill a browser left over from a previous orchestrator run (crash path).
   * Only signals a process whose command line matches both the recorded binary
   * and our profile dir — PIDs get recycled, so a bare pidfile is not identity.
   */
  async sweepStaleProcess(): Promise<void> {
    const state = readJsonFileOr(this.stateFile, decodeState, emptyState);
    if (!state.pid) return;
    const command = await processCommand(state.pid);
    const ours = command !== null
      && state.binary !== null
      && command.includes(state.binary)
      && command.includes(`--user-data-dir=${this.profileDir}`);
    if (ours) {
      this.logger.warn(`[browser-host] killing stale agent browser pid ${state.pid} from previous run`);
      try {
        process.kill(state.pid, 'SIGTERM');
        await delay(1_500);
        if (await processCommand(state.pid) !== null) process.kill(state.pid, 'SIGKILL');
      } catch {
        // Already gone between the check and the signal.
      }
    }
    writeJsonFileAtomic(this.stateFile, emptyState());
  }

  private async startOnce(): Promise<void> {
    const binary = this.resolveBinary();
    if (!binary) throw new Error('No Chromium-family browser installed.');

    await this.sweepStaleProcess();

    const firstUse = !existsSync(this.profileDir);
    if (firstUse) seedProfile(this.profileDir);

    // One port per orchestrator lifetime: Hermes's env captures the URL at
    // spawn, so the endpoint must survive browser restarts. Prefer the port
    // from the previous run so long-lived Hermes homes see a stable endpoint,
    // but never fight another process for it.
    if (this.port === null) {
      const persisted = readJsonFileOr(this.stateFile, decodeState, emptyState).port;
      this.port = persisted !== null && await canBind('127.0.0.1', persisted)
        ? persisted
        : await allocatePort('127.0.0.1');
    }

    const args = [
      `--user-data-dir=${this.profileDir}`,
      `--remote-debugging-port=${this.port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-startup-window',
      ...this.extraArgs,
    ];
    const child = spawn(binary, args, { stdio: 'ignore' });
    this.child = child;
    this.desiredRunning = true;
    this.lastSpawnAt = Date.now();
    child.once('exit', () => this.handleUnexpectedExit(child));

    try {
      await this.awaitReady(child);
    } catch (error) {
      this.desiredRunning = false;
      if (!hasExited(child)) {
        try {
          await terminateChild(child);
        } catch {
          // Readiness failure is the error worth reporting.
        }
      }
      this.child = null;
      throw error;
    }

    writeJsonFileAtomic(this.stateFile, {
      pid: child.pid ?? null,
      binary,
      userDataDir: this.profileDir,
      port: this.port,
    } satisfies BrowserHostState);
    this.logger.info(`[browser-host] agent browser ready on 127.0.0.1:${this.port} (pid ${child.pid})`);
  }

  private async awaitReady(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (hasExited(child)) throw new Error('Agent browser exited during startup.');
      if (await this.cdpResponds() && await this.portOwnedByChild(child)) return;
      await delay(250);
    }
    throw new Error('Agent browser did not become ready within 15s.');
  }

  private async cdpResponds(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Never adopt a foreign CDP endpoint: the listener must be our child. */
  private async portOwnedByChild(child: ChildProcess): Promise<boolean> {
    if (!child.pid) return false;
    try {
      const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${this.port}`, '-sTCP:LISTEN', '-t']);
      const owners = stdout.split('\n').map((line) => parseInt(line.trim(), 10)).filter(Number.isFinite);
      return owners.includes(child.pid);
    } catch {
      // lsof exits 1 when nothing listens yet; treat as not-ready, not error.
      return false;
    }
  }

  private handleUnexpectedExit(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    if (!this.desiredRunning) return;
    // Windowless respawn keeps logged-in sessions reachable without ever
    // touching window focus. Three quick deaths in a row means something is
    // genuinely wrong — stop until the next explicit user action.
    this.rapidExits = Date.now() - this.lastSpawnAt < 60_000 ? this.rapidExits + 1 : 1;
    if (this.rapidExits >= 3) {
      this.logger.warn('[browser-host] agent browser keeps exiting; giving up until next user action');
      this.desiredRunning = false;
      return;
    }
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      void this.ensureStarted().catch((error) => {
        this.logger.warn('[browser-host] respawn failed:', error instanceof Error ? error.message : String(error));
      });
    }, 2_000);
    this.respawnTimer.unref();
  }
}

/**
 * Create the profile with Chrome's password manager disabled: the whole design
 * keeps Verso out of credential custody, so the agent profile must not offer to
 * save the passwords users type during login.
 */
function seedProfile(profileDir: string): void {
  mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  writeJsonFileAtomic(path.join(profileDir, 'Default', 'Preferences'), {
    credentials_enable_service: false,
    profile: { password_manager_enabled: false },
  });
}

async function processCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
    const command = stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}
