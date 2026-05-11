import type {
  InferenceRequestRecord,
  InferenceRequestUsage,
  InferenceStore,
  InferenceUsageTotals,
} from './types.ts';

export class MemoryInferenceStore implements InferenceStore {
  private readonly recordsById = new Map<string, InferenceRequestRecord>();

  async insertRequest(record: InferenceRequestRecord): Promise<void> {
    this.recordsById.set(record.id, { ...record });
  }

  async markCompleted(id: string, completedAt: string, usage: InferenceRequestUsage): Promise<void> {
    const existing = this.recordsById.get(id);
    if (!existing) return;
    this.recordsById.set(id, {
      ...existing,
      status: 'completed',
      requestCompletedAt: completedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      reasoningTokens: usage.reasoningTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
      providerRequestId: usage.providerRequestId ?? existing.providerRequestId,
    });
  }

  async markFailed(id: string, completedAt: string, errorCode: string): Promise<void> {
    const existing = this.recordsById.get(id);
    if (!existing) return;
    this.recordsById.set(id, {
      ...existing,
      status: 'failed',
      requestCompletedAt: completedAt,
      errorCode,
    });
  }

  async listByUserId(userId: string): Promise<InferenceRequestRecord[]> {
    return Array.from(this.recordsById.values()).filter((record) => record.userId === userId);
  }

  async getUserUsageTotals(userId: string, now: Date): Promise<InferenceUsageTotals> {
    const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let monthToDateUsd = 0;
    let dayToDateUsd = 0;
    for (const record of this.recordsById.values()) {
      if (record.userId !== userId) continue;
      if (record.estimatedCostUsd === null) continue;
      const ts = Date.parse(record.requestStartedAt);
      if (Number.isNaN(ts)) continue;
      if (ts >= startOfMonth) monthToDateUsd += record.estimatedCostUsd;
      if (ts >= startOfDay) dayToDateUsd += record.estimatedCostUsd;
    }
    return { monthToDateUsd, dayToDateUsd };
  }
}
