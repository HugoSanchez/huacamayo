import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Local embedding runtime for GBrain.
 *
 * Verso runs a small multilingual GGUF embedding model behind llama.cpp's
 * `llama-server --embeddings` so user memories never leave the machine and no
 * API key is required. The orchestrator downloads the model once (kept out of
 * the app bundle so Sparkle updates stay small), supervises the server process
 * the same way it supervises Hermes, and exposes its state so the rest of the
 * stack can defer embedding-dependent work until the runtime is ready.
 *
 * GBrain is configured with the `ollama` provider recipe pointed at this
 * server via OLLAMA_BASE_URL. Both Ollama and llama-server speak the same
 * OpenAI-compatible /v1/embeddings wire; we deliberately avoid gbrain's
 * `llama-server` recipe because its availability check rejects any
 * user-provided model id (`user_provided_model_unset`), which silently
 * disables embedding on put_page.
 */

export interface EmbeddingRuntimeConfig {
  enabled: boolean;
  /** Model id reported to GBrain (`ollama:<modelId>`). */
  modelId: string;
  modelUrl: string;
  /** Absolute path the GGUF is downloaded to. */
  modelPath: string;
  dimensions: number;
  port: number;
  /** OpenAI-compatible base URL GBrain should call (`OLLAMA_BASE_URL`). */
  baseUrl: string;
  /** llama-server binary, or null when none could be resolved. */
  command: string | null;
  reason: string | null;
}

export type EmbeddingRuntimeState =
  | 'idle'
  | 'disabled'
  | 'unavailable'
  | 'downloading'
  | 'starting'
  | 'ready'
  | 'error';

export interface EmbeddingRuntimeDiagnostics {
  enabled: boolean;
  state: EmbeddingRuntimeState;
  modelId: string;
  modelPath: string;
  modelPresent: boolean;
  dimensions: number;
  port: number;
  baseUrl: string;
  command: string | null;
  reason: string | null;
  restarts: number;
  lastError: string | null;
}

const DEFAULT_MODEL_ID = 'embeddinggemma-300m';
const DEFAULT_MODEL_FILE = 'embeddinggemma-300M-Q8_0.gguf';
const DEFAULT_MODEL_URL =
  'https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf';
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_PORT = 17872;

