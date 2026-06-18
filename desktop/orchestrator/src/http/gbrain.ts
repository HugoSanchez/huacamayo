import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEmbeddingRuntimeConfig, type EmbeddingRuntimeConfig } from './embeddings.ts';

export interface HermesGatewayConfig {
  baseUrl: string;
  apiKey: string | null;
}

export interface GBrainRuntimeConfig {
  enabled: boolean;
  home: string;
  command: string | null;
  argsPrefix: string[];
  reason: string | null;
  embedding: EmbeddingRuntimeConfig;
}

export interface GBrainDiagnostics {
  enabled: boolean;
  configured: boolean;
  home: string;
  configPath: string;
  command: string | null;
  argsPrefix: string[];
  reason: string | null;
  wantsEmbeddings: boolean;
  embedding: {
    modelId: string;
    dimensions: number;
    baseUrl: string;
    command: string | null;
    reason: string | null;
  };
}

export type GBrainMcpToolMode = 'read' | 'write';

const DEFAULT_SIGNAL_TIMEOUT_MS = 5 * 60_000;
const EMBED_BACKFILL_TIMEOUT_MS = 15 * 60_000;

// Hermes profiles no longer talk to GBrain directly — PGLite is a
// single-process embedded DB, and per-profile `gbrain serve` children
// corrupted it (see memory.ts). The agent-facing surface is now the narrow
// verso bridge tools (search_memory / write_memory_page / …), proxied
// through the orchestrator's single owner process.

const GBRAIN_SOUL_START = '<!-- verso:gbrain-memory:start -->';
const GBRAIN_SOUL_END = '<!-- verso:gbrain-memory:end -->';

const GBRAIN_SOUL_SECTION = [
  '## Your memory',
  '',
  'You have a persistent, private memory of your past conversations with this user, stored locally on their machine. Search it with the search_memory tool and read full entries with get_memory_page.',
  '',
  '- Check memory first — before web search and before answering from general knowledge — whenever your answer could depend on people, companies, projects, decisions, preferences, or anything the user may have discussed with you before.',
  '- When memory informs an answer, weave it in naturally ("From our earlier conversations, ...").',
  '- If memory has nothing relevant, just proceed normally — do not mention the empty lookup.',
].join('\n');

/**
 * Adds/removes the marker-delimited memory section in a SOUL.md document.
 * Idempotent: re-applying replaces the managed block in place, and anything
 * the user wrote outside the markers is preserved verbatim.
 */
export function applyGBrainSoulSection(soul: string, enabled: boolean): string {
  const startIdx = soul.indexOf(GBRAIN_SOUL_START);
  const endIdx = soul.indexOf(GBRAIN_SOUL_END);
  let stripped = soul;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    stripped = soul.slice(0, startIdx).trimEnd() + soul.slice(endIdx + GBRAIN_SOUL_END.length);
  }
  if (!enabled) {
    return stripped.trimEnd() ? `${stripped.trimEnd()}\n` : stripped;
  }
  return [
    stripped.trimEnd(),
    '',
    GBRAIN_SOUL_START,
    GBRAIN_SOUL_SECTION,
    GBRAIN_SOUL_END,
    '',
  ].join('\n');
}

