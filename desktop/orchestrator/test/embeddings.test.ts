import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EmbeddingRuntime,
  resolveEmbeddingRuntimeConfig,
  type EmbeddingRuntimeConfig,
} from '../src/http/embeddings.ts';

const EMBEDDING_ENV_KEYS = [
  'VERSO_EMBEDDINGS_MODEL_ID',
  'VERSO_EMBEDDINGS_MODEL_URL',
  'VERSO_EMBEDDINGS_MODEL_FILE',
  'VERSO_EMBEDDINGS_MODELS_DIR',
  'VERSO_EMBEDDINGS_DIMENSIONS',
  'VERSO_EMBEDDINGS_PORT',
  'VERSO_LLAMA_SERVER_COMMAND',
] as const;

let tempRoot = '';
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-embeddings-test-'));
  envSnapshot = {};
  for (const key of EMBEDDING_ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

function hermesHome(): string {
  return path.join(tempRoot, 'hermes-home');
}

describe('resolveEmbeddingRuntimeConfig', () => {
  it('resolves defaults relative to the Hermes home parent', () => {
    const config = resolveEmbeddingRuntimeConfig(hermesHome(), true, {});

    expect(config.enabled).toBe(true);
    expect(config.modelId).toBe('embeddinggemma-300m');
    expect(config.modelUrl).toContain('huggingface.co');
    expect(config.modelPath).toBe(path.join(tempRoot, 'models', 'embeddinggemma-300M-Q8_0.gguf'));
    expect(config.dimensions).toBe(768);
    expect(config.port).toBe(17872);
    expect(config.baseUrl).toBe('http://127.0.0.1:17872/v1');
  });

  it('honors env overrides', () => {
    const config = resolveEmbeddingRuntimeConfig(hermesHome(), true, {
      VERSO_EMBEDDINGS_MODEL_ID: 'custom-model',
      VERSO_EMBEDDINGS_MODEL_URL: 'https://example.com/custom.gguf',
      VERSO_EMBEDDINGS_MODEL_FILE: 'custom.gguf',
      VERSO_EMBEDDINGS_MODELS_DIR: path.join(tempRoot, 'elsewhere'),
      VERSO_EMBEDDINGS_DIMENSIONS: '1024',
      VERSO_EMBEDDINGS_PORT: '19999',
      VERSO_LLAMA_SERVER_COMMAND: '/bin/echo',
    });

    expect(config.modelId).toBe('custom-model');
    expect(config.modelUrl).toBe('https://example.com/custom.gguf');
    expect(config.modelPath).toBe(path.join(tempRoot, 'elsewhere', 'custom.gguf'));
    expect(config.dimensions).toBe(1024);
    expect(config.port).toBe(19999);
    expect(config.baseUrl).toBe('http://127.0.0.1:19999/v1');
    expect(config.command).toBe('/bin/echo');
    expect(config.reason).toBeNull();
  });

  it('rejects an explicit command that does not exist', () => {
    const config = resolveEmbeddingRuntimeConfig(hermesHome(), true, {
      VERSO_LLAMA_SERVER_COMMAND: path.join(tempRoot, 'nope', 'llama-server'),
    });

    expect(config.command).toBeNull();
    expect(config.reason).toContain('llama-server not found');
  });

  it('falls back to invalid-value defaults for malformed numeric envs', () => {
    const config = resolveEmbeddingRuntimeConfig(hermesHome(), true, {
      VERSO_EMBEDDINGS_DIMENSIONS: 'not-a-number',
      VERSO_EMBEDDINGS_PORT: '-5',
    });

    expect(config.dimensions).toBe(768);
    expect(config.port).toBe(17872);
  });

  it('finds llama-server on PATH', () => {
    const binDir = path.join(tempRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeBinary = path.join(binDir, 'llama-server');
    writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(fakeBinary, 0o755);

    const config = resolveEmbeddingRuntimeConfig(hermesHome(), true, { PATH: binDir });
    expect(config.command).toBe(fakeBinary);
  });
});

/**
 * Writes a fake llama-server: a shell wrapper around a node script that
 * parses --port and serves 200 on /health, exactly like the real binary's
 * readiness surface.
 */
function writeFakeLlamaServer(opts: { exitImmediately?: boolean } = {}): string {
  const serverScript = path.join(tempRoot, 'fake-llama-server.mjs');
  writeFileSync(serverScript, [
    "import http from 'node:http';",
    `const exitImmediately = ${opts.exitImmediately ? 'true' : 'false'};`,
    'if (exitImmediately) process.exit(7);',
    "const portIdx = process.argv.indexOf('--port');",
    'const port = Number(process.argv[portIdx + 1]);',
    'http.createServer((req, res) => {',
    "  res.writeHead(200, { 'Content-Type': 'text/plain' });",
    "  res.end('ok');",
    "}).listen(port, '127.0.0.1');",
  ].join('\n'), 'utf8');

  const wrapper = path.join(tempRoot, 'fake-llama-server.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${serverScript}" "$@"\n`, 'utf8');
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function testPort(): number {
  return 18000 + Math.floor(Math.random() * 10_000);
}

function runtimeConfig(overrides: Partial<EmbeddingRuntimeConfig> = {}): EmbeddingRuntimeConfig {
  const port = overrides.port ?? testPort();
  return {
    enabled: true,
    modelId: 'embeddinggemma-300m',
    modelUrl: 'https://example.com/model.gguf',
    modelPath: path.join(tempRoot, 'models', 'model.gguf'),
    dimensions: 768,
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    command: null,
    reason: null,
    ...overrides,
  };
}

function fakeModelResponse(bytes: Buffer, opts: { contentLength?: number; status?: number } = {}): Response {
  const headers = new Headers();
  if (opts.contentLength !== undefined) headers.set('content-length', String(opts.contentLength));
  return new Response(opts.status && opts.status >= 400 ? null : bytes, {
    status: opts.status ?? 200,
    headers,
  });
}

describe('EmbeddingRuntime', () => {
  let runtime: EmbeddingRuntime | null = null;

  afterEach(async () => {
    await runtime?.stop();
    runtime = null;
  });

  it('reports disabled without touching anything when not enabled', async () => {
    runtime = new EmbeddingRuntime(runtimeConfig({ enabled: false, command: '/bin/echo' }));
    await runtime.start();

    expect(runtime.getState()).toBe('disabled');
    expect(runtime.isReady()).toBe(false);
  });

  it('reports unavailable when llama-server is missing', async () => {
    runtime = new EmbeddingRuntime(runtimeConfig({ command: null, reason: 'llama-server not found.' }));
    await runtime.start();

    expect(runtime.getState()).toBe('unavailable');
    expect(runtime.diagnostics().lastError).toContain('llama-server not found');
  });

  it('starts, becomes ready, fires onReady, and stops cleanly', async () => {
    const command = writeFakeLlamaServer();
    const config = runtimeConfig({ command });
    mkdirSync(path.dirname(config.modelPath), { recursive: true });
    writeFileSync(config.modelPath, 'fake-gguf', 'utf8');

    runtime = new EmbeddingRuntime(config, { healthIntervalMs: 50, healthTimeoutMs: 10_000 });
    let readyFired = 0;
    runtime.onReady(() => { readyFired += 1; });

    await runtime.start();

    expect(runtime.getState()).toBe('ready');
    expect(runtime.isReady()).toBe(true);
    expect(readyFired).toBe(1);

    const diagnostics = runtime.diagnostics();
    expect(diagnostics.state).toBe('ready');
    expect(diagnostics.modelPresent).toBe(true);
    expect(diagnostics.restarts).toBe(0);

    await runtime.stop();
    expect(runtime.isReady()).toBe(false);
  });

  it('start is idempotent while a start is in flight', async () => {
    const command = writeFakeLlamaServer();
    const config = runtimeConfig({ command });
    mkdirSync(path.dirname(config.modelPath), { recursive: true });
    writeFileSync(config.modelPath, 'fake-gguf', 'utf8');

    runtime = new EmbeddingRuntime(config, { healthIntervalMs: 50, healthTimeoutMs: 10_000 });
    const [first, second] = [runtime.start(), runtime.start()];
    await Promise.all([first, second]);

    expect(runtime.getState()).toBe('ready');
  });

  it('downloads the model when missing, then becomes ready', async () => {
    const command = writeFakeLlamaServer();
    const config = runtimeConfig({ command });
    const modelBytes = Buffer.from('gguf-bytes-payload');

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === config.modelUrl) {
        return fakeModelResponse(modelBytes, { contentLength: modelBytes.length });
      }
      return fetch(input, init);
    };

    runtime = new EmbeddingRuntime(config, { fetchImpl, healthIntervalMs: 50, healthTimeoutMs: 10_000 });
    await runtime.start();

    expect(runtime.getState()).toBe('ready');
    expect(readFileSync(config.modelPath, 'utf8')).toBe('gguf-bytes-payload');
    expect(existsSync(`${config.modelPath}.partial`)).toBe(false);
  });

  it('retries failed downloads and lands in error state when they keep failing', async () => {
    const config = runtimeConfig({ command: '/bin/echo' });
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      return fakeModelResponse(Buffer.alloc(0), { status: 503 });
    };

    runtime = new EmbeddingRuntime(config, {
      fetchImpl,
      downloadRetries: 3,
      downloadRetryDelayMs: 1,
    });
    await runtime.start();

    expect(attempts).toBe(3);
    expect(runtime.getState()).toBe('error');
    expect(runtime.diagnostics().lastError).toContain('model download failed');
    expect(existsSync(config.modelPath)).toBe(false);
  });

  it('rejects truncated downloads and cleans up the partial file', async () => {
    const config = runtimeConfig({ command: '/bin/echo' });
    const fetchImpl: typeof fetch = async () =>
      fakeModelResponse(Buffer.from('short'), { contentLength: 9999 });

    runtime = new EmbeddingRuntime(config, {
      fetchImpl,
      downloadRetries: 1,
      downloadRetryDelayMs: 1,
    });
    await runtime.start();

    expect(runtime.getState()).toBe('error');
    expect(runtime.diagnostics().lastError).toContain('incomplete download');
    expect(existsSync(config.modelPath)).toBe(false);
    expect(existsSync(`${config.modelPath}.partial`)).toBe(false);
  });

  it('schedules restarts when the server exits and gives up after maxRestarts', async () => {
    const command = writeFakeLlamaServer({ exitImmediately: true });
    const config = runtimeConfig({ command });
    mkdirSync(path.dirname(config.modelPath), { recursive: true });
    writeFileSync(config.modelPath, 'fake-gguf', 'utf8');

    runtime = new EmbeddingRuntime(config, {
      healthIntervalMs: 20,
      healthTimeoutMs: 2_000,
      restartDelayMs: 10,
      maxRestarts: 1,
    });
    await runtime.start();

    // The child exits immediately; wait for the (single) restart attempt to
    // also fail, then the runtime gives up.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const diagnostics = runtime.diagnostics();
    expect(diagnostics.restarts).toBe(1);
    expect(diagnostics.state).toBe('error');
    expect(diagnostics.lastError).toContain('llama-server exited');
  });
});
