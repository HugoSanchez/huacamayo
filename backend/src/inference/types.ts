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

export interface InferenceUsageTotals {
  monthToDateUsd: number;
  dayToDateUsd: number;
}

export interface InferenceStore {
  insertRequest(record: InferenceRequestRecord): Promise<void>;
  markCompleted(id: string, completedAt: string, usage: InferenceRequestUsage): Promise<void>;
  markFailed(id: string, completedAt: string, errorCode: string): Promise<void>;
  listByUserId(userId: string): Promise<InferenceRequestRecord[]>;
  /**
   * Sum of `estimated_cost_usd` over completed (non-null cost) requests for the
   * user, bucketed by month-to-date and day-to-date relative to `now` (UTC).
   */
  getUserUsageTotals(userId: string, now: Date): Promise<InferenceUsageTotals>;
}
