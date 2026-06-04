import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ChatRole = 'user' | 'assistant';
export type DraftResolutionStatus = 'sent' | 'discarded';

export type ChatActivityStep =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      id?: string;
      name: string;
      input?: unknown;
      result?: string;
    };

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  reasoning?: string | null;
  steps?: ChatActivityStep[];
  startedAt?: number;
  endedAt?: number;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  hermesSessionId: string | null;
  archivedAt: string | null;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  messageCount: number;
  lastMessagePreview: string | null;
}

export interface DraftResolutionRecord {
  sessionId: string;
  draftId: string;
  status: DraftResolutionStatus;
  channel: string;
  updatedAt: string;
}

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'chat-sessions.sqlite');
}

export class ChatStore {
  private readonly storePath: string;
  private readonly db: DatabaseSync;

  constructor(storePath = process.env.VERSO_CHAT_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.db = new DatabaseSync(this.storePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        hermes_session_id TEXT,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS local_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at
        ON chat_sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_local_messages_session_id
        ON local_messages(session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS draft_resolutions (
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        draft_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sent', 'discarded')),
        channel TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, draft_id)
      );
    `);
  }

  get path(): string {
    return this.storePath;
  }

  listSessions(): ChatSessionSummary[] {
    return this.listSessionRecords().map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archivedAt: session.archivedAt,
      messageCount: 0,
      lastMessagePreview: null,
    }));
  }

  listSessionRecords(): ChatSessionRecord[] {
    const rows = this.db.prepare(`
      SELECT id, title, created_at, updated_at, hermes_session_id, archived_at
      FROM chat_sessions
      ORDER BY updated_at DESC
    `).all() as unknown as SessionRow[];

    return rows.map(rowToSessionRecord);
  }

  getSession(sessionId: string): ChatSessionSummary | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archivedAt: session.archivedAt,
      messageCount: 0,
      lastMessagePreview: null,
    };
  }

  getSessionRecord(sessionId: string): ChatSessionRecord | null {
    const row = this.db.prepare(`
      SELECT id, title, created_at, updated_at, hermes_session_id, archived_at
      FROM chat_sessions
      WHERE id = ?
    `).get(sessionId) as SessionRow | undefined;

    return row ? rowToSessionRecord(row) : null;
  }

  createSession(title?: string): ChatSessionSummary {
    const now = new Date().toISOString();
    const id = randomUUID();
    const resolvedTitle = normalizeTitle(title) || 'New chat';

    this.db.prepare(`
      INSERT INTO chat_sessions (id, title, created_at, updated_at, hermes_session_id, archived_at)
      VALUES (?, ?, ?, ?, NULL, NULL)
    `).run(id, resolvedTitle, now, now);

    return {
      id,
      title: resolvedTitle,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      messageCount: 0,
      lastMessagePreview: null,
    };
  }

  appendMessage(sessionId: string, role: ChatRole, content: string): ChatMessageRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    const now = new Date().toISOString();
    const messageId = randomUUID();
    this.db.prepare(`
      INSERT INTO local_messages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(messageId, sessionId, role, content, now);
    this.touchSession(sessionId, now);

    return {
      id: messageId,
      sessionId,
      role,
      content,
      createdAt: now,
    };
  }

  getMessages(sessionId: string): ChatMessageRecord[] | null {
    const exists = this.db.prepare(`
      SELECT 1
      FROM chat_sessions
      WHERE id = ?
    `).get(sessionId);
    if (!exists) return null;

    const rows = this.db.prepare(`
      SELECT id, session_id, role, content, created_at
      FROM local_messages
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId) as unknown as MessageRow[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  linkHermesSession(sessionId: string, hermesSessionId: string): void {
    const session = this.getSessionRecord(sessionId);
    if (!session) return;

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE chat_sessions
      SET hermes_session_id = ?, updated_at = ?
      WHERE id = ?
    `).run(hermesSessionId, now, sessionId);
  }

  touchSession(sessionId: string, updatedAt = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE chat_sessions
      SET updated_at = ?
      WHERE id = ?
    `).run(updatedAt, sessionId);
  }

  recordDraftResolution(
    sessionId: string,
    draftId: string,
    status: DraftResolutionStatus,
    channel: string,
  ): DraftResolutionRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    const resolvedDraftId = normalizeDraftId(draftId);
    const resolvedChannel = normalizeChannel(channel);
    if (!resolvedDraftId || !resolvedChannel) return null;

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO draft_resolutions (session_id, draft_id, status, channel, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, draft_id) DO UPDATE SET
        status = excluded.status,
        channel = excluded.channel,
        updated_at = excluded.updated_at
    `).run(sessionId, resolvedDraftId, status, resolvedChannel, now);
    this.touchSession(sessionId, now);

    return {
      sessionId,
      draftId: resolvedDraftId,
      status,
      channel: resolvedChannel,
      updatedAt: now,
    };
  }

  listDraftResolutions(sessionId: string): DraftResolutionRecord[] {
    const rows = this.db.prepare(`
      SELECT session_id, draft_id, status, channel, updated_at
      FROM draft_resolutions
      WHERE session_id = ?
    `).all(sessionId) as unknown as DraftResolutionRow[];

    return rows.map(rowToDraftResolutionRecord);
  }

  renameSession(sessionId: string, title: string): ChatSessionRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    const resolvedTitle = normalizeTitle(title);
    if (!resolvedTitle) return session;

    this.db.prepare(`
      UPDATE chat_sessions
      SET title = ?
      WHERE id = ?
    `).run(resolvedTitle, sessionId);

    return {
      ...session,
      title: resolvedTitle,
    };
  }

  archiveSession(sessionId: string): ChatSessionRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    const archivedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE chat_sessions
      SET archived_at = ?
      WHERE id = ?
    `).run(archivedAt, sessionId);

    return {
      ...session,
      archivedAt,
    };
  }

  unarchiveSession(sessionId: string): ChatSessionRecord | null {
    const session = this.getSessionRecord(sessionId);
    if (!session) return null;

    this.db.prepare(`
      UPDATE chat_sessions
      SET archived_at = NULL
      WHERE id = ?
    `).run(sessionId);

    return {
      ...session,
      archivedAt: null,
    };
  }
}

interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  hermes_session_id: string | null;
  archived_at: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
}

interface DraftResolutionRow {
  session_id: string;
  draft_id: string;
  status: DraftResolutionStatus;
  channel: string;
  updated_at: string;
}

function rowToSessionRecord(row: SessionRow): ChatSessionRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hermesSessionId: row.hermes_session_id,
    archivedAt: row.archived_at,
  };
}

function rowToDraftResolutionRecord(row: DraftResolutionRow): DraftResolutionRecord {
  return {
    sessionId: row.session_id,
    draftId: row.draft_id,
    status: row.status,
    channel: row.channel,
    updatedAt: row.updated_at,
  };
}

function normalizeTitle(input: string | undefined): string {
  if (!input) return '';
  const compact = input.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
}

function normalizeDraftId(input: string): string {
  return input.trim().slice(0, 128);
}

function normalizeChannel(input: string): string {
  return input.trim().toLowerCase().slice(0, 64);
}
