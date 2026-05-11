import { eq } from 'drizzle-orm';
import { getDb } from './client.ts';
import { inferenceRequests } from './schema.ts';
import type {
  InferenceRequestRecord,
  InferenceRequestUsage,
  InferenceStatus,
  InferenceStore,
} from '../inference/types.ts';

type Db = ReturnType<typeof getDb>;
type Row = typeof inferenceRequests.$inferSelect;

export class DrizzleInferenceStore implements InferenceStore {
  private readonly db: Db;

  constructor(databaseUrl: string) {
    this.db = getDb(databaseUrl);
  }

  async insertRequest(record: InferenceRequestRecord): Promise<void> {
    await this.db.insert(inferenceRequests).values({
      id: record.id,
      userId: record.userId,
      deviceId: record.deviceId,
      localSessionId: record.localSessionId,
      provider: record.provider,
      model: record.model,
      requestStartedAt: new Date(record.requestStartedAt),
      requestCompletedAt: record.requestCompletedAt ? new Date(record.requestCompletedAt) : null,
      status: record.status,
      inputTokens: serializeNumber(record.inputTokens),
      outputTokens: serializeNumber(record.outputTokens),
      cachedTokens: serializeNumber(record.cachedTokens),
      reasoningTokens: serializeNumber(record.reasoningTokens),
      estimatedCostUsd: serializeNumber(record.estimatedCostUsd),
      providerRequestId: record.providerRequestId,
      errorCode: record.errorCode,
    });
  }

  async markCompleted(id: string, completedAt: string, usage: InferenceRequestUsage): Promise<void> {
    await this.db
      .update(inferenceRequests)
      .set({
        status: 'completed',
        requestCompletedAt: new Date(completedAt),
        inputTokens: serializeNumber(usage.inputTokens),
        outputTokens: serializeNumber(usage.outputTokens),
        cachedTokens: serializeNumber(usage.cachedTokens),
        reasoningTokens: serializeNumber(usage.reasoningTokens),
        estimatedCostUsd: serializeNumber(usage.estimatedCostUsd),
        providerRequestId: usage.providerRequestId,
      })
      .where(eq(inferenceRequests.id, id));
  }

  async markFailed(id: string, completedAt: string, errorCode: string): Promise<void> {
    await this.db
      .update(inferenceRequests)
      .set({
        status: 'failed',
        requestCompletedAt: new Date(completedAt),
        errorCode,
      })
      .where(eq(inferenceRequests.id, id));
  }

  async listByUserId(userId: string): Promise<InferenceRequestRecord[]> {
    const rows = await this.db.select().from(inferenceRequests).where(eq(inferenceRequests.userId, userId));
    return rows.map(mapRow);
  }
}

function mapRow(row: Row): InferenceRequestRecord {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    localSessionId: row.localSessionId,
    provider: row.provider,
    model: row.model,
    requestStartedAt: row.requestStartedAt.toISOString(),
    requestCompletedAt: row.requestCompletedAt ? row.requestCompletedAt.toISOString() : null,
    status: row.status as InferenceStatus,
    inputTokens: parseNumber(row.inputTokens),
    outputTokens: parseNumber(row.outputTokens),
    cachedTokens: parseNumber(row.cachedTokens),
    reasoningTokens: parseNumber(row.reasoningTokens),
    estimatedCostUsd: parseNumber(row.estimatedCostUsd),
    providerRequestId: row.providerRequestId,
    errorCode: row.errorCode,
  };
}

function serializeNumber(value: number | null): string | null {
  return value === null ? null : String(value);
}

function parseNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
