import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Durable per-session Centaur thread state: the last SSE event id we consumed
 * and the id of an execution that was in flight when the app last saw it.
 *
 * Kept in its own SQLite file (not folded into ChatStore) so that with
 * `VERSO_AGENT_BACKEND` unset this class is never constructed and the main
 * chat store schema stays byte-identical to main.
 *
 * Persisting `last_event_id` is the API's resilience contract: replaying the
 * event stream from it on reconnect resumes a turn without duplicating output.
 */
export interface CentaurThreadState {
  sessionId: string;
  lastEventId: number;
  activeExecutionId: string | null;
}

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'centaur-threads.sqlite');
}

export class CentaurThreadStore {
  private readonly storePath: string;
  private readonly db: DatabaseSync;

  constructor(storePath = process.env.VERSO_CENTAUR_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.db = new DatabaseSync(this.storePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS centaur_threads (
        session_id TEXT PRIMARY KEY,
        last_event_id INTEGER NOT NULL DEFAULT 0,
        active_execution_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get path(): string {
    return this.storePath;
  }

  getState(sessionId: string): CentaurThreadState {
    const row = this.db.prepare(`
      SELECT session_id, last_event_id, active_execution_id
      FROM centaur_threads
      WHERE session_id = ?
    `).get(sessionId) as
      | { session_id: string; last_event_id: number; active_execution_id: string | null }
      | undefined;

    if (!row) {
      return { sessionId, lastEventId: 0, activeExecutionId: null };
    }
    return {
      sessionId: row.session_id,
      lastEventId: row.last_event_id,
      activeExecutionId: row.active_execution_id,
    };
  }

  /** Record the execution that is now running (clears on terminal via clearActive). */
  startExecution(sessionId: string, executionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO centaur_threads (session_id, last_event_id, active_execution_id, updated_at)
      VALUES (?, COALESCE((SELECT last_event_id FROM centaur_threads WHERE session_id = ?), 0), ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        active_execution_id = excluded.active_execution_id,
        updated_at = excluded.updated_at
    `).run(sessionId, sessionId, executionId, now);
  }

  /** Advance the high-water mark as events are consumed. Monotonic. */
  recordEventId(sessionId: string, eventId: number): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO centaur_threads (session_id, last_event_id, active_execution_id, updated_at)
      VALUES (?, ?, NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_event_id = MAX(centaur_threads.last_event_id, excluded.last_event_id),
        updated_at = excluded.updated_at
    `).run(sessionId, eventId, now);
  }

  /** Clear the in-flight execution once a terminal event is seen. */
  clearActive(sessionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE centaur_threads
      SET active_execution_id = NULL, updated_at = ?
      WHERE session_id = ?
    `).run(now, sessionId);
  }
}
