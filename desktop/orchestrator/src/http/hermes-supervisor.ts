import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { RuntimeMode } from '../integrations/runtime-mode.ts';
import {
  ensureRuntimeVenv,
  getBundledHermesBin,
  getBundledVenvPython,
  isBundledRuntime,
  seedHermesHomeFromBundle,
} from './runtime-bootstrap.ts';

export interface HermesGatewayConfig {
  baseUrl: string;
  timeoutMs: number;
  startupTimeoutMs: number;
}

type HermesRuntimeState = 'idle' | 'starting' | 'ready' | 'error' | 'unavailable';
type HermesRuntimeSource = 'none' | 'managed' | 'manual';

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
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8642;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
export function getHermesGatewayConfig(): HermesGatewayConfig {
  const baseUrl = normalizeBaseUrl(
    process.env.VERSO_HERMES_GATEWAY_URL?.trim() || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
  );
  const rawTimeout = parseInt(process.env.VERSO_HERMES_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;
  const rawStartupTimeout = parseInt(
    process.env.VERSO_HERMES_STARTUP_TIMEOUT_MS || String(DEFAULT_STARTUP_TIMEOUT_MS),
    10,
  );
  const startupTimeoutMs = Number.isFinite(rawStartupTimeout) && rawStartupTimeout > 0
    ? rawStartupTimeout
    : DEFAULT_STARTUP_TIMEOUT_MS;

  return { baseUrl, timeoutMs, startupTimeoutMs };
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.replace(/\/+$/, '');
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
  // In Release builds the orchestrator owns a private venv it manages itself,
  // so always point at that path — even if it doesn't exist yet. ensureReady()
  // creates the venv before spawn.
  const bundled = getBundledHermesBin();
  if (bundled) return bundled;

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
}

// Exact disable list written by an earlier managed-profile experiment. We keep
// it only so existing profiles can be restored to the user's normal Hermes
// skill configuration.
const DEFAULT_DISABLED_HERMES_SKILLS = [
  'google-workspace',
  'himalaya',
  'notion',
  'linear',
  'granola-meeting-notes',
  'github-auth',
  'github-repo-management',
  'github-pr-workflow',
  'github-code-review',
  'github-issues',
];

export class HermesSupervisor {
  private readonly launch: HermesLaunchConfig;
  private readonly hasExplicitBaseUrl: boolean;
  private readonly manualMode: boolean;
  private readonly managedHermesHome: string;
  private readonly templateHermesHome: string;
  private readonly runtimeMode: RuntimeMode;

  private config: HermesGatewayConfig;
  private orchestratorBaseUrl: string | null = null;
  private baseUrlResolved: boolean;
  private resolveBaseUrlPromise: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private state: HermesRuntimeState;
  private source: HermesRuntimeSource = 'none';
  private lastError: string | null = null;
  private logTail: string[] = [];

  constructor(options: HermesSupervisorOptions = {}) {
    this.config = options.config ?? getHermesGatewayConfig();
    this.launch = options.launch ?? getHermesLaunchConfig();
    this.runtimeMode = options.runtimeMode ?? 'managed';
    this.hasExplicitBaseUrl = Boolean(process.env.VERSO_HERMES_GATEWAY_URL?.trim());
    this.manualMode = isManagedDisabled();
    this.templateHermesHome = getTemplateHermesHome();
    this.managedHermesHome = getManagedHermesHome(this.templateHermesHome);
    this.baseUrlResolved = this.hasExplicitBaseUrl;
    this.state = this.launch.command || this.manualMode ? 'idle' : 'unavailable';
  }

  // The on-disk Hermes home for the gateway we manage (or the template path
  // when the user pointed us at their own gateway). Cron output files and
  // session JSON live under this directory, so the /crons routes need it.
  get hermesHome(): string {
    return this.manualMode ? this.templateHermesHome : this.managedHermesHome;
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
    await this.ensureResolvedBaseUrl();

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
    await this.ensureResolvedBaseUrl();
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
    const child = this.child;
    this.child = null;
    this.startPromise = null;

    if (!child || child.exitCode !== null || child.killed) {
      this.state = this.launch.command || this.manualMode ? 'idle' : 'unavailable';
      this.source = 'none';
      return;
    }

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    child.kill('SIGTERM');
    await Promise.race([exited, delay(2_000)]);
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(1_000)]);
    }

    this.state = this.launch.command || this.manualMode ? 'idle' : 'unavailable';
    this.source = 'none';
  }

  private async ensureResolvedBaseUrl(): Promise<void> {
    if (this.baseUrlResolved) return;
    if (this.resolveBaseUrlPromise) {
      await this.resolveBaseUrlPromise;
      return;
    }

    this.resolveBaseUrlPromise = (async () => {
      const port = await allocatePort();
      this.config = {
        ...this.config,
        baseUrl: `http://${DEFAULT_HOST}:${port}`,
      };
      this.baseUrlResolved = true;
    })().finally(() => {
      this.resolveBaseUrlPromise = null;
    });

    await this.resolveBaseUrlPromise;
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
  }

  private isChildRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
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

    // First-launch bootstrap (Release builds only): build the user venv from
    // bundled Python + offline wheels, and seed hermes-home from bundled
    // config templates. No-op when the bundled-runtime env vars aren't set
    // (Debug builds use the developer's existing ~/.hermes install).
    if (isBundledRuntime()) {
      this.state = 'starting';
      try {
        await ensureRuntimeVenv();
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

    const child = this.spawnManagedProcess();
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
    if (!await this.ping(200)) {
      return;
    }

    if (!this.hasExplicitBaseUrl) {
      const port = await allocatePort();
      this.config = {
        ...this.config,
        baseUrl: `http://${DEFAULT_HOST}:${port}`,
      };
      return;
    }

    this.lastError = [
      `Configured Hermes gateway URL is already in use: ${this.config.baseUrl}.`,
      'Refusing to reuse an external process in managed mode.',
    ].join(' ');
    throw new Error(this.lastError);
  }

  private spawnManagedProcess(): ChildProcess {
    this.ensureManagedHermesHome();
    const gatewayUrl = new URL(this.config.baseUrl);
    const port = gatewayUrl.port || (gatewayUrl.protocol === 'https:' ? '443' : '80');
    const host = gatewayUrl.hostname;
    const env = {
      ...process.env,
      PORT: port,
      HOST: host,
      HERMES_PORT: port,
      HERMES_HOST: host,
      API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: host,
      API_SERVER_PORT: port,
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
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'config.yaml');
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, '.env');
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'auth.json');
    this.syncManagedAuthStore();
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'SOUL.md');
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'memories/MEMORY.md');
    seedHermesHomeFile(this.templateHermesHome, this.managedHermesHome, 'memories/USER.md');
    this.syncVersoSkill();
    this.configureManagedMcpServers();
    this.restoreManagedModelConfigIfProxyOwned();
    this.restoreDefaultDisabledSkillsIfOwned();
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
   * Earlier managed-profile experiments disabled several Hermes built-in
   * skills. That made the managed profile diverge from the working Hermes
   * setup. If the disabled list is exactly the one we wrote, restore the
   * template/default list; otherwise respect the user's current setting.
   */
  private restoreDefaultDisabledSkillsIfOwned(): void {
    const configPath = join(this.managedHermesHome, 'config.yaml');
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown> = {};
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = YAML.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }

    const skills = asRecord(config.skills) ?? {};
    const disabled = Array.isArray(skills.disabled)
      ? skills.disabled.filter((item): item is string => typeof item === 'string')
      : null;
    if (!disabled || !sameStringSet(disabled, DEFAULT_DISABLED_HERMES_SKILLS)) {
      return;
    }

    const templateConfig = readYamlRecord(join(this.templateHermesHome, 'config.yaml'));
    const templateSkills = asRecord(templateConfig?.skills);
    const templateDisabled = Array.isArray(templateSkills?.disabled)
      ? templateSkills.disabled.filter((item): item is string => typeof item === 'string')
      : [];

    skills.disabled = templateDisabled;
    config.skills = skills;
    writeFileSync(configPath, YAML.stringify(config), 'utf8');
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

    let config: Record<string, unknown> = {};
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = YAML.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }

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

    let config: Record<string, unknown> = {};
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = YAML.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }

    const mcpServers = asRecord(config.mcp_servers) ?? {};
    delete mcpServers.vervo;

    if (this.orchestratorBaseUrl) {
      const pythonPath = resolveHermesPython(this.templateHermesHome);
      const serverPath = resolveversoMcpServerPath();
      if (pythonPath && serverPath) {
        mcpServers.verso = {
          command: pythonPath,
          args: [serverPath],
          env: {
            VERSO_ORCHESTRATOR_BASE_URL: this.orchestratorBaseUrl,
          },
          timeout: 120,
          connect_timeout: 60,
        };
      }
    }

    // Composio is reached through verso's backend-backed MCP bridge.
    // Do not register Composio's hosted MCP server directly with Hermes; raw
    // provider tool schemas are too unstable for the primary product path.
    delete mcpServers.composio;

    config.mcp_servers = mcpServers;
    writeFileSync(configPath, YAML.stringify(config), 'utf8');
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
    const details = this.logTail.length > 0
      ? ` Recent logs: ${this.logTail.slice(-6).join(' | ')}`
      : '';
    if (signal) {
      return `Hermes process exited on signal ${signal}.${details}`;
    }
    return `Hermes process exited with code ${code ?? 'unknown'}.${details}`;
  }

  private async waitForGatewayHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.launch.startupTimeoutMs;

    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.killed) {
        throw new Error(this.formatExitMessage(child.exitCode, child.signalCode));
      }
      if (await this.ping(500)) {
        return;
      }
      await delay(250);
    }

    const details = this.logTail.length > 0
      ? ` Recent logs: ${this.logTail.slice(-6).join(' | ')}`
      : '';
    this.lastError = `Timed out waiting for Hermes gateway at ${this.config.baseUrl}.${details}`;
    this.state = 'error';
    throw new Error(this.lastError);
  }

  private async ping(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl}/health`, {
        method: 'GET',
        signal: anySignal([controller.signal, signal].filter(Boolean) as AbortSignal[]),
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
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

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const activeSignals = signals.filter(Boolean);

  if (activeSignals.some((signal) => signal.aborted)) {
    controller.abort();
    return controller.signal;
  }

  const onAbort = () => {
    controller.abort();
    for (const signal of activeSignals) {
      signal.removeEventListener('abort', onAbort);
    }
  };

  for (const signal of activeSignals) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
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
  // In Release the bundled-runtime venv owns Python; prefer it.
  const bundledVenvPython = getBundledVenvPython();
  if (bundledVenvPython && existsSync(bundledVenvPython)) return bundledVenvPython;

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

function seedHermesHomeFile(sourceHome: string, targetHome: string, fileName: string): void {
  const sourcePath = join(sourceHome, fileName);
  const targetPath = join(targetHome, fileName);
  if (!existsSync(sourcePath)) return;
  if (existsSync(targetPath) && !shouldRefreshManagedFile(sourcePath, targetPath, fileName)) return;
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

function shouldRefreshManagedFile(sourcePath: string, targetPath: string, fileName: string): boolean {
  if (fileName !== 'auth.json') return false;

  try {
    return statSync(sourcePath).mtimeMs > statSync(targetPath).mtimeMs;
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

function sameStringSet(left: string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}