export function isGBrainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VERSO_GBRAIN_ENABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function resolveGBrainRuntimeConfig(
  hermesHome: string,
  env: NodeJS.ProcessEnv = process.env,
): GBrainRuntimeConfig {
  const enabled = isGBrainEnabled(env);
  const explicitHome = env.VERSO_GBRAIN_HOME?.trim();
  const home = explicitHome || join(dirname(hermesHome), 'gbrain-home');
  const explicitCommand = env.VERSO_GBRAIN_COMMAND?.trim();
  const explicitArgs = parseArgs(env.VERSO_GBRAIN_ARGS);
  const embedding = resolveEmbeddingRuntimeConfig(hermesHome, enabled, env);

  if (explicitCommand) {
    return {
      enabled,
      home,
      command: explicitCommand,
      argsPrefix: explicitArgs,
      reason: existsSync(explicitCommand) ? null : `VERSO_GBRAIN_COMMAND does not exist: ${explicitCommand}`,
      embedding,
    };
  }

  const devCheckout = resolveDevGBrainCheckout();
  const bun = findExecutable('bun') || join(os.homedir(), '.bun', 'bin', 'bun');
  if (devCheckout && existsSync(bun)) {
    return {
      enabled,
      home,
      command: bun,
      argsPrefix: [join(devCheckout, 'src', 'cli.ts')],
      reason: null,
      embedding,
    };
  }

  const gbrain = findExecutable('gbrain');
  if (gbrain) {
    return {
      enabled,
      home,
      command: gbrain,
      argsPrefix: [],
      reason: null,
      embedding,
    };
  }

  return {
    enabled,
    home,
    command: null,
    argsPrefix: [],
    reason: 'GBrain command not found. Set VERSO_GBRAIN_COMMAND or install gbrain.',
    embedding,
  };
}

export function ensureGBrainInitialized(config: GBrainRuntimeConfig): void {
  if (!config.enabled || !config.command) return;
  if (existsSync(gbrainConfigPath(config.home))) {
    if (!shouldMigrateToEmbeddings(config)) return;
    backupGBrainState(config.home);
  }

  mkdirSync(config.home, { recursive: true });
  const init = runGBrain(config, buildInitArgs(config.embedding));
  if (init.status !== 0) {
    console.warn(`[gbrain] init failed: ${formatSpawnFailure(init)}`);
    return;
  }

  const mode = runGBrain(config, ['config', 'set', 'search.mode', 'conservative']);
  if (mode.status !== 0) {
    console.warn(`[gbrain] search mode setup failed: ${formatSpawnFailure(mode)}`);
  }
}

/**
 * Whether the brain at `home` was initialized with an embedding model.
 * Embedding dimensions size the schema at init time, so this reflects what
 * put_page/search will actually do, not what the runtime could do.
 */
export function gbrainWantsEmbeddings(home: string): boolean {
  const parsed = readGBrainConfig(home);
  return typeof parsed?.embedding_model === 'string' && parsed.embedding_model.length > 0;
}

/**
 * Re-embeds pages whose chunks are missing or stale (e.g. written while the
 * embedding server was briefly down). Runs the gbrain CLI asynchronously so
 * a large backfill never blocks the orchestrator.
 */
