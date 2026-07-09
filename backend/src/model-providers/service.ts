import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { BackendConfig } from '../config.ts';
import { getDb } from '../db/client.ts';
import { modelProviderConnections } from '../db/schema.ts';

export const MODEL_PROVIDERS = ['openai', 'anthropic'] as const;
export type ModelProvider = typeof MODEL_PROVIDERS[number];
export type ModelProviderStatus = 'connected' | 'needs_attention';

export interface ModelProviderConnectionRecord {
  userId: string;
  provider: ModelProvider;
  status: ModelProviderStatus;
  keyLast4: string;
  keySha256Prefix: string;
  centaurStaticSecretId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderConnectionView {
  provider: ModelProvider;
  status: ModelProviderStatus | 'not_connected';
  keyLast4: string | null;
  keySha256Prefix: string | null;
  updatedAt: string | null;
}

export interface ModelProviderConnectionStore {
  listByUserId(userId: string): Promise<ModelProviderConnectionRecord[]>;
  get(userId: string, provider: ModelProvider): Promise<ModelProviderConnectionRecord | null>;
  upsert(record: ModelProviderConnectionRecord): Promise<void>;
  delete(userId: string, provider: ModelProvider): Promise<void>;
}

export class MemoryModelProviderConnectionStore implements ModelProviderConnectionStore {
  private readonly records = new Map<string, ModelProviderConnectionRecord>();

  async listByUserId(userId: string): Promise<ModelProviderConnectionRecord[]> {
    return Array.from(this.records.values()).filter((record) => record.userId === userId);
  }

  async get(userId: string, provider: ModelProvider): Promise<ModelProviderConnectionRecord | null> {
    return this.records.get(storeKey(userId, provider)) ?? null;
  }

  async upsert(record: ModelProviderConnectionRecord): Promise<void> {
    this.records.set(storeKey(record.userId, record.provider), { ...record });
  }

  async delete(userId: string, provider: ModelProvider): Promise<void> {
    this.records.delete(storeKey(userId, provider));
  }
}

export class DrizzleModelProviderConnectionStore implements ModelProviderConnectionStore {
  private readonly db: ReturnType<typeof getDb>;

  constructor(databaseUrl: string) {
    this.db = getDb(databaseUrl);
  }

  async listByUserId(userId: string): Promise<ModelProviderConnectionRecord[]> {
    const rows = await this.db
      .select()
      .from(modelProviderConnections)
      .where(eq(modelProviderConnections.userId, userId));
    return rows.map(mapConnectionRow);
  }

  async get(userId: string, provider: ModelProvider): Promise<ModelProviderConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(modelProviderConnections)
      .where(and(
        eq(modelProviderConnections.userId, userId),
        eq(modelProviderConnections.provider, provider),
      ))
      .limit(1);
    return rows[0] ? mapConnectionRow(rows[0]) : null;
  }

  async upsert(record: ModelProviderConnectionRecord): Promise<void> {
    await this.db
      .insert(modelProviderConnections)
      .values(serializeConnection(record))
      .onConflictDoUpdate({
        target: [modelProviderConnections.userId, modelProviderConnections.provider],
        set: {
          status: record.status,
          keyLast4: record.keyLast4,
          keySha256Prefix: record.keySha256Prefix,
          centaurStaticSecretId: record.centaurStaticSecretId,
          updatedAt: new Date(record.updatedAt),
        },
      });
  }

  async delete(userId: string, provider: ModelProvider): Promise<void> {
    await this.db
      .delete(modelProviderConnections)
      .where(and(
        eq(modelProviderConnections.userId, userId),
        eq(modelProviderConnections.provider, provider),
      ));
  }
}

export interface CentaurInstance {
  consoleApiUrl: string;
  consoleApiKey: string;
}

export interface CentaurInstanceResolver {
  resolveUserCentaurInstance(userId: string): Promise<CentaurInstance>;
}

export class EnvCentaurInstanceResolver implements CentaurInstanceResolver {
  private readonly config: BackendConfig;

  constructor(config: BackendConfig) {
    this.config = config;
  }

  async resolveUserCentaurInstance(_userId: string): Promise<CentaurInstance> {
    const consoleApiUrl = this.config.VERSO_CENTAUR_CONSOLE_API_URL?.trim() ?? '';
    const consoleApiKey = this.config.VERSO_CENTAUR_CONSOLE_API_KEY?.trim() ?? '';
    if (!consoleApiUrl || !consoleApiKey) {
      throw new ModelProviderServiceError(
        503,
        'centaur_instance_unconfigured',
        'Centaur console API coordinates are not configured.',
      );
    }
    return { consoleApiUrl, consoleApiKey };
  }
}

