export interface HermesSessionDetail {
  id: string;
  title?: string | null;
  started_at?: number;
  ended_at?: number | null;
  message_count?: number;
  last_active?: number;
}

export interface HermesSessionMessage {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  timestamp: number;
}

export class HermesSessionsClient {
  constructor(private readonly baseUrl: string) {}

  async getSession(sessionId: string): Promise<HermesSessionDetail | null> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(await readError(res, 'Failed to load Hermes session'));
    }
    return res.json() as Promise<HermesSessionDetail>;
  }

  async getSessionMessages(sessionId: string): Promise<HermesSessionMessage[] | null> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(await readError(res, 'Failed to load Hermes session messages'));
    }
    const body = await res.json() as { messages?: HermesSessionMessage[] };
    return Array.isArray(body.messages) ? body.messages : [];
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.text()).trim();
    return body || fallback;
  } catch {
    return fallback;
  }
}
