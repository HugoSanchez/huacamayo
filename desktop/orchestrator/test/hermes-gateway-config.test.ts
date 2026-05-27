import { afterEach, describe, expect, it } from 'vitest';
import { getHermesGatewayConfig } from '../src/http/hermes-supervisor.ts';

describe('Hermes gateway config', () => {
  const envSnapshot = {
    VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
    VERSO_HERMES_STARTUP_TIMEOUT_MS: process.env.VERSO_HERMES_STARTUP_TIMEOUT_MS,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('only configures the Hermes gateway URL and startup timeout', () => {
    delete process.env.VERSO_HERMES_GATEWAY_URL;
    delete process.env.VERSO_HERMES_STARTUP_TIMEOUT_MS;

    expect(getHermesGatewayConfig()).toEqual({
      baseUrl: 'http://127.0.0.1:8642',
      startupTimeoutMs: 45_000,
    });
  });

  it('allows an explicit startup timeout override', () => {
    process.env.VERSO_HERMES_STARTUP_TIMEOUT_MS = '60000';

    expect(getHermesGatewayConfig().startupTimeoutMs).toBe(60_000);
  });
});
