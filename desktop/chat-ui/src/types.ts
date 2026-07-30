export interface ChatMessage {
  id: string;
  sessionId?: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | null;
  steps?: ActivityStep[];
  isStreaming?: boolean;
  startedAt?: number;
  endedAt?: number;
  // Client-only marker. When set, the renderer swaps the normal message body
  // for a special widget (e.g. an inline Codex connect flow). Synthetic
  // messages with `kind` are never persisted to the orchestrator.
  kind?: 'codex_connect_required';
  // For `codex_connect_required` widgets: the message the user was trying to
  // send when we intercepted them. Once they finish connecting, we replay
  // this send in place of the widget so the chat continues seamlessly.
  pendingText?: string;
  pendingAttached?: AttachedContext | null;
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
  reasoning?: string | null;
  steps?: ActivityStep[];
  startedAt?: number;
  endedAt?: number;
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

export interface HubSkillSummaryView {
  identifier: string;
  name: string;
  slug: string;
  description: string;
  source: string;
  trustLevel: string;
  repo: string | null;
  path: string | null;
  tags: string[];
  installed: boolean;
}

export interface HubSkillDetailView extends HubSkillSummaryView {
  content: string;
  rawContent: string;
  files: string[];
}

export interface HubSkillInstallView {
  installed: boolean;
  changed: boolean;
  skill: {
    name: string;
    source: string;
    identifier: string;
    trustLevel: string;
    scanVerdict: string;
    contentHash: string;
    installPath: string;
    files: string[];
    installedAt: string | null;
    updatedAt: string | null;
  } | null;
  message: string;
  output: string;
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

// Reasoning-effort levels offered in the chat-input selector. A subset of the
// levels Hermes accepts (it also supports "minimal"/"xhigh"); these are the
// ones we surface to non-technical users. Sent per message as
// `reasoningEffort` and applied by the gateway over its config.yaml default.
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

// Codex models offered in the chat-input model selector. Order defines the
// click-to-cycle sequence. Sent per message as `model` and applied by the
// gateway over its config.yaml default (validated server-side too).
export const CHAT_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

export const CHAT_MODEL_LABELS: Record<ChatModel, string> = {
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 mini',
};

export type HarnessType = 'codex' | 'claudecode' | 'amp';

export interface HarnessModelOption {
  id: string;
  label: string;
  group: string;
  harnessType: HarnessType;
  model?: string;
  provider?: string;
  shortcut?: string;
  badge?: string;
  favorite?: boolean;
}

export interface HarnessModelGroup {
  id: HarnessType;
  label: string;
  options: HarnessModelOption[];
}

export const HARNESS_MODEL_GROUPS: HarnessModelGroup[] = [
  {
    id: 'claudecode',
    label: 'Claude Code',
    options: [
      { id: 'claudecode:claude-sonnet-5', label: 'Sonnet 5 1M', group: 'Claude Code', harnessType: 'claudecode', model: 'claude-sonnet-5', provider: 'anthropic', shortcut: '1', badge: 'NEW' },
      { id: 'claudecode:claude-fable-5', label: 'Fable 5', group: 'Claude Code', harnessType: 'claudecode', model: 'claude-fable-5', provider: 'anthropic', shortcut: '2' },
      { id: 'claudecode:claude-opus-4-8', label: 'Opus 4.8 1M', group: 'Claude Code', harnessType: 'claudecode', model: 'claude-opus-4-8[1m]', provider: 'anthropic', shortcut: '3' },
      { id: 'claudecode:claude-opus-4-7', label: 'Opus 4.7 1M', group: 'Claude Code', harnessType: 'claudecode', model: 'claude-opus-4-7[1m]', provider: 'anthropic', shortcut: '4' },
      { id: 'claudecode:claude-opus-4-6', label: 'Opus 4.6 1M', group: 'Claude Code', harnessType: 'claudecode', model: 'claude-opus-4-6[1m]', provider: 'anthropic', shortcut: '5' },
      { id: 'claudecode:claude-sonnet-4-6-1m', label: 'Sonnet 4.6 1M', group: 'Claude Code', harnessType: 'claudecode', model: 'claude-sonnet-4-6[1m]', provider: 'anthropic', shortcut: '6' },
      { id: 'claudecode:claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'Claude Code', harnessType: 'claudecode', model: 'claude-sonnet-4-6', provider: 'anthropic', shortcut: '7' },
      { id: 'claudecode:claude-haiku-4-5', label: 'Haiku 4.5', group: 'Claude Code', harnessType: 'claudecode', model: 'claude-haiku-4-5', provider: 'anthropic', shortcut: '8' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    options: [
      { id: 'codex:gpt-5.5', label: 'GPT-5.5', group: 'Codex', harnessType: 'codex', model: 'gpt-5.5', provider: 'openai', shortcut: '9', favorite: true },
      { id: 'codex:gpt-5.4', label: 'GPT-5.4', group: 'Codex', harnessType: 'codex', model: 'gpt-5.4', provider: 'openai' },
    ],
  },
  {
    id: 'amp',
    label: 'Amp',
    options: [
      { id: 'amp:deep', label: 'Deep', group: 'Amp', harnessType: 'amp', model: 'deep', provider: 'amp' },
      { id: 'amp:smart', label: 'Smart', group: 'Amp', harnessType: 'amp', model: 'smart', provider: 'amp' },
      { id: 'amp:rush', label: 'Rush', group: 'Amp', harnessType: 'amp', model: 'rush', provider: 'amp' },
    ],
  },
];

export const DEFAULT_HARNESS_MODEL_ID = 'codex:gpt-5.5';

export const HARNESS_MODEL_OPTIONS = HARNESS_MODEL_GROUPS.flatMap((group) => group.options);

export const HARNESS_MODEL_BY_ID: Record<string, HarnessModelOption> = Object.fromEntries(
  HARNESS_MODEL_OPTIONS.map((option) => [option.id, option]),
);

export function getHarnessModelOption(id: string | null | undefined): HarnessModelOption {
  return HARNESS_MODEL_BY_ID[id ?? ''] ?? HARNESS_MODEL_BY_ID[DEFAULT_HARNESS_MODEL_ID];
}

export type ActivityStep =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'status'; label: string; kind?: string; source?: string | null; durationMs?: number | null }
  | {
      type: 'tool';
      id?: string;
      name: string;
      input?: unknown;
      result?: string;
      label?: string;
      icon?: ToolStepIcon;
      detail?: unknown;
      summary?: string;
      status?: 'running' | 'ok' | 'error';
      connection?: ConnectionRequestView;
    };

export type ToolStepIcon =
  | { type: 'glyph'; name: string }
  | { type: 'url'; url: string; fallback: string };

export interface ChatSSEEvent {
  type: string;
  message?: string | {
    role?: string;
    content?: Array<{
      type: string;
      id?: string;
      text?: string;
      name?: string;
      input?: unknown;
      detail?: unknown;
      label?: string;
      icon?: ToolStepIcon;
      tool_use_id?: string;
      content?: unknown;
      status?: 'ok' | 'error';
      summary?: string;
    }>;
  };
  delta?: { text?: string } | string;
  reasoning?: string | null;
  reason?: string;
  session_id?: string;
  role?: string;
  content?: Array<{
    type: string;
    id?: string;
    text?: string;
    name?: string;
    input?: unknown;
    detail?: unknown;
    label?: string;
    icon?: ToolStepIcon;
    tool_use_id?: string;
    content?: unknown;
    status?: 'ok' | 'error';
    summary?: string;
  }>;
  kind?: string;
  source?: string | null;
  duration_ms?: number | null;
  stop_reason?: string;
}
