import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { RuntimeMode } from '../integrations/runtime-mode.ts';
import {
  getBundledHermesInvocation,
  getBundledPython,
  isBundledRuntime,
  seedHermesHomeFromBundle,
} from './runtime-bootstrap.ts';
import { isMemoryEnabled } from './lexical-provider.ts';
import { applyMemorySoulSection } from './memory-soul.ts';
import { computePinnedToolNames, findInertCorePins } from './hermes-pinned-tools.ts';
import { ANTHROPIC_CHAT_MODELS, CODEX_CHAT_MODELS } from './model-catalog.ts';
import { readAnthropicKeyFromEnvFile } from './model-auth.ts';
import { CustomConnectorsStore } from './custom-connectors-store.ts';
import { CustomConnectorKeychain } from './keychain.ts';
import { fetchRegisteredToolNames, hermesGatewayAuthHeaders } from './hermes-gateway-client.ts';

export interface HermesGatewayConfig {
  baseUrl: string;
  startupTimeoutMs: number;
  apiKey: string | null;
}

type HermesRuntimeState = 'idle' | 'starting' | 'ready' | 'error' | 'unavailable';
type HermesRuntimeSource = 'none' | 'managed' | 'manual';

const LEGACY_DEFAULT_SOUL_MD = '# Verso\n\nYou are a helpful research assistant running inside the Verso macOS app.\n';

interface HermesLaunchConfig {
  command: string | null;
  args: string[];
  cwd: string | null;
  startupTimeoutMs: number;
}

export interface HermesRuntimeSnapshot {
  state: HermesRuntimeState;
  source: HermesRuntimeSource;
  reachable: boolean;
  launchConfigured: boolean;
  baseUrl: string;
  home: string | null;
  pid: number | null;
  command: string | null;
  cwd: string | null;
  lastError: string | null;
  // Core pinned tools the gateway did not register (base names). null while
  // unchecked or when the gateway doesn't expose /v1/toolsets; non-empty
  // means product-critical tools are invisible to the model.
  inertCorePins: string[] | null;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8642;
// Cold starts have to load the local embedding model and register the MCP
// bridge before the gateway can answer /health. Allow enough time for that on
// a busy developer machine so the UI never reports a false "not ready" error
// while Hermes is still coming online.
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const MANAGED_API_SERVER_KEY = randomBytes(32).toString('hex');
export function getHermesGatewayConfig(): HermesGatewayConfig {
  const baseUrl = normalizeBaseUrl(
    process.env.VERSO_HERMES_GATEWAY_URL?.trim() || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
  );
  const rawStartupTimeout = parseInt(
    process.env.VERSO_HERMES_STARTUP_TIMEOUT_MS || String(DEFAULT_STARTUP_TIMEOUT_MS),
    10,
  );
  const startupTimeoutMs = Number.isFinite(rawStartupTimeout) && rawStartupTimeout > 0
    ? rawStartupTimeout
    : DEFAULT_STARTUP_TIMEOUT_MS;
  const apiKey = getHermesApiServerKey();

  return { baseUrl, startupTimeoutMs, apiKey };
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.replace(/\/+$/, '');
}

function getHermesApiServerKey(): string | null {
  const explicit = process.env.API_SERVER_KEY?.trim()
    || process.env.VERSO_HERMES_API_SERVER_KEY?.trim()
    || null;
  if (explicit) return explicit;
  return isManagedDisabled() ? null : MANAGED_API_SERVER_KEY;
}

function getHermesLaunchConfig(): HermesLaunchConfig {
  const startupTimeoutMs = getHermesGatewayConfig().startupTimeoutMs;
  const cwd = process.env.VERSO_HERMES_CWD?.trim() || null;
  if (isManagedDisabled()) {
    return {
      command: null,
      args: [],
      cwd,
      startupTimeoutMs,
    };
  }

  // Release builds: spawn the bundled Python on the bundled hermes
  // console-script, with PYTHONPATH wired up in spawnManagedProcess.
  const bundled = getBundledHermesInvocation();
  if (bundled) {
    return {
      command: bundled.python,
      args: [bundled.hermesScript, 'gateway', 'run', '--replace'],
      cwd,
      startupTimeoutMs,
    };
  }

  // Debug builds / manual override: use the developer's installed Hermes.
  const command = process.env.VERSO_HERMES_COMMAND?.trim() || detectInstalledHermesCommand();

  return {
    command,
    args: command === process.env.VERSO_HERMES_COMMAND?.trim()
      ? parseLaunchArgs(process.env.VERSO_HERMES_ARGS)
      : ['gateway', 'run', '--replace'],
    cwd,
    startupTimeoutMs,
  };
}

function isManagedDisabled(): boolean {
  const managed = process.env.VERSO_HERMES_MANAGED?.trim().toLowerCase();
  return managed === '0' || managed === 'false' || managed === 'no';
}

function parseLaunchArgs(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to a simple whitespace split for convenience.
  }

  return trimmed.split(/\s+/).filter(Boolean);
}

