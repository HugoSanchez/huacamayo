import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  MemoryDiagnostics,
  MemoryPage,
  MemoryRuntimeState,
  MemorySearchResult,
  MemoryWriteProvider,
} from './memory-provider.ts';

/**
 * The one memory backend: a single SQLite file with FTS5 (BM25 ranking),
 * opened in-process by the orchestrator. No child processes, no model
 * downloads, no LLM in the ingestion path.
 *
 * Two tables: `pages` are agent-curated memories (the visible agent writes
 * them itself via write_memory_page); `documents` are raw passive capture —
 * chat segments and connected-source items (Gmail/Granola/Slack) indexed
 * verbatim. Search merges both, boosting curated pages over raw documents.
 */

export interface LexicalMemoryConfig {
  enabled: boolean;
  dbPath: string;
}

/** Memory is on by default; an explicit falsy VERSO_MEMORY_ENABLED is a kill switch. */
export function isMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VERSO_MEMORY_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

export function resolveLexicalMemoryConfig(
  hermesHome: string,
  env: NodeJS.ProcessEnv = process.env,
): LexicalMemoryConfig {
  return {
    enabled: isMemoryEnabled(env),
    // Sibling of the Hermes home (same convention as the models/ dir), so the
    // database survives app updates and profile reseeds.
    dbPath: env.VERSO_MEMORY_DB_PATH?.trim()
      || join(dirname(hermesHome), 'memory', 'verso-memory.db'),
  };
}