export function runGBrainEmbedBackfill(config: GBrainRuntimeConfig): Promise<{ ok: boolean; detail: string }> {
  if (!config.enabled || !config.command) {
    return Promise.resolve({ ok: false, detail: 'GBrain not available' });
  }
  if (!gbrainWantsEmbeddings(config.home)) {
    return Promise.resolve({ ok: false, detail: 'Brain initialized without embeddings' });
  }

  return new Promise((resolvePromise) => {
    const child = spawn(config.command!, [...config.argsPrefix, 'embed', '--stale'], {
      env: gbrainEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    const collect = (chunk: Buffer) => {
      output.push(chunk.toString('utf8'));
      if (output.length > 50) output.shift();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, EMBED_BACKFILL_TIMEOUT_MS);
    timeout.unref();

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolvePromise({ ok: false, detail: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      const detail = output.join('').trim().split('\n').slice(-5).join('\n');
      resolvePromise({ ok: code === 0, detail: detail || `exit code ${code}` });
    });
  });
}

function buildInitArgs(embedding: EmbeddingRuntimeConfig): string[] {
  if (embeddingConfigured(embedding)) {
    return [
      'init', '--pglite',
      // The `ollama` recipe speaks the same OpenAI-compatible embeddings wire
      // as our supervised llama-server; OLLAMA_BASE_URL (set in gbrainEnv and
      // the MCP server env) points it at the local port. See embeddings.ts
      // for why we avoid gbrain's `llama-server` recipe.
      '--embedding-model', `ollama:${embedding.modelId}`,
      '--embedding-dimensions', String(embedding.dimensions),
      // The model may still be downloading at init time; the runtime gates
      // extraction until the server is healthy, so skip the init-time probe.
      '--skip-embed-check',
      '--non-interactive',
    ];
  }
  return ['init', '--pglite', '--no-embedding', '--non-interactive'];
}

function embeddingConfigured(embedding: EmbeddingRuntimeConfig): boolean {
  return embedding.enabled && embedding.command !== null;
}

/**
 * Pre-embeddings dev installs were initialized with `--no-embedding`, and
 * gbrain bakes embedding dimensions into the PGLite schema at init time
 * (`config set embedding_model` is hard-refused upstream). When this machine
 * can now run the local embedding stack, take the documented wipe-and-reinit
 * path: back up the old state and re-init with embeddings.
 */
function shouldMigrateToEmbeddings(config: GBrainRuntimeConfig): boolean {
  if (!embeddingConfigured(config.embedding)) return false;
  return readGBrainConfig(config.home)?.embedding_disabled === true;
}

function backupGBrainState(home: string): void {
  const stateDir = join(home, '.gbrain');
  const backupDir = join(home, `.gbrain.pre-embeddings-${Date.now()}.bak`);
  try {
    renameSync(stateDir, backupDir);
    console.log(`[gbrain] migrating to embeddings; previous state backed up at ${backupDir}`);
  } catch (error: unknown) {
    console.warn(`[gbrain] state backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readGBrainConfig(home: string): { embedding_model?: string; embedding_disabled?: boolean } | null {
  try {
    return JSON.parse(readFileSync(gbrainConfigPath(home), 'utf8')) as {
      embedding_model?: string;
      embedding_disabled?: boolean;
    };
  } catch {
    return null;
  }
}

/**
 * Env for any process that owns the brain (the serve child, init/backfill
 * CLI calls). OLLAMA_BASE_URL points the `ollama` embedding recipe at
 * Verso's supervised local llama-server; harmless when the brain was
 * initialized without embeddings.
 */
export function gbrainEnv(config: GBrainRuntimeConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GBRAIN_HOME: config.home,
    OLLAMA_BASE_URL: config.embedding.baseUrl,
  };
}

export function getGBrainDiagnostics(hermesHome: string): GBrainDiagnostics {
  const config = resolveGBrainRuntimeConfig(hermesHome);
  return {
    enabled: config.enabled,
    configured: Boolean(config.command && existsSync(gbrainConfigPath(config.home))),
    home: config.home,
    configPath: gbrainConfigPath(config.home),
    command: config.command,
    argsPrefix: config.argsPrefix,
    reason: config.reason,
    wantsEmbeddings: gbrainWantsEmbeddings(config.home),
    embedding: {
      modelId: config.embedding.modelId,
      dimensions: config.embedding.dimensions,
      baseUrl: config.embedding.baseUrl,
      command: config.embedding.command,
      reason: config.embedding.reason,
    },
  };
}

export function runGBrainSignalDetection(
  config: HermesGatewayConfig,
  opts: {
    sessionId: string;
    title: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }>;
    timestamp?: Date;
  },
): Promise<void> {
  if (!isGBrainEnabled()) return Promise.resolve();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), signalDetectionTimeoutMs());
  const timestamp = opts.timestamp ?? new Date();
  const conversation = `verso-gbrain-${opts.sessionId}-${timestamp.getTime()}`;

  return fetch(`${config.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...hermesGatewayAuthHeaders(config) },
    body: JSON.stringify({
      conversation,
      input: buildSignalDetectionPrompt({
        sessionId: opts.sessionId,
        title: opts.title,
        messages: opts.messages,
        timestamp,
      }),
      truncation: 'auto',
      stream: false,
      store: false,
    }),
    signal: controller.signal,
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GBrain signal detection failed HTTP ${res.status}${body ? `: ${body}` : ''}`);
    }
    await res.arrayBuffer().catch(() => undefined);
    console.log(`[gbrain] signal detection completed for session ${opts.sessionId}`);
  }).catch((error: unknown) => {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`GBrain signal detection timed out for session ${opts.sessionId}`);
    }
    throw error;
  }).finally(() => {
    clearTimeout(timeout);
  });
}

function signalDetectionTimeoutMs(): number {
  const raw = process.env.VERSO_GBRAIN_SIGNAL_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_SIGNAL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SIGNAL_TIMEOUT_MS;
}

function hermesGatewayAuthHeaders(config: HermesGatewayConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

function buildSignalDetectionPrompt(opts: {
  sessionId: string;
  title: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }>;
  timestamp: Date;
}): string {
  const { sessionId, title, messages, timestamp } = opts;
  const isoDate = timestamp.toISOString().slice(0, 10);
  const transcript = messages.map((message, index) => [
    `### Message ${index + 1}`,
    `role: ${message.role}`,
    `created_at: ${message.createdAt}`,
    '',
    message.content,
  ].join('\n')).join('\n\n');
  return [
    'You are running the Verso memory signal-detector silently in the background.',
    '',
    'Scan this idle conversation segment for original thinking, durable facts, decisions, preferences, commitments, and notable entity mentions.',
    'Use the verso memory tools (search_memory, get_memory_page, write_memory_page, add_memory_link, add_memory_timeline, log_memory_ingest). Do not answer the user.',
    '',
    'Session context:',
    `- Verso session id: ${sessionId}`,
    `- Session title: ${title || 'Untitled chat'}`,
    `- Extraction date: ${isoDate}`,
    '',
    'Required behavior:',
    '- First call search_memory for each notable person/company/concept before creating pages.',
    '- Create or update useful pages with write_memory_page only when the segment contains durable information worth remembering.',
    '- Page writes do not create links or timeline entries automatically; explicitly call add_memory_link and add_memory_timeline where applicable.',
    '- Add citations for every fact using this source format:',
    `  [Source: User, Verso chat, ${isoDate}]`,
    '- Log the ingest with one concise signal summary via log_memory_ingest.',
    '- If there is nothing to capture, do not write pages; just log a zero-signal summary.',
    '',
    'Conversation segment:',
    transcript,
  ].join('\n');
}

export function runGBrainSourceIngestion(
  config: HermesGatewayConfig,
  opts: {
    source: string;
    stream: string;
    items: Array<{ sourceRef: string; occurredAt: string; content: string }>;
    timestamp?: Date;
  },
): Promise<void> {
  if (!isGBrainEnabled()) return Promise.resolve();
  if (opts.items.length === 0) return Promise.resolve();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), signalDetectionTimeoutMs());
  const timestamp = opts.timestamp ?? new Date();
  const streamSuffix = opts.stream ? `-${opts.stream}` : '';
  const conversation = `verso-ingest-${opts.source}${streamSuffix}-${timestamp.getTime()}`;

  return fetch(`${config.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...hermesGatewayAuthHeaders(config) },
    body: JSON.stringify({
      conversation,
      input: buildSourceIngestionPrompt({
        source: opts.source,
        stream: opts.stream,
        items: opts.items,
        timestamp,
      }),
      truncation: 'auto',
      stream: false,
      store: false,
    }),
    signal: controller.signal,
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GBrain source ingestion failed HTTP ${res.status}${body ? `: ${body}` : ''}`);
    }
    await res.arrayBuffer().catch(() => undefined);
    console.log(`[gbrain] source ingestion completed for ${opts.source}${streamSuffix} (${opts.items.length} items)`);
  }).catch((error: unknown) => {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`GBrain source ingestion timed out for ${opts.source}${streamSuffix}`);
    }
    throw error;
  }).finally(() => {
    clearTimeout(timeout);
  });
}

