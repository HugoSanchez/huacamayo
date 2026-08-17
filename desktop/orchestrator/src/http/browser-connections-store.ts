import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'chat-sessions.sqlite');
}

export type BrowserConnectionStatus = 'pending' | 'connected' | 'needs_login' | 'error';

export interface BrowserConnection {
  id: string;
  name: string;
  domain: string | null;
  startUrl: string | null;
  title: string | null;
  profileDir: string;
  status: BrowserConnectionStatus;
  createdAt: number;
  updatedAt: number;
}

export type BrowserLeaseOutcome = 'done' | 'needs_login' | 'error' | 'expired' | 'launch_failed';

const STATUSES: readonly string[] = ['pending', 'connected', 'needs_login', 'error'];

// A "browser connection" is one logged-in website a routine can automate:
// a persistent Chromium profile dir plus the target page captured during
// setup. Hermes knows nothing about these — routines reference them by id
// (a `browser-connection:<id>` token in the cron prompt), and the session
// lease log is the source of truth for what actually happened on each run,
// independent of how the model narrated it.
export class BrowserConnectionsStore {
  private readonly db: DatabaseSync;

  constructor(storePath = process.env.VERSO_CHAT_STORE_PATH?.trim() || defaultStorePath()) {
    mkdirSync(path.dirname(storePath), { recursive: true });
    this.db = new DatabaseSync(storePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS browser_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT,
        start_url TEXT,
        title TEXT,
        profile_dir TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'connected', 'needs_login', 'error')),
        paused_jobs TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS browser_lease_log (
        lease_id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('setup', 'run')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT,
        summary TEXT
      );
    `);
    // Columns added after the table first shipped. ALTER throws when the
    // column already exists — the common case — so each is best-effort.
    try {
      this.db.exec(`ALTER TABLE browser_connections ADD COLUMN paused_jobs TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // Column already present.
    }
  }

  /** `startUrl` is the agent-provided target page: the setup window opens
   * there so the user never faces a blank tab. The completion capture
   * overwrites it with wherever the user actually landed. */
  create(name: string, profilesRoot: string, startUrl: string | null = null): BrowserConnection {
    const id = randomBytes(6).toString('hex');
    const now = Date.now();
    const connection: BrowserConnection = {
      id,
      name,
      domain: null,
      startUrl,
      title: null,
      profileDir: path.join(profilesRoot, id),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO browser_connections (id, name, domain, start_url, title, profile_dir, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, null, startUrl, null, connection.profileDir, 'pending', now, now);
    return connection;
  }

  get(id: string): BrowserConnection | null {
    const row = this.db.prepare(`
      SELECT id, name, domain, start_url, title, profile_dir, status, created_at, updated_at
      FROM browser_connections WHERE id = ?
    `).get(id) as {
      id: string; name: string; domain: string | null; start_url: string | null;
      title: string | null; profile_dir: string; status: string;
      created_at: number; updated_at: number;
    } | undefined;
    if (!row || !STATUSES.includes(row.status)) return null;
    return {
      id: row.id,
      name: row.name,
      domain: row.domain,
      startUrl: row.start_url,
      title: row.title,
      profileDir: row.profile_dir,
      status: row.status as BrowserConnectionStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  complete(id: string, capture: { domain: string; startUrl: string; title: string | null; name?: string }): void {
    this.db.prepare(`
      UPDATE browser_connections
      SET domain = ?, start_url = ?, title = ?, name = COALESCE(?, name), status = 'connected', updated_at = ?
      WHERE id = ?
    `).run(capture.domain, capture.startUrl, capture.title, capture.name ?? null, Date.now(), id);
  }

  setStatus(id: string, status: BrowserConnectionStatus): void {
    this.db.prepare(`
      UPDATE browser_connections SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, Date.now(), id);
  }

  /** Job ids the needs_login fan-out paused for this connection. Reconnect
   * resumes exactly these — never routines the user paused deliberately. */
  pausedJobs(id: string): string[] {
    const row = this.db.prepare(`
      SELECT paused_jobs FROM browser_connections WHERE id = ?
    `).get(id) as { paused_jobs: string } | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.paused_jobs);
      return Array.isArray(parsed) ? parsed.filter((j): j is string => typeof j === 'string') : [];
    } catch {
      return [];
    }
  }

  setPausedJobs(id: string, jobIds: string[]): void {
    this.db.prepare(`
      UPDATE browser_connections SET paused_jobs = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(jobIds), Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM browser_connections WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM browser_lease_log WHERE connection_id = ?`).run(id);
  }

  logLeaseStart(leaseId: string, connectionId: string, mode: 'setup' | 'run'): void {
    this.db.prepare(`
      INSERT INTO browser_lease_log (lease_id, connection_id, mode, started_at)
      VALUES (?, ?, ?, ?)
    `).run(leaseId, connectionId, mode, Date.now());
  }

  logLeaseEnd(leaseId: string, outcome: BrowserLeaseOutcome, summary: string | null): void {
    this.db.prepare(`
      UPDATE browser_lease_log SET ended_at = ?, outcome = ?, summary = ? WHERE lease_id = ?
    `).run(Date.now(), outcome, summary, leaseId);
  }

  lastLease(connectionId: string): { leaseId: string; mode: string; startedAt: number; endedAt: number | null; outcome: string | null; summary: string | null } | null {
    const row = this.db.prepare(`
      SELECT lease_id, mode, started_at, ended_at, outcome, summary
      FROM browser_lease_log WHERE connection_id = ? ORDER BY started_at DESC LIMIT 1
    `).get(connectionId) as {
      lease_id: string; mode: string; started_at: number;
      ended_at: number | null; outcome: string | null; summary: string | null;
    } | undefined;
    if (!row) return null;
    return {
      leaseId: row.lease_id,
      mode: row.mode,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      outcome: row.outcome,
      summary: row.summary,
    };
  }
}
