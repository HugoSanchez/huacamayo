import type { AgentSSEEvent } from './types';

/** Get the sidecar base URL. The Swift host posts the port via webkit message handler. */
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

/**
 * Stream an agent query via SSE.
 * Calls onEvent for each parsed SSE message.
 * Returns an abort function.
 */
export function streamQuery(
  prompt: string,
  opts: { sessionId?: string } = {},
  onEvent: (event: AgentSSEEvent) => void,
  onDone: () => void,
  onError: (err: string) => void,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${baseURL()}/agent/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
        onError(`HTTP ${res.status}: ${text}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6)) as AgentSSEEvent;
            onEvent(parsed);
          } catch {
            // skip malformed lines
          }
        }
      }

      onDone();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      onError(err instanceof Error ? err.message : String(err));
    }
  })();

  return () => controller.abort();
}

export async function stopQuery(): Promise<void> {
  await fetch(`${baseURL()}/agent/stop`, { method: 'POST' });
}

export async function agentStatus(): Promise<{ status: string; hasActiveQuery: boolean }> {
  const res = await fetch(`${baseURL()}/agent/status`);
  return res.json();
}