const MAX_SNIPPET_CHARS = 700;
const MAX_PAGE_CHARS = 20_000;
const SNIPPET_TOKENS = 64;
// Curated pages beat raw documents for the same terms.
const PAGE_RANK_BOOST = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  slug        TEXT PRIMARY KEY,
  title       TEXT,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  stream      TEXT,
  source_ref  TEXT NOT NULL,
  title       TEXT,
  content     TEXT NOT NULL,
  occurred_at TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(source, source_ref)
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, content, content='pages', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, content, content='documents', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO documents_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
`;

interface RankedHit {
  slug: string;
  title: string | null;
  snippet: string;
  relevance: number;
  recency: string;
}

export class LexicalMemoryProvider implements MemoryWriteProvider {
  readonly backend = 'lexical' as const;
  readonly capabilities = { search: true, getPage: true, bridgeWrites: true } as const;

  private readonly config: LexicalMemoryConfig;
  private db: DatabaseSync | null = null;
  private state: MemoryRuntimeState = 'idle';
  private lastError: string | null = null;

  constructor(config: LexicalMemoryConfig) {
    this.config = config;
  }

  /** Idempotent, synchronous under the hood. Never throws — failures land in diagnostics. */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.state = 'disabled';
      return;
    }
    if (this.db) return;
    try {
      mkdirSync(dirname(this.config.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.config.dbPath);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec(SCHEMA);
      this.state = 'ready';
      this.lastError = null;
    } catch (error: unknown) {
      this.state = 'error';
      this.lastError = formatError(error);
      this.db = null;
      console.warn(`[memory] lexical store failed to open: ${this.lastError}`);
    }
  }

  async stop(): Promise<void> {
    this.db?.close();
    this.db = null;
    if (this.state === 'ready') this.state = 'idle';
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  getState(): MemoryRuntimeState {
    return this.state;
  }

  diagnostics(): MemoryDiagnostics {
    return {
      enabled: this.config.enabled,
      state: this.state,
      backend: this.backend,
      dbPath: this.config.dbPath,
      lastError: this.lastError,
      ...(this.db ? this.counts() : {}),
    };
  }

  async search(query: string, limit: number): Promise<MemorySearchResult[]> {
    const match = buildFtsMatchExpression(query);
    if (!match) return [];
    const db = this.requireDb();

    const pageHits = db.prepare(`
      SELECT p.slug AS slug, p.title AS title, p.updated_at AS recency,
             -bm25(pages_fts) AS relevance,
             snippet(pages_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS snip
      FROM pages_fts JOIN pages p ON p.rowid = pages_fts.rowid
      WHERE pages_fts MATCH ?
      ORDER BY bm25(pages_fts) LIMIT ?
    `).all(match, limit) as unknown as Array<{ slug: string; title: string | null; recency: string; relevance: number; snip: string }>;

    const docHits = db.prepare(`
      SELECT d.id AS id, d.title AS title, d.source AS source,
             COALESCE(d.occurred_at, d.created_at) AS recency,
             -bm25(documents_fts) AS relevance,
             snippet(documents_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS snip
      FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
      WHERE documents_fts MATCH ?
      ORDER BY bm25(documents_fts) LIMIT ?
    `).all(match, limit) as unknown as Array<{ id: number; title: string | null; source: string; recency: string; relevance: number; snip: string }>;

    const merged: RankedHit[] = [
      ...pageHits.map((row) => ({
        slug: row.slug,
        title: row.title,
        snippet: row.snip,
        relevance: row.relevance * PAGE_RANK_BOOST,
        recency: row.recency ?? '',
      })),
      ...docHits.map((row) => ({
        slug: `doc:${row.id}`,
        title: row.title ?? `${row.source} ${(row.recency ?? '').slice(0, 10)}`.trim(),
        snippet: row.snip,
        relevance: row.relevance,
        recency: row.recency ?? '',
      })),
    ];

    merged.sort((a, b) => (b.relevance - a.relevance) || b.recency.localeCompare(a.recency));

    return merged.slice(0, limit).map((hit) => ({
      slug: hit.slug,
      title: hit.title,
      score: Math.round(hit.relevance * 10_000) / 10_000,
      snippet: truncate(hit.snippet, MAX_SNIPPET_CHARS),
    }));
  }

  async getPage(slug: string): Promise<MemoryPage | null> {
    const db = this.requireDb();
    const trimmed = slug.trim();

    // `doc:<id>` reads a raw ingested document, so the agent can open a
    // search hit that came from a transcript or email.
    const docMatch = /^doc:(\d+)$/.exec(trimmed);
    if (docMatch) {
      const row = db.prepare(
        'SELECT id, source, stream, title, content, occurred_at FROM documents WHERE id = ?',
      ).get(Number(docMatch[1])) as { id: number; source: string; stream: string | null; title: string | null; content: string; occurred_at: string | null } | undefined;
      if (!row) return null;
      return {
        slug: `doc:${row.id}`,
        title: row.title,
        content: truncate(row.content, MAX_PAGE_CHARS),
        source: row.source,
        stream: row.stream,
        occurredAt: row.occurred_at,
      };
    }

    const exact = db.prepare('SELECT slug, title, content, created_at, updated_at FROM pages WHERE slug = ?')
      .get(trimmed) as PageRow | undefined;
    const found = exact ?? this.fuzzyPageLookup(trimmed);
    if (!found) return null;
    return {
      slug: found.slug,
      title: found.title,
      content: truncate(found.content, MAX_PAGE_CHARS),
      createdAt: found.created_at,
      updatedAt: found.updated_at,
    };
  }

  async putPage(slug: string, content: string): Promise<unknown> {
    const db = this.requireDb();
    const cleanSlug = slug.trim();
    if (!cleanSlug) throw new Error('slug is required');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO pages (slug, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        updated_at = excluded.updated_at
    `).run(cleanSlug, deriveTitle(cleanSlug, content), content, now, now);
    return { slug: cleanSlug, updatedAt: now };
  }

  async ingestChatSegment(segment: {
    sourceRef: string;
    sessionId: string;
    title: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }>;
    occurredAt?: string;
  }): Promise<void> {
    const content = segment.messages
      .map((message) => `${message.role} (${message.createdAt}): ${message.content}`)
      .join('\n');
    this.upsertDocument({
      source: 'chat',
      stream: segment.sessionId,
      sourceRef: segment.sourceRef,
      title: segment.title || null,
      content,
      occurredAt: segment.occurredAt ?? segment.messages.at(-1)?.createdAt ?? null,
    });
  }

  async ingestSourceBatch(batch: {
    source: string;
    stream: string;
    items: Array<{ sourceRef: string; occurredAt?: string; title?: string; content: string }>;
  }): Promise<void> {
    for (const item of batch.items) {
      this.upsertDocument({
        source: batch.source,
        stream: batch.stream || null,
        sourceRef: item.sourceRef,
        title: item.title ?? null,
        content: item.content,
        occurredAt: item.occurredAt ?? null,
      });
    }
  }

  private upsertDocument(doc: {
    source: string;
    stream: string | null;
    sourceRef: string;
    title: string | null;
    content: string;
    occurredAt: string | null;
  }): void {
    this.requireDb().prepare(`
      INSERT INTO documents (source, stream, source_ref, title, content, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_ref) DO UPDATE SET
        stream = excluded.stream,
        title = excluded.title,
        content = excluded.content,
        occurred_at = excluded.occurred_at
    `).run(doc.source, doc.stream, doc.sourceRef, doc.title, doc.content, doc.occurredAt, new Date().toISOString());
  }

  private fuzzyPageLookup(slug: string): PageRow | undefined {
    const normalized = normalizeSlug(slug);
    if (!normalized) return undefined;
    const rows = this.requireDb().prepare('SELECT slug, title, content, created_at, updated_at FROM pages')
      .all() as unknown as PageRow[];
    return rows.find((row) => normalizeSlug(row.slug) === normalized)
      ?? rows.find((row) => normalizeSlug(row.slug).includes(normalized));
  }

  private counts(): Record<string, unknown> {
    try {
      const db = this.requireDb();
      const pages = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM pages').get() as { n: number; last: string | null };
      const documents = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM documents').get() as { n: number; last: string | null };
      return {
        pages: pages.n,
        documents: documents.n,
        lastPageWriteAt: pages.last,
        lastDocumentWriteAt: documents.last,
      };
    } catch {
      return {};
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db || this.state !== 'ready') {
      throw new Error(`Memory is not available (state: ${this.state})`);
    }
    return this.db;
  }
}

interface PageRow {
  slug: string;
  title: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

/**
 * Turn a free-form query into an FTS5 MATCH expression that can never hit
 * FTS5 syntax errors (`"`, `-`, `NEAR`, unbalanced quotes, emoji…): tokenize
 * on non-word characters, quote every token, OR them together, and also try
 * the full phrase so exact matches rank first.
 */
export function buildFtsMatchExpression(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((token) => `"${token}"`);
  const parts = tokens.length > 1 ? [`"${tokens.join(' ')}"`, ...quoted] : quoted;
  return parts.join(' OR ');
}

function deriveTitle(slug: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  const leaf = slug.split('/').at(-1) ?? slug;
  return leaf.replace(/[-_]+/g, ' ').trim();
}

function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
