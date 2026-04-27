export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: ActivityStep[];
  isStreaming?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
}

export interface StoredChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export type ActivityStep =
  | { type: 'text'; text: string }
  | { type: 'tool'; id?: string; name: string; input?: unknown; result?: string };

export interface ChatSSEEvent {
  type: string;
  message?: string | {
    role?: string;
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  };
  reason?: string;
  session_id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
}
