import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage, ActivityStep, ConnectionRequestView } from './types';
import { openExternalUrl } from './chat';

interface Props {
  messages: ChatMessage[];
  onConnect: (request: ConnectionRequestView) => void;
}

export function MessageList({ messages, onConnect }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    <div style={{
      flex: 1,
      overflowY: 'auto',
      padding: '16px 32px',
    }}>
      {messages.map(msg => (
        <MessageBubble key={msg.id} message={msg} onConnect={onConnect} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({
  message,
  onConnect,
}: {
  message: ChatMessage;
  onConnect: (request: ConnectionRequestView) => void;
}) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: isUser ? '28px' : '12px',
      marginTop: isUser ? '28px' : '0',
    }}>
      <div style={{
        maxWidth: isUser ? '70%' : '100%',
        padding: isUser ? '10px 16px' : '4px 0',
        borderRadius: isUser ? '14px' : '0',
        background: isUser ? 'var(--user-bubble)' : 'var(--assistant-bg)',
        wordBreak: 'break-word',
        width: isUser ? 'auto' : '100%',
      }}>
        {!isUser && <AssistantActivity message={message} onConnect={onConnect} />}

        <div className="message-content">
          {isUser ? (
            <span>{message.content}</span>
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
      </div>
    </div>
  );
}

function AssistantActivity({
  message,
  onConnect,
}: {
  message: ChatMessage;
  onConnect: (request: ConnectionRequestView) => void;
}) {
  const steps = message.steps ?? [];
  const hasActivity = steps.length > 0;
  const hasConnectionCard = steps.some((step) => step.type === 'tool' && !!step.connection);
  const hasPendingConnection = steps.some((step) =>
    step.type === 'tool' && !!step.connection && (step.connection.status === 'pending' || step.connection.status === 'failed'),
  );
  const [expanded, setExpanded] = useState<boolean>(!!message.isStreaming || hasPendingConnection);

  // When streaming stops, auto-collapse
  const wasStreaming = useRef<boolean>(!!message.isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !message.isStreaming && !hasPendingConnection) {
      setExpanded(false);
    }
    wasStreaming.current = !!message.isStreaming;
  }, [hasPendingConnection, message.isStreaming]);

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
      {(expanded || hasConnectionCard) && hasActivity && (
        <div style={{ marginTop: '6px', paddingLeft: '18px' }}>
          {steps.map((step, i) => <StepView key={i} step={step} onConnect={onConnect} />)}
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
}: {
  step: ActivityStep;
  onConnect: (request: ConnectionRequestView) => void;
}) {
  if (step.type === 'text') {
    return (
      <div style={{
        color: 'var(--text-dim)',
        fontSize: '13px',
        lineHeight: 1.5,
        margin: '6px 0',
        whiteSpace: 'pre-wrap',
      }}>
        {step.text}
      </div>
    );
  }

  if (step.connection) {
    return <ConnectionCard request={step.connection} onConnect={onConnect} />;
  }

  return <ToolStep step={step} />;
}

function ToolStep({ step }: { step: Extract<ActivityStep, { type: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const friendlyName = friendlyToolName(step.name);
  const inputPreview = previewInput(step.input);
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
        <ToolIcon kind={iconForTool(step.name)} />
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
  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [isStreaming]);
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
