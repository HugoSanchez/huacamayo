import { useState, useRef, useCallback, useEffect } from 'react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { streamQuery, stopQuery, setSidecarPort, getSidecarPort } from './agent';
import type { ChatMessage, AgentSSEEvent, ActivityStep } from './types';

// Listen for the sidecar port from the Swift host
declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        chatBridge?: { postMessage: (msg: unknown) => void };
      };
    };
    /** Called by Swift to set the sidecar port */
    setSidecarPort?: (port: number) => void;
  }
}

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const claudeSessionIdRef = useRef<string | null>(null);
  const idCounter = useRef(0);

  // Expose setSidecarPort globally for Swift to call
  useEffect(() => {
    window.setSidecarPort = (port: number) => {
      setSidecarPort(port);
      setConnected(true);
    };

    // Check URL params for dev mode
    const params = new URLSearchParams(window.location.search);
    const devPort = params.get('port');
    if (devPort) {
      setSidecarPort(parseInt(devPort, 10));
      setConnected(true);
    }

    return () => { window.setSidecarPort = undefined; };
  }, []);

  const nextId = () => String(++idCounter.current);

  const handleSend = useCallback((text: string) => {
    if (!text.trim() || isStreaming || !getSidecarPort()) return;

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text };
    const assistantMsg: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      steps: [],
      isStreaming: true,
      startedAt: Date.now(),
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    const assistantId = assistantMsg.id;

    const abort = streamQuery(
      text,
      { sessionId: claudeSessionIdRef.current ?? undefined },
      (event: AgentSSEEvent) => {
        const sessionId = extractSessionId(event);
        if (sessionId) claudeSessionIdRef.current = sessionId;

        setMessages(prev => prev.map(m => {
          if (m.id !== assistantId) return m;
          return applySSEEvent(m, event);
        }));
      },
      () => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, isStreaming: false, endedAt: Date.now() } : m,
        ));
        setIsStreaming(false);
        abortRef.current = null;
      },
      (err: string) => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: m.content + `\n\n**Error:** ${err}`, isStreaming: false, endedAt: Date.now() }
            : m,
        ));
        setIsStreaming(false);
        abortRef.current = null;
      },
    );

    abortRef.current = abort;
  }, [isStreaming]);

  const handleStop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    stopQuery().catch(() => {});
    setIsStreaming(false);
    setMessages(prev => prev.map(m =>
      m.isStreaming ? { ...m, isStreaming: false, endedAt: Date.now() } : m,
    ));
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--bg)',
    }}>
      <MessageList messages={messages} />
      <InputBar
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
        disabled={!connected}
      />
    </div>
  );
}

function extractSessionId(event: AgentSSEEvent): string | undefined {
  const sessionId = (event as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

/** Apply an SSE event to the assistant message being built.
 *
 * The Claude Agent SDK nests content blocks inside `event.message.content`
 * for both assistant and user messages. Tool results arrive as `tool_result`
 * blocks inside user-role messages.
 *
 * Steps are recorded in order (text blocks + tool calls). The content field
 * always holds the most recent assistant text — on completion that becomes
 * the final answer, while earlier text blocks remain in steps as "messages". */
function applySSEEvent(msg: ChatMessage, event: AgentSSEEvent): ChatMessage {
  const steps = msg.steps ?? [];
  const ev = event as any;

  if (event.type === 'assistant') {
    const blocks = ev.message?.content ?? ev.content ?? [];
    let newSteps = steps;
    let newContent = msg.content;

    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        if (newContent) {
          newSteps = [...newSteps, { type: 'text', text: newContent }];
        }
        newContent = block.text;
      } else if (block.type === 'tool_use') {
        newSteps = [...newSteps, {
          type: 'tool',
          id: block.id,
          name: block.name ?? 'tool',
          input: block.input,
        }];
      }
    }
    return { ...msg, steps: newSteps, content: newContent };
  }

  // SDK user-role messages carry tool_result blocks back from tool execution.
  if (event.type === 'user') {
    const blocks = ev.message?.content ?? ev.content ?? [];
    if (!Array.isArray(blocks)) return msg;
    let newSteps = steps;
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id;
      const result = stringifyToolResult(block.content);
      newSteps = attachResult(newSteps, toolUseId, result);
    }
    return { ...msg, steps: newSteps };
  }

  if (event.type === 'content_block_delta' || event.type === 'text') {
    const delta = ev.delta?.text ?? ev.text ?? '';
    return { ...msg, content: msg.content + delta };
  }

  if (event.type === 'result') {
    const text = ev.result ?? '';
    if (text) return { ...msg, content: text };
  }

  if (event.type === 'error') {
    return { ...msg, content: msg.content + `\n\n**Error:** ${event.message ?? 'Unknown error'}` };
  }

  if (event.type === 'done') {
    return { ...msg, isStreaming: false, endedAt: Date.now() };
  }

  return msg;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === 'string' ? c : c?.text ?? JSON.stringify(c)))
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function attachResult(
  steps: ActivityStep[],
  toolUseId: string | undefined,
  result: string,
): ActivityStep[] {
  const arr = [...steps];
  if (toolUseId) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const s = arr[i];
      if (s.type === 'tool' && s.id === toolUseId && !s.result) {
        arr[i] = { ...s, result };
        return arr;
      }
    }
  }
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = arr[i];
    if (s.type === 'tool' && !s.result) {
      arr[i] = { ...s, result };
      return arr;
    }
  }
  return arr;
}
