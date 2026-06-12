import { spawn, type ChildProcess } from 'node:child_process';
import { gbrainEnv, type GBrainRuntimeConfig } from './gbrain.ts';
import { json, route, type Route } from './router.ts';

/**
 * Single-owner GBrain access.
 *
 * GBrain's local engine is PGLite — embedded Postgres over WASM, a
 * single-process database, not a server. The first integration let every
 * Hermes profile spawn its own `gbrain serve` (plus CLI calls from the
 * orchestrator), and the contending owners corrupted the brain's data
 * directory. This module makes the orchestrator the ONE owner: it supervises
 * a single long-lived `gbrain serve` child, speaks MCP over stdio to it, and
 * exposes a narrow product-shaped HTTP surface (/memory/*) that the verso
 * MCP bridge proxies to Hermes as search_memory / write_memory_page / etc.
 *
 * Nothing else may open the brain while the child runs — CLI work (init,
 * embed backfill) happens in the `prepare` hook strictly before the child
 * spawns.
 */

export type MemoryRuntimeState = 'idle' | 'disabled' | 'unavailable' | 'starting' | 'ready' | 'error';

export interface MemoryRuntimeDiagnostics {
  enabled: boolean;
  state: MemoryRuntimeState;
  pid: number | null;
  restarts: number;
  reason: string | null;
  lastError: string | null;
}

