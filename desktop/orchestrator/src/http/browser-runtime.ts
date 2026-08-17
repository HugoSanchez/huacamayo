import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
  return process.env.VERSO_HERMES_HOME?.trim()
    || path.join(os.homedir(), '.hermes', 'profiles', 'verso');
}

function defaultAgentBrowserHome(): string {
  return path.join(os.homedir(), '.agent-browser');
}

/**
 * Owns the on-demand install of the browser automation runtime:
 *  - the pinned `agent-browser` npm CLI (which Hermes' browser tools shell
 *    out to), installed into Hermes' own profile dependency directory and
 *    prepended to Hermes' PATH;
 *  - Chrome for Testing, which `agent-browser install` manages under
 *    ~/.agent-browser/browsers/chrome-<version>/ (the CLI's own fixed
 *    layout — verified against the pinned version).
 * `resolveChromium()` is the one shared answer for "which browser binary".
 * Both the headed sign-in flow and Hermes receive it through
 * AGENT_BROWSER_EXECUTABLE_PATH.
 */
export class BrowserRuntime {
  private phase: BrowserRuntimePhase = { kind: 'idle', ready: false };
  private installPromise: Promise<void> | null = null;

  constructor(
    private root = process.env.VERSO_BROWSER_RUNTIME_DIR?.trim() || defaultRuntimeRoot(),
    private readonly agentBrowserHome = process.env.VERSO_AGENT_BROWSER_HOME?.trim() || defaultAgentBrowserHome(),
  ) {}

  /** Share Hermes' native dependency directory instead of maintaining a
   * second agent-browser installation tree. Must run before installation. */
  configureInstallRoot(root: string): void {
    if (this.installPromise) throw new Error('Cannot change browser runtime root during installation');
    this.root = root;
  }

  get binDir(): string {
    return path.join(this.root, 'node_modules', '.bin');
  }

  cliPath(): string | null {
    const p = path.join(this.binDir, 'agent-browser');
    if (!existsSync(p)) return null;
    try {
      const manifest = JSON.parse(readFileSync(
        path.join(this.root, 'node_modules', 'agent-browser', 'package.json'),
        'utf8',
      )) as { version?: unknown };
      return manifest.version === AGENT_BROWSER_VERSION ? p : null;
    } catch {
      return null;
    }
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

  /** Run the pinned CLI with the matching managed Chrome binary. */
  async runCli(args: string[], timeoutMs = 30_000): Promise<string> {
    await this.ensureInstalled();
    const cli = this.cliPath();
    const chromium = this.resolveChromium();
    if (!cli || !chromium) throw new Error('Browser automation runtime is not ready');
    return this.run(cli, args, timeoutMs, {
      ...process.env,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium,
    });
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

  private run(
    command: string,
    args: string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv = { ...process.env },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-100_000);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${path.basename(command)} ${commandAction(args)} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else {
          const detail = commandFailureDetail(stdout, stderr);
          reject(new Error(
            `${path.basename(command)} ${commandAction(args)} exited ${code}${detail ? `: ${detail}` : ''}`,
          ));
        }
      });
    });
  }
}

const OPTIONS_WITH_VALUES = new Set([
  '--args', '--enable', '--executable-path', '--extension', '--headers', '--init-script',
  '--namespace', '--profile', '--restore', '--restore-check-fn', '--restore-check-text',
  '--restore-check-url', '--restore-save', '--session', '--session-name', '--state', '--user-agent',
]);

function commandAction(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (OPTIONS_WITH_VALUES.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return args[0] ?? 'command';
}

function commandFailureDetail(stdout: string, stderr: string): string {
  const cleanStderr = stderr.trim();
  const cleanStdout = stdout.trim();
  // `agent-browser --json` reports command failures on stdout, while Node/npm
  // failures generally use stderr. Prefer a structured message from either
  // stream before falling back to unparsed text from either one.
  for (const raw of [cleanStdout, cleanStderr]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim().slice(-1000);
      if (parsed.error && typeof parsed.error === 'object') {
        const message = (parsed.error as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return message.trim().slice(-1000);
      }
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim().slice(-1000);
    } catch {
      // Some subprocess failures are plain text; fall through below.
    }
  }
  return (cleanStderr || cleanStdout).slice(-1000);
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
