import 'dotenv/config';
import { z } from 'zod';

const optionalString = () => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

const DEFAULT_SESSION_LIFETIME_DAYS = 365;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8788),
  DATABASE_URL: optionalString(),
  PRIVY_APP_ID: optionalString(),
  PRIVY_APP_SECRET: optionalString(),
  AUTH_SESSION_LIFETIME_DAYS: z.coerce.number().int().positive().optional(),
  WEB_BASE_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
});

export type BackendConfig = z.infer<typeof envSchema> & {
  databaseConfigured: boolean;
  privyConfigured: boolean;
  authSessionLifetimeMs: number;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = envSchema.parse(env);
  const authSessionLifetimeDays = parsed.AUTH_SESSION_LIFETIME_DAYS ?? DEFAULT_SESSION_LIFETIME_DAYS;
  const authSessionLifetimeMs = authSessionLifetimeDays * 24 * 60 * 60 * 1000;

  return {
    ...parsed,
    databaseConfigured: Boolean(parsed.DATABASE_URL),
    privyConfigured: Boolean(parsed.PRIVY_APP_ID && parsed.PRIVY_APP_SECRET),
    authSessionLifetimeMs,
  };
}
