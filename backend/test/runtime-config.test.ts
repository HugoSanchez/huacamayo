import { afterEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.ts';
import { getConfig } from '../src/config.ts';

describe('runtime-config route', () => {
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  test('returns the built-in defaults when no MANAGED_* env vars are set', async () => {
    const config = getConfig({ NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '8788' });
    app = await buildServer({ config });

    const response = await app.inject({ method: 'GET', url: '/v1/runtime-config' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      defaultModel: 'openai/gpt-5.4',
      allowedModels: ['openai/gpt-5.4', 'anthropic/claude-opus-4.7'],
    });
  });

  test('honours MANAGED_DEFAULT_MODEL and MANAGED_ALLOWED_MODELS overrides', async () => {
    const config = getConfig({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '8788',
      MANAGED_DEFAULT_MODEL: 'openai/gpt-5.4',
      MANAGED_ALLOWED_MODELS: 'openai/gpt-5.4, anthropic/opus-4.7 ,  ',
    });
    app = await buildServer({ config });

    const response = await app.inject({ method: 'GET', url: '/v1/runtime-config' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      defaultModel: 'openai/gpt-5.4',
      allowedModels: ['openai/gpt-5.4', 'anthropic/opus-4.7'],
    });
  });
});
