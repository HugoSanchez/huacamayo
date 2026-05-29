import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage, ActivityStep, ConnectionRequestView, ConnectionView, ToolkitView } from './types';
import { generateCronDescription, openExternalUrl } from './chat';
import { useIsSystemAsleep } from './useSystemSleep';
import { CodexMark, CodexConnectFlow, useCodexConnect } from './CodexConnect';

interface Props {
  messages: ChatMessage[];
  onConnect: (request: ConnectionRequestView) => void;
  connections: ConnectionView[];
  toolkitCatalog: ToolkitView[];
  onCodexConnected: (widgetMessageId: string) => void;
}

export interface ToolkitInfo {
  name: string;
  logoUrl: string | null;
  connected: boolean;
}

// Build a slug → {name, logoUrl} map from the full toolkit catalog first
// (covers every toolkit regardless of connection state), then overlay
// connection entries so user-customized names and any connection-specific
// logo URLs win when present.
function buildToolkitMap(
  connections: ConnectionView[],
  catalog: ToolkitView[],
): Map<string, ToolkitInfo> {
  const map = new Map<string, ToolkitInfo>();
  for (const tk of catalog) {
    const slug = tk.slug?.toLowerCase();
    if (!slug) continue;
    map.set(slug, { name: tk.name, logoUrl: tk.logoUrl, connected: tk.connected });
  }
  for (const conn of connections) {
    const slug = conn.toolkitSlug?.toLowerCase();
    if (!slug) continue;
    const existing = map.get(slug);
    map.set(slug, {
      name: conn.toolkitName || existing?.name || slug,
      logoUrl: conn.logoUrl ?? existing?.logoUrl ?? null,
      connected: conn.status === 'active' || existing?.connected === true,
    });
  }
  return map;
}

// Pixel slack for "user is at the bottom" — any scroll position within this
// many pixels of the end keeps auto-scroll engaged. Larger than 0 so that the
// browser's natural smooth-scroll deceleration still counts as pinned.
const STICK_TO_BOTTOM_THRESHOLD_PX = 32;