function detectInstalledHermesCommand(): string | null {
  // Used only as the Debug-build fallback — Release builds resolve Hermes
  // via getBundledHermesInvocation() in getHermesLaunchConfig and never
  // reach this branch.
  const home = process.env.HOME?.trim();
  const candidates = [
    home ? join(home, '.local', 'bin', 'hermes') : null,
    home ? join(home, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes') : null,
    findExecutableOnPath('hermes'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function findExecutableOnPath(name: string): string | null {
  const pathValue = process.env.PATH ?? '';
  for (const entry of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(entry, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface HermesSupervisorOptions {
  config?: HermesGatewayConfig;
  launch?: HermesLaunchConfig;
  runtimeMode?: RuntimeMode;
  memoryToolsMode?: 'full' | 'none';
  customConnectorsStore?: CustomConnectorsStore;
  customConnectorKeychain?: CustomConnectorKeychain;
}

// Skills the user must never be able to enable. They overlap with — and
// would conflict with — the verso/Composio bridge or shell out to local
// CLIs in ways we don't support. Hidden from the UI and force-added to
// `skills.disabled` on every launch.
export const ALWAYS_DISABLED_HERMES_SKILLS: readonly string[] = [
  'google-workspace',
  'himalaya',
];

// First-party Hermes skills that teach use of shell CLIs or direct provider
// SDKs (gh, notion, etc.). We disable them so all third-party access flows
// through the verso/Composio bridge. Unlike ALWAYS_DISABLED, these are seeded
// once per profile migration — users can re-enable them via the UI.
// Self-authored skills that already use the verso bridge (e.g.
// granola-meeting-notes) are intentionally NOT in this list — they encode
// learned tool slugs and let the model skip the discovery ritual.
const DEFAULT_DISABLED_HERMES_SKILLS = [
  ...ALWAYS_DISABLED_HERMES_SKILLS,
  'notion',
  'linear',
  'github-auth',
  'github-repo-management',
  'github-pr-workflow',
  'github-code-review',
  'github-issues',
];
const DEFAULT_DISABLED_SKILLS_MARKER = '.verso-default-disabled-skills-v1';
const PRE_RELEASE_BROWSER_CRON_CLEANUP_MARKER = '.verso-paused-pre-release-browser-crons-v1';

export class HermesSupervisor {
  private readonly launch: HermesLaunchConfig;
  private readonly hasExplicitBaseUrl: boolean;
  private readonly manualMode: boolean;
  private readonly managedHermesHome: string;
  private readonly templateHermesHome: string;
  private readonly runtimeMode: RuntimeMode;
  private readonly memoryToolsMode: 'full' | 'none';
  private readonly customConnectorsStore: CustomConnectorsStore;
  private readonly customConnectorKeychain: CustomConnectorKeychain;

  private config: HermesGatewayConfig;
  private orchestratorBaseUrl: string | null = null;
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private restartPromise: Promise<void> | null = null;
  private state: HermesRuntimeState;
  private source: HermesRuntimeSource = 'none';
  private lastError: string | null = null;
  private logTail: string[] = [];
  // null = not checked yet (or gateway doesn't expose /v1/toolsets);
  // [] = all core pins live; non-empty = product-critical tools are
  // invisible to the model and someone should look at naming drift.
  private inertCorePins: string[] | null = null;
  private pinLivenessPromise: Promise<void> | null = null;

  constructor(options: HermesSupervisorOptions = {}) {
    this.config = options.config ?? getHermesGatewayConfig();
    this.launch = options.launch ?? getHermesLaunchConfig();
    this.runtimeMode = options.runtimeMode ?? 'managed';
    this.memoryToolsMode = options.memoryToolsMode ?? 'full';
    this.customConnectorsStore = options.customConnectorsStore ?? new CustomConnectorsStore();
    this.customConnectorKeychain = options.customConnectorKeychain ?? new CustomConnectorKeychain();
    this.hasExplicitBaseUrl = Boolean(process.env.VERSO_HERMES_GATEWAY_URL?.trim());
    this.manualMode = isManagedDisabled();
    this.templateHermesHome = getTemplateHermesHome();
    this.managedHermesHome = getManagedHermesHome(this.templateHermesHome);
    this.state = this.launch.command || this.manualMode ? 'idle' : 'unavailable';
  }

  // The on-disk Hermes home for the gateway we manage (or the template path
  // when the user pointed us at their own gateway). Cron output files and
  // session JSON live under this directory, so the /crons routes need it.
  get hermesHome(): string {
    return this.manualMode ? this.templateHermesHome : this.managedHermesHome;
  }

  get composioToolsManifestPath(): string {
    return join(this.hermesHome, 'verso-composio-tools.json');
  }

  get gatewayConfig(): HermesGatewayConfig {
    return this.config;
  }

  // Resolved path/command of the Hermes binary the supervisor will spawn.
  // Exposed so one-off helpers (auth flows, etc.) can shell out to the same
  // binary without duplicating the detection logic. Callers that need to
  // run a Hermes subcommand should prefer invoke() below — launchCommand
  // alone is the bundled-python binary in Release builds, which spawns
  // garbage if passed Hermes subcommand args directly.
  get launchCommand(): string | null {
    return this.launch.command;
  }

  get launchCwd(): string | null {
    return this.launch.cwd;
  }

  /**
   * Build a spawn-compatible invocation for an arbitrary Hermes subcommand.
   * In Release builds the supervisor runs `<bundled-python> <hermes-script>
   * <args...>` with `PYTHONPATH=<bundled-site-packages>`; in Debug builds
   * it runs the developer's installed `hermes` directly with the bare args.
   * Helpers (codex auth, status checks, etc.) call this so they don't have
   * to special-case the bundled vs Debug code paths.
   */
  invoke(args: readonly string[]): { command: string; args: string[]; env: Record<string, string> } | null {
    if (!this.launch.command) return null;
    const bundled = getBundledHermesInvocation();
    if (bundled) {
      return {
        command: bundled.python,
        args: [bundled.hermesScript, ...args],
        env: bundledPythonEnv(bundled),
      };
    }
    return { command: this.launch.command, args: [...args], env: {} };
  }

  prepare(): void {
    if (!this.launch.command) return;
    void this.ensureReady().catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = 'error';
    });
  }

  setOrchestratorBaseUrl(baseUrl: string): void {
    this.orchestratorBaseUrl = normalizeBaseUrl(baseUrl);
  }

  async ensureReady(signal?: AbortSignal): Promise<HermesGatewayConfig> {
    if (!this.launch.command && this.manualMode) {
      if (await this.ping(800, signal)) {
        this.lastError = null;
        this.state = 'ready';
        this.source = 'manual';
        return this.config;
      }
      this.lastError = `Hermes gateway unavailable at ${this.config.baseUrl}.`;
      this.state = 'error';
      this.source = 'none';
      throw new Error(this.lastError);
    }

    if (this.startPromise) {
      await abortable(this.startPromise, signal);
    } else if (this.isChildRunning() && await this.ping(800, signal)) {
      this.noteReady();
      return this.config;
    } else if (this.launch.command) {
      await abortable(this.startManaged(), signal);
    } else {
      this.lastError = 'Hermes CLI not found. Install Hermes or set VERSO_HERMES_COMMAND.';
      this.state = 'unavailable';
      this.source = 'none';
      throw new Error(this.lastError);
    }

    if (!(await this.ping(800, signal))) {
      const message = this.lastError || `Hermes gateway did not become ready at ${this.config.baseUrl}.`;
      this.state = 'error';
      throw new Error(message);
    }

    this.noteReady();
    return this.config;
  }

  async getStatus(timeoutMs = 1200): Promise<HermesRuntimeSnapshot> {
    const reachable = this.isChildRunning() ? await this.ping(timeoutMs) : false;
    if (!this.launch.command && this.manualMode) {
      const manualReachable = await this.ping(timeoutMs);
      if (manualReachable) {
        this.lastError = null;
        this.state = 'ready';
        this.source = 'manual';
      } else {
        this.state = 'idle';
        this.source = 'none';
      }
      return this.snapshot(manualReachable);
    }
    this.reconcileReachability(reachable);
    return this.snapshot(reachable);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    const promise = this.shutdownInner().finally(() => {
      if (this.shutdownPromise === promise) this.shutdownPromise = null;
    });
    this.shutdownPromise = promise;
    return promise;
  }

  private async shutdownInner(): Promise<void> {
    const child = this.child;
    this.startPromise = null;

    if (!child || hasExited(child)) {
      if (this.child === child) this.child = null;
      this.state = this.launch.command || this.manualMode ? 'idle' : 'unavailable';
      this.source = 'none';
      return;
    }

    const exited = childExitPromise(child);

    child.kill('SIGTERM');
    let didExit = await waitForExit(exited, 2_000);
    if (!didExit && !hasExited(child)) {
      child.kill('SIGKILL');
      didExit = await waitForExit(exited, 1_000);
    }
    if (!didExit && !hasExited(child)) {
      throw new Error(`Hermes gateway process ${child.pid ?? 'unknown'} did not exit after SIGKILL.`);
    }

    if (this.child === child) this.child = null;
    this.state = this.launch.command || this.manualMode ? 'idle' : 'unavailable';
    this.source = 'none';
  }

  /**
   * Full child restart. Needed after credential/config changes the gateway
   * only reads at startup (.env API keys, api_server model_routes). Chat
   * sessions survive: the orchestrator rebuilds conversation history from
   * its own store when Hermes forgets a previous_response_id.
   *
   * Concurrent callers coalesce onto one in-flight restart. Without this,
   * two overlapping restarts (e.g. connector remove followed quickly by
   * add) have the second shutdown() SIGTERM the healthy gateway the first
   * restart just started, and the loser reports "did not become ready"
   * while a perfectly good gateway is running.
   */
  async restart(): Promise<void> {
    if (this.restartPromise) {
      return this.restartPromise;
    }
    const promise = (async () => {
      await this.shutdown();
      await this.ensureReady();
    })().finally(() => {
      this.restartPromise = null;
    });
    this.restartPromise = promise;
    return promise;
  }

  private snapshot(reachable: boolean): HermesRuntimeSnapshot {
    return {
      state: this.state,
      source: this.source,
      reachable,
      launchConfigured: Boolean(this.launch.command),
      baseUrl: this.config.baseUrl,
      home: this.managedHermesHome,
      pid: this.child?.pid ?? null,
      command: this.describeLaunch(),
      cwd: this.launch.cwd,
      lastError: this.lastError,
      inertCorePins: this.inertCorePins,
    };
  }

  private describeLaunch(): string | null {
    if (!this.launch.command) return null;
    return [this.launch.command, ...this.launch.args].join(' ');
  }

  private reconcileReachability(reachable: boolean): void {
    if (this.isChildRunning()) {
      if (reachable) {
        this.noteReady();
      } else if (this.state !== 'error') {
        this.state = 'starting';
        this.source = 'managed';
      }
      return;
    }

    this.source = 'none';
    this.state = this.launch.command || this.manualMode
      ? (this.lastError ? 'error' : 'idle')
      : 'unavailable';
  }

  private noteReady(): void {
    this.state = 'ready';
    this.lastError = null;
    this.source = 'managed';
    void this.verifyPinnedToolLiveness();
  }

  // Best-effort inert-pin detector. Hermes ignores pinned names that match
  // no registered tool without any diagnostic, so a naming-convention drift
  // (e.g. the 0.19 mcp_verso_* → mcp__verso__* rename) silently strips the
  // memory/product-core tools from the model. Ask the gateway what the
  // api_server platform actually exposes and complain loudly on a mismatch.
  private async verifyPinnedToolLiveness(): Promise<void> {
    if (this.pinLivenessPromise) return this.pinLivenessPromise;
    this.pinLivenessPromise = (async () => {
      // MCP registration can lag the health endpoint by a moment on cold
      // boots; retry a few times before concluding anything.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await delay(5_000);
        const registered = await fetchRegisteredToolNames(this.config);
        if (registered === null) return; // endpoint unavailable — inconclusive, stay null
        const memoryToolsActive = isMemoryEnabled() && this.memoryToolsMode !== 'none';
        const inert = findInertCorePins(registered, { includeMemoryTools: memoryToolsActive });
        if (inert.length === 0 || attempt === 2) {
          this.inertCorePins = inert;
          if (inert.length > 0) {
            console.error(
              `[hermes-supervisor] ${inert.length} core pinned tool(s) matched nothing the gateway registered: `
              + `${inert.join(', ')}. The model cannot see them. This usually means the Hermes MCP tool-naming `
              + 'convention drifted from hermes-pinned-tools.ts — check the "registered N tool(s)" line in agent.log.',
            );
          }
          return;
        }
      }
    })().catch(() => {
      // Diagnostics must never disturb the boot path.
    }).finally(() => {
      this.pinLivenessPromise = null;
    });
    return this.pinLivenessPromise;
  }

  private isChildRunning(): boolean {
    return Boolean(this.child && !hasExited(this.child));
  }

  private async startManaged(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (!this.launch.command) {
      throw new Error('Hermes launch command is not configured.');
    }

    const promise = this.startManagedInner().finally(() => {
      this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  private async startManagedInner(): Promise<void> {
    if (this.isChildRunning() && await this.ping(500)) {
      this.noteReady();
      return;
    }

    // First-launch bootstrap (Release builds only): seed hermes-home from the
    // bundled config templates. No-op when the bundled-runtime env vars
    // aren't set (Debug builds use the developer's existing ~/.hermes
    // install). The venv is pre-installed at bundle time and ships inside
    // Resources/site-packages/<arch>/ — no first-launch pip install needed.
    if (isBundledRuntime()) {
      this.state = 'starting';
      try {
        seedHermesHomeFromBundle();
      } catch (error) {
        this.lastError = `Failed to prepare bundled runtime: ${error instanceof Error ? error.message : String(error)}`;
        this.state = 'error';
        throw new Error(this.lastError);
      }
    }

    await this.ensureSpawnTargetAvailable();

    this.state = 'starting';
    this.source = 'managed';
    this.lastError = null;
    this.logTail = [];

    const child = await this.spawnManagedProcess();
    this.child = child;
    child.once('exit', (code, signal) => {
      this.lastError = this.formatExitMessage(code, signal);
      this.state = 'error';
      this.source = 'managed';
    });

    await this.waitForGatewayHealthy(child);
    this.noteReady();
  }

  private async ensureSpawnTargetAvailable(): Promise<void> {
    const target = new URL(this.config.baseUrl);
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    if (await canBind(target.hostname, port)) {
      return;
    }

    if (!this.hasExplicitBaseUrl) {
      const port = await allocatePort();
      this.config = { ...this.config, baseUrl: `http://${DEFAULT_HOST}:${port}` };
      return;
    }

    this.lastError = [
      `Configured Hermes gateway URL is already in use: ${this.config.baseUrl}.`,
      'Refusing to reuse an external process in managed mode.',
    ].join(' ');
    throw new Error(this.lastError);
  }

  private async spawnManagedProcess(): Promise<ChildProcess> {
    this.ensureManagedHermesHome();
    const gatewayUrl = new URL(this.config.baseUrl);
    const port = gatewayUrl.port || (gatewayUrl.protocol === 'https:' ? '443' : '80');
    const host = gatewayUrl.hostname;
    const bundled = getBundledHermesInvocation();
    const pythonEnv = bundled ? bundledPythonEnv(bundled) : {};
    const customConnectorEnv: Record<string, string> = {};
    for (const connector of this.customConnectorsStore.list()) {
      if (connector.auth !== 'bearer') continue;
      const token = await this.customConnectorKeychain.getSecret(connector.id);
      if (token) customConnectorEnv[`VERSO_CC_${connector.id}_TOKEN`] = token;
    }

    const env = {
      ...process.env,
      ...pythonEnv,
      ...customConnectorEnv,
      PORT: port,
      HOST: host,
      HERMES_PORT: port,
      HERMES_HOST: host,
      API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: host,
      API_SERVER_PORT: port,
      ...(this.config.apiKey ? { API_SERVER_KEY: this.config.apiKey } : {}),
      HERMES_HOME: this.managedHermesHome,
      VERSO_HERMES_GATEWAY_URL: this.config.baseUrl,
      ...(this.orchestratorBaseUrl ? { VERSO_ORCHESTRATOR_BASE_URL: this.orchestratorBaseUrl } : {}),
    };
    const runnerPath = fileURLToPath(new URL('./hermes-child-runner.mjs', import.meta.url));
    const child = spawn(process.execPath, [runnerPath], {
      cwd: this.launch.cwd ?? process.cwd(),
      env: {
        ...env,
        VERSO_HERMES_CHILD_COMMAND: this.launch.command ?? '',
        VERSO_HERMES_CHILD_ARGS: JSON.stringify(this.launch.args),
        VERSO_HERMES_CHILD_CWD: this.launch.cwd ?? '',
      },
      // 4th stdio slot opens an IPC channel so the child can detect parent
      // death via `process.on('disconnect')` instead of polling `ppid` once
      // per second. Saves a CPU wakeup every second on idle/sleep.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.captureLog('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => this.captureLog('stderr', chunk));

    return child;
  }

  private ensureManagedHermesHome(): void {
    this.migrateLegacyVervoProfile();
    mkdirSync(this.managedHermesHome, { recursive: true });
    const configExistedBeforeSeed = existsSync(join(this.managedHermesHome, 'config.yaml'));
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'config.yaml');
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, '.env');
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'auth.json');
    this.syncManagedAuthStore();
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'SOUL.md');
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'memories/MEMORY.md');
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'memories/USER.md');
    this.syncVersoSkill();
    this.configureManagedMcpServers();
    this.pausePreReleaseBrowserCrons();
    this.configureModelRoutes();
    this.restoreManagedModelConfigIfProxyOwned();
    this.seedDefaultDisabledSkillsIfNeeded(configExistedBeforeSeed);
    this.enforceAlwaysDisabledSkills();
  }

  /**
   * Copy our shipped verso-composio skill into the managed profile's skill
   * tree so Hermes picks it up alongside its built-in skills. Re-copies on
   * every launch when the source is newer than the destination, so iterating
   * on the SKILL.md propagates without manual file moves.
   */
  private syncVersoSkill(): void {
    const targetPath = join(this.managedHermesHome, 'skills', 'verso', 'verso-composio', 'SKILL.md');
    if (process.env.VERSO_ENABLE_COMPOSIO_SKILL?.trim() !== '1') {
      rmSync(targetPath, { force: true });
      return;
    }

    const sourceDir = resolveVersoSkillSourceDir();
    if (!sourceDir) return;
    const sourcePath = join(sourceDir, 'SKILL.md');
    if (!existsSync(sourcePath)) return;
    if (existsSync(targetPath)) {
      try {
        const srcMtime = statSync(sourcePath).mtimeMs;
        const dstMtime = statSync(targetPath).mtimeMs;
        if (dstMtime >= srcMtime) return;
      } catch {
        // fall through to re-copy
      }
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  /**
   * Pre-release builds briefly allowed the agent to create browser-backed
   * cron jobs. That path proved unreliable and was removed before release,
   * but jobs already written to a test profile would otherwise resume when
   * Hermes starts. Preserve the jobs and their history while pausing active
   * ones exactly once; users can still inspect or delete them in the UI.
   */
  private pausePreReleaseBrowserCrons(): void {
    const markerPath = join(this.managedHermesHome, PRE_RELEASE_BROWSER_CRON_CLEANUP_MARKER);
    if (existsSync(markerPath)) return;

    const jobsPath = join(this.managedHermesHome, 'cron', 'jobs.json');
    let pausedCount = 0;
    if (existsSync(jobsPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(jobsPath, 'utf8'));
      } catch (error) {
        console.warn(
          `[cron-cleanup] could not read ${jobsPath}; browser routines were not changed:`,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const jobs = (parsed as Record<string, unknown>).jobs;
      if (Array.isArray(jobs)) {
        const pausedAt = new Date().toISOString();
        for (const rawJob of jobs) {
          if (!rawJob || typeof rawJob !== 'object' || Array.isArray(rawJob)) continue;
          const job = rawJob as Record<string, unknown>;
          if (!Array.isArray(job.enabled_toolsets) || !job.enabled_toolsets.includes('browser')) continue;
          if (job.enabled === false && job.state === 'paused') continue;
          job.enabled = false;
          job.state = 'paused';
          job.paused_at = pausedAt;
          job.paused_reason = 'Browser routines are disabled in this Verso release.';
          pausedCount += 1;
        }
      }

      if (pausedCount > 0) {
        const tempPath = `${jobsPath}.verso-cleanup-${process.pid}.tmp`;
        writeFileSync(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        renameSync(tempPath, jobsPath);
      }
    }

    writeFileSync(markerPath, 'Browser cron cleanup v1 completed.\n', 'utf8');
    if (pausedCount > 0) {
      console.warn(`[cron-cleanup] paused ${pausedCount} pre-release browser routine(s)`);
    }
  }

  private syncManagedAuthStore(): void {
    const sourcePath = join(this.templateHermesHome, 'auth.json');
    const targetPath = join(this.managedHermesHome, 'auth.json');
    if (sourcePath === targetPath || !existsSync(sourcePath)) return;

    const sourceAuth = readJsonRecord(sourcePath);
    if (!isModernHermesAuthStore(sourceAuth)) return;

    const targetAuth = readJsonRecord(targetPath);
    const targetIsModern = isModernHermesAuthStore(targetAuth);
    if (targetIsModern) {
      try {
        if (statSync(targetPath).mtimeMs >= statSync(sourcePath).mtimeMs) return;
      } catch {
        return;
      }
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  /**
   * Force-add `ALWAYS_DISABLED_HERMES_SKILLS` to the profile's
   * `skills.disabled` list on every launch. Non-destructive — leaves
   * anything else the user disabled in place. Pairs with the UI-side
   * filter that hides these skills entirely so the user never sees
   * a (broken) toggle for them.
   */
  private enforceAlwaysDisabledSkills(): void {
    this.mergeDisabledSkills(ALWAYS_DISABLED_HERMES_SKILLS);
  }

  /**
   * Union `names` into the profile's `skills.disabled` list (sorted).
   * Non-destructive — leaves anything else the user disabled in place —
   * and skips the write when every name is already present.
   */
  private mergeDisabledSkills(names: readonly string[]): void {
    const configPath = join(this.managedHermesHome, 'config.yaml');
    const config = readYamlRecord(configPath) ?? {};
    const skills = asRecord(config.skills) ?? {};
    const existing = Array.isArray(skills.disabled)
      ? skills.disabled.filter((item): item is string => typeof item === 'string')
      : [];
    const existingSet = new Set(existing);
    if (names.every((name) => existingSet.has(name))) return;

    skills.disabled = [...new Set([...existing, ...names])].sort();
    config.skills = skills;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, YAML.stringify(config), 'utf8');
  }

  private seedDefaultDisabledSkillsIfNeeded(configExistedBeforeSeed: boolean): void {
    const markerPath = join(this.managedHermesHome, DEFAULT_DISABLED_SKILLS_MARKER);
    if (configExistedBeforeSeed && existsSync(markerPath)) {
      return;
    }

    this.seedDefaultDisabledSkills();
    writeFileSync(markerPath, new Date().toISOString() + '\n', 'utf8');
  }

  /**
   * Run once per profile migration: union our default-disabled list with
   * whatever the template carried over. After the marker is written, the UI
   * is the only writer — we never overwrite a user's choices on later launches.
   */
  private seedDefaultDisabledSkills(): void {
    this.mergeDisabledSkills(DEFAULT_DISABLED_HERMES_SKILLS);
  }

  // One-shot rename of the pre-rename ~/.hermes/profiles/vervo profile to
  // ~/.hermes/profiles/verso. Idempotent: only moves when the new profile
  // doesn't exist yet, so it's safe to leave in place indefinitely. Skipped
  // entirely when VERSO_HERMES_HOME is overridden — that user knows what
  // their layout looks like.
  private migrateLegacyVervoProfile(): void {
    if (process.env.VERSO_HERMES_HOME?.trim()) return;
    if (existsSync(this.managedHermesHome)) return;
    const legacy = join(this.managedHermesHome, '..', 'vervo');
    if (!existsSync(legacy)) return;
    try {
      renameSync(legacy, this.managedHermesHome);
    } catch {
      // Cross-volume or permission failure — fall through and let the
      // following mkdir create a fresh profile.
    }
  }

  /**
   * Reconcile api_server model_routes with the credentials that actually
   * exist, so the chat-input model selector can switch providers per
   * request. A routed alias makes the gateway re-resolve provider
   * credentials for that request (gateway/platforms/api_server.py route
   * handling) — without a route, the verso-request-overrides patch swaps
   * only the model string and the request would go to the default
   * provider's endpoint with the wrong model name.
   *
   * Runs on every managed start, so routes appear/disappear as keys are
   * connected/disconnected (both flows restart the child). Only the
   * aliases in the model catalog are touched; any hand-added route is
   * preserved.
   */
  private configureModelRoutes(): void {
    const configPath = join(this.managedHermesHome, 'config.yaml');
    if (!existsSync(configPath)) return;

    const config = readYamlRecord(configPath) ?? {};

    const hasAnthropic = readAnthropicKeyFromEnvFile(this.managedHermesHome) !== null;
    const hasCodex = this.hasCodexPoolCredentials();

    const platforms = asRecord(config.platforms) ?? {};
    const apiServer = asRecord(platforms.api_server) ?? {};
    const extra = asRecord(apiServer.extra) ?? {};
    const routes = asRecord(extra.model_routes) ?? {};

    for (const model of CODEX_CHAT_MODELS) {
      if (hasCodex) {
        routes[model] = { model, provider: 'openai-codex' };
      } else {
        delete routes[model];
      }
    }
    for (const model of ANTHROPIC_CHAT_MODELS) {
      if (hasAnthropic) {
        routes[model] = { model, provider: 'anthropic' };
      } else {
        delete routes[model];
      }
    }

    if (Object.keys(routes).length > 0) {
      extra.model_routes = routes;
    } else {
      delete extra.model_routes;
    }
    apiServer.extra = extra;
    platforms.api_server = apiServer;
    config.platforms = platforms;

    // Chat requests always carry an explicit model, but cron runs (and any
    // session without one) fall back to the top-level `model.default`. A
    // claude-* default paired with the Codex backend 400s every such run
    // ("model not supported when using Codex with a ChatGPT account"), so
    // repair that known-broken pairing whenever Codex credentials exist.
    const modelCfg = asRecord(config.model);
    if (modelCfg && hasCodex) {
      const defaultModel = typeof modelCfg.default === 'string' ? modelCfg.default : '';
      const provider = typeof modelCfg.provider === 'string' ? modelCfg.provider : '';
      const baseUrl = typeof modelCfg.base_url === 'string' ? modelCfg.base_url : '';
      const codexBackend = provider === 'openai-codex' || baseUrl.includes('chatgpt.com');
      if (codexBackend && defaultModel.startsWith('claude-')) {
        modelCfg.default = CODEX_CHAT_MODELS[0];
        config.model = modelCfg;
      }
    }

    writeFileSync(configPath, YAML.stringify(config), 'utf8');
  }

  private hasCodexPoolCredentials(): boolean {
    try {
      const raw = readFileSync(join(this.managedHermesHome, 'auth.json'), 'utf8');
      const parsed = JSON.parse(raw) as { credential_pool?: Record<string, unknown[]> };
      const pool = parsed?.credential_pool?.['openai-codex'];
      return Array.isArray(pool) && pool.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Earlier managed-profile experiments pointed Hermes at verso's local
   * `/llm/v1` proxy. That proxy is no longer part of the product path; Hermes
   * should preserve the user's own Codex/OpenAI auth and model config. If we
   * find the exact old proxy-owned model config, restore the template model
   * section. Other model configs are left untouched.
   */
  private restoreManagedModelConfigIfProxyOwned(): void {
    if (this.runtimeMode !== 'managed') return;

    const configPath = join(this.managedHermesHome, 'config.yaml');
    if (!existsSync(configPath)) return;

    const config = readYamlRecord(configPath) ?? {};

    const currentModel = asRecord(config.model);
    const baseUrl = typeof currentModel?.base_url === 'string' ? currentModel.base_url : '';
    const provider = typeof currentModel?.provider === 'string' ? currentModel.provider : '';
    if (provider !== 'custom' || !baseUrl.endsWith('/llm/v1')) return;

    const templateModel = asRecord(readYamlRecord(join(this.templateHermesHome, 'config.yaml'))?.model);
    if (templateModel) {
      config.model = templateModel;
    } else {
      delete config.model;
    }
    writeFileSync(configPath, YAML.stringify(config), 'utf8');
  }

  private configureManagedMcpServers(): void {
    const configPath = join(this.managedHermesHome, 'config.yaml');
    if (!existsSync(configPath)) return;

    const config = readYamlRecord(configPath) ?? {};

    const mcpServers = asRecord(config.mcp_servers) ?? {};
    delete mcpServers.vervo;
    for (const key of Object.keys(mcpServers)) {
      if (key.startsWith('custom_')) delete mcpServers[key];
    }

    const memoryToolsActive = isMemoryEnabled() && this.memoryToolsMode !== 'none';

    if (this.orchestratorBaseUrl) {
      const pythonPath = resolveHermesPython(this.templateHermesHome);
      const serverPath = resolveversoMcpServerPath();
      if (pythonPath && serverPath) {
        // In Release the bundled CPython has no site-packages of its own —
        // we ship one separately and wire it up via PYTHONPATH. Without
        // this, `import mcp` in verso_server.py fails on first connect and
        // Hermes gives up after a few retries. Debug builds (no bundled
        // invocation) skip this; their python already sees its own venv.
        const bundled = getBundledHermesInvocation();
        const env: Record<string, string> = {
          VERSO_ORCHESTRATOR_BASE_URL: this.orchestratorBaseUrl,
          VERSO_COMPOSIO_TOOLS_MANIFEST: this.composioToolsManifestPath,
        };
        // The native app protects every sidecar endpoint with a fresh token
        // for each launch. Hermes starts MCP servers from this explicit env
        // map (rather than inheriting its parent environment), so forward the
        // token to the verso bridge or memory/tool calls will fail with 401.
        const sidecarAuthSecret = process.env.VERSO_SIDECAR_AUTH_SECRET?.trim();
        if (sidecarAuthSecret) {
          env.VERSO_SIDECAR_AUTH_SECRET = sidecarAuthSecret;
        }
        if (bundled) {
          env.PYTHONPATH = bundled.sitePackages;
        }
        // Memory tools are part of the verso bridge: the orchestrator owns
        // the in-process memory store and the bridge proxies to it.
        if (memoryToolsActive) {
          env.VERSO_MEMORY_TOOLS = 'full';
        }
        mcpServers.verso = {
          command: pythonPath,
          args: [serverPath],
          env,
          timeout: 120,
          connect_timeout: 60,
        };
      }
    }

    // Composio is reached through verso's backend-backed MCP bridge.
    // Do not register Composio's hosted MCP server directly with Hermes; raw
    // provider tool schemas are too unstable for the primary product path.
    delete mcpServers.composio;

    for (const connector of this.customConnectorsStore.list()) {
      const entry: Record<string, unknown> = {
        url: connector.url,
        timeout: 120,
        connect_timeout: 30,
      };
      if (connector.transport === 'sse') entry.transport = 'sse';
      if (connector.auth === 'oauth') entry.auth = 'oauth';
      if (connector.auth === 'bearer') {
        entry.headers = {
          Authorization: `Bearer \${VERSO_CC_${connector.id}_TOKEN}`,
        };
      }
      mcpServers[`custom_${connector.slug}`] = entry;
    }

    const tools = asRecord(config.tools) ?? {};
    const toolSearch = asRecord(tools.tool_search) ?? {};
    tools.tool_search = {
      ...toolSearch,
      enabled: 'on',
      // Hot set that skips the tool_search bridge. Honored by the
      // verso-tool-search-pinned runtime patch; older unpatched Hermes
      // builds ignore the unknown key.
      pinned: computePinnedToolNames(this.composioToolsManifestPath, {
        includeMemoryTools: memoryToolsActive,
      }),
    };

    // Teach the visible agent that the memory tools ARE its memory —
    // without this it pattern-matches "what do you know about X" to web
    // search. Managed via marker comments so user SOUL edits survive, and
    // removed again when the feature is off.
    this.syncMemorySoulSection(memoryToolsActive);

    config.mcp_servers = mcpServers;
    config.tools = tools;
    writeFileSync(configPath, YAML.stringify(config), 'utf8');
  }

  private syncMemorySoulSection(enabled: boolean): void {
    const soulPath = join(this.managedHermesHome, 'SOUL.md');
    try {
      const current = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';
      const next = applyMemorySoulSection(current, enabled);
      if (next !== current) {
        writeFileSync(soulPath, next, 'utf8');
      }
    } catch (error: unknown) {
      console.warn(`[memory] SOUL.md memory section sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private captureLog(stream: 'stdout' | 'stderr', chunk: string): void {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `[hermes ${stream}] ${line}`);

    if (lines.length === 0) return;

    this.logTail.push(...lines);
    if (this.logTail.length > 40) {
      this.logTail.splice(0, this.logTail.length - 40);
    }
    for (const line of lines) {
      console.log(line);
    }
  }

  private formatExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const details = this.formatDiagnosticLogDetails();
    if (signal) {
      return `Hermes process exited on signal ${signal}.${details}`;
    }
    if (code === 0) {
      return `Hermes gateway stopped unexpectedly (process exit code 0).${details}`;
    }
    return `Hermes process exited with code ${code ?? 'unknown'}.${details}`;
  }

  private formatDiagnosticLogDetails(): string {
    if (this.logTail.length === 0) return '';

    // Hermes prints its banner to stdout after some startup failures. A plain
    // tail therefore hid the actual stderr error and showed only ASCII art in
    // the UI. Preserve the most useful failure lines alongside the last few
    // lines of context, without duplicating entries that are already recent.
    const diagnostic = this.logTail
      .filter((line) => /\[hermes stderr\].*(?:error|failed|failure|conflict|could not|traceback|exception)/i.test(line))
      .slice(-3);
    const recent = this.logTail.slice(-3);
    const selected = [...new Set([...diagnostic, ...recent])];
    return ` Recent logs: ${selected.join(' | ')}`;
  }

  private async waitForGatewayHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.launch.startupTimeoutMs;

    while (Date.now() < deadline) {
      if (hasExited(child)) {
        throw new Error(this.formatExitMessage(child.exitCode, child.signalCode));
      }
      if (await this.ping(500)) {
        return;
      }
      await delay(250);
    }

    const details = this.formatDiagnosticLogDetails();
    this.lastError = `Timed out waiting for Hermes gateway at ${this.config.baseUrl}.${details}`;
    this.state = 'error';
    throw new Error(this.lastError);
  }

  private async ping(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const signals = [AbortSignal.timeout(timeoutMs), signal].filter(Boolean) as AbortSignal[];
    try {
      const res = await fetch(`${this.config.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.any(signals),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Env for running bundled Hermes: Python needs PYTHONPATH to find the
// pre-installed packages — without it, `from hermes_cli.main import main`
// fails immediately. Debug builds (no bundle) leave PYTHONPATH untouched so
// the developer's venv-resolved imports keep working.
function bundledPythonEnv(bundled: { sitePackages: string }): Record<string, string> {
  return {
    ...getBundledPythonBytecodeEnv(),
    PYTHONPATH: [bundled.sitePackages, process.env.PYTHONPATH].filter(Boolean).join(':'),
  };
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function childExitPromise(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const onExit = () => resolve();
    child.once('exit', onExit);
    // Cover the narrow race where the process exits between the caller's
    // initial state check and registration of the exit listener.
    if (hasExited(child)) {
      child.off('exit', onExit);
      resolve();
    }
  });
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  server.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate Hermes port.')));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function canBind(host: string, port: number): Promise<boolean> {
  const server = net.createServer();
  server.unref();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close((error) => resolve(!error));
    });
  });
}

function getTemplateHermesHome(): string {
  // In Release the seed-defaults live next to the app bundle, not under ~/.hermes.
  return process.env.VERSO_BUNDLED_DEFAULTS?.trim()
    || process.env.HERMES_HOME?.trim()
    || join(os.homedir(), '.hermes');
}

function getManagedHermesHome(templateHome: string): string {
  const override = process.env.VERSO_HERMES_HOME?.trim();
  if (override) return override;
  return join(resolveHermesRoot(templateHome), 'profiles', 'verso');
}

function resolveHermesRoot(home: string): string {
  const profilesMarker = `${sep}profiles${sep}`;
  const index = home.lastIndexOf(profilesMarker);
  return index >= 0 ? home.slice(0, index) : home;
}

function resolveHermesPython(templateHome: string): string | null {
  // In Release the bundled CPython owns Python; prefer it.
  const bundledPython = getBundledPython();
  if (bundledPython && existsSync(bundledPython)) return bundledPython;

  const candidate = join(resolveHermesRoot(templateHome), 'hermes-agent', 'venv', 'bin', 'python');
  return existsSync(candidate) ? candidate : null;
}

function resolveversoMcpServerPath(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidate = join(currentDir, '..', '..', 'mcp', 'verso_server.py');
  return existsSync(candidate) ? candidate : null;
}

function resolveVersoSkillSourceDir(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidate = join(currentDir, '..', '..', 'skills', 'verso-composio');
  return existsSync(candidate) ? candidate : null;
}

function getBundledPythonBytecodeEnv(): Record<string, string> {
  const cachePrefix = process.env.VERSO_PYTHON_CACHE_DIR?.trim()
    || join(os.homedir(), 'Library', 'Caches', 'Verso', 'python-bytecode');
  try {
    mkdirSync(cachePrefix, { recursive: true });
  } catch {
    // Python can still run without bytecode caches; preserving app-bundle
    // integrity matters more than surfacing a cache-directory warning here.
  }
  return {
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: cachePrefix,
  };
}

function seedHermesHomeFile(sourceHome: string, targetHome: string, fileName: string): void {
  const sourcePath = join(sourceHome, fileName);
  const targetPath = join(targetHome, fileName);
  if (!existsSync(sourcePath)) return;
  if (existsSync(targetPath) && !shouldRefreshManagedFile(sourcePath, targetPath, fileName)) return;
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

function shouldRefreshManagedFile(sourcePath: string, targetPath: string, fileName: string): boolean {
  if (fileName === 'SOUL.md') {
    return shouldRefreshDefaultSoul(sourcePath, targetPath);
  }

  if (fileName !== 'auth.json') return false;

  try {
    return statSync(sourcePath).mtimeMs > statSync(targetPath).mtimeMs;
  } catch {
    return false;
  }
}

function shouldRefreshDefaultSoul(sourcePath: string, targetPath: string): boolean {
  try {
    const source = readFileSync(sourcePath, 'utf8');
    const target = readFileSync(targetPath, 'utf8');
    return target.trim() === LEGACY_DEFAULT_SOUL_MD.trim() && source.trim() !== target.trim();
  } catch {
    return false;
  }
}

function readYamlRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = YAML.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isModernHermesAuthStore(value: Record<string, unknown> | null): boolean {
  return Boolean(
    value
    && typeof value.active_provider === 'string'
    && asRecord(value.providers)
    && asRecord(value.credential_pool),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