export interface MemoryRuntimeOptions {
  /** Runs before the serve child spawns (init, backfill). CLI access to the brain is only safe here. */
  prepare?: () => Promise<void> | void;
  requestTimeoutMs?: number;
  initTimeoutMs?: number;
  restartDelayMs?: number;
  maxRestarts?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class GBrainMemoryRuntime {
  readonly config: GBrainRuntimeConfig;

  private readonly prepare: (() => Promise<void> | void) | null;
  private readonly requestTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly restartDelayMs: number;
  private readonly maxRestarts: number;

  private state: MemoryRuntimeState = 'idle';
  private child: ChildProcess | null = null;
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrTail: string[] = [];
  private restarts = 0;
  private lastError: string | null = null;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private prepared = false;

  constructor(config: GBrainRuntimeConfig, opts: MemoryRuntimeOptions = {}) {
    this.config = config;
    this.prepare = opts.prepare ?? null;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.initTimeoutMs = opts.initTimeoutMs ?? 60_000;
    this.restartDelayMs = opts.restartDelayMs ?? 2_000;
    this.maxRestarts = opts.maxRestarts ?? 3;
  }

  getState(): MemoryRuntimeState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  diagnostics(): MemoryRuntimeDiagnostics {
    return {
      enabled: this.config.enabled,
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      reason: this.config.reason,
      lastError: this.lastError,
    };
  }

  /** Idempotent background start. Never throws — failures land in diagnostics. */
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
        console.warn(`[memory] start failed: ${this.lastError}`);
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
    this.rejectAllPending(new Error('Memory runtime is shutting down'));
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

  /**
   * Call one gbrain MCP tool and return its parsed result. Rejects when the
   * runtime is not ready, the tool reports an error, or the request times out.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.isReady() || !this.child) {
      throw new Error(`Memory is not available (state: ${this.state})`);
    }
    const result = await this.sendRequest('tools/call', { name, arguments: args }) as {
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };

    const text = result?.content?.find((item) => item?.type === 'text')?.text;
    if (result?.isError) {
      throw new Error(text || `gbrain tool ${name} failed`);
    }
    if (result?.structuredContent !== undefined) return result.structuredContent;
    if (typeof text === 'string') {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return result;
  }

  private async startInner(): Promise<void> {
    this.state = 'starting';
    if (!this.prepared && this.prepare) {
      // CLI work against the brain is only safe while no serve child exists.
      await this.prepare();
      this.prepared = true;
    }
    if (this.stopping) return;
    await this.spawnAndHandshake();
  }

  private async spawnAndHandshake(): Promise<void> {
    this.state = 'starting';
    const child = spawn(this.config.command!, [...this.config.argsPrefix, 'serve'], {
      env: { ...gbrainEnv(this.config), MCP_STDIO: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stdoutBuffer = '';

    child.stdout?.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });

    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.rejectAllPending(new Error('gbrain serve exited'));
      if (this.stopping) return;
      this.lastError = `gbrain serve exited (code=${code ?? 'null'} signal=${signal ?? 'null'}): ${this.stderrTail.slice(-3).join(' | ')}`;
      console.warn(`[memory] ${this.lastError}`);
      this.scheduleRestart();
    });

    try {
      await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'verso-orchestrator', version: '1.0.0' },
      }, this.initTimeoutMs);
      this.sendNotification('notifications/initialized', {});
    } catch (error: unknown) {
      this.lastError = `gbrain serve handshake failed: ${formatError(error)}`;
      console.warn(`[memory] ${this.lastError}`);
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
      return;
    }

    this.state = 'ready';
    console.log(`[memory] gbrain serve ready (pid ${child.pid})`);
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    if (this.restarts >= this.maxRestarts) {
      this.state = 'error';
      console.warn(`[memory] giving up after ${this.restarts} restarts`);
      return;
    }
    this.restarts += 1;
    this.state = 'starting';
    const delay = this.restartDelayMs * this.restarts;
    console.log(`[memory] restarting gbrain serve in ${delay}ms (attempt ${this.restarts}/${this.maxRestarts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnAndHandshake().catch((error: unknown) => {
        this.state = 'error';
        this.lastError = formatError(error);
        console.warn(`[memory] restart failed: ${this.lastError}`);
      });
    }, delay);
    this.restartTimer.unref();
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    let newlineIdx = this.stdoutBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (line) this.handleMessage(line);
      newlineIdx = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleMessage(line: string): void {
    let message: { id?: number | string; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // Non-JSON output on stdout; ignore.
    }
    if (message.id === undefined || message.id === null) return; // notification
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || 'gbrain serve returned an error'));
    } else {
      pending.resolve(message.result);
    }
  }

  private sendRequest(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin?.writable) {
      return Promise.reject(new Error('gbrain serve is not running'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gbrain ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// HTTP surface — what the verso MCP bridge calls.
// ---------------------------------------------------------------------------

const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_RESULTS = 6;
const MAX_SNIPPET_CHARS = 700;
const MAX_PAGE_CHARS = 20_000;

export function buildMemoryRoutes(memory: GBrainMemoryRuntime): Route[] {
  return [
    route('GET', '/memory/status', async (_req, res) => {
      json(res, 200, { ok: true, ...memory.diagnostics() });
    }),

    route('POST', '/memory/search', async (_req, res, _params, body) => {
      const payload = asRecord(body);
      const query = readString(payload, 'query');
      if (!query) return badRequest(res, 'query is required');
      const limit = clampInt(payload?.limit, 1, MAX_SEARCH_RESULTS, DEFAULT_SEARCH_RESULTS);

      await respondWithTool(res, memory, 'search', { query, limit }, (result) => ({
        results: normalizeSearchResults(result),
      }));
    }),

    route('POST', '/memory/page', async (_req, res, _params, body) => {
      const payload = asRecord(body);
      const slug = readString(payload, 'slug');
      if (!slug) return badRequest(res, 'slug is required');

      await respondWithTool(res, memory, 'get_page', { slug, fuzzy: true }, (result) => ({
        page: truncatePage(result),
      }));
    }),

    route('POST', '/memory/write-page', async (_req, res, _params, body) => {
      const payload = asRecord(body);
      const slug = readString(payload, 'slug');
      const content = readString(payload, 'content');
      if (!slug || !content) return badRequest(res, 'slug and content are required');

      await respondWithTool(res, memory, 'put_page', { slug, content }, (result) => ({ result }));
    }),

    route('POST', '/memory/link', async (_req, res, _params, body) => {
      const payload = asRecord(body);
      const from = readString(payload, 'from');
      const to = readString(payload, 'to');
      if (!from || !to) return badRequest(res, 'from and to are required');
      const linkType = readString(payload, 'link_type');
      const context = readString(payload, 'context');

      await respondWithTool(res, memory, 'add_link', {
        from,
        to,
        ...(linkType ? { link_type: linkType } : {}),
        ...(context ? { context } : {}),
      }, (result) => ({ result }));
    }),

    route('POST', '/memory/timeline', async (_req, res, _params, body) => {
      const payload = asRecord(body);
      const slug = readString(payload, 'slug');
      const date = readString(payload, 'date');
      const summary = readString(payload, 'summary');
      if (!slug || !date || !summary) return badRequest(res, 'slug, date and summary are required');
      const detail = readString(payload, 'detail');

      await respondWithTool(res, memory, 'add_timeline_entry', {
        slug,
        date,
        summary,
        ...(detail ? { detail } : {}),
      }, (result) => ({ result }));
    }),

    route('POST', '/memory/ingest-log', async (_req, res, _params, body) => {
      const payload = asRecord(body);
      const sourceRef = readString(payload, 'source_ref');
      const summary = readString(payload, 'summary');
      if (!sourceRef || !summary) return badRequest(res, 'source_ref and summary are required');
      const pagesUpdated = Array.isArray(payload?.pages_updated)
        ? payload!.pages_updated.filter((item): item is string => typeof item === 'string')
        : [];

      await respondWithTool(res, memory, 'log_ingest', {
        source_type: readString(payload, 'source_type') || 'verso_chat_signal_detector',
        source_ref: sourceRef,
        pages_updated: pagesUpdated,
        summary,
      }, (result) => ({ result }));
    }),
  ];
}

async function respondWithTool(
  res: Parameters<Route['handler']>[1],
  memory: GBrainMemoryRuntime,
  tool: string,
  args: Record<string, unknown>,
  shape: (result: unknown) => Record<string, unknown>,
): Promise<void> {
  if (!memory.isReady()) {
    json(res, 503, {
      ok: false,
      error: 'memory_unavailable',
      message: `Memory is not available right now (state: ${memory.getState()}).`,
    });
    return;
  }
  try {
    const result = await memory.callTool(tool, args);
    json(res, 200, { ok: true, ...shape(result) });
  } catch (error: unknown) {
    json(res, 502, {
      ok: false,
      error: 'memory_tool_failed',
      message: formatError(error),
    });
  }
}

/**
 * Keep the agent-facing payload compact: whitelisted fields, capped snippet
 * lengths. Raw gbrain search rows carry full chunk text and internal scoring
 * columns we don't want re-expanded into the model context.
 */
function normalizeSearchResults(result: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray(asRecord(result)?.results)
      ? (asRecord(result)!.results as unknown[])
      : [];
  return rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => row !== null)
    .map((row) => {
      const snippetSource = [row.snippet, row.chunk_text, row.text, row.content]
        .find((value): value is string => typeof value === 'string' && value.length > 0);
      const out: Record<string, unknown> = {
        slug: row.slug ?? null,
        title: row.title ?? null,
        score: typeof row.score === 'number' ? Math.round(row.score * 10_000) / 10_000 : undefined,
        snippet: snippetSource ? truncate(snippetSource, MAX_SNIPPET_CHARS) : undefined,
      };
      return out;
    });
}

function truncatePage(result: unknown): unknown {
  const page = asRecord(result);
  if (!page) return result;
  const out: Record<string, unknown> = { ...page };
  for (const key of ['content', 'compiled_truth', 'markdown']) {
    if (typeof out[key] === 'string') {
      out[key] = truncate(out[key] as string, MAX_PAGE_CHARS);
    }
  }
  return out;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

function badRequest(res: Parameters<Route['handler']>[1], message: string): void {
  json(res, 400, { ok: false, error: 'invalid_request', message });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