export class ModelProviderServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ModelProviderServiceError';
    this.status = status;
    this.code = code;
  }
}

export class ModelProviderService {
  private readonly store: ModelProviderConnectionStore;
  private readonly resolver: CentaurInstanceResolver;

  constructor(store: ModelProviderConnectionStore, resolver: CentaurInstanceResolver) {
    this.store = store;
    this.resolver = resolver;
  }

  async listConnections(userId: string): Promise<ModelProviderConnectionView[]> {
    const records = await this.store.listByUserId(userId);
    const byProvider = new Map(records.map((record) => [record.provider, record]));
    return MODEL_PROVIDERS.map((provider) => toConnectionView(provider, byProvider.get(provider) ?? null));
  }

  async saveProviderKey(input: {
    userId: string;
    provider: ModelProvider;
    apiKey: string;
  }): Promise<ModelProviderConnectionView> {
    validateProvider(input.provider);
    const apiKey = input.apiKey.trim();
    if (!apiKey) {
      throw new ModelProviderServiceError(400, 'invalid_api_key', 'API key must not be empty.');
    }

    const instance = await this.resolver.resolveUserCentaurInstance(input.userId);
    const centaur = new CentaurConsoleClient({
      baseUrl: instance.consoleApiUrl,
      apiKey: instance.consoleApiKey,
    });

    const role = await centaur.upsertRole('infra', {
      namespace: 'default',
      name: 'Infrastructure',
      labels: { managed_by: 'verso', purpose: 'runtime' },
    });

    const secret = await centaur.upsertStaticSecret(
      providerSecretForeignId(input.provider),
      providerSecretPayload(input.provider, apiKey),
    );

    await centaur.grantStaticSecretToRole(role.id, secret.id);

    const existing = await this.store.get(input.userId, input.provider);
    const nowIso = new Date().toISOString();
    const fingerprint = fingerprintKey(apiKey);
    const record: ModelProviderConnectionRecord = {
      userId: input.userId,
      provider: input.provider,
      status: 'connected',
      keyLast4: fingerprint.last4,
      keySha256Prefix: fingerprint.sha256Prefix,
      centaurStaticSecretId: secret.id,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    await this.store.upsert(record);
    return toConnectionView(input.provider, record);
  }

  async removeProviderKey(userId: string, provider: ModelProvider): Promise<ModelProviderConnectionView> {
    validateProvider(provider);
    const existing = await this.store.get(userId, provider);
    const instance = await this.resolver.resolveUserCentaurInstance(userId);
    const centaur = new CentaurConsoleClient({
      baseUrl: instance.consoleApiUrl,
      apiKey: instance.consoleApiKey,
    });

    let staticSecretId = existing?.centaurStaticSecretId ?? null;
    if (!staticSecretId) {
      const lookup = await centaur.lookupStaticSecret('default', providerSecretForeignId(provider));
      staticSecretId = lookup?.id ?? null;
    }

    if (staticSecretId) {
      await centaur.deleteStaticSecret(staticSecretId);
    }

    await this.store.delete(userId, provider);
    return toConnectionView(provider, null);
  }
}

interface CentaurEntity {
  id: string;
}

interface CentaurClientConfig {
  baseUrl: string;
  apiKey: string;
}

export class CentaurConsoleClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: CentaurClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  async upsertRole(foreignId: string, data: Record<string, unknown>): Promise<CentaurEntity> {
    return this.requestEntity('PUT', `/api/v1/roles/${encodeURIComponent(foreignId)}`, { data });
  }

  async upsertStaticSecret(foreignId: string, data: Record<string, unknown>): Promise<CentaurEntity> {
    return this.requestEntity('PUT', `/api/v1/static_secrets/${encodeURIComponent(foreignId)}`, { data });
  }

  async grantStaticSecretToRole(roleId: string, staticSecretId: string): Promise<void> {
    await this.request('POST', '/api/v1/grants', {
      data: {
        role_id: roleId,
        static_secret_id: staticSecretId,
      },
    });
  }

  async lookupStaticSecret(namespace: string, foreignId: string): Promise<CentaurEntity | null> {
    const response = await this.request(
      'GET',
      `/api/v1/static_secrets/lookup/${encodeURIComponent(namespace)}/${encodeURIComponent(foreignId)}`,
      undefined,
      { allow404: true },
    );
    if (response === null) return null;
    return extractEntity(response);
  }

