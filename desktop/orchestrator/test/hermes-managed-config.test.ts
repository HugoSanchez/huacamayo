import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { HermesSupervisor } from '../src/http/hermes-supervisor.ts';
import { GBRAIN_READ_ONLY_TOOLS } from '../src/http/gbrain.ts';

/**
 * Verifies that HermesSupervisor's managed-mode seeding preserves Hermes'
 * existing model config and restores profiles that were previously pointed at
 * verso's now-deleted local LLM proxy.
 */
describe('HermesSupervisor: managed config override', () => {
  let tempRoot = '';
  let templateHome = '';
  let managedHome = '';
  let envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-hermes-test-'));
    templateHome = tempRoot;
    managedHome = path.join(tempRoot, 'profiles', 'verso');
    envSnapshot = {
      HERMES_HOME: process.env.HERMES_HOME,
      VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
      VERSO_HERMES_COMMAND: process.env.VERSO_HERMES_COMMAND,
      VERSO_GBRAIN_ENABLED: process.env.VERSO_GBRAIN_ENABLED,
      VERSO_GBRAIN_HOME: process.env.VERSO_GBRAIN_HOME,
      VERSO_GBRAIN_COMMAND: process.env.VERSO_GBRAIN_COMMAND,
      VERSO_GBRAIN_ARGS: process.env.VERSO_GBRAIN_ARGS,
      VERSO_EMBEDDINGS_PORT: process.env.VERSO_EMBEDDINGS_PORT,
      VERSO_LLAMA_SERVER_COMMAND: process.env.VERSO_LLAMA_SERVER_COMMAND,
    };
    process.env.HERMES_HOME = templateHome;
    // Pretend Hermes is launchable so the supervisor doesn't bail out.
    process.env.VERSO_HERMES_COMMAND = '/bin/true';
    // Avoid touching the real Hermes gateway during tests.
    delete process.env.VERSO_HERMES_GATEWAY_URL;
    delete process.env.VERSO_GBRAIN_ENABLED;
    delete process.env.VERSO_GBRAIN_HOME;
    delete process.env.VERSO_GBRAIN_COMMAND;
    delete process.env.VERSO_GBRAIN_ARGS;
    delete process.env.VERSO_EMBEDDINGS_PORT;
    delete process.env.VERSO_LLAMA_SERVER_COMMAND;

    // Seed a minimal template config.yaml that mirrors the user's real one.
    writeFileSync(path.join(tempRoot, 'config.yaml'), [
      'model:',
      '  provider: openai-codex',
      '  default: gpt-5.5',
      '  base_url: https://chatgpt.com/backend-api/codex',
      'agent:',
      '  max_turns: 90',
      '  reasoning_effort: medium',
      'toolsets:',
      '- hermes-cli',
    ].join('\n'), 'utf8');
    writeFileSync(path.join(tempRoot, '.env'), '', 'utf8');
    writeFileSync(path.join(tempRoot, 'auth.json'), '{}', 'utf8');
    writeFileSync(path.join(tempRoot, 'SOUL.md'), '', 'utf8');
    mkdirSync(path.join(tempRoot, 'memories'), { recursive: true });
    writeFileSync(path.join(tempRoot, 'memories', 'MEMORY.md'), '', 'utf8');
    writeFileSync(path.join(tempRoot, 'memories', 'USER.md'), '', 'utf8');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves the managed config.yaml model section by default', () => {
    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');

    // Trigger ensureManagedHermesHome indirectly by accessing the private path.
    // We call the public seed entry through reflection-friendly cast — the
    // supervisor exposes this as part of spawnManagedProcess; we exercise just
    // the seeding by invoking the private method via cast for the test.
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const managedConfigPath = path.join(managedHome, 'config.yaml');
    expect(existsSync(managedConfigPath)).toBe(true);

    const parsed = YAML.parse(readFileSync(managedConfigPath, 'utf8')) as Record<string, unknown>;
    expect(parsed.model).toEqual({
      provider: 'openai-codex',
      default: 'gpt-5.5',
      base_url: 'https://chatgpt.com/backend-api/codex',
    });
    // Other top-level sections from the template survive managed seeding.
    expect(parsed.agent).toEqual({ max_turns: 90, reasoning_effort: 'medium' });
    expect(parsed.toolsets).toEqual(['hermes-cli']);
  });

  it('replaces old managed auth.json with the template Hermes auth store', () => {
    writeFileSync(path.join(tempRoot, 'auth.json'), JSON.stringify({
      version: 2,
      active_provider: 'openai-codex',
      providers: {
        'openai-codex': { type: 'oauth' },
      },
      credential_pool: {
        'openai-codex': [{ id: 'codex-test' }],
      },
    }), 'utf8');
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(path.join(managedHome, 'auth.json'), JSON.stringify({
      auth_mode: 'oauth',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'old' },
    }), 'utf8');

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = JSON.parse(readFileSync(path.join(managedHome, 'auth.json'), 'utf8')) as Record<string, unknown>;
    expect(parsed.active_provider).toBe('openai-codex');
    expect(parsed.credential_pool).toEqual({ 'openai-codex': [{ id: 'codex-test' }] });
  });

  it('refreshes the old default SOUL.md but preserves customized identity files', () => {
    const newSoul = '# Verso\n\nUpdated identity for Verso users.\n';
    writeFileSync(path.join(tempRoot, 'SOUL.md'), newSoul, 'utf8');
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(
      path.join(managedHome, 'SOUL.md'),
      '# Verso\n\nYou are a helpful research assistant running inside the Verso macOS app.\n',
      'utf8',
    );

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    expect(readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8')).toBe(newSoul);

    writeFileSync(path.join(tempRoot, 'SOUL.md'), '# Verso\n\nAnother new identity.\n', 'utf8');
    writeFileSync(path.join(managedHome, 'SOUL.md'), '# Custom\n\nKeep my local identity.\n', 'utf8');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    expect(readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8')).toBe('# Custom\n\nKeep my local identity.\n');
  });

  it('leaves the model section untouched when runtimeMode is not managed', () => {
    const supervisor = new HermesSupervisor({ runtimeMode: 'local' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as Record<string, unknown>;
    expect(parsed.model).toEqual({
      provider: 'openai-codex',
      default: 'gpt-5.5',
      base_url: 'https://chatgpt.com/backend-api/codex',
    });
  });

  it('restores old proxy-owned model config to the template model', () => {
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(path.join(managedHome, 'config.yaml'), [
      'model:',
      '  provider: custom',
      '  default: openai/gpt-5.4',
      '  base_url: http://127.0.0.1:62000/llm/v1',
      'agent:',
      '  max_turns: 12',
    ].join('\n'), 'utf8');

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as Record<string, unknown>;
    expect(parsed.model).toEqual({
      provider: 'openai-codex',
      default: 'gpt-5.5',
      base_url: 'https://chatgpt.com/backend-api/codex',
    });
    expect(parsed.agent).toEqual({ max_turns: 12 });
  });

  it('removes direct Composio MCP config and legacy vervo', () => {
    writeFileSync(path.join(tempRoot, 'config.yaml'), [
      'model:',
      '  provider: openai-codex',
      'mcp_servers:',
      '  vervo:',
      '    command: python',
      '    args:',
      '      - old/vervo_server.py',
      '  composio:',
      '    url: https://backend.composio.dev/tool_router/trs_old/mcp',
    ].join('\n'), 'utf8');

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as {
      mcp_servers?: Record<string, unknown>;
    };
    expect(parsed.mcp_servers?.vervo).toBeUndefined();
    expect(parsed.mcp_servers?.composio).toBeUndefined();
  });

  it('adds GBrain MCP config when the feature flag is enabled', () => {
    const gbrainHome = path.join(tempRoot, 'gbrain-home');
    mkdirSync(path.join(gbrainHome, '.gbrain'), { recursive: true });
    writeFileSync(path.join(gbrainHome, '.gbrain', 'config.json'), '{}', 'utf8');
    process.env.VERSO_GBRAIN_ENABLED = '1';
    process.env.VERSO_GBRAIN_HOME = gbrainHome;
    process.env.VERSO_GBRAIN_COMMAND = '/bin/echo';
    process.env.VERSO_GBRAIN_ARGS = JSON.stringify(['/tmp/gbrain/src/cli.ts']);

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as {
      mcp_servers?: Record<string, {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      }>;
    };
    expect(parsed.mcp_servers?.gbrain).toEqual({
      command: '/bin/echo',
      args: ['/tmp/gbrain/src/cli.ts', 'serve'],
      env: {
        GBRAIN_HOME: gbrainHome,
        MCP_STDIO: '1',
        OLLAMA_BASE_URL: 'http://127.0.0.1:17872/v1',
      },
      timeout: 120,
      connect_timeout: 60,
      tools: { include: [...GBRAIN_READ_ONLY_TOOLS] },
    });
  });

  it('adds the memory section to the visible profile SOUL.md when GBrain is enabled', () => {
    const gbrainHome = path.join(tempRoot, 'gbrain-home');
    mkdirSync(path.join(gbrainHome, '.gbrain'), { recursive: true });
    writeFileSync(path.join(gbrainHome, '.gbrain', 'config.json'), '{}', 'utf8');
    process.env.VERSO_GBRAIN_ENABLED = '1';
    process.env.VERSO_GBRAIN_HOME = gbrainHome;
    process.env.VERSO_GBRAIN_COMMAND = '/bin/echo';

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const soul = readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8');
    expect(soul).toContain('<!-- verso:gbrain-memory:start -->');
    expect(soul).toContain('## Your memory');
    expect(soul).toContain('Check memory FIRST');
  });

  it('removes the memory section when GBrain is disabled', () => {
    const gbrainHome = path.join(tempRoot, 'gbrain-home');
    mkdirSync(path.join(gbrainHome, '.gbrain'), { recursive: true });
    writeFileSync(path.join(gbrainHome, '.gbrain', 'config.json'), '{}', 'utf8');
    process.env.VERSO_GBRAIN_ENABLED = '1';
    process.env.VERSO_GBRAIN_HOME = gbrainHome;
    process.env.VERSO_GBRAIN_COMMAND = '/bin/echo';

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();
    expect(readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8')).toContain('## Your memory');

    delete process.env.VERSO_GBRAIN_ENABLED;
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const soul = readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8');
    expect(soul).not.toContain('## Your memory');
    expect(soul).not.toContain('verso:gbrain-memory');
  });

  it('does not add the memory section to the hidden worker profile', () => {
    const gbrainHome = path.join(tempRoot, 'gbrain-home');
    const workerHome = path.join(tempRoot, 'profiles', 'verso-gbrain-worker');
    mkdirSync(path.join(gbrainHome, '.gbrain'), { recursive: true });
    writeFileSync(path.join(gbrainHome, '.gbrain', 'config.json'), '{}', 'utf8');
    process.env.VERSO_GBRAIN_ENABLED = '1';
    process.env.VERSO_GBRAIN_HOME = gbrainHome;
    process.env.VERSO_GBRAIN_COMMAND = '/bin/echo';

    const supervisor = new HermesSupervisor({
      runtimeMode: 'managed',
      managedProfileName: 'verso-gbrain-worker',
      gbrainMcpMode: 'write',
    });
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const soul = readFileSync(path.join(workerHome, 'SOUL.md'), 'utf8');
    expect(soul).not.toContain('verso:gbrain-memory');
  });

  it('adds full GBrain MCP config for the hidden worker profile', () => {
    const gbrainHome = path.join(tempRoot, 'gbrain-home');
    const workerHome = path.join(tempRoot, 'profiles', 'verso-gbrain-worker');
    writeFileSync(path.join(tempRoot, 'config.yaml'), [
      'model:',
      '  provider: auto',
      '  default: anthropic/claude-opus-4.6',
      '  base_url: https://openrouter.ai/api/v1',
    ].join('\n'), 'utf8');
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(path.join(managedHome, 'config.yaml'), [
      'model:',
      '  provider: openai-codex',
      '  default: gpt-5.5',
      '  base_url: https://chatgpt.com/backend-api/codex',
      'agent:',
      '  max_turns: 45',
    ].join('\n'), 'utf8');
    writeFileSync(path.join(managedHome, 'auth.json'), JSON.stringify({
      version: 2,
      active_provider: 'openai-codex',
      providers: {
        'openai-codex': { type: 'oauth' },
      },
      credential_pool: {
        'openai-codex': [{ id: 'codex-test' }],
      },
    }), 'utf8');
    mkdirSync(path.join(gbrainHome, '.gbrain'), { recursive: true });
    writeFileSync(path.join(gbrainHome, '.gbrain', 'config.json'), '{}', 'utf8');
    process.env.VERSO_GBRAIN_ENABLED = '1';
    process.env.VERSO_GBRAIN_HOME = gbrainHome;
    process.env.VERSO_GBRAIN_COMMAND = '/bin/echo';
    process.env.VERSO_GBRAIN_ARGS = JSON.stringify(['/tmp/gbrain/src/cli.ts']);

    const supervisor = new HermesSupervisor({
      runtimeMode: 'managed',
      managedProfileName: 'verso-gbrain-worker',
      gbrainMcpMode: 'write',
    });
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(workerHome, 'config.yaml'), 'utf8')) as {
      model?: Record<string, unknown>;
      agent?: Record<string, unknown>;
      mcp_servers?: Record<string, {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        tools?: unknown;
      }>;
    };
    expect(parsed.model).toEqual({
      provider: 'openai-codex',
      default: 'gpt-5.5',
      base_url: 'https://chatgpt.com/backend-api/codex',
    });
    expect(parsed.agent).toEqual({ max_turns: 45 });
    expect(parsed.mcp_servers?.gbrain).toMatchObject({
      command: '/bin/echo',
      args: ['/tmp/gbrain/src/cli.ts', 'serve'],
      env: {
        GBRAIN_HOME: gbrainHome,
        MCP_STDIO: '1',
        OLLAMA_BASE_URL: 'http://127.0.0.1:17872/v1',
      },
      timeout: 120,
      connect_timeout: 60,
    });
    expect(parsed.mcp_servers?.gbrain.tools).toBeUndefined();
    const auth = JSON.parse(readFileSync(path.join(workerHome, 'auth.json'), 'utf8')) as Record<string, unknown>;
    expect(auth.active_provider).toBe('openai-codex');
  });
});
