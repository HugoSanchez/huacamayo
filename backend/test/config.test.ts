import { describe, expect, test } from 'vitest';
import { getConfig } from '../src/config.ts';

describe('getConfig', () => {
  test('derives capability flags from env vars', () => {
    const config = getConfig({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '9000',
      DATABASE_URL: 'postgres://example',
      PRIVY_APP_ID: 'app-id',
      PRIVY_APP_SECRET: 'app-secret',
      WEB_BASE_URL: 'https://example.com',
    });

    expect(config.databaseConfigured).toBe(true);
    expect(config.privyConfigured).toBe(true);
    expect(config.PORT).toBe(9000);
  });

  test('treats blank optional env vars as unset', () => {
    const config = getConfig({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '9000',
      DATABASE_URL: '',
      PRIVY_APP_ID: '',
      PRIVY_APP_SECRET: '',
      WEB_BASE_URL: '',
    });

    expect(config.databaseConfigured).toBe(false);
    expect(config.privyConfigured).toBe(false);
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.WEB_BASE_URL).toBeUndefined();
  });
});
