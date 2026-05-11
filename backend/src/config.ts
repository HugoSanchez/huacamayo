import 'dotenv/config';
import { z } from 'zod';

const optionalString = () => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

const DEFAULT_MANAGED_MODEL = 'anthropic/opus-4.7';
const DEFAULT_ALLOWED_MODELS = ['anthropic/opus-4.7', 'openai/gpt-5.4'];
const DEFAULT_MAX_TOKENS = 4096;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8788),
  DATABASE_URL: optionalString(),
  PRIVY_APP_ID: optionalString(),
  PRIVY_APP_SECRET: optionalString(),
  OPENROUTER_API_KEY: optionalString(),
  MANAGED_DEFAULT_MODEL: optionalString(),
  MANAGED_ALLOWED_MODELS: optionalString(),
  MANAGED_DEFAULT_MAX_TOKENS: z.coerce.number().int().positive().optional(),
  WEB_BASE_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
});

export type BackendConfig = z.infer<typeof envSchema> & {
  databaseConfigured: boolean;
  privyConfigured: boolean;
  openRouterConfigured: boolean;
  managedDefaultModel: string;
  managedAllowedModels: string[];
  managedDefaultMaxTokens: number;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = envSchema.parse(env);
  const allowedFromEnv = parseModelList(parsed.MANAGED_ALLOWED_MODELS);
  const managedAllowedModels = allowedFromEnv.length > 0 ? allowedFromEnv : DEFAULT_ALLOWED_MODELS;
  const managedDefaultModel = parsed.MANAGED_DEFAULT_MODEL ?? DEFAULT_MANAGED_MODEL;
  const managedDefaultMaxTokens = parsed.MANAGED_DEFAULT_MAX_TOKENS ?? DEFAULT_MAX_TOKENS;

  return {
    ...parsed,
    databaseConfigured: Boolean(parsed.DATABASE_URL),
    privyConfigured: Boolean(parsed.PRIVY_APP_ID && parsed.PRIVY_APP_SECRET),
    openRouterConfigured: Boolean(parsed.OPENROUTER_API_KEY),
    managedDefaultModel,
    managedAllowedModels,
    managedDefaultMaxTokens,
  };
}

function parseModelList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
