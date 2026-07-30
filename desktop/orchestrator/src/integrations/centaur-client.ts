/**
 * Centaur backend client + SSE translation shim.
 *
 * A spike-only alternative to the local Hermes gateway: instead of spawning
 * Hermes, the orchestrator drives a personal Centaur instance on Lightsail
 * (reached over an SSH tunnel — see `.context/plan-verso-centaur-spike.md`).
 *
 * Everything here is dormant unless `VERSO_AGENT_BACKEND=centaur`. When the
 * flag is unset `isCentaurBackend()` returns false and no code in this module
 * runs, so main-branch behavior is byte-identical.
 *
 * The API surface is the RFC-0002 session API served by the pinned api-rs
 * images (`/api/session/*`), mirrored from `scripts/ask.sh` in centaur-sm-poc:
 *   POST /api/session/{tk}            create-or-get a durable thread
 *   POST /api/session/{tk}/messages  persist the user turn
 *   POST /api/session/{tk}/execute   run the harness, returns execution_id
 *   GET  /api/session/{tk}/events     SSE: execution_started → sandbox_ready →
 *                                     N× output.line → terminal completed/failed
 */

import {
  classifyToolCall,
  summarizeToolResult,
  type CentaurToolIcon,
} from './centaur-tool-classifier.ts';

export { classifyToolCall, summarizeToolResult } from './centaur-tool-classifier.ts';

export type CentaurHarness = 'codex' | 'amp' | 'claudecode';

const VALID_HARNESSES: readonly CentaurHarness[] = ['codex', 'amp', 'claudecode'];
const DEFAULT_HARNESS: CentaurHarness = 'claudecode';

export interface CentaurConfig {
  baseUrl: string;
  apiKey: string | null;
  harness: CentaurHarness;
  /** Composio entity id (the user's Verso user id) — see buildSessionPreamble. */
  composioUserId: string | null;
}

/**
 * True when the orchestrator should route chat through Centaur instead of the
 * local Hermes gateway. The single gate every centaur code path branches on.
 */
export function isCentaurBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERSO_AGENT_BACKEND?.trim().toLowerCase() === 'centaur';
}

/**
 * Resolve the Centaur endpoint/key/harness from the environment. Returns null
 * when the backend flag is off (so callers can treat it as "not configured").
 * Throws only when the flag is ON but the URL is missing — a misconfiguration
 * we want to surface loudly rather than silently fall back to Hermes.
 */
export function readCentaurConfig(env: NodeJS.ProcessEnv = process.env): CentaurConfig | null {
  if (!isCentaurBackend(env)) return null;

  const baseUrl = env.VERSO_CENTAUR_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      'VERSO_AGENT_BACKEND=centaur requires VERSO_CENTAUR_URL (e.g. http://127.0.0.1:18080 for the SSH tunnel).',
    );
  }

  const rawHarness = env.VERSO_CENTAUR_HARNESS?.trim().toLowerCase();
  const harness = (VALID_HARNESSES as readonly string[]).includes(rawHarness ?? '')
    ? (rawHarness as CentaurHarness)
    : DEFAULT_HARNESS;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: env.VERSO_CENTAUR_API_KEY?.trim() || null,
    harness,
    composioUserId: env.VERSO_CENTAUR_COMPOSIO_USER_ID?.trim() || null,
  };
}

/**
 * Compact reminder prepended to every NON-first message. The full preamble
 * lives three-plus turns back by the time the user asks for a Slack action,
 * and it demonstrably loses to the salient (broken) CLI tool inventory — the
 * agent ran `slack --help` right past a "do NOT attempt" note. Repetition wins.
 */
export function buildTurnReminder(composioUserId: string | null): string {
  const userId = composioUserId ?? "<ask the user for their Composio user id>";
  return `<verso-reminder>
For any action on the user's apps (Slack, Gmail, Calendar, Notion, ...), use the Composio
Python client via the symlink pattern from the start of this session: search_tools(query,
user_id) to find the tool slug, then execute(slug, args, user_id). ALWAYS pass
user_id='${userId}'. Never use the first-party slack/linear/notion CLIs (broken on this
instance), and never judge capabilities from \`composio health\` (github-only check).
For questions about the user's history, work, contacts, or preferences, search personal
memory FIRST (before web/Composio): use \`memory search "..."\` if the wrapper is
installed. If \`memory\` is not on PATH, symlink
/home/agent/github/HugoSanchez/centaur/tools/productivity/memory as "memory" in a tmpdir,
then \`python -m memory.cli search "..."\` via the same uv --no-project pattern. Save
durable new facts with \`memory write\` or \`memory.cli write\` (search first; update,
don't duplicate).
Attribute memory answers in human terms (title/source/date, link if present) — never
show raw doc:<id> refs to the user.
</verso-reminder>`;
}

