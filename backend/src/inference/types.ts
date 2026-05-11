export type InferenceStatus = 'pending' | 'completed' | 'failed';

export interface InferenceRequestRecord {
  id: string;
  userId: string;
  deviceId: string;
  localSessionId: string | null;
  provider: string;
  model: string;
  requestStartedAt: string;
  requestCompletedAt: string | null;
  status: InferenceStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  estimatedCostUsd: number | null;
  providerRequestId: string | null;
  errorCode: string | null;
}

export interface InferenceRequestUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  estimatedCostUsd: number | null;
  providerRequestId: string | null;
}

export interface InferenceStore {
  insertRequest(record: InferenceRequestRecord): Promise<void>;
  markCompleted(id: string, completedAt: string, usage: InferenceRequestUsage): Promise<void>;
  markFailed(id: string, completedAt: string, errorCode: string): Promise<void>;
  listByUserId(userId: string): Promise<InferenceRequestRecord[]>;
}
