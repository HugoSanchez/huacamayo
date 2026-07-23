import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { HermesSupervisor } from '../src/http/hermes-supervisor.ts';

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
      VERSO_MEMORY_ENABLED: process.env.VERSO_MEMORY_ENABLED,
    };
    process.env.HERMES_HOME = templateHome;
    // Pretend Hermes is launchable so the supervisor doesn't bail out.
    process.env.VERSO_HERMES_COMMAND = '/bin/true';
    // Avoid touching the real Hermes gateway during tests.
    delete process.env.VERSO_HERMES_GATEWAY_URL;
    delete process.env.VERSO_MEMORY_ENABLED;

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

    // The managed memory section is appended after the refreshed identity.
    const refreshed = readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8');
    expect(refreshed.startsWith(newSoul.trimEnd())).toBe(true);
    expect(refreshed).toContain('verso:gbrain-memory:start');

    writeFileSync(path.join(tempRoot, 'SOUL.md'), '# Verso\n\nAnother new identity.\n', 'utf8');
    writeFileSync(path.join(managedHome, 'SOUL.md'), '# Custom\n\nKeep my local identity.\n', 'utf8');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const custom = readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8');
    expect(custom.startsWith('# Custom\n\nKeep my local identity.')).toBe(true);
    expect(custom).not.toContain('Another new identity');
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

  it('removes a stale per-profile GBrain MCP entry from an older install', () => {
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(path.join(managedHome, 'config.yaml'), [
      'model:',
      '  provider: openai-codex',
      'mcp_servers:',
      '  gbrain:',
      '    command: /Users/someone/.bun/bin/bun',
      '    args:',
      '      - /tmp/gbrain/src/cli.ts',
      '      - serve',
    ].join('\n'), 'utf8');

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as {
      mcp_servers?: Record<string, unknown>;
    };
    expect(parsed.mcp_servers?.gbrain).toBeUndefined();
  });

  it('writes the pinned tool_search hot set from the native tool manifest', () => {
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(path.join(managedHome, 'verso-composio-tools.json'), JSON.stringify({
      version: 1,
      generatedAt: '2026-07-21T00:00:00.000Z',
      tools: [
        {
          nativeName: 'slack_search_messages',
          toolSlug: 'SLACK_SEARCH_MESSAGES',
          toolkitSlug: 'slack',
          name: 'Search messages',
          description: null,
          inputParameters: { type: 'object', properties: {} },
          origin: 'usage',
        },
        {
          nativeName: 'slack_kick_user',
          toolSlug: 'SLACK_KICK_USER',
          toolkitSlug: 'slack',
          name: 'Kick user',
          description: null,
          inputParameters: { type: 'object', properties: {} },
          origin: 'toolkit',
        },
      ],
    }), 'utf8');

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as {
      tools?: { tool_search?: { enabled?: string; pinned?: string[] } };
    };
    expect(parsed.tools?.tool_search?.enabled).toBe('on');
    const pinned = parsed.tools?.tool_search?.pinned ?? [];
    expect(pinned).toContain('mcp_verso_search_memory');
    expect(pinned).toContain('mcp_verso_request_connection');
    expect(pinned).toContain('mcp_verso_slack_search_messages');
    expect(pinned).not.toContain('mcp_verso_slack_kick_user');
  });

  it('exposes the full memory tool surface through the verso bridge env by default', () => {
    // Make resolveHermesPython resolve inside the temp template home so the
    // verso bridge block is generated in this test environment.
    const fakePython = path.join(tempRoot, 'hermes-agent', 'venv', 'bin', 'python');
    mkdirSync(path.dirname(fakePython), { recursive: true });
    writeFileSync(fakePython, '#!/bin/sh\n', 'utf8');

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as {
      mcp_servers?: Record<string, { env?: Record<string, string> }>;
    };
    expect(parsed.mcp_servers?.verso?.env?.VERSO_MEMORY_TOOLS).toBe('full');
    expect(parsed.mcp_servers?.verso?.env?.VERSO_MEMORY_BACKEND).toBeUndefined();
  });

  it('omits the memory tools env when memory is disabled', () => {
    const fakePython = path.join(tempRoot, 'hermes-agent', 'venv', 'bin', 'python');
    mkdirSync(path.dirname(fakePython), { recursive: true });
    writeFileSync(fakePython, '#!/bin/sh\n', 'utf8');
    process.env.VERSO_MEMORY_ENABLED = '0';

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const parsed = YAML.parse(readFileSync(path.join(managedHome, 'config.yaml'), 'utf8')) as {
      mcp_servers?: Record<string, { env?: Record<string, string> }>;
    };
    expect(parsed.mcp_servers?.verso?.env?.VERSO_MEMORY_TOOLS).toBeUndefined();
  });

  it('adds the memory section to the profile SOUL.md by default', () => {
    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const soul = readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8');
    // The markers keep the historical gbrain name so existing installs
    // upgrade their managed block in place.
    expect(soul).toContain('<!-- verso:gbrain-memory:start -->');
    expect(soul).toContain('## Your memory');
    expect(soul).toContain('search_memory FIRST');
    expect(soul).toContain('write_memory_page');
  });

  it('removes the memory section when memory is disabled', () => {
    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();
    expect(readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8')).toContain('## Your memory');

    process.env.VERSO_MEMORY_ENABLED = '0';
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const soul = readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8');
    expect(soul).not.toContain('## Your memory');
    expect(soul).not.toContain('verso:gbrain-memory');
  });

  it('replaces an older gbrain-era managed SOUL section in place', () => {
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(path.join(managedHome, 'SOUL.md'), [
      '# Custom identity',
      '',
      '<!-- verso:gbrain-memory:start -->',
      '## Your memory',
      '',
      'Old GBrain knowledge-base wording.',
      '<!-- verso:gbrain-memory:end -->',
      '',
    ].join('\n'), 'utf8');

    const supervisor = new HermesSupervisor({ runtimeMode: 'managed' });
    supervisor.setOrchestratorBaseUrl('http://127.0.0.1:62000');
    (supervisor as unknown as { ensureManagedHermesHome: () => void }).ensureManagedHermesHome();

    const soul = readFileSync(path.join(managedHome, 'SOUL.md'), 'utf8');
    expect(soul).toContain('# Custom identity');
    expect(soul).not.toContain('Old GBrain knowledge-base wording.');
    expect(soul).toContain('write_memory_page');
    expect(soul.match(/verso:gbrain-memory:start/g)).toHaveLength(1);
  });
});