export class CentaurHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'CentaurHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface CentaurExecuteOptions {
  idleTimeoutMs?: number;
  maxDurationMs?: number;
  idempotencyKey?: string | null;
  model?: string | null;
  provider?: string | null;
}

export interface CentaurGatewayStatus {
  reachable: boolean;
  state: 'ready' | 'starting' | 'error';
}

// Verso session id → durable Centaur thread. api-rs validates that thread keys
// are namespaced `<source>:<id>`; `verso:` is our source prefix.
export function threadKeyForSession(sessionId: string): string {
  return `verso:${sessionId}`;
}

export function buildCentaurInputLine(opts: {
  threadKey: string;
  text: string;
  model?: string | null;
  provider?: string | null;
}): string {
  return JSON.stringify({
    type: 'user',
    thread_key: opts.threadKey,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    message: {
      role: 'user',
      content: [{ type: 'text', text: opts.text }],
    },
  });
}

/**
 * Environment notes injected ahead of the FIRST user message of each session.
 *
 * Why: the sandbox's `composio` CLI exposes only `health`; the real client is
 * the Python module. Without this note the agent burns ~9 shell commands per
 * session rediscovering that (measured 77s vs ~15s). Injecting it client-side
 * is the spike-grade fix — the durable home for this text is an overlay-repo
 * skill, at which point this preamble can be deleted.
 *
 * The preamble goes only to Centaur (appendMessage/execute); the local
 * ChatStore keeps the user's clean prompt, so the UI never shows it.
 */
