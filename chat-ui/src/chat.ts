import type {
  ChatSessionSummary,
  ChatSSEEvent,
  ConnectionRequestView,
  ConnectionView,
  SkillDetailView,
  SkillSummaryView,
  StoredChatMessage,
  ToolkitView,
} from './types';

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

export async function getChatSessions(): Promise<ChatSessionSummary[]> {
  const res = await fetch(`${baseURL()}/chat/sessions`);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load chat sessions'));
  }
  const body = await res.json() as { sessions: ChatSessionSummary[] };
  return Array.isArray(body.sessions) ? body.sessions : [];
}

export async function archiveChatSession(sessionId: string): Promise<ChatSessionSummary> {
  const res = await fetch(`${baseURL()}/chat/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to archive chat session'));
  }
  const body = await res.json() as { session: ChatSessionSummary };
  return body.session;
}

export async function unarchiveChatSession(sessionId: string): Promise<ChatSessionSummary> {
  const res = await fetch(`${baseURL()}/chat/sessions/${encodeURIComponent(sessionId)}/unarchive`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to restore chat session'));
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
  options: { attached?: import('./types').AttachedContext | null } = {},
): () => void {
  const controller = new AbortController();

  // Skills travel via the slash text (`/skill body`), so we only forward the
  // structured `attached` field for cron context — the orchestrator does the
  // Hermes round-trip to inject the cron's current state.
  const attached = options.attached?.kind === 'cron'
    ? { kind: 'cron' as const, id: options.attached.id }
    : undefined;

  (async () => {
    try {
      const res = await fetch(`${baseURL()}/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attached ? { content, attached } : { content }),
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

export async function getConnections(): Promise<{
  available: boolean;
  configured: boolean;
  connections: ConnectionView[];
}> {
  const res = await fetch(`${baseURL()}/connections`);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load connections'));
  }
  return res.json();
}

export async function getToolkits(opts: {
  query?: string;
  cursor?: string;
  limit?: number;
} = {}): Promise<{
  toolkits: ToolkitView[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams();
  if (opts.query) params.set('query', opts.query);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
  const url = params.toString().length > 0
    ? `${baseURL()}/connections/toolkits?${params.toString()}`
    : `${baseURL()}/connections/toolkits`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load toolkits'));
  }
  const body = await res.json() as { toolkits: ToolkitView[]; nextCursor?: string | null };
  return {
    toolkits: body.toolkits ?? [],
    nextCursor: body.nextCursor ?? null,
  };
}

export async function getSkills(): Promise<SkillSummaryView[]> {
  const res = await fetch(`${baseURL()}/skills`);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load skills'));
  }
  const body = await res.json() as { skills: SkillSummaryView[] };
  return Array.isArray(body.skills) ? body.skills : [];
}

export async function getSkill(slug: string): Promise<SkillDetailView> {
  const res = await fetch(`${baseURL()}/skills/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load skill'));
  }
  const body = await res.json() as { skill: SkillDetailView };
  return body.skill;
}

export async function toggleSkill(slug: string, enabled: boolean): Promise<SkillSummaryView> {
  const res = await fetch(`${baseURL()}/skills/${encodeURIComponent(slug)}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to toggle skill'));
  }
  const body = await res.json() as { skill: SkillSummaryView };
  return body.skill;
}

export async function getCronDetail(id: string): Promise<import('./types').CronDetailView> {
  const res = await fetch(`${baseURL()}/crons/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load cron job'));
  }
  return res.json() as Promise<import('./types').CronDetailView>;
}

export async function getCronRunOutput(id: string, filename: string): Promise<string> {
  const res = await fetch(`${baseURL()}/crons/${encodeURIComponent(id)}/runs/${encodeURIComponent(filename)}`);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load run output'));
  }
  const body = await res.json() as { content: string };
  return body.content;
}

export async function generateCronDescription(id: string, force = false): Promise<import('./types').CronDescriptionView | null> {
  const res = await fetch(`${baseURL()}/crons/${encodeURIComponent(id)}/description/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to generate description'));
  }
  const body = await res.json() as { description: import('./types').CronDescriptionView | null };
  return body.description;
}

export async function patchCronDescription(id: string, description: string): Promise<import('./types').CronDescriptionView | null> {
  const res = await fetch(`${baseURL()}/crons/${encodeURIComponent(id)}/description`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to update description'));
  }
  const body = await res.json() as { description: import('./types').CronDescriptionView | null };
  return body.description;
}

export async function getCronRunTranscript(id: string, filename: string): Promise<import('./types').CronRunTranscriptView | null> {
  const res = await fetch(`${baseURL()}/crons/${encodeURIComponent(id)}/runs/${encodeURIComponent(filename)}/transcript`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load run transcript'));
  }
  return res.json() as Promise<import('./types').CronRunTranscriptView>;
}

export async function patchCron(id: string, payload: Partial<{
  name: string;
  schedule: string;
  prompt: string;
  deliver: string;
  skills: string[];
}>): Promise<import('./types').CronJobView> {
  const res = await fetch(`${baseURL()}/crons/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to update cron job'));
  }
  const body = await res.json() as { cron: import('./types').CronJobView };
  return body.cron;
}

export async function deleteCron(id: string): Promise<void> {
  const res = await fetch(`${baseURL()}/crons/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to delete cron job'));
  }
}

export async function cronAction(id: string, op: 'pause' | 'resume' | 'run'): Promise<import('./types').CronJobView> {
  const res = await fetch(`${baseURL()}/crons/${encodeURIComponent(id)}/${op}`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to ${op} cron job`));
  }
  const body = await res.json() as { cron: import('./types').CronJobView };
  return body.cron;
}

export async function pinSkill(slug: string, pinned: boolean): Promise<SkillSummaryView> {
  const res = await fetch(`${baseURL()}/skills/${encodeURIComponent(slug)}/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to pin skill'));
  }
  const body = await res.json() as { skill: SkillSummaryView };
  return body.skill;
}

export async function getConnectionRequest(requestId: string): Promise<ConnectionRequestView> {
  const res = await fetch(`${baseURL()}/connections/requests/${encodeURIComponent(requestId)}`);
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to load connection request'));
  }
  const body = await res.json() as { request: ConnectionRequestView };
  return body.request;
}

export async function createConnectionRequest(toolkit: string): Promise<ConnectionRequestView> {
  const res = await fetch(`${baseURL()}/connections/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolkit }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Failed to create connection request'));
  }
  const body = await res.json() as { request: ConnectionRequestView };
  return body.request;
}

export function openConnectionRequest(requestId: string): void {
  openExternalUrl(`${baseURL()}/connections/requests/${encodeURIComponent(requestId)}/open`);
}

export function openExternalUrl(url: string): void {
  const handler = window.webkit?.messageHandlers?.chatBridge;
  if (handler) {
    handler.postMessage({ type: 'openExternalUrl', url });
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.text();
    return body || fallback;
  } catch {
    return fallback;
  }
}
