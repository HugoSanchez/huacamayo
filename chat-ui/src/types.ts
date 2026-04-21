export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: ActivityStep[];
  isStreaming?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export type ActivityStep =
  | { type: 'text'; text: string }
  | { type: 'tool'; id?: string; name: string; input?: unknown; result?: string };

/** SSE event from /agent/query */
export interface AgentSSEEvent {
  type: string;
  message?: string;
  reason?: string;
  session_id?: string;
  // Claude Agent SDK message fields
  role?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
}