export function buildSessionPreamble(composioUserId: string | null): string {
  const userId = composioUserId ?? "<ask the user for their Composio user id>";
  return `<verso-environment-notes>
You are the user's personal assistant inside Verso, a macOS app, running on their private
cloud agent instance. Identity: you are Verso's assistant — do NOT describe yourself as
"Centaur" or "Paradigm's assistant". Answer identity and small-talk questions directly,
without running any commands.

WORKS on this instance:
- Personal memory — the user's own history (Slack, Google Docs, meeting notes, past
  chats), searchable and writable. Check it FIRST for anything touching the user's work,
  projects, contacts, or preferences — before web search and before Composio. Preferred
  invocation:
    memory status
    memory search "kinexys rpc" --limit 5
  If \`memory\` is not on PATH, use this fallback invocation (same symlink rule as
  Composio; the import name only resolves through the symlink):
    TMPD=$(mktemp -d)
    ln -s /home/agent/github/HugoSanchez/centaur/tools/productivity/memory "$TMPD/memory"
    cd "$TMPD" && PYTHONPATH="$TMPD:/opt/centaur" uv run --no-project \\
      --with 'asyncpg>=0.30.0' --with 'python-dotenv>=1.0.0' \\
      --with 'rich>=13.0.0' --with 'typer>=0.12.0' python -m memory.cli \\
      search "kinexys rpc" --limit 5
  Commands: search QUERY [--limit N] [--source slack|gdrive|granola|chat] [--json],
  page <slug or doc:ID>, write SLUG --title T --content "...", list, status.
  If a search misses, reword it once (synonyms, or the other language) and retry before
  concluding memory has nothing. Save durable new facts about the user as pages with
  \`write\` — search first and UPDATE an existing page rather than creating a
  near-duplicate. When memory informs an answer, attribute it in HUMAN terms — the
  entry's title, source, and date ("your All-Hands notes from July 8", "a Slack thread
  in #eng-cloud on July 9"), with its link when it carries one. NEVER show raw internal
  refs like doc:1028 to the user — those ids are only for your own follow-up
  \`memory.cli page doc:ID\` reads.
- Composio — the user's own connected apps (Gmail, Slack, Google Calendar, Notion, ...).
  This is THE way to read or act on the user's personal apps. The \`composio\` CLI exposes
  only \`health\`; call the Python client with this exact pattern (the import name only
  resolves through the symlink — do not skip it):
    TMPD=$(mktemp -d)
    ln -s /app/tools/productivity/composio "$TMPD/centaur_tool_composio"
    cd "$TMPD" && PYTHONPATH="$TMPD:/opt/centaur" uv run --no-project \\
      --with 'composio>=0.13.0' --with 'python-dotenv>=1.0.0' \\
      --with 'rich>=13.0.0' --with 'typer>=0.12.0' python -c "
    from centaur_tool_composio.client import ComposioClient
    c = ComposioClient()
    print(c.execute('GMAIL_FETCH_EMAILS', {'max_results': 1}, user_id='${userId}'))
    "
  Client methods: search_tools(query, user_id), list_tools(toolkit, user_id),
  get_tool_schema(tool_slug, user_id), execute(tool_slug, arguments, user_id).
  The same client handles ALL the user's apps — e.g. for Slack, first
  c.search_tools('send slack message', user_id='${userId}') to find the tool slug, then
  c.execute(that_slug, {...}, user_id='${userId}'). Same for Calendar, Notion, etc.
  WARNING: \`composio health\` output lists GITHUB_* actions only — it is a hardcoded
  github connectivity check, NOT an inventory of available apps. Never conclude an app
  is unavailable from health output; use search_tools.
  ALWAYS pass user_id='${userId}' — it scopes calls to this user's connected accounts.
- Web research and general shell/python work in your sandbox.

BROKEN or unconfigured on this instance — do NOT attempt, they only waste time:
- First-party tool CLIs (slack, linear, notion, gsuite, ...): version-skewed or not set
  up here. Known examples: \`slack\` fails with a centaur_sdk ImportError, and
  SLACK_BOT_TOKEN is a placeholder for a Slack app that is not installed (direct Slack
  API calls return invalid_auth). For Slack/Gmail/Calendar actions, use Composio above.
</verso-environment-notes>`;
}

/**
 * Raw event as read off the api-rs SSE stream: numeric monotonic id, event
 * name, and the `data:` payload (a JSON string for structured events, or the
 * harness's raw stdout line for `session.output.line`).
 */
export interface CentaurRawEvent {
  id: number | null;
  event: string;
  data: string;
}

