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
  archivedAt: string | null;
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

export interface ConnectionRequestView {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: 'pending' | 'connected' | 'failed' | 'expired';
  redirectUrl: string | null;
  connectedAccountId: string | null;
  errorMessage: string | null;
}

export interface ConnectionView {
  connectedAccountId: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: 'active' | 'inactive';
}

export interface ToolkitView {
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  connected: boolean;
  connectedAccountId: string | null;
  noAuth: boolean;
}

export interface SkillSummaryView {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  prerequisites: string[];
  platforms: string[];
  enabled: boolean;
  pinned: boolean;
}

export interface SkillDetailView extends SkillSummaryView {
  content: string;
}

export interface CronJobView {
  id: string;
  name: string;
  prompt: string;
  skills: string[];
  schedule: { kind?: string; display?: string; expr?: string; minutes?: number; run_at?: string } | null;
  schedule_display: string | null;
  enabled: boolean;
  state: string;
  paused_at: string | null;
  paused_reason: string | null;
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  deliver: string | null;
  origin: Record<string, unknown> | null;
}

export interface CronRunSummaryView {
  filename: string;
  ts: string;
  size: number;
  modified: string;
}

export interface CronDescriptionView {
  text: string;
  source: 'auto' | 'user';
  generatedAt: number;
}

export interface CronDetailView {
  cron: CronJobView;
  runs: CronRunSummaryView[];
  description: CronDescriptionView | null;
}

export interface CronRunTranscriptMessage {
  role: string;
  content: unknown;
  reasoning?: string | null;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
  timestamp?: number | string | null;
}

export interface CronRunTranscriptView {
  sessionId: string;
  messages: CronRunTranscriptMessage[];
}

// Generalized "context attachment" for the chat input. Today the input bar
// supports two flavours: a skill (auto-promoted from `/skill-name` text) and
// a cron job (attached via the "Edit in chat" button on its detail page).
export type AttachedContext =
  | { kind: 'skill'; slug: string }
  | { kind: 'cron'; id: string; name: string };

export type ActivityStep =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      id?: string;
      name: string;
      input?: unknown;
      result?: string;
      connection?: ConnectionRequestView;
    };

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
