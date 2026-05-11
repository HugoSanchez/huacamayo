import type { InferenceRequestRecord, InferenceRequestUsage, InferenceStore } from './types.ts';

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
}