export function resolveEmbeddingRuntimeConfig(
  hermesHome: string,
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingRuntimeConfig {
  const modelId = env.VERSO_EMBEDDINGS_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
  const modelUrl = env.VERSO_EMBEDDINGS_MODEL_URL?.trim() || DEFAULT_MODEL_URL;
  const modelFile = env.VERSO_EMBEDDINGS_MODEL_FILE?.trim() || DEFAULT_MODEL_FILE;
  const dimensions = readPositiveIntEnv(env.VERSO_EMBEDDINGS_DIMENSIONS, DEFAULT_DIMENSIONS);
  const port = readPositiveIntEnv(env.VERSO_EMBEDDINGS_PORT, DEFAULT_PORT);
  // Same parent directory convention as gbrain-home: a sibling of the Hermes
  // home (e.g. ~/Library/Application Support/Verso/models). Survives app
  // updates because it lives outside the bundle.
  const modelsDir = env.VERSO_EMBEDDINGS_MODELS_DIR?.trim() || join(dirname(hermesHome), 'models');
  const command = resolveLlamaServerCommand(env);

  return {
    enabled,
    modelId,
    modelUrl,
    modelPath: join(modelsDir, modelFile),
    dimensions,
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    command,
    reason: command
      ? null
      : 'llama-server not found. Set VERSO_LLAMA_SERVER_COMMAND or install llama.cpp.',
  };
}

export interface EmbeddingRuntimeOptions {
  fetchImpl?: typeof fetch;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  downloadRetries?: number;
  downloadRetryDelayMs?: number;
  restartDelayMs?: number;
  maxRestarts?: number;
}

export class EmbeddingRuntime {
  readonly config: EmbeddingRuntimeConfig;

  private readonly fetchImpl: typeof fetch;
  private readonly healthIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly downloadRetries: number;
  private readonly downloadRetryDelayMs: number;
  private readonly restartDelayMs: number;
  private readonly maxRestarts: number;

  private state: EmbeddingRuntimeState = 'idle';
  private child: ChildProcess | null = null;
  private restarts = 0;
  private lastError: string | null = null;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly readyListeners: Array<() => void> = [];
  private readonly stderrTail: string[] = [];

  constructor(config: EmbeddingRuntimeConfig, opts: EmbeddingRuntimeOptions = {}) {
    this.config = config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.healthIntervalMs = opts.healthIntervalMs ?? 500;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 120_000;
    this.downloadRetries = opts.downloadRetries ?? 3;
    this.downloadRetryDelayMs = opts.downloadRetryDelayMs ?? 5_000;
    this.restartDelayMs = opts.restartDelayMs ?? 2_000;
    this.maxRestarts = opts.maxRestarts ?? 3;
  }

  getState(): EmbeddingRuntimeState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  /** Fires on every transition into 'ready' (initial start and recoveries). */
  onReady(listener: () => void): void {
    this.readyListeners.push(listener);
  }

  diagnostics(): EmbeddingRuntimeDiagnostics {
    return {
      enabled: this.config.enabled,
      state: this.state,
      modelId: this.config.modelId,
      modelPath: this.config.modelPath,
      modelPresent: existsSync(this.config.modelPath),
      dimensions: this.config.dimensions,
      port: this.config.port,
      baseUrl: this.config.baseUrl,
      command: this.config.command,
      reason: this.config.reason,
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }

  /**
   * Idempotent background start: ensure the model is on disk (downloading it
   * if needed), then spawn llama-server and wait until it reports healthy.
   * Never throws — failures land in `state`/`lastError` diagnostics so the
   * rest of the app keeps working without embeddings.
   */
  start(): Promise<void> {
    if (!this.config.enabled) {
      this.state = 'disabled';
      return Promise.resolve();
    }
    if (!this.config.command) {
      this.state = 'unavailable';
      this.lastError = this.config.reason;
      return Promise.resolve();
    }
    if (this.startPromise) return this.startPromise;

    this.stopping = false;
    this.startPromise = this.startInner()
      .catch((error: unknown) => {
        this.state = 'error';
        this.lastError = formatError(error);
        console.warn(`[embeddings] start failed: ${this.lastError}`);
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    if (this.state !== 'disabled' && this.state !== 'unavailable') {
      this.state = 'idle';
    }
  }

  private async startInner(): Promise<void> {
    await this.ensureModel();
    if (this.stopping) return;
    await this.spawnAndAwaitHealthy();
  }

  private async ensureModel(): Promise<void> {
    if (existsSync(this.config.modelPath)) return;
    this.state = 'downloading';
    console.log(`[embeddings] downloading ${this.config.modelId} from ${this.config.modelUrl}`);

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.downloadRetries; attempt++) {
      if (this.stopping) return;
      try {
        await this.downloadModel();
        console.log(`[embeddings] model ready at ${this.config.modelPath}`);
        return;
      } catch (error: unknown) {
        lastError = error;
        console.warn(
          `[embeddings] download attempt ${attempt}/${this.downloadRetries} failed: ${formatError(error)}`,
        );
        if (attempt < this.downloadRetries) {
          await sleep(this.downloadRetryDelayMs * attempt);
        }
      }
    }
    throw new Error(`model download failed: ${formatError(lastError)}`);
  }

  private async downloadModel(): Promise<void> {
    mkdirSync(dirname(this.config.modelPath), { recursive: true });
    const partialPath = `${this.config.modelPath}.partial`;
    rmSync(partialPath, { force: true });

    const response = await this.fetchImpl(this.config.modelUrl, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} from ${this.config.modelUrl}`);
    }
    const expectedBytes = Number.parseInt(response.headers.get('content-length') ?? '', 10);

    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        createWriteStream(partialPath),
      );
      const actualBytes = statSync(partialPath).size;
      if (actualBytes === 0) {
        throw new Error('downloaded file is empty');
      }
      if (Number.isFinite(expectedBytes) && expectedBytes > 0 && actualBytes !== expectedBytes) {
        throw new Error(`incomplete download: got ${actualBytes} of ${expectedBytes} bytes`);
      }
      renameSync(partialPath, this.config.modelPath);
    } catch (error) {
      rmSync(partialPath, { force: true });
      throw error;
    }
  }

  private async spawnAndAwaitHealthy(): Promise<void> {
    this.state = 'starting';
    const child = spawn(this.config.command!, [
      '--model', this.config.modelPath,
      '--embeddings',
      '--host', '127.0.0.1',
      '--port', String(this.config.port),
      // EmbeddingGemma's context is 2048 tokens; embedding models are
      // non-causal so the micro-batch must hold the longest single input.
      '--ctx-size', '2048',
      '--batch-size', '2048',
      '--ubatch-size', '2048',
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    });
    this.child = child;

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });

    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      this.lastError = `llama-server exited (code=${code ?? 'null'} signal=${signal ?? 'null'}): ${this.stderrTail.slice(-3).join(' | ')}`;
      console.warn(`[embeddings] ${this.lastError}`);
      this.scheduleRestart();
    });

    const healthy = await this.waitForHealthy(child);
    if (!healthy) {
      // waitForHealthy either timed out (kill the child; its exit handler
      // schedules the restart) or the child already exited on its own.
      if (child.exitCode === null && !child.killed) {
        this.lastError = `llama-server did not become healthy within ${this.healthTimeoutMs}ms`;
        console.warn(`[embeddings] ${this.lastError}`);
        child.kill('SIGKILL');
      }
      return;
    }

    this.state = 'ready';
    console.log(`[embeddings] llama-server ready on ${this.config.baseUrl}`);
    for (const listener of this.readyListeners) {
      try {
        listener();
      } catch (error: unknown) {
        console.warn(`[embeddings] onReady listener failed: ${formatError(error)}`);
      }
    }
  }

  private async waitForHealthy(child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (this.stopping || child.exitCode !== null) return false;
      try {
        const res = await this.fetchImpl(`http://127.0.0.1:${this.config.port}/health`);
        if (res.ok) return true;
      } catch {
        // Server not accepting connections yet.
      }
      await sleep(this.healthIntervalMs);
    }
    return false;
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    if (this.restarts >= this.maxRestarts) {
      this.state = 'error';
      console.warn(`[embeddings] giving up after ${this.restarts} restarts`);
      return;
    }
    this.restarts += 1;
    this.state = 'starting';
    const delay = this.restartDelayMs * this.restarts;
    console.log(`[embeddings] restarting llama-server in ${delay}ms (attempt ${this.restarts}/${this.maxRestarts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnAndAwaitHealthy().catch((error: unknown) => {
        this.state = 'error';
        this.lastError = formatError(error);
        console.warn(`[embeddings] restart failed: ${this.lastError}`);
      });
    }, delay);
    this.restartTimer.unref();
  }
}

function resolveLlamaServerCommand(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.VERSO_LLAMA_SERVER_COMMAND?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  const pathValue = env.PATH ?? '';
  for (const entry of pathValue.split(':').filter(Boolean)) {
    const candidate = join(entry, 'llama-server');
    if (existsSync(candidate)) return candidate;
  }
  // Common install locations that may not be on the app's PATH.
  const fallbacks = [
    '/opt/homebrew/bin/llama-server',
    '/usr/local/bin/llama-server',
    join(os.homedir(), '.local', 'bin', 'llama-server'),
  ];
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readPositiveIntEnv(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
