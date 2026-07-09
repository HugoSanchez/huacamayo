import { afterEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.ts';
import { getConfig } from '../src/config.ts';
import { AuthService } from '../src/auth/service.ts';
import { MemoryAuthStore } from '../src/auth/memory-store.ts';
import {
  MemoryModelProviderConnectionStore,
  type CentaurInstanceResolver,
} from '../src/model-providers/service.ts';
import type { PrivyAuthVerifier, VerifiedPrivyAuthToken } from '../src/auth/types.ts';

class StubVerifier implements PrivyAuthVerifier {
  async verifyAuthToken(_t: string): Promise<VerifiedPrivyAuthToken> {
    return {
      userId: 'did:privy:model-providers-test',
      sessionId: 'p-s',
      appId: 'p-a',
      issuer: 'privy.io',
      issuedAt: 1_700_000_000,
      expiration: 1_700_003_600,
    };
  }
}

class StubCentaurResolver implements CentaurInstanceResolver {
  constructor(private readonly baseUrl: string) {}

  async resolveUserCentaurInstance(_userId: string) {
    return {
      consoleApiUrl: this.baseUrl,
      consoleApiKey: 'console-test-key',
    };
  }
}

const config = getConfig({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '8788',
  PRIVY_APP_ID: 'app',
  PRIVY_APP_SECRET: 'secret',
});

interface CapturedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

interface Setup {
  app: Awaited<ReturnType<typeof buildServer>>;
  centaur: Awaited<ReturnType<typeof startFakeCentaur>>;
  token: string;
  captured: CapturedRequest[];
}

async function setup(): Promise<Setup> {
  const centaur = await startFakeCentaur();
  const authStore = new MemoryAuthStore();
  const authService = new AuthService(config, authStore, new StubVerifier());
  const app = await buildServer({
    config,
    authService,
    authStore,
    modelProviderStore: new MemoryModelProviderConnectionStore(),
    centaurInstanceResolver: new StubCentaurResolver(centaur.baseUrl),
  });
  const exchange = await authService.exchangePrivyAuth({
    privyAccessToken: 'privy',
    deviceLabel: 'Hugo',
    platform: 'macos',
  });
  return { app, centaur, token: exchange.sessionToken, captured: centaur.captured };
}

describe('model provider routes', () => {
  let s: Setup | null = null;

  afterEach(async () => {
    if (s) {
      await s.app.close();
      await s.centaur.close();
      s = null;
    }
  });

  test('saves OpenAI key through Centaur and only returns metadata', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'PUT',
      url: '/v1/model-providers/openai',
      headers: { authorization: `Bearer ${s.token}` },
      payload: { apiKey: 'sk-test-openai-1234' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toMatchObject({
      provider: 'openai',
      status: 'connected',
      keyLast4: '1234',
    });
    expect(JSON.stringify(body)).not.toContain('sk-test-openai');

    expect(s.captured.map((req) => `${req.method} ${req.path}`)).toEqual([
      'PUT /api/v1/roles/infra',
      'PUT /api/v1/static_secrets/openai-api-key',
      'POST /api/v1/grants',
    ]);
    expect(s.captured.every((req) => req.authorization === 'Bearer console-test-key')).toBe(true);
    expect(s.captured[0].body).toEqual({
      data: {
        namespace: 'default',
        name: 'Infrastructure',
        labels: { managed_by: 'verso', purpose: 'runtime' },
      },
    });
    expect(s.captured[1].body).toEqual({
      data: {
        namespace: 'default',
        name: 'OpenAI API key',
        description: 'Model provider key managed by Verso settings.',
        labels: { managed_by: 'verso', kind: 'model_provider', provider: 'openai' },
        inject_config: { header: 'Authorization', formatter: 'Bearer {{.Value}}' },
        source: { source_type: 'control_plane', secret: 'sk-test-openai-1234', config: {} },
        rules: [{ host: 'api.openai.com' }],
      },
    });
    expect(s.captured[2].body).toEqual({
      data: { role_id: 'role-infra', static_secret_id: 'secret-openai-api-key' },
    });

    const list = await s.app.inject({
      method: 'GET',
      url: '/v1/model-providers',
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().providers.find((item: { provider: string }) => item.provider === 'openai')).toMatchObject({
      provider: 'openai',
      status: 'connected',
      keyLast4: '1234',
    });
  });

  test('saves Anthropic key with replacement config', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'PUT',
      url: '/v1/model-providers/anthropic',
      headers: { authorization: `Bearer ${s.token}` },
      payload: { apiKey: 'sk-ant-test-5678' },
    });

    expect(res.statusCode).toBe(200);
    expect(s.captured[1].body).toEqual({
      data: {
        namespace: 'default',
        name: 'Anthropic API key',
        description: 'Model provider key managed by Verso settings.',
        labels: { managed_by: 'verso', kind: 'model_provider', provider: 'anthropic' },
        replace_config: {
          proxy_value: 'ANTHROPIC_API_KEY',
          match_headers: ['X-Api-Key'],
          require: true,
        },
        source: { source_type: 'control_plane', secret: 'sk-ant-test-5678', config: {} },
        rules: [{ host: 'api.anthropic.com' }],
      },
    });
  });

  test('delete removes Centaur secret and metadata', async () => {
    s = await setup();
    await s.app.inject({
      method: 'PUT',
      url: '/v1/model-providers/openai',
      headers: { authorization: `Bearer ${s.token}` },
      payload: { apiKey: 'sk-test-openai-1234' },
    });

    const res = await s.app.inject({
      method: 'DELETE',
      url: '/v1/model-providers/openai',
      headers: { authorization: `Bearer ${s.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toEqual({
      provider: 'openai',
      status: 'not_connected',
      keyLast4: null,
      keySha256Prefix: null,
      updatedAt: null,
    });
    expect(s.captured.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/api/v1/static_secrets/secret-openai-api-key',
    });
  });

  test('rejects unauthenticated save without calling Centaur', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'PUT',
      url: '/v1/model-providers/openai',
      payload: { apiKey: 'sk-test-openai-1234' },
    });

    expect(res.statusCode).toBe(401);
    expect(s.captured).toHaveLength(0);
  });
});

async function startFakeCentaur(): Promise<{
  baseUrl: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const http = await import('node:http');
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const bodyText = await readRequest(req);
      const body = bodyText ? JSON.parse(bodyText) as unknown : null;
      captured.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        authorization: req.headers.authorization ?? null,
        body,
      });

      if (req.method === 'PUT' && req.url === '/api/v1/roles/infra') {
        sendJson(res, 200, { data: { id: 'role-infra' } });
        return;
      }

      if (req.method === 'PUT' && req.url?.startsWith('/api/v1/static_secrets/')) {
        const foreignId = req.url.split('/').at(-1) ?? 'unknown';
        sendJson(res, 200, { data: { id: `secret-${foreignId}` } });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/v1/grants') {
        sendJson(res, 200, { data: { id: 'grant-1' } });
        return;
      }

      if (req.method === 'GET' && req.url?.startsWith('/api/v1/static_secrets/lookup/')) {
        const foreignId = req.url.split('/').at(-1) ?? 'unknown';
        sendJson(res, 200, { data: { id: `secret-${foreignId}` } });
        return;
      }

      if (req.method === 'DELETE' && req.url?.startsWith('/api/v1/static_secrets/')) {
        res.writeHead(204);
        res.end();
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Fake Centaur failed to start.');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    captured,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function readRequest(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}