  async deleteStaticSecret(staticSecretId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/static_secrets/${encodeURIComponent(staticSecretId)}`);
  }

  private async requestEntity(method: string, path: string, body: unknown): Promise<CentaurEntity> {
    return extractEntity(await this.request(method, path, body));
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { allow404?: boolean } = {},
  ): Promise<unknown | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ModelProviderServiceError(
        502,
        'centaur_unreachable',
        error instanceof Error ? error.message : 'Centaur console API is unreachable.',
      );
    }

    if (opts.allow404 && response.status === 404) return null;
    if (!response.ok) {
      throw new ModelProviderServiceError(
        502,
        'centaur_error',
        `Centaur console API returned HTTP ${response.status}.`,
      );
    }

    if (response.status === 204) return {};
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ModelProviderServiceError(502, 'centaur_error', 'Centaur console API returned invalid JSON.');
    }
  }
}

export function parseModelProvider(value: unknown): ModelProvider {
  if (value === 'openai' || value === 'anthropic') return value;
  throw new ModelProviderServiceError(400, 'invalid_provider', 'Provider must be "openai" or "anthropic".');
}

export function providerSecretForeignId(provider: ModelProvider): string {
  return provider === 'openai' ? 'openai-api-key' : 'anthropic-api-key';
}

export function providerSecretPayload(provider: ModelProvider, apiKey: string): Record<string, unknown> {
  if (provider === 'openai') {
    return {
      namespace: 'default',
      name: 'OpenAI API key',
      description: 'Model provider key managed by Verso settings.',
      labels: {
        managed_by: 'verso',
        kind: 'model_provider',
        provider: 'openai',
      },
      inject_config: {
        header: 'Authorization',
        formatter: 'Bearer {{.Value}}',
      },
      source: {
        source_type: 'control_plane',
        secret: apiKey,
        config: {},
      },
      rules: [
        {
          host: 'api.openai.com',
        },
      ],
    };
  }

  return {
    namespace: 'default',
    name: 'Anthropic API key',
    description: 'Model provider key managed by Verso settings.',
    labels: {
      managed_by: 'verso',
      kind: 'model_provider',
      provider: 'anthropic',
    },
    replace_config: {
      proxy_value: 'ANTHROPIC_API_KEY',
      match_headers: ['X-Api-Key'],
      require: true,
    },
    source: {
      source_type: 'control_plane',
      secret: apiKey,
      config: {},
    },
    rules: [
      {
        host: 'api.anthropic.com',
      },
    ],
  };
}

export function fingerprintKey(key: string): { last4: string; sha256Prefix: string } {
  return {
    last4: key.slice(-4),
    sha256Prefix: createHash('sha256').update(key).digest('hex').slice(0, 12),
  };
}

function validateProvider(provider: ModelProvider): void {
  parseModelProvider(provider);
}

function extractEntity(value: unknown): CentaurEntity {
  const data = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).data : null;
  if (typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).id === 'string') {
    return { id: (data as Record<string, unknown>).id as string };
  }
  throw new ModelProviderServiceError(502, 'centaur_error', 'Centaur console API response is missing data.id.');
}

type ModelProviderConnectionRow = typeof modelProviderConnections.$inferSelect;

function mapConnectionRow(row: ModelProviderConnectionRow): ModelProviderConnectionRecord {
  return {
    userId: row.userId,
    provider: parseModelProvider(row.provider),
    status: row.status === 'needs_attention' ? 'needs_attention' : 'connected',
    keyLast4: row.keyLast4,
    keySha256Prefix: row.keySha256Prefix,
    centaurStaticSecretId: row.centaurStaticSecretId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeConnection(record: ModelProviderConnectionRecord): typeof modelProviderConnections.$inferInsert {
  return {
    userId: record.userId,
    provider: record.provider,
    status: record.status,
    keyLast4: record.keyLast4,
    keySha256Prefix: record.keySha256Prefix,
    centaurStaticSecretId: record.centaurStaticSecretId,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function toConnectionView(
  provider: ModelProvider,
  record: ModelProviderConnectionRecord | null,
): ModelProviderConnectionView {
  if (!record) {
    return {
      provider,
      status: 'not_connected',
      keyLast4: null,
      keySha256Prefix: null,
      updatedAt: null,
    };
  }
  return {
    provider,
    status: record.status,
    keyLast4: record.keyLast4,
    keySha256Prefix: record.keySha256Prefix,
    updatedAt: record.updatedAt,
  };
}

function storeKey(userId: string, provider: ModelProvider): string {
  return `${userId}::${provider}`;
}