export class CentaurClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;

  constructor(config: Pick<CentaurConfig, 'baseUrl' | 'apiKey'>) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  /** Liveness probe used by tests and legacy callers. */
  async healthy(timeoutMs = 1500, signal?: AbortSignal): Promise<boolean> {
    const status = await this.gatewayStatus(timeoutMs, signal);
    return status.reachable;
  }

  /**
   * Readiness probe used by /chat/status. `/healthz` only proves the process is
   * alive; `/readyz` catches startup/config states where api-rs is listening
   * but not ready to create sessions.
   */
  async gatewayStatus(timeoutMs = 1500, signal?: AbortSignal): Promise<CentaurGatewayStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const ready = await fetch(`${this.baseUrl}/readyz`, {
        method: 'GET',
        signal: mergeSignals(controller.signal, signal),
      });
      if (ready.ok) {
        const body = await ready.json().catch(() => null);
        return {
          reachable: true,
          state: body?.ready === false ? 'starting' : 'ready',
        };
      }

      const health = await fetch(`${this.baseUrl}/healthz`, {
        method: 'GET',
        signal: mergeSignals(controller.signal, signal),
      });
      return {
        reachable: health.ok,
        state: health.ok ? 'starting' : 'error',
      };
    } catch {
      return { reachable: false, state: 'error' };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Create-or-get the durable thread for this Verso session. Idempotent: safe
   * to call on every turn. `on_harness_conflict: restart` lets a per-session
   * harness override swap harnesses (the new one starts with no memory) instead
   * of failing with 409.
   */
  async ensureSession(
    threadKey: string,
    harness: CentaurHarness,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.postJson(`/api/session/${encodeURIComponent(threadKey)}`, {
      harness_type: harness,
      persona_id: null,
      metadata: { source: 'verso' },
      on_harness_conflict: 'restart',
    }, signal, [200, 201]);
  }

  /** Persist the user turn before executing (mirrors ask.sh). */
  async appendMessage(
    threadKey: string,
    text: string,
    clientMessageId: string | null = null,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.postJson(`/api/session/${encodeURIComponent(threadKey)}/messages`, {
      messages: [{
        client_message_id: clientMessageId,
        role: 'user',
        parts: [{ type: 'text', text }],
        metadata: { source: 'verso' },
      }],
    }, signal, [200, 201]);
  }

  /**
   * Kick off a harness turn. The single input line is block-encoded — codex
   * requires each `input_line` to be a JSON content block, and claudecode
   * accepts the same shape. Returns the execution id used to scope the event
   * stream to this turn.
   */
  async execute(
    threadKey: string,
    text: string,
    opts: CentaurExecuteOptions = {},
    signal?: AbortSignal,
  ): Promise<{ executionId: string }> {
    const block = buildCentaurInputLine({
      threadKey,
      text,
      model: opts.model,
      provider: opts.provider,
    });
    const body = await this.postJson(`/api/session/${encodeURIComponent(threadKey)}/execute`, {
      idempotency_key: opts.idempotencyKey ?? null,
      metadata: { source: 'verso' },
      input_lines: [block],
      idle_timeout_ms: opts.idleTimeoutMs ?? 60_000,
      max_duration_ms: opts.maxDurationMs ?? 300_000,
    }, signal, [200]);
    const executionId = typeof body?.execution_id === 'string' ? body.execution_id : '';
    return { executionId };
  }

  /**
   * Stream session events over SSE from `afterEventId` (exclusive). Persisting
   * the last seen id per session and replaying from it is the API's resilience
   * model — a dropped connection or app restart resumes without duplicating
   * output. When `executionId` is given, api-rs scopes the stream to that turn.
   *
   * `onEvent` is invoked for every parsed event; return `true` from the caller
   * side by throwing to abort. This method resolves once a terminal event
   * (`execution_completed|failed|cancelled`) is seen or the stream closes.
   */
  async streamEvents(
    threadKey: string,
    afterEventId: number,
    executionId: string | null,
    signal: AbortSignal,
    onEvent: (event: CentaurRawEvent) => void,
  ): Promise<void> {
    const params = new URLSearchParams({ after_event_id: String(afterEventId) });
    if (executionId) params.set('execution_id', executionId);
    const url = `${this.baseUrl}/api/session/${encodeURIComponent(threadKey)}/events?${params.toString()}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...this.authHeaders() },
      signal,
    });

    if (!res.ok || !res.body) {
      const responseBody = await safeReadBody(res);
      throw new CentaurHttpError(
        res.status,
        responseBody,
        `Centaur event stream failed (HTTP ${res.status})${responseBody ? `: ${responseBody}` : ''}`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const parsed = parseSseFrame(frame);
        if (!parsed) continue;
        onEvent(parsed);
        if (isTerminalEventName(parsed.event)) return;
      }
    }

    const trailing = parseSseFrame(buffer);
    if (trailing) onEvent(trailing);
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { 'X-Api-Key': this.apiKey } : {};
  }

  private async postJson(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    okStatuses: number[],
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal,
    });

    if (!okStatuses.includes(res.status)) {
      const responseBody = await safeReadBody(res);
      throw new CentaurHttpError(
        res.status,
        responseBody,
        `Centaur ${path} failed (HTTP ${res.status})${responseBody ? `: ${responseBody}` : ''}`,
      );
    }

    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

const TERMINAL_EVENT_NAMES = new Set([
  'session.execution_completed',
  'session.execution_failed',
  'session.execution_cancelled',
  'session.stream_error',
]);

export function isTerminalEventName(name: string): boolean {
  return TERMINAL_EVENT_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// SSE translation shim
//
// Maps Centaur session events → the neutral chat frames the orchestrator's
// chat-ui contract renders. The `session.output.line` payload is NOT opaque —
// it carries the harness's structured JSON (codex emits JSON-RPC-style
// {method, params} frames; claudecode's dialect is still being characterized).
// We extract incremental assistant text, reasoning, and tool activity where we
// recognize the shape, and fall back to the terminal `result_text` otherwise.
// ---------------------------------------------------------------------------

export type CentaurChatEvent =
  | { kind: 'status'; statusKind: 'sandbox_starting' | 'sandbox_ready'; message: string; source?: string | null; durationMs?: number | null }
  | { kind: 'text_delta'; text: string }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'reasoning_done' }
  | { kind: 'tool_call_started'; callId?: string; tool: string; icon: CentaurToolIcon; label: string; detail: unknown }
  | { kind: 'tool_call_done'; callId?: string; status: 'ok' | 'error'; summary: string; content: unknown }
  | { kind: 'completed'; resultText: string }
  | { kind: 'error'; message: string };

export class CentaurStreamTranslator {
  // Answer text keyed by harness item id (codex), in first-seen order. Deltas
  // accumulate here and an `item.completed` reconciles (replaces) the same id's
  // text with the canonical version instead of double-counting.
  private readonly answerByItemId = new Map<string, string>();
  // Cumulative answer text from Anthropic-style `assistant` frames (claudecode),
  // which restate the whole message each frame rather than sending deltas.
  private harnessAnswerText = '';
  // The exact answer text already emitted to the append-only UI. EVERY emission
  // must be a pure continuation of this string — the chat UI only ever does
  // `content = content + delta`, so emitting anything that isn't a genuine
  // extension interleaves a second copy of the answer on screen. This mirrors
  // the guard in davao's renderer (packages/rendering/src/codex-app-server.ts,
  // `emitPendingAssistantText`).
  private streamedAnswerText = '';

  handle(event: CentaurRawEvent): CentaurChatEvent[] {
    switch (event.event) {
      case 'session.execution_started':
        return [{ kind: 'status', statusKind: 'sandbox_starting', message: 'Starting workspace' }];
      case 'session.sandbox_ready':
        return [describeSandboxReady(event.data)];
      case 'session.output.line':
        return this.handleOutputLine(event.data);
      case 'session.execution_completed':
        return [{ kind: 'completed', resultText: extractResultText(event.data) }];
      case 'session.execution_failed':
      case 'session.stream_error':
        return [{ kind: 'error', message: extractError(event.data) || 'Centaur execution failed' }];
      case 'session.execution_cancelled':
        return [{ kind: 'error', message: extractError(event.data) || 'Execution cancelled' }];
      default:
        return [];
    }
  }

  /**
   * The canonical full answer, recomposed from every source. This is the single
   * source of truth for both live streaming and final storage — codex per-item
   * text first (in arrival order), then any cumulative `assistant` text.
   */
  composedAnswer(): string {
    const segments = [...this.answerByItemId.values()];
    if (this.harnessAnswerText) segments.push(this.harnessAnswerText);
    return segments.filter(Boolean).join('\n\n');
  }

  /**
   * Emit only the portion of the recomposed answer that genuinely extends what
   * the UI has already rendered. If the recomposed answer no longer starts with
   * what we've streamed — a canonical rewrite, or a second source restating the
   * same text — we suppress the live emission rather than append a divergent
   * copy. `composedAnswer()` still returns the corrected text for storage, so
   * the persisted message is right even when a live rewrite is dropped.
   */
  private emitAnswerText(): CentaurChatEvent[] {
    const full = this.composedAnswer();
    if (!full.startsWith(this.streamedAnswerText)) return [];
    const suffix = full.slice(this.streamedAnswerText.length);
    if (!suffix) return [];
    this.streamedAnswerText = full;
    return [{ kind: 'text_delta', text: suffix }];
  }

  private handleOutputLine(line: string): CentaurChatEvent[] {
    const notification = normalizeNotification(line);
    if (!notification) return [];

    const type = String(notification.type ?? '');

    // Reasoning deltas (codex): stream as they arrive; the completed reasoning
    // item is redundant with the deltas so we don't re-emit it.
    if (type === 'item.reasoning.textDelta' || type === 'item.reasoning.summaryTextDelta') {
      const text = String(notification.delta ?? '');
      return text ? [{ kind: 'reasoning_delta', text }] : [];
    }

    // Incremental agent message text (codex). Accumulate under the item id and
    // emit only the genuine continuation. A NEW message item after earlier
    // answer text is separated by a paragraph break — which falls out naturally
    // from recomposing (join '\n\n') and slicing the suffix, so multi-phase
    // answers never run together ("...before I go further.The token resolves...").
    if (type === 'item.agentMessage.delta') {
      const id = itemId(notification);
      const text = extractDeltaText(notification);
      if (!text) return [];
      this.answerByItemId.set(id, (this.answerByItemId.get(id) ?? '') + text);
      return this.emitAnswerText();
    }

    // Completed items (codex): agent messages reconcile stored text; command
    // executions become tool_result frames so the UI logs the agent's work.
    if (type === 'item.completed') {
      const item = asRecord(notification.item);
      const itemType = String(item?.type ?? '');
      if (itemType === 'agentMessage' || itemType === 'agent_message') {
        const id = itemId(notification);
        const text = String(item?.text ?? '');
        if (!text) return [];
        // If this completed frame's id doesn't line up with the deltas that
        // already streamed this exact text (id drift across frames), don't add a
        // second copy — it's already on screen and in the composed answer.
        if (!this.answerByItemId.has(id) && this.streamedAnswerText.endsWith(text)) {
          return [];
        }
        // Reconcile: replace this item's text with the canonical version, then
        // emit only whatever genuinely extends what we've already streamed
        // (usually nothing, since the deltas already carried it).
        this.answerByItemId.set(id, text);
        return this.emitAnswerText();
      }
      if (itemType === 'reasoning' || itemType === 'reasoning_summary') {
        return [{ kind: 'reasoning_done' }];
      }
      const completedCommand = typeof item?.command === 'string' ? item.command : '';
      if (completedCommand) {
        const output = typeof item?.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        const result = summarizeToolResult(truncateToolOutput(output));
        const failed = item?.status === 'failed'
          || (typeof item?.exitCode === 'number' && item.exitCode !== 0);
        return [{
          kind: 'tool_call_done',
          callId: itemId(notification),
          status: failed ? 'error' : result.status,
          summary: result.summary,
          content: truncateToolOutput(output),
        }];
      }
      return [];
    }

    // Command execution starting (normalized dialect): surface as tool
    // activity so long turns render a live progress feed instead of dead air.
    if (type === 'item.started') {
      const item = asRecord(notification.item);
      const startedCommand = typeof item?.command === 'string' ? item.command : '';
      if (startedCommand) {
        const classified = classifyToolCall('shell', { command: startedCommand });
        return [{
          kind: 'tool_call_started',
          callId: itemId(notification),
          tool: classified.tool,
          icon: classified.icon,
          label: classified.label,
          detail: classified.detail,
        }];
      }
      return [];
    }

    if (/thinking/i.test(type)) {
      const text = extractDeltaText(notification);
      if (text) return [{ kind: 'reasoning_delta', text }];
      return type.toLowerCase().includes('done') || type.toLowerCase().includes('completed')
        ? [{ kind: 'reasoning_done' }]
        : [];
    }

    // Anthropic-style `assistant` message frames (claudecode dialect, TBD).
    // These tend to be cumulative rather than delta-based: each frame restates
    // the whole message. Store it as the cumulative buffer and let the shared
    // emitter forward only the genuine continuation — if a frame diverges from
    // what's already on screen it's suppressed rather than re-streamed whole.
    if (type === 'assistant') {
      const events: CentaurChatEvent[] = [];
      const full = assistantText(notification);
      if (full) {
        this.harnessAnswerText = full;
        events.push(...this.emitAnswerText());
      }
      for (const tool of toolUses(notification)) {
        const name = typeof tool.name === 'string' ? tool.name : 'tool';
        const classified = classifyToolCall(name, tool.input);
        events.push({
          kind: 'tool_call_started',
          callId: typeof tool.id === 'string' ? tool.id : undefined,
          tool: classified.tool,
          icon: classified.icon,
          label: classified.label,
          detail: classified.detail,
        });
      }
      for (const text of thinkingText(notification)) {
        events.push({ kind: 'reasoning_delta', text });
      }
      return events;
    }

    // Tool results (claudecode `user`/`tool` frames).
    if (type === 'user' || type === 'tool') {
      return toolResults(notification).map((result) => {
        const summary = summarizeToolResult(result.content);
        return {
          kind: 'tool_call_done' as const,
          callId: typeof result.tool_use_id === 'string' ? result.tool_use_id : undefined,
          status: summary.status,
          summary: summary.summary,
          content: result.content,
        };
      });
    }

    return [];
  }
}

function normalizeNotification(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  if (typeof record.type === 'string') return record;
  // JSON-RPC-style codex frame: {method, params} → {...params, type}.
  if (typeof record.method === 'string') {
    const params = asRecord(record.params) ?? {};
    return { ...params, type: record.method.replace(/\//g, '.') };
  }
  return null;
}

function itemId(notification: Record<string, unknown>): string {
  const item = asRecord(notification.item);
  return String(
    notification.itemId
      ?? notification.item_id
      ?? item?.id
      ?? notification.turnId
      ?? notification.turn_id
      ?? '',
  );
}

function extractDeltaText(notification: Record<string, unknown>): string {
  const delta = notification.delta ?? notification.text ?? notification.content ?? '';
  if (delta && typeof delta === 'object') {
    const record = delta as Record<string, unknown>;
    return String(record.text ?? record.content ?? '');
  }
  return String(delta);
}

function assistantText(notification: Record<string, unknown>): string {
  const message = asRecord(notification.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('');
}

function toolUses(notification: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = asRecord(notification.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map(asRecord)
    .filter((block): block is Record<string, unknown> => Boolean(block) && block!.type === 'tool_use');
}

function thinkingText(notification: Record<string, unknown>): string[] {
  const message = asRecord(notification.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map(asRecord)
    .filter((block): block is Record<string, unknown> => Boolean(block) && /thinking/i.test(String(block!.type ?? '')))
    .map((block) => String(block.text ?? block.thinking ?? block.content ?? ''))
    .filter(Boolean);
}

function toolResults(notification: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = Array.isArray(notification.content) ? notification.content : [];
  return content
    .map(asRecord)
    .filter((block): block is Record<string, unknown> =>
      Boolean(block) && (block!.type === 'tool_result' || 'tool_use_id' in block!));
}

const MAX_TOOL_OUTPUT_CHARS = 1500;

function truncateToolOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= MAX_TOOL_OUTPUT_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_TOOL_OUTPUT_CHARS)}…[truncated]`;
}

function extractResultText(data: string): string {
  const record = parseJsonRecord(data);
  const value = record?.result_text;
  return typeof value === 'string' ? value : '';
}

function extractError(data: string): string {
  const record = parseJsonRecord(data);
  const message = record?.error ?? record?.message;
  if (typeof message === 'string') return message;
  return data.trim();
}

function describeSandboxReady(data: string): Extract<CentaurChatEvent, { kind: 'status' }> {
  const record = parseJsonRecord(data);
  const source = typeof record?.sandbox_ready_source === 'string' ? record.sandbox_ready_source : '';
  const duration = typeof record?.sandbox_ready_duration_ms === 'number'
    ? record.sandbox_ready_duration_ms
    : null;
  const warm = source === 'reused' || source === 'resumed' || source === 'warm_pool';
  return {
    kind: 'status',
    statusKind: 'sandbox_ready',
    message: warm ? 'Workspace ready' : 'Workspace ready after cold start',
    source: source || null,
    durationMs: duration,
  };
}

function parseJsonRecord(data: string): Record<string, unknown> | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Parse one SSE frame (`event:` / `id:` / `data:` lines). `data:` values are
 * joined with newlines per the SSE spec; a leading single space after the
 * colon is stripped.
 */
function parseSseFrame(frame: string): CentaurRawEvent | null {
  const lines = frame.split(/\r?\n/);
  let eventName = 'message';
  let eventId: number | null = null;
  const dataLines: string[] = [];
  let sawField = false;

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    if (field === 'event') {
      eventName = value || eventName;
      sawField = true;
    } else if (field === 'id') {
      const parsed = Number.parseInt(value, 10);
      eventId = Number.isFinite(parsed) ? parsed : null;
      sawField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    }
  }

  if (!sawField) return null;
  return { id: eventId, event: eventName, data: dataLines.join('\n') };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mergeSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).trim().slice(0, 600);
  } catch {
    return '';
  }
}
