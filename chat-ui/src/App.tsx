import { useState, useRef, useCallback, useEffect } from 'react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import {
  cancelChatRequest,
  createChatSession,
  getChatMessages,
  getSidecarPort,
  setSidecarPort,
  streamChatMessage,
} from './chat';
import type { ChatMessage, ChatSSEEvent, ActivityStep, StoredChatMessage } from './types';

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
    /** Last injected sidecar port from host bridge */
    __vervoSidecarPort?: number;
  }
}

const SESSION_STORAGE_KEY = 'vervo.chat.sessionId';

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const idCounter = useRef(0);
  const hydrateTokenRef = useRef(0);

  // Expose setSidecarPort globally for Swift to call
  useEffect(() => {
    const hydrateStoredSession = async () => {
      const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (!storedSessionId) {
        sessionIdRef.current = null;
        setMessages([]);
        return;
      }

      const token = ++hydrateTokenRef.current;
      try {
        const storedMessages = await getChatMessages(storedSessionId);
        if (token !== hydrateTokenRef.current) return;
        sessionIdRef.current = storedSessionId;
        setMessages(storedMessages.map(toUiMessage));
      } catch {
        if (token !== hydrateTokenRef.current) return;
        sessionIdRef.current = null;
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
        setMessages([]);
      }
    };

    const applyPort = (port: number) => {
      setSidecarPort(port);
      setConnected(true);
      void hydrateStoredSession();
    };

    window.setSidecarPort = (port: number) => {
      window.__vervoSidecarPort = port;
      applyPort(port);
    };

    // If Swift injected before React finished mounting, recover the port here.
    if (typeof window.__vervoSidecarPort === 'number' && window.__vervoSidecarPort > 0) {
      applyPort(window.__vervoSidecarPort);
    }

    const onPortEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<{ port?: unknown }>).detail;
      const rawPort = detail?.port;
      const port = typeof rawPort === 'number' ? rawPort : Number(rawPort);
      if (Number.isFinite(port) && port > 0) {
        window.__vervoSidecarPort = port;
        applyPort(port);
      }
    };
    window.addEventListener('vervo:sidecar-port', onPortEvent as EventListener);

    // Check URL params for dev mode
    const params = new URLSearchParams(window.location.search);
    const devPort = params.get('port');
    if (devPort) {
      const parsed = parseInt(devPort, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        applyPort(parsed);
      }
    }

    return () => {
      window.removeEventListener('vervo:sidecar-port', onPortEvent as EventListener);
      window.setSidecarPort = undefined;
    };
  }, []);

  const nextId = () => String(++idCounter.current);

  const ensureSession = useCallback(async (seedText: string) => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const session = await createChatSession(seedText);
    sessionIdRef.current = session.id;
    window.localStorage.setItem(SESSION_STORAGE_KEY, session.id);
    return session.id;
  }, []);

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

    void (async () => {
      try {
        const sessionId = await ensureSession(text);
        const abort = streamChatMessage(
          sessionId,
          text,
          (event: ChatSSEEvent) => {
            const resolvedSessionId = extractSessionId(event);
            if (resolvedSessionId) sessionIdRef.current = resolvedSessionId;

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
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `**Error:** ${message}`, isStreaming: false, endedAt: Date.now() }
            : m,
        ));
        setIsStreaming(false);
      }
    })();
  }, [ensureSession, isStreaming]);

  const handleStop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    if (sessionIdRef.current) {
      void cancelChatRequest(sessionIdRef.current).catch(() => {});
    }
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

function extractSessionId(event: ChatSSEEvent): string | undefined {
  const sessionId = (event as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

/** Apply an SSE event to the assistant message being built. */
function applySSEEvent(msg: ChatMessage, event: ChatSSEEvent): ChatMessage {
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

function toUiMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
  };
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
