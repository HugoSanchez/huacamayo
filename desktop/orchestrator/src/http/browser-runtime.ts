import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Exact-version pin, never a range and never `npx agent-browser` (which
// resolves to registry-latest at run time — the Hermes-pin lesson). Bump
// deliberately, alongside a bundle smoke pass.
export const AGENT_BROWSER_VERSION = '0.34.0';

export type BrowserRuntimePhase =
  | { kind: 'idle'; ready: boolean }
  | { kind: 'installing'; step: 'cli' | 'chromium' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

function defaultRuntimeRoot(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'browser-runtime');
}

function defaultAgentBrowserHome(): string {
  return path.join(os.homedir(), '.agent-browser');
}

/**
 * Owns the on-demand install of the browser automation runtime:
 *  - the pinned `agent-browser` npm CLI (which Hermes' browser tools shell
 *    out to), installed under <app support>/verso/browser-runtime and
 *    prepended to Hermes' PATH;
 *  - Chrome for Testing, which `agent-browser install` manages under
 *    ~/.agent-browser/browsers/chrome-<version>/ (the CLI's own fixed
 *    layout — verified against the pinned version).
 * `resolveChromium()` is the one shared answer for "which browser binary":
 * Verso's own profile launcher uses it directly, and the supervisor exports
 * it to Hermes as AGENT_BROWSER_EXECUTABLE_PATH.
 */
export class BrowserRuntime {
  private phase: BrowserRuntimePhase = { kind: 'idle', ready: false };
  private installPromise: Promise<void> | null = null;

  constructor(
    private readonly root = process.env.VERSO_BROWSER_RUNTIME_DIR?.trim() || defaultRuntimeRoot(),
    private readonly agentBrowserHome = process.env.VERSO_AGENT_BROWSER_HOME?.trim() || defaultAgentBrowserHome(),
  ) {}

  get binDir(): string {
    return path.join(this.root, 'node_modules', '.bin');
  }

  cliPath(): string | null {
    const p = path.join(this.binDir, 'agent-browser');
    return existsSync(p) ? p : null;
  }

  /** Newest Chrome for Testing executable from the agent-browser home. */
  resolveChromium(): string | null {
    const browsersDir = path.join(this.agentBrowserHome, 'browsers');
    if (!existsSync(browsersDir)) return null;
    let entries: string[];
    try {
      entries = readdirSync(browsersDir)
        .filter((e) => /^chrome-[\d.]+$/.test(e))
        .sort((a, b) => compareVersions(a.slice('chrome-'.length), b.slice('chrome-'.length)));
    } catch {
      return null;
    }
    for (const entry of entries.reverse()) {
      const candidate = path.join(
        browsersDir, entry,
        'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing',
      );
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  isReady(): boolean {
    return this.cliPath() !== null && this.resolveChromium() !== null;
  }

  status(): BrowserRuntimePhase {
    if (this.phase.kind === 'installing' || this.phase.kind === 'error') return this.phase;
    return this.isReady() ? { kind: 'ready' } : { kind: 'idle', ready: false };
  }

  /** Install the CLI + Chrome. Concurrent calls share one install. */
  ensureInstalled(): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    if (!this.installPromise) {
      this.installPromise = this.install().finally(() => {
        this.installPromise = null;
      });
    }
    return this.installPromise;
  }

  private async install(): Promise<void> {
    mkdirSync(this.root, { recursive: true });
    try {
      if (!this.cliPath()) {
        this.phase = { kind: 'installing', step: 'cli' };
        await this.run(this.npmBinary(), [
          'install',
          '--prefix', this.root,
          '--no-audit', '--no-fund', '--loglevel=error',
          `agent-browser@${AGENT_BROWSER_VERSION}`,
        ], 5 * 60_000);
        if (!this.cliPath()) throw new Error('agent-browser CLI missing after npm install');
      }
      if (!this.resolveChromium()) {
        this.phase = { kind: 'installing', step: 'chromium' };
        const cli = this.cliPath();
        if (!cli) throw new Error('agent-browser CLI not installed');
        // The installer has been seen exiting non-zero after a successful
        // download (post-install warmup); presence of the browser binary is
        // the real success signal.
        await this.run(cli, ['install'], 15 * 60_000).catch((error) => {
          if (!this.resolveChromium()) throw error;
        });
        if (!this.resolveChromium()) throw new Error('Chrome missing after agent-browser install');
      }
      this.phase = { kind: 'ready' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.phase = { kind: 'error', message };
      throw error;
    }
  }

  private npmBinary(): string {
    // The orchestrator runs under the bundled Node in Release builds; npm
    // ships next to it. Fall back to PATH resolution for dev launches.
    const sibling = path.join(path.dirname(process.execPath), 'npm');
    return existsSync(sibling) ? sibling : 'npm';
  }

  private run(command: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${path.basename(command)} ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${path.basename(command)} ${args[0]} exited ${code}: ${stderr.trim().slice(-400)}`));
      });
    });
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** One runtime per process: the supervisor injects its paths into Hermes'
 * env at spawn and the browser routes drive installs through the same
 * instance, so both always resolve identical binaries. */
export const browserRuntime = new BrowserRuntime();