export function MessageList({ messages, onConnect, connections, toolkitCatalog, onCodexConnected }: Props) {
  const toolkits = buildToolkitMap(connections, toolkitCatalog);
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Tracks whether the user is currently pinned to the bottom. Streaming
  // tokens only auto-scroll while this is true; the moment the user scrolls
  // up it flips to false and stays false until they scroll back down.
  const stickToBottomRef = useRef(true);
  const previousLengthRef = useRef(0);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < STICK_TO_BOTTOM_THRESHOLD_PX;
  };

  useEffect(() => {
    const justLoaded = previousLengthRef.current === 0 && messages.length > 0;
    if (justLoaded) {
      // Fresh session hydrate — jump instantly to the latest message, no
      // smooth-scroll animation since there's no continuity to preserve.
      stickToBottomRef.current = true;
      endRef.current?.scrollIntoView({ behavior: 'auto' });
    } else if (messages.length === 0) {
      // Session cleared — reset pinning so the next load starts at bottom.
      stickToBottomRef.current = true;
    } else if (stickToBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    previousLengthRef.current = messages.length;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-dim)',
        fontSize: '15px',
      }}>
        Start a new session or resume one from the sidebar
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 32px',
      }}
    >
      {messages.map(msg => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onConnect={onConnect}
          toolkits={toolkits}
          onCodexConnected={onCodexConnected}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({
  message,
  onConnect,
  toolkits,
  onCodexConnected,
}: {
  message: ChatMessage;
  onConnect: (request: ConnectionRequestView) => void;
  toolkits: Map<string, ToolkitInfo>;
  onCodexConnected: (widgetMessageId: string) => void;
}) {
  const isUser = message.role === 'user';

  if (message.kind === 'codex_connect_required') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '12px' }}>
        <CodexConnectRequiredCard onConnected={() => onCodexConnected(message.id)} />
      </div>
    );
  }

  // Connection cards live alongside the assistant's response text, not inside
  // the "N tool calls" collapsible. Pull them out of the activity stream and
  // render them as siblings of the message body so the user always sees the
  // call-to-action without expanding the activity log.
  const allSteps = message.steps ?? [];
  const connectionRequests: ConnectionRequestView[] = [];
  const stepsForActivity: ActivityStep[] = [];
  for (const step of allSteps) {
    if (step.type === 'tool' && step.connection) {
      connectionRequests.push(step.connection);
    } else {
      stepsForActivity.push(step);
    }
  }

  const assistantMessage = !isUser ? { ...message, steps: stepsForActivity } : message;

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: isUser ? '28px' : '12px',
      marginTop: isUser ? '28px' : '0',
    }}>
      <div
        className={isUser ? 'user-message-bubble' : undefined}
        style={{
          maxWidth: isUser ? '70%' : '100%',
          padding: isUser ? '10px 16px' : '4px 0',
          borderRadius: isUser ? '14px' : '0',
          background: isUser ? 'var(--user-bubble)' : 'var(--assistant-bg)',
          color: isUser ? 'var(--user-bubble-text)' : undefined,
          wordBreak: 'break-word',
          width: isUser ? 'auto' : '100%',
        }}
      >
        {!isUser && <AssistantActivity message={assistantMessage} onConnect={onConnect} toolkits={toolkits} />}

        <div className="message-content">
          {isUser ? (
            <UserMessageBody content={message.content} />
          ) : message.content ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                a: ({ href, children, ...props }) => (
                  <a
                    {...props}
                    href={href}
                    onClick={(event) => {
                      event.preventDefault();
                      if (href) openExternalUrl(href);
                    }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          ) : null}
        </div>

        {!isUser && connectionRequests.length > 0 && (
          <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {connectionRequests.map((request, idx) => (
              <ConnectionCard
                key={request.id || `${idx}-${request.toolkitSlug}`}
                request={request}
                onConnect={onConnect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CodexConnectRequiredCard({ onConnected }: { onConnected: () => void }) {
  const { phase, start, cancel, reset } = useCodexConnect({ onConnected });

  return (
    <div className="codex-connect-card">
      {phase.kind === 'idle' ? (
        <>
          <p className="codex-connect-card-text">
            Connect your Codex account to start chatting. We&rsquo;ll open the OpenAI sign-in
            page in your browser and you can come back here once you&rsquo;re done.
          </p>
          <button
            type="button"
            className="settings-button settings-button-primary"
            onClick={start}
          >
            <CodexMark />
            <span>Connect Codex</span>
          </button>
        </>
      ) : null}

      <CodexConnectFlow phase={phase} onRetry={start} onCancel={phase.kind === 'error' ? reset : cancel} />
    </div>
  );
}

function AssistantActivity({
  message,
  onConnect,
  toolkits,
}: {
  message: ChatMessage;
  onConnect: (request: ConnectionRequestView) => void;
  toolkits: Map<string, ToolkitInfo>;
}) {
  const steps = message.steps ?? [];
  const hasActivity = steps.length > 0;
  const [expanded, setExpanded] = useState<boolean>(!!message.isStreaming);

  // When streaming stops, auto-collapse
  const wasStreaming = useRef<boolean>(!!message.isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !message.isStreaming) {
      setExpanded(false);
    }
    wasStreaming.current = !!message.isStreaming;
  }, [message.isStreaming]);

  if (!hasActivity && !message.isStreaming) return null;

  const toolCount = steps.filter(s => s.type === 'tool').length;
  const msgCount = steps.filter(s => s.type === 'text').length;

  return (
    <div style={{ marginBottom: message.content ? '12px' : '0' }}>
      <ActivityHeader
        message={message}
        toolCount={toolCount}
        msgCount={msgCount}
        expanded={expanded}
        onToggle={() => setExpanded(e => !e)}
      />
      {expanded && hasActivity && (
        <div style={{ marginTop: '6px', paddingLeft: '18px' }}>
          {steps.map((step, i) => <StepView key={i} step={step} onConnect={onConnect} toolkits={toolkits} />)}
        </div>
      )}
    </div>
  );
}

function ActivityHeader({
  message, toolCount, msgCount, expanded, onToggle,
}: {
  message: ChatMessage;
  toolCount: number;
  msgCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const elapsed = useElapsed(message.startedAt, message.endedAt, message.isStreaming);

  const hasActivity = toolCount > 0 || msgCount > 0;
  const summary = !hasActivity
    ? ''
    : [
        toolCount ? `${toolCount} tool call${toolCount === 1 ? '' : 's'}` : '',
        msgCount ? `${msgCount} message${msgCount === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(', ');

  return (
    <button
      onClick={hasActivity ? onToggle : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'transparent',
        border: 'none',
        padding: '2px 0',
        color: 'var(--text-dim)',
        fontSize: '13px',
        cursor: hasActivity ? 'pointer' : 'default',
        userSelect: 'none',
      }}
    >
      {hasActivity && !message.isStreaming && (
        <svg
          width="10" height="10" viewBox="0 0 10 10"
          fill="none" stroke="currentColor" strokeWidth="1.75"
          strokeLinecap="round" strokeLinejoin="round"
          style={{
            transition: 'transform 120ms ease',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        >
          <polyline points="3.5,2 7,5 3.5,8" />
        </svg>
      )}
      {message.isStreaming ? <Spinner /> : <Dot />}
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatElapsed(elapsed)}</span>
      {summary && <span>· {summary}</span>}
    </button>
  );
}

function StepView({
  step,
  onConnect,
  toolkits,
}: {
  step: ActivityStep;
  onConnect: (request: ConnectionRequestView) => void;
  toolkits: Map<string, ToolkitInfo>;
}) {
  if (step.type === 'text') {
    return (
      <div style={{
        color: 'var(--text-thinking)',
        fontSize: '13px',
        fontStyle: 'italic',
        lineHeight: 1.5,
        margin: '2px 0',
        whiteSpace: 'pre-wrap',
      }}>
        {step.text.trim()}
      </div>
    );
  }

  // Connection cards are pulled out of `steps` upstream and rendered next to
  // the assistant's response, not inside the activity collapsible. Anything
  // still tagged with a connection here is unexpected — fall through to the
  // generic ToolStep rather than rendering a card in the wrong place.

  if (step.name === 'cronjob') {
    const card = parseCronToolStep(step);
    if (card) return <CronToolCard {...card} />;
  }

  return <ToolStep step={step} toolkits={toolkits} />;
}

interface CronToolCardProps {
  action: 'create' | 'update' | 'remove' | 'pause' | 'resume' | 'run';
  jobId: string | null;
  name: string | null;
  scheduleDisplay: string | null;
}

function parseCronToolStep(step: Extract<ActivityStep, { type: 'tool' }>): CronToolCardProps | null {
  // The agent's request is the function-call's input; the tool's response
  // is the function-call-output. We render a card only after the result
  // arrives so we can confirm it succeeded.
  if (typeof step.result !== 'string' || step.result.length === 0) return null;
  let parsedResult: unknown;
  try {
    parsedResult = JSON.parse(step.result);
  } catch {
    return null;
  }
  if (!parsedResult || typeof parsedResult !== 'object') return null;
  const resultObj = parsedResult as Record<string, unknown>;
  if (resultObj.success !== true) return null;

  const inputObj = (typeof step.input === 'object' && step.input !== null
    ? step.input as Record<string, unknown>
    : null);
  const action = typeof inputObj?.action === 'string' ? inputObj.action : null;
  if (
    action !== 'create'
    && action !== 'update'
    && action !== 'remove'
    && action !== 'pause'
    && action !== 'resume'
    && action !== 'run'
  ) {
    return null;
  }

  const job = (resultObj.job && typeof resultObj.job === 'object'
    ? resultObj.job as Record<string, unknown>
    : null);

  const jobId = action === 'remove'
    ? (typeof inputObj?.job_id === 'string' ? inputObj.job_id : null)
    : (typeof job?.id === 'string' ? job.id : null);
  const name = typeof job?.name === 'string'
    ? job.name
    : typeof inputObj?.name === 'string' ? inputObj.name : null;
  const scheduleDisplay = typeof job?.schedule_display === 'string'
    ? job.schedule_display
    : typeof inputObj?.schedule === 'string' ? inputObj.schedule : null;

  return { action, jobId, name, scheduleDisplay };
}

const CRON_ACTION_LABELS: Record<CronToolCardProps['action'], string> = {
  create: 'Scheduled',
  update: 'Updated',
  remove: 'Removed',
  pause: 'Paused',
  resume: 'Resumed',
  run: 'Triggered',
};

function CronToolCard({ action, jobId, name, scheduleDisplay }: CronToolCardProps) {
  // Bump the sidebar exactly once per card mount — every cron mutation that
  // produced this tool result is a reason for the Swift sidebar to refetch.
  // For freshly-created routines, also kick off the LLM-generated subtitle
  // in the background so it's already cached by the time the user opens
  // the detail page. Failures here are silent — the detail page has its
  // own backstop generator for crons we somehow missed.
  useEffect(() => {
    window.webkit?.messageHandlers?.chatBridge?.postMessage({ type: 'cronsChanged' });
    if (action === 'create' && jobId) {
      void generateCronDescription(jobId).catch(() => {
        /* best-effort — detail page will retry on first view */
      });
    }
  }, [action, jobId]);

  const canView = action !== 'remove' && jobId !== null;
  const handleView = () => {
    if (!canView || jobId === null) return;
    window.dispatchEvent(new CustomEvent('verso:open-cron-detail', { detail: { id: jobId } }));
  };

  return (
    <div className="cron-tool-card">
      <div className="cron-tool-card-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="7" r="5.5" />
          <polyline points="7,4 7,7 9.5,8.5" />
        </svg>
      </div>
      <div className="cron-tool-card-body">
        <div className="cron-tool-card-title">
          {CRON_ACTION_LABELS[action]} routine {name ? <strong>{name}</strong> : ''}
        </div>
        {scheduleDisplay && action !== 'remove' && (
          <div className="cron-tool-card-subtitle">{scheduleDisplay}</div>
        )}
      </div>
      {canView && (
        <button type="button" className="cron-tool-card-view" onClick={handleView}>
          View
        </button>
      )}
    </div>
  );
}

function ToolStep({
  step,
  toolkits,
}: {
  step: Extract<ActivityStep, { type: 'tool' }>;
  toolkits: Map<string, ToolkitInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const composio = parseComposioExecute(step, toolkits);
  const friendlyName = composio ? composio.toolkitName : friendlyToolName(step.name);
  const inputPreview = composio ? composio.actionLabel : previewInput(step.input);
  const hasInput = step.input != null && step.input !== '';
  const hasResult = typeof step.result === 'string' && step.result.length > 0;
  const hasDetails = hasInput || hasResult;

  return (
    <div className="tool-step">
      <button
        type="button"
        className="tool-step-row"
        onClick={hasDetails ? () => setExpanded((value) => !value) : undefined}
        disabled={!hasDetails}
      >
        {composio ? (
          <ToolkitMark name={composio.toolkitName} logoUrl={composio.logoUrl} />
        ) : (
          <ToolIcon kind={iconForTool(step.name)} />
        )}
        <span className="tool-step-name">{friendlyName}</span>
        {inputPreview && !expanded && (
          <span className="tool-step-preview">{inputPreview}</span>
        )}
        {hasDetails && (
          <svg
            className="tool-step-chevron"
            width="9" height="9" viewBox="0 0 9 9"
            fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
            aria-hidden="true"
          >
            <polyline points="3,2 6,4.5 3,7" />
          </svg>
        )}
      </button>
      {expanded && hasDetails && (
        <div className="tool-step-details">
          {hasInput && (
            <pre className="tool-step-payload">
              <span className="tool-step-payload-label">Input</span>
              {prettyValue(step.input)}
            </pre>
          )}
          {hasResult && (
            <pre className="tool-step-payload">
              <span className="tool-step-payload-label">Result</span>
              {step.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

interface ComposioExecuteView {
  toolkitName: string;
  logoUrl: string | null;
  actionLabel: string;
}

function parseComposioExecute(
  step: Extract<ActivityStep, { type: 'tool' }>,
  toolkits: Map<string, ToolkitInfo>,
): ComposioExecuteView | null {
  const strippedName = stripNamespace(step.name).toLowerCase();
  if (strippedName !== 'execute_composio_tool') {
    return parseNativeComposioToolName(strippedName, toolkits);
  }

  const input = step.input;
  if (!input || typeof input !== 'object') return null;
  const rawSlug = (input as Record<string, unknown>).tool_slug
    ?? (input as Record<string, unknown>).toolSlug;
  if (typeof rawSlug !== 'string' || rawSlug.length === 0) return null;

  return composioViewFromToolSlug(rawSlug, toolkits);
}

function parseNativeComposioToolName(
  strippedToolName: string,
  toolkits: Map<string, ToolkitInfo>,
): ComposioExecuteView | null {
  const match = matchComposioToolkitPrefix(strippedToolName, toolkits);
  if (!match || match.info?.connected !== true) return null;
  return composioViewFromMatchedPrefix(strippedToolName, match);
}

function composioViewFromToolSlug(
  toolSlug: string,
  toolkits: Map<string, ToolkitInfo>,
): ComposioExecuteView | null {
  const lowered = toolSlug.toLowerCase();
  const match = matchComposioToolkitPrefix(lowered, toolkits);
  if (!match) {
    const fallbackSlug = lowered.split('_')[0] ?? lowered;
    return composioViewFromMatchedPrefix(lowered, { slug: fallbackSlug, info: undefined });
  }
  return composioViewFromMatchedPrefix(lowered, match);
}

function matchComposioToolkitPrefix(
  loweredToolSlug: string,
  toolkits: Map<string, ToolkitInfo>,
): { slug: string; info: ToolkitInfo | undefined } | null {
  const parts = loweredToolSlug.split('_');
  // Composio toolkit slugs can themselves contain underscores (e.g.
  // `granola_mcp`), so we can't just take the substring before the first
  // underscore. Try the longest prefix first and walk back; first hit in the
  // catalog wins.
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const candidate = parts.slice(0, i).join('_');
    const info = toolkits.get(candidate) ?? toolkits.get(candidate.replace(/_/g, '-'));
    if (info) {
      return { slug: candidate, info };
    }
  }
  return null;
}

function composioViewFromMatchedPrefix(
  loweredToolSlug: string,
  match: { slug: string; info: ToolkitInfo | undefined },
): ComposioExecuteView {
  const actionRaw = loweredToolSlug.slice(match.slug.length + 1);
  const toolkitName = match.info?.name ?? titleCase(match.slug);
  const actionLabel = actionRaw.replace(/_+/g, ' ').trim() || loweredToolSlug;
  return { toolkitName, logoUrl: match.info?.logoUrl ?? null, actionLabel };
}

function titleCase(slug: string): string {
  if (!slug) return slug;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function ToolkitMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        aria-hidden="true"
        className="tool-step-toolkit-logo"
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span className="tool-step-toolkit-fallback" aria-hidden="true">{initial}</span>
  );
}

type ToolIconKind = 'search' | 'terminal' | 'pencil' | 'trash' | 'link' | 'fetch' | 'dot';

function ToolIcon({ kind }: { kind: ToolIconKind }) {
  return (
    <svg
      className="tool-step-icon"
      width="13" height="13" viewBox="0 0 13 13"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'search' && (
        <>
          <circle cx="5.5" cy="5.5" r="3.25" />
          <path d="M8 8 L11 11" />
        </>
      )}
      {kind === 'terminal' && (
        <>
          <polyline points="2.5,3.5 5,6.5 2.5,9.5" />
          <line x1="6.5" y1="9.5" x2="10.5" y2="9.5" />
        </>
      )}
      {kind === 'pencil' && (
        <>
          <path d="M2.5 10.5 L8.5 4.5" />
          <path d="M8 4 L9.5 5.5" />
          <path d="M9.5 5.5 L11 4 L8.5 1.5 L7 3 Z" />
          <path d="M2.5 10.5 L2 11.5 L3 11" />
        </>
      )}
      {kind === 'trash' && (
        <>
          <line x1="2" y1="3.5" x2="11" y2="3.5" />
          <path d="M3 3.5 L3.5 10.5 L9.5 10.5 L10 3.5" />
          <line x1="5.5" y1="3.5" x2="5.5" y2="2" />
          <line x1="7.5" y1="3.5" x2="7.5" y2="2" />
        </>
      )}
      {kind === 'link' && (
        <>
          <path d="M5.5 4 L4 4 A2.5 2.5 0 0 0 4 9 L5.5 9" />
          <path d="M7.5 4 L9 4 A2.5 2.5 0 0 1 9 9 L7.5 9" />
          <line x1="4.5" y1="6.5" x2="8.5" y2="6.5" />
        </>
      )}
      {kind === 'fetch' && (
        <>
          <line x1="6.5" y1="2" x2="6.5" y2="9" />
          <polyline points="3.5,6.5 6.5,9.5 9.5,6.5" />
          <line x1="3" y1="11.5" x2="10" y2="11.5" />
        </>
      )}
      {kind === 'dot' && (
        <circle cx="6.5" cy="6.5" r="1.25" fill="currentColor" />
      )}
    </svg>
  );
}

const SEARCH_VERBS = new Set(['search', 'find', 'list', 'get', 'read', 'look', 'lookup', 'query', 'inspect', 'show', 'view', 'check']);
const TERMINAL_VERBS = new Set(['run', 'exec', 'execute', 'terminal', 'bash', 'shell', 'invoke', 'spawn', 'launch']);
const WRITE_VERBS = new Set(['write', 'create', 'edit', 'update', 'set', 'save', 'append', 'modify', 'patch', 'rename']);
const DELETE_VERBS = new Set(['delete', 'remove', 'clear', 'drop', 'archive', 'unarchive']);
const LINK_VERBS = new Set(['connect', 'disconnect', 'auth', 'authorize', 'authenticate', 'login', 'logout', 'request']);
const FETCH_VERBS = new Set(['fetch', 'download', 'pull', 'sync', 'import']);

function iconForTool(name: string): ToolIconKind {
  const verb = firstVerb(name);
  if (SEARCH_VERBS.has(verb)) return 'search';
  if (TERMINAL_VERBS.has(verb)) return 'terminal';
  if (WRITE_VERBS.has(verb)) return 'pencil';
  if (DELETE_VERBS.has(verb)) return 'trash';
  if (LINK_VERBS.has(verb)) return 'link';
  if (FETCH_VERBS.has(verb)) return 'fetch';
  return 'dot';
}

function firstVerb(name: string): string {
  return stripNamespace(name).split(/[_\s]+/)[0]?.toLowerCase() ?? '';
}

function stripNamespace(name: string): string {
  // Strip both `mcp_<ns>_` and `mcp__<ns>__` style prefixes, then any remaining
  // `<ns>__` namespace.
  return name
    .replace(/^mcp(?:_+|__)?[a-z0-9]+(?:_+|__)/i, '')
    .replace(/^[a-z0-9]+__/i, '');
}

function friendlyToolName(name: string): string {
  const stripped = stripNamespace(name).replace(/_+/g, ' ').trim();
  if (!stripped) return name;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function prettyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ConnectionCard({
  request,
  onConnect,
}: {
  request: ConnectionRequestView;
  onConnect: (request: ConnectionRequestView) => void;
}) {
  const status = request.status;
  const canConnect = status === 'pending' || status === 'failed' || status === 'expired';
  const label = status === 'connected'
    ? 'Connected'
    : status === 'failed' || status === 'expired'
      ? 'Retry'
      : 'Connect';

  return (
    <div className="connection-card">
      <div className="connection-card-head">
        <div className="connection-card-meta">
          <ToolkitLogo name={request.toolkitName} logoUrl={request.logoUrl} />
          <div>
            <div className="connection-card-title">{request.toolkitName}</div>
            <div className="connection-card-subtitle">This tool needs access to continue.</div>
          </div>
        </div>
        <button
          type="button"
          className={`connection-pill is-${status}`}
          disabled={!canConnect}
          onClick={() => canConnect && onConnect(request)}
        >
          {label}
        </button>
      </div>
      {request.errorMessage && (
        <div className="connection-card-error">{request.errorMessage}</div>
      )}
    </div>
  );
}

function ToolkitLogo({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  if (logoUrl) {
    return <img className="connection-card-logo" src={logoUrl} alt="" aria-hidden="true" />;
  }

  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return <div className="connection-card-logo-fallback" aria-hidden="true">{initial}</div>;
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: 'var(--text-dim)',
      animation: 'activity-pulse 1.2s ease-in-out infinite',
    }} />
  );
}

function Dot() {
  return (
    <span style={{
      display: 'inline-block',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: 'var(--text-dim)',
    }} />
  );
}

function useElapsed(startedAt: number | undefined, endedAt: number | undefined, isStreaming: boolean | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  // Suspend the 100ms tick while the laptop is asleep; nothing is rendering
  // anyway, and the interval would otherwise wake the CPU 10× per second.
  const asleep = useIsSystemAsleep();
  useEffect(() => {
    if (!isStreaming || asleep) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [isStreaming, asleep]);
  if (!startedAt) return 0;
  const end = isStreaming ? now : (endedAt ?? now);
  return Math.max(0, end - startedAt);
}

function formatElapsed(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = (totalSec - min * 60).toFixed(1);
  return `${min}m ${sec}s`;
}

function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) {
    return `${input.length} item${input.length === 1 ? '' : 's'}`;
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of [
      'command', 'file_path', 'path', 'query', 'pattern', 'url',
      'name', 'slug', 'toolkit', 'search', 'title', 'message',
    ]) {
      const value = obj[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    for (const value of Object.values(obj)) {
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    try { return JSON.stringify(obj).slice(0, 120); } catch { return ''; }
  }
  return '';
}

const SLASH_SKILL_MATCH = /^\/([a-z0-9][a-z0-9_-]*)\b\s*/i;

function UserMessageBody({ content }: { content: string }) {
  const match = content.match(SLASH_SKILL_MATCH);
  if (!match) {
    return <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>;
  }
  const slug = match[1].toLowerCase();
  const remainder = content.slice(match[0].length);
  return (
    <span style={{ whiteSpace: 'pre-wrap' }}>
      <span className="skill-chip">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M5 1 L6 4 L9 5 L6 6 L5 9 L4 6 L1 5 L4 4 Z" fill="currentColor" />
        </svg>
        <span className="skill-chip-slug">/{slug}</span>
      </span>
      {remainder.length > 0 && <span> {remainder}</span>}
    </span>
  );
}