function sourceDisplayName(source: string): string {
  const known: Record<string, string> = {
    gmail: 'Gmail',
    slack: 'Slack',
    granola: 'Granola',
    granola_mcp: 'Granola',
  };
  return known[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

// Source ingestion is PAGES-ONLY in v1: every write is an idempotent put_page,
// so a re-run after a mid-batch timeout produces no duplicates. add_timeline_entry
// appends and is not idempotent, so the prompt forbids it until the timeline tool
// accepts an idempotency key (v2). Dated info is preserved inside the page body.
export function buildSourceIngestionPrompt(opts: {
  source: string;
  stream: string;
  items: Array<{ sourceRef: string; occurredAt: string; content: string }>;
  timestamp: Date;
}): string {
  const { source, stream, items, timestamp } = opts;
  const isoDate = timestamp.toISOString().slice(0, 10);
  const display = sourceDisplayName(source);
  const sourceType = `verso_${source}_ingest`;
  const body = items.map((item, index) => [
    `### Item ${index + 1}`,
    `source_ref: ${item.sourceRef}`,
    item.occurredAt ? `occurred_at: ${item.occurredAt}` : '',
    '',
    item.content,
  ].filter((line) => line !== '').join('\n')).join('\n\n');

  return [
    `You are running the Verso memory signal-detector silently in the background, ingesting new items from ${display}${stream ? ` (${stream})` : ''}.`,
    '',
    'Scan these items for original thinking, durable facts, decisions, preferences, commitments, and notable entity mentions worth remembering long-term. Most items will have little or nothing durable — that is expected.',
    'Use the verso memory tools: search_memory, get_memory_page, write_memory_page, add_memory_link, log_memory_ingest. Do not answer or reply to anyone.',
    '',
    'Source context:',
    `- Source: ${display}${stream ? ` / ${stream}` : ''}`,
    `- Ingestion date: ${isoDate}`,
    '',
    'Required behavior:',
    '- First call search_memory for each notable person/company/concept before creating pages.',
    '- Create or update useful pages with write_memory_page only when an item contains durable information worth remembering.',
    '- Page writes do not create links automatically; explicitly call add_memory_link where applicable.',
    '- Do NOT call add_memory_timeline: timeline writes are disabled for source ingestion (append-only, not idempotent on retry). Put any dated detail inside the page body instead.',
    '- Add citations for every fact using this source format:',
    `  [Source: ${display}, <item occurred_at date>]`,
    `- Log exactly one ingest summary via log_memory_ingest with source_type "${sourceType}", referencing the source_refs you processed.`,
    '- If there is nothing durable to capture, do not write pages; just log a zero-signal summary.',
    '',
    `${display} items:`,
    body,
  ].join('\n');
}

function gbrainConfigPath(home: string): string {
  return join(home, '.gbrain', 'config.json');
}

function runGBrain(config: GBrainRuntimeConfig, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(config.command ?? '', [...config.argsPrefix, ...args], {
    env: gbrainEnv(config),
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function formatSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  if (result.error) return result.error.message;
  return [
    `status=${result.status ?? 'unknown'}`,
    outputText(result.stderr).trim(),
    outputText(result.stdout).trim(),
  ].filter(Boolean).join(' ');
}

function outputText(value: string | Buffer | null | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.toString('utf8');
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Fall back to whitespace splitting for simple local testing.
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function resolveDevGBrainCheckout(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(currentDir, '..', '..', '..', '..');
  const candidate = join(repoRoot, '.context', 'external', 'gbrain-latest');
  return existsSync(join(candidate, 'src', 'cli.ts')) ? candidate : null;
}

function findExecutable(name: string): string | null {
  const pathValue = process.env.PATH ?? '';
  for (const entry of pathValue.split(':').filter(Boolean)) {
    const candidate = join(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
