import 'dotenv/config';
import { z } from 'zod';

const optionalString = () => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8788),
  DATABASE_URL: optionalString(),
  PRIVY_APP_ID: optionalString(),
  PRIVY_APP_SECRET: optionalString(),
  OPENROUTER_API_KEY: optionalString(),
  WEB_BASE_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
});

export type BackendConfig = z.infer<typeof envSchema> & {
  databaseConfigured: boolean;
  privyConfigured: boolean;
  openRouterConfigured: boolean;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    databaseConfigured: Boolean(parsed.DATABASE_URL),
    privyConfigured: Boolean(parsed.PRIVY_APP_ID && parsed.PRIVY_APP_SECRET),
    openRouterConfigured: Boolean(parsed.OPENROUTER_API_KEY),
  };
}
