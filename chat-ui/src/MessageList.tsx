import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage, ActivityStep } from './types';

interface Props {
  messages: ChatMessage[];
}

export function MessageList({ messages }: Props) {
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
        Ask Hermes anything
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
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
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
        {!isUser && <AssistantActivity message={message} />}

        <div className="message-content">
          {isUser ? (
            <span>{message.content}</span>
          ) : message.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {message.content}
            </ReactMarkdown>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AssistantActivity({ message }: { message: ChatMessage }) {
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
          {steps.map((step, i) => <StepView key={i} step={step} />)}
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

function StepView({ step }: { step: ActivityStep }) {
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

  const displayName = displayToolName(step.name);
  const inputPreview = step.input ? previewInput(step.input) : '';
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      margin: '3px 0',
      fontSize: '13px',
      overflow: 'hidden',
    }}>
      <span style={{ color: 'var(--text)', fontWeight: 500, flexShrink: 0 }}>{displayName}</span>
      {inputPreview && (
        <span style={{
          color: 'var(--text-dim)',
          fontFamily: 'SF Mono, monospace',
          fontSize: '12px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          flex: 1,
        }}>{inputPreview}</span>
      )}
    </div>
  );
}

function displayToolName(name: string): string {
  // namespace__tool_name -> tool_name
  const parts = name.split('__');
  return parts[parts.length - 1] || name;
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
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'query', 'pattern', 'url']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
    try { return JSON.stringify(obj); } catch { return ''; }
  }
  return '';
}
