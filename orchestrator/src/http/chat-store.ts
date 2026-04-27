import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastResponseId: string | null;
  messages: ChatMessageRecord[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
}

interface ChatStoreShape {
  sessions: ChatSessionRecord[];
}

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Vervo', 'chat-sessions.json');
}

export class ChatStore {
  private readonly storePath: string;

  private state: ChatStoreShape;

  constructor(storePath = process.env.VERVO_CHAT_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    this.state = this.load();
  }

  get path(): string {
    return this.storePath;
  }

  listSessions(): ChatSessionSummary[] {
    return [...this.state.sessions]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => toSessionSummary(session));
  }

  createSession(title?: string): ChatSessionSummary {
    const now = new Date().toISOString();
    const session: ChatSessionRecord = {
      id: randomUUID(),
      title: normalizeTitle(title) || 'New chat',
      createdAt: now,
      updatedAt: now,
      lastResponseId: null,
      messages: [],
    };
    this.state.sessions.push(session);
    this.save();
    return toSessionSummary(session);
  }

  getSession(sessionId: string): ChatSessionSummary | null {
    const session = this.findSession(sessionId);
    return session ? toSessionSummary(session) : null;
  }

  getMessages(sessionId: string): ChatMessageRecord[] | null {
    const session = this.findSession(sessionId);
    if (!session) return null;
    return [...session.messages];
  }

  appendMessage(sessionId: string, role: ChatRole, content: string): ChatMessageRecord | null {
    const session = this.findSession(sessionId);
    if (!session) return null;

    const now = new Date().toISOString();
    const message: ChatMessageRecord = {
      id: randomUUID(),
      sessionId,
      role,
      content,
      createdAt: now,
    };

    session.messages.push(message);
    session.updatedAt = now;
    if (role === 'user' && session.messages.filter((item) => item.role === 'user').length === 1) {
      session.title = normalizeTitle(content) || session.title;
    }
    this.save();
    return message;
  }

  getLastResponseId(sessionId: string): string | null {
    return this.findSession(sessionId)?.lastResponseId ?? null;
  }

  setLastResponseId(sessionId: string, responseId: string | null): void {
    const session = this.findSession(sessionId);
    if (!session) return;
    session.lastResponseId = responseId;
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  private findSession(sessionId: string): ChatSessionRecord | undefined {
    return this.state.sessions.find((session) => session.id === sessionId);
  }

  private load(): ChatStoreShape {
    if (!existsSync(this.storePath)) {
      return { sessions: [] };
    }

    try {
      const raw = readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ChatStoreShape>;
      if (!parsed || !Array.isArray(parsed.sessions)) {
        return { sessions: [] };
      }

      return {
        sessions: parsed.sessions
          .filter(isValidSessionRecord)
          .map((session) => ({
            ...session,
            lastResponseId: typeof session.lastResponseId === 'string' ? session.lastResponseId : null,
            messages: session.messages.filter(isValidMessageRecord),
          })),
      };
    } catch {
      return { sessions: [] };
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmpPath = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.storePath);
  }
}

function normalizeTitle(input: string | undefined): string {
  if (!input) return '';
  const compact = input.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
}

function toSessionSummary(session: ChatSessionRecord): ChatSessionSummary {
  const lastMessage = session.messages[session.messages.length - 1];
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    lastMessagePreview: lastMessage ? preview(lastMessage.content) : null,
  };
}

function preview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 120)}...`;
}

function isValidSessionRecord(value: unknown): value is ChatSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ChatSessionRecord>;
  return typeof candidate.id === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && Array.isArray(candidate.messages);
}

function isValidMessageRecord(value: unknown): value is ChatMessageRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ChatMessageRecord>;
  return typeof candidate.id === 'string'
    && typeof candidate.sessionId === 'string'
    && (candidate.role === 'user' || candidate.role === 'assistant')
    && typeof candidate.content === 'string'
    && typeof candidate.createdAt === 'string';
}
