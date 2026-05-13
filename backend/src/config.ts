import 'dotenv/config';
import { z } from 'zod';

const optionalString = () => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

const DEFAULT_MANAGED_MODEL = 'anthropic/claude-opus-4.7';
const DEFAULT_ALLOWED_MODELS = ['anthropic/claude-opus-4.7', 'openai/gpt-5.4'];
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;
const DEFAULT_SESSION_LIFETIME_DAYS = 365;

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
  MANAGED_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().optional(),
  MANAGED_BREAKER_THRESHOLD: z.coerce.number().int().positive().optional(),
  MANAGED_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().optional(),
  AUTH_SESSION_LIFETIME_DAYS: z.coerce.number().int().positive().optional(),
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
  managedRateLimitPerMinute: number;
  managedBreakerThreshold: number;
  managedBreakerCooldownMs: number;
  authSessionLifetimeMs: number;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = envSchema.parse(env);
  const allowedFromEnv = parseModelList(parsed.MANAGED_ALLOWED_MODELS);
  const managedAllowedModels = allowedFromEnv.length > 0 ? allowedFromEnv : DEFAULT_ALLOWED_MODELS;
  const managedDefaultModel = parsed.MANAGED_DEFAULT_MODEL ?? DEFAULT_MANAGED_MODEL;
  const managedDefaultMaxTokens = parsed.MANAGED_DEFAULT_MAX_TOKENS ?? DEFAULT_MAX_TOKENS;
  const managedRateLimitPerMinute = parsed.MANAGED_RATE_LIMIT_PER_MINUTE ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const managedBreakerThreshold = parsed.MANAGED_BREAKER_THRESHOLD ?? DEFAULT_BREAKER_THRESHOLD;
  const managedBreakerCooldownMs = parsed.MANAGED_BREAKER_COOLDOWN_MS ?? DEFAULT_BREAKER_COOLDOWN_MS;
  const authSessionLifetimeDays = parsed.AUTH_SESSION_LIFETIME_DAYS ?? DEFAULT_SESSION_LIFETIME_DAYS;
  const authSessionLifetimeMs = authSessionLifetimeDays * 24 * 60 * 60 * 1000;

  return {
    ...parsed,
    databaseConfigured: Boolean(parsed.DATABASE_URL),
    privyConfigured: Boolean(parsed.PRIVY_APP_ID && parsed.PRIVY_APP_SECRET),
    openRouterConfigured: Boolean(parsed.OPENROUTER_API_KEY),
    managedDefaultModel,
    managedAllowedModels,
    managedDefaultMaxTokens,
    managedRateLimitPerMinute,
    managedBreakerThreshold,
    managedBreakerCooldownMs,
    authSessionLifetimeMs,
  };
}

function parseModelList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
