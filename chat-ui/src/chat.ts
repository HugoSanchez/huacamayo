import type { ChatSessionSummary, ChatSSEEvent, StoredChatMessage } from './types';

let sidecarPort: number | null = null;

export function setSidecarPort(port: number) {
  sidecarPort = port;
}

export function getSidecarPort(): number | null {
  return sidecarPort;
}

function baseURL(): string {
  if (!sidecarPort) throw new Error('Sidecar port not set');
  return `http://127.0.0.1:${sidecarPort}`;
}

export async function createChatSession(title?: string): Promise<ChatSessionSummary> {
  const res = await fetch(`${baseURL()}/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to create chat session'));
  }
  const body = await res.json() as { session: ChatSessionSummary };
  return body.session;
}

export async function getChatMessages(sessionId: string): Promise<StoredChatMessage[]> {
  const res = await fetch(`${baseURL()}/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load chat messages'));
  }
  const body = await res.json() as { messages: StoredChatMessage[] };
  return body.messages;
}

export function streamChatMessage(
  sessionId: string,
  content: string,
  onEvent: (event: ChatSSEEvent) => void,
  onDone: () => void,
  onError: (err: string) => void,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${baseURL()}/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        onError(await readError(res, `HTTP ${res.status}`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n');
        buffer = frames.pop() ?? '';

        for (const line of frames) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6)) as ChatSSEEvent;
            onEvent(parsed);
          } catch {
            // Skip malformed lines.
          }
        }
      }

      onDone();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      onError(error instanceof Error ? error.message : String(error));
    }
  })();

  return () => controller.abort();
}

export async function cancelChatRequest(sessionId: string): Promise<void> {
  await fetch(`${baseURL()}/chat/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: 'POST',
  });
}

export async function getChatStatus(): Promise<{
  status: string;
  provider: string;
  hasActiveRequest: boolean;
}> {
  const res = await fetch(`${baseURL()}/chat/status`);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load chat status'));
  }
  return res.json();
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.text();
    return body || fallback;
  } catch {
    return fallback;
  }
}
