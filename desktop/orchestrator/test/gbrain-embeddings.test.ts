import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyGBrainSoulSection,
  ensureGBrainInitialized,
  gbrainMcpServerConfig,
  gbrainWantsEmbeddings,
  resolveGBrainRuntimeConfig,
  runGBrainEmbedBackfill,
  GBRAIN_READ_ONLY_TOOLS,
} from '../src/http/gbrain.ts';

const ENV_KEYS = [
  'VERSO_GBRAIN_ENABLED',
  'VERSO_GBRAIN_HOME',
  'VERSO_GBRAIN_COMMAND',
  'VERSO_GBRAIN_ARGS',
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
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-gbrain-test-'));
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
  process.env.VERSO_GBRAIN_ENABLED = '1';
  process.env.VERSO_GBRAIN_HOME = gbrainHome();
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

function gbrainHome(): string {
  return path.join(tempRoot, 'gbrain-home');
}

function logPath(): string {
  return path.join(tempRoot, 'gbrain-calls.log');
}

function readLog(): string[] {
  if (!existsSync(logPath())) return [];
  return readFileSync(logPath(), 'utf8').trim().split('\n').filter(Boolean);
}

/**
 * Fake gbrain CLI: records every invocation (args + the env we care about)
 * and mimics `init` by writing a config.json shaped like the real one.
 */
function writeFakeGBrain(opts: { exitCode?: number } = {}): string {
  const script = path.join(tempRoot, 'fake-gbrain.sh');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo "ARGS:$@" >> "${logPath()}"`,
    `echo "OLLAMA_BASE_URL:$OLLAMA_BASE_URL" >> "${logPath()}"`,
    `echo "GBRAIN_HOME:$GBRAIN_HOME" >> "${logPath()}"`,
    'if [ "$1" = "init" ]; then',
    '  mkdir -p "$GBRAIN_HOME/.gbrain"',
    '  case "$@" in',
    '    *--no-embedding*)',
    `      printf '{"embedding_disabled":true}' > "$GBRAIN_HOME/.gbrain/config.json"`,
    '      ;;',
    '    *)',
    `      printf '{"embedding_model":"ollama:embeddinggemma-300m","embedding_dimensions":768}' > "$GBRAIN_HOME/.gbrain/config.json"`,
    '      ;;',
    '  esac',
    'fi',
    `exit ${opts.exitCode ?? 0}`,
  ].join('\n'), 'utf8');
  chmodSync(script, 0o755);
  return script;
}

function seedConfig(content: Record<string, unknown>): void {
  mkdirSync(path.join(gbrainHome(), '.gbrain'), { recursive: true });
  writeFileSync(path.join(gbrainHome(), '.gbrain', 'config.json'), JSON.stringify(content), 'utf8');
}

describe('resolveGBrainRuntimeConfig embedding integration', () => {
  it('carries the embedding runtime config alongside the gbrain config', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    process.env.VERSO_LLAMA_SERVER_COMMAND = '/bin/echo';
    process.env.VERSO_EMBEDDINGS_PORT = '19123';

    const config = resolveGBrainRuntimeConfig(hermesHome());

    expect(config.embedding.enabled).toBe(true);
    expect(config.embedding.command).toBe('/bin/echo');
    expect(config.embedding.baseUrl).toBe('http://127.0.0.1:19123/v1');
    expect(config.embedding.modelPath).toBe(
      path.join(tempRoot, 'models', 'embeddinggemma-300M-Q8_0.gguf'),
    );
  });

  it('embedding config is disabled when GBrain is disabled', () => {
    delete process.env.VERSO_GBRAIN_ENABLED;
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();

    const config = resolveGBrainRuntimeConfig(hermesHome());
    expect(config.enabled).toBe(false);
    expect(config.embedding.enabled).toBe(false);
  });
});

describe('ensureGBrainInitialized', () => {
  it('initializes with local embeddings when llama-server is available', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    process.env.VERSO_LLAMA_SERVER_COMMAND = '/bin/echo';

    const config = resolveGBrainRuntimeConfig(hermesHome());
    ensureGBrainInitialized(config);

    const log = readLog();
    const initLine = log.find((line) => line.includes('ARGS:init'));
    expect(initLine).toBeDefined();
    expect(initLine).toContain('--pglite');
    expect(initLine).toContain('--embedding-model ollama:embeddinggemma-300m');
    expect(initLine).toContain('--embedding-dimensions 768');
    expect(initLine).toContain('--skip-embed-check');
    expect(initLine).toContain('--non-interactive');
    expect(initLine).not.toContain('--no-embedding');

    // gbrain CLI calls run with the local embedding endpoint injected.
    expect(log).toContain('OLLAMA_BASE_URL:http://127.0.0.1:17872/v1');
    // Search stays on the cheap conservative mode.
    expect(log.some((line) => line.includes('ARGS:config set search.mode conservative'))).toBe(true);

    expect(gbrainWantsEmbeddings(gbrainHome())).toBe(true);
  });

  it('honors custom embedding model id and dimensions', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    process.env.VERSO_LLAMA_SERVER_COMMAND = '/bin/echo';
    process.env.VERSO_EMBEDDINGS_MODEL_ID = 'qwen3-embedding-0.6b';
    process.env.VERSO_EMBEDDINGS_DIMENSIONS = '1024';

    ensureGBrainInitialized(resolveGBrainRuntimeConfig(hermesHome()));

    const initLine = readLog().find((line) => line.includes('ARGS:init'));
    expect(initLine).toContain('--embedding-model ollama:qwen3-embedding-0.6b');
    expect(initLine).toContain('--embedding-dimensions 1024');
  });

  it('falls back to --no-embedding when llama-server cannot be resolved', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    process.env.VERSO_LLAMA_SERVER_COMMAND = path.join(tempRoot, 'missing-llama-server');

    ensureGBrainInitialized(resolveGBrainRuntimeConfig(hermesHome()));

    const initLine = readLog().find((line) => line.includes('ARGS:init'));
    expect(initLine).toContain('--no-embedding');
    expect(initLine).not.toContain('--embedding-model');
    expect(gbrainWantsEmbeddings(gbrainHome())).toBe(false);
  });

  it('leaves an already-embedding-enabled brain untouched', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    process.env.VERSO_LLAMA_SERVER_COMMAND = '/bin/echo';
    seedConfig({ embedding_model: 'ollama:embeddinggemma-300m', embedding_dimensions: 768 });

    ensureGBrainInitialized(resolveGBrainRuntimeConfig(hermesHome()));

    expect(readLog()).toEqual([]);
  });

  it('migrates a pre-embeddings brain: backs up state and re-inits with embeddings', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    process.env.VERSO_LLAMA_SERVER_COMMAND = '/bin/echo';
    seedConfig({ embedding_disabled: true });

    ensureGBrainInitialized(resolveGBrainRuntimeConfig(hermesHome()));

    // Old state preserved as a backup directory.
    const backups = readdirSync(gbrainHome()).filter((entry) =>
      entry.startsWith('.gbrain.pre-embeddings-') && entry.endsWith('.bak'),
    );
    expect(backups).toHaveLength(1);
    const backupConfig = JSON.parse(
      readFileSync(path.join(gbrainHome(), backups[0], 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(backupConfig.embedding_disabled).toBe(true);

    // Fresh init ran with embedding flags.
    const initLine = readLog().find((line) => line.includes('ARGS:init'));
    expect(initLine).toContain('--embedding-model ollama:embeddinggemma-300m');
    expect(gbrainWantsEmbeddings(gbrainHome())).toBe(true);
  });

  it('does not migrate when llama-server is unavailable', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    process.env.VERSO_LLAMA_SERVER_COMMAND = path.join(tempRoot, 'missing-llama-server');
    seedConfig({ embedding_disabled: true });

    ensureGBrainInitialized(resolveGBrainRuntimeConfig(hermesHome()));

    expect(readLog()).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(gbrainHome(), '.gbrain', 'config.json'), 'utf8'))).toEqual({
      embedding_disabled: true,
    });
  });

  it('surfaces init failures without writing a config', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain({ exitCode: 1 });
    process.env.VERSO_LLAMA_SERVER_COMMAND = '/bin/echo';

    // Fake gbrain still records the call but exits non-zero; the helper must
    // not throw and must not run the follow-up config-set.
    ensureGBrainInitialized(resolveGBrainRuntimeConfig(hermesHome()));

    const log = readLog();
    expect(log.some((line) => line.includes('ARGS:init'))).toBe(true);
    expect(log.some((line) => line.includes('search.mode'))).toBe(false);
  });
});

describe('gbrainWantsEmbeddings', () => {
  it('is false for a missing config', () => {
    expect(gbrainWantsEmbeddings(gbrainHome())).toBe(false);
  });

  it('is false for a deferred-setup config', () => {
    seedConfig({ embedding_disabled: true });
    expect(gbrainWantsEmbeddings(gbrainHome())).toBe(false);
  });

  it('is true when an embedding model is configured', () => {
    seedConfig({ embedding_model: 'ollama:embeddinggemma-300m' });
    expect(gbrainWantsEmbeddings(gbrainHome())).toBe(true);
  });

  it('is false for malformed config files', () => {
    mkdirSync(path.join(gbrainHome(), '.gbrain'), { recursive: true });
    writeFileSync(path.join(gbrainHome(), '.gbrain', 'config.json'), 'not-json', 'utf8');
    expect(gbrainWantsEmbeddings(gbrainHome())).toBe(false);
  });
});

describe('gbrainMcpServerConfig', () => {
  it('injects the local embedding endpoint for the read-only profile', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    process.env.VERSO_EMBEDDINGS_PORT = '19500';

    const config = resolveGBrainRuntimeConfig(hermesHome());
    const serverConfig = gbrainMcpServerConfig(config, 'read');

    expect(serverConfig).toMatchObject({
      env: {
        GBRAIN_HOME: gbrainHome(),
        MCP_STDIO: '1',
        OLLAMA_BASE_URL: 'http://127.0.0.1:19500/v1',
      },
      tools: { include: [...GBRAIN_READ_ONLY_TOOLS] },
    });
  });

  it('injects the endpoint for the write profile without a tool allowlist', () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();

    const config = resolveGBrainRuntimeConfig(hermesHome());
    const serverConfig = gbrainMcpServerConfig(config, 'write') as Record<string, unknown>;

    expect((serverConfig.env as Record<string, string>).OLLAMA_BASE_URL).toBe('http://127.0.0.1:17872/v1');
    expect(serverConfig.tools).toBeUndefined();
  });
});

describe('applyGBrainSoulSection', () => {
  const SOUL = '# Verso\n\nYou are a helpful assistant.\n';

  it('appends the memory section when enabled', () => {
    const result = applyGBrainSoulSection(SOUL, true);

    expect(result).toContain('# Verso');
    expect(result).toContain('<!-- verso:gbrain-memory:start -->');
    expect(result).toContain('## Your memory');
    expect(result).toContain('Check memory FIRST');
    expect(result).toContain('<!-- verso:gbrain-memory:end -->');
  });

  it('is idempotent', () => {
    const once = applyGBrainSoulSection(SOUL, true);
    const twice = applyGBrainSoulSection(once, true);

    expect(twice).toBe(once);
    expect(twice.match(/## Your memory/g)).toHaveLength(1);
  });

  it('removes the section when disabled, restoring the original content', () => {
    const withSection = applyGBrainSoulSection(SOUL, true);
    const removed = applyGBrainSoulSection(withSection, false);

    expect(removed).toBe(SOUL);
  });

  it('preserves user customizations outside the markers', () => {
    const custom = '# Custom identity\n\nAlways answer in Spanish.\n';
    const withSection = applyGBrainSoulSection(custom, true);

    expect(withSection).toContain('Always answer in Spanish.');
    expect(applyGBrainSoulSection(withSection, false)).toBe(custom);
  });

  it('replaces a stale managed block instead of stacking a new one', () => {
    const stale = [
      SOUL.trimEnd(),
      '',
      '<!-- verso:gbrain-memory:start -->',
      'old instructions from a previous version',
      '<!-- verso:gbrain-memory:end -->',
      '',
    ].join('\n');

    const result = applyGBrainSoulSection(stale, true);

    expect(result).not.toContain('old instructions');
    expect(result.match(/verso:gbrain-memory:start/g)).toHaveLength(1);
    expect(result).toContain('## Your memory');
  });

  it('leaves a section-free document untouched when disabled', () => {
    expect(applyGBrainSoulSection(SOUL, false)).toBe(SOUL);
    expect(applyGBrainSoulSection('', false)).toBe('');
  });
});

describe('runGBrainEmbedBackfill', () => {
  it('runs embed --stale with the embedding endpoint when the brain wants embeddings', async () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    process.env.VERSO_LLAMA_SERVER_COMMAND = '/bin/echo';
    seedConfig({ embedding_model: 'ollama:embeddinggemma-300m' });

    const result = await runGBrainEmbedBackfill(resolveGBrainRuntimeConfig(hermesHome()));

    expect(result.ok).toBe(true);
    const log = readLog();
    expect(log.some((line) => line.includes('ARGS:embed --stale'))).toBe(true);
    expect(log).toContain('OLLAMA_BASE_URL:http://127.0.0.1:17872/v1');
  });

  it('skips brains initialized without embeddings', async () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain();
    seedConfig({ embedding_disabled: true });

    const result = await runGBrainEmbedBackfill(resolveGBrainRuntimeConfig(hermesHome()));

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('without embeddings');
    expect(readLog()).toEqual([]);
  });

  it('reports failures from the gbrain CLI', async () => {
    process.env.VERSO_GBRAIN_COMMAND = writeFakeGBrain({ exitCode: 2 });
    seedConfig({ embedding_model: 'ollama:embeddinggemma-300m' });

    const result = await runGBrainEmbedBackfill(resolveGBrainRuntimeConfig(hermesHome()));

    expect(result.ok).toBe(false);
  });
});
