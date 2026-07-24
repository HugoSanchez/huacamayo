import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { LocalEmbedder } from '../http/embedder.ts';
import type {
  MemoryDiagnostics,
  MemoryPage,
  MemoryRuntimeState,
  MemorySearchResult,
  MemoryWriteProvider,
} from '../http/memory-provider.ts';

/**
 * Postgres port of LexicalMemoryProvider's WRITE side, targeting the cloud
 * memory tables (memory_pages / memory_documents / memory_embeddings) that the
 * sandbox `memory` CLI reads. memoryd never searches — retrieval lives in the
 * CLI (pg_search BM25 + pgvector cosine + RRF) — so `search` here is a stub.
 *
 * Semantics are a 1:1 port of lexical-provider.ts:
 *  - upsert keyed on (source, source_ref); merge sources APPEND with a
 *    most-recent-tail cap instead of replacing.
 *  - embeddings are strictly additive: a background backfill embeds rows whose
 *    source_stamp is missing or stale; nothing gates on the embedder.
 *  - chunking 1600/200, ≤8 chunks per row, title prepended.
 */

const MAX_MERGED_DOC_CHARS = 20_000;
export const CHUNK_CHARS = 1600;
export const CHUNK_OVERLAP = 200;
export const MAX_CHUNKS_PER_ROW = 8;

export class PgMemoryProvider implements MemoryWriteProvider {
  readonly backend = 'lexical' as const;
  readonly capabilities = { search: true, getPage: true, bridgeWrites: true } as const;

  private readonly pool: pg.Pool;
  private readonly embedder: LocalEmbedder | null;
  private state: MemoryRuntimeState = 'idle';
  private instanceId: string | null = null;
  private lastError: string | null = null;
  private backfillRunning = false;

  constructor(dsn: string, opts: { embedder?: LocalEmbedder | null } = {}) {
    this.pool = new pg.Pool({ connectionString: dsn, max: 4 });
    this.embedder = opts.embedder ?? null;
  }

  /** Connects, ensures the memoryd-owned meta table, mints the instance token. */
  async start(): Promise<void> {
    if (this.state === 'ready') return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS memory_meta (
          key   text PRIMARY KEY,
          value text NOT NULL
        )
      `);
      this.instanceId = await this.ensureInstanceId();
      this.state = 'ready';
      this.lastError = null;
    } catch (error: unknown) {
      this.state = 'error';
      this.lastError = formatError(error);
      console.warn(`[memoryd] pg memory provider failed to start: ${this.lastError}`);
    }
  }

  async stop(): Promise<void> {
    await this.pool.end();
    if (this.state === 'ready') this.state = 'idle';
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  getState(): MemoryRuntimeState {
    return this.state;
  }

  instanceToken(): string | null {
    return this.instanceId;
  }

  diagnostics(): MemoryDiagnostics {
    return {
      enabled: true,
      state: this.state,
      backend: this.backend,
      lastError: this.lastError,
      ...(this.embedder ? { embedder: this.embedder.diagnostics() } : {}),
    };
  }

  /** Row counts + embedding lag, for /status. Never throws. */
  async counts(): Promise<Record<string, unknown>> {
    try {
      const [pages, documents, embedded, pending] = await Promise.all([
        this.pool.query('SELECT COUNT(*)::int AS n, MAX(updated_at)::text AS last FROM memory_pages'),
        this.pool.query('SELECT COUNT(*)::int AS n, MAX(created_at)::text AS last FROM memory_documents'),
        this.pool.query("SELECT COUNT(DISTINCT kind || ':' || ref)::int AS n FROM memory_embeddings"),
        this.embedder ? this.countPendingEmbeds() : Promise.resolve(null),
      ]);
      return {
        pages: pages.rows[0].n,
        documents: documents.rows[0].n,
        lastPageWriteAt: pages.rows[0].last,
        lastDocumentWriteAt: documents.rows[0].last,
        embeddedRows: embedded.rows[0].n,
        ...(pending === null ? {} : { pendingEmbeds: pending }),
      };
    } catch {
      return {};
    }
  }

  /** memoryd is write-only; retrieval belongs to the sandbox memory CLI. */
  async search(_query: string, _limit: number): Promise<MemorySearchResult[]> {
    return [];
  }

  async getPage(_slug: string): Promise<MemoryPage | null> {
    return null;
  }

  async putPage(slug: string, content: string): Promise<unknown> {
    const cleanSlug = slug.trim();
    if (!cleanSlug) throw new Error('slug is required');
    const result = await this.pool.query(
      `INSERT INTO memory_pages (slug, title, content)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         updated_at = now()
       RETURNING updated_at::text AS updated_at`,
      [cleanSlug, deriveTitle(cleanSlug, content), content],
    );
    return { slug: cleanSlug, updatedAt: result.rows[0].updated_at };
  }

  /** Chat capture is a local-Verso concern; cloud sessions live in Centaur. */
  async ingestChatSegment(): Promise<void> {
    throw new Error('ingestChatSegment is not supported by memoryd');
  }

  async ingestSourceBatch(batch: {
    source: string;
    stream: string;
    items: Array<{ sourceRef: string; occurredAt?: string; title?: string; content: string; merge?: boolean }>;
  }): Promise<void> {
    for (const item of batch.items) {
      await this.upsertDocument({
        source: batch.source,
        stream: batch.stream || '',
        sourceRef: item.sourceRef,
        title: item.title ?? '',
        content: item.content,
        occurredAt: item.occurredAt ?? null,
        merge: item.merge ?? false,
      });
    }
  }

  private async upsertDocument(doc: {
    source: string;
    stream: string;
    sourceRef: string;
    title: string;
    content: string;
    occurredAt: string | null;
    merge: boolean;
  }): Promise<void> {
    if (doc.merge) {
      // Merge sources (Slack day buckets) APPEND into the shared row. The
      // scheduler's ledger guarantees each dedupRef lands exactly once, so a
      // plain append is correct; the cap keeps the most-recent tail.
      const existing = await this.pool.query(
        'SELECT content, occurred_at::text AS occurred_at FROM memory_documents WHERE source = $1 AND source_ref = $2',
        [doc.source, doc.sourceRef],
      );
      if (existing.rows.length > 0) {
        await this.pool.query(
          `UPDATE memory_documents
           SET stream = $1, title = $2, content = $3, occurred_at = $4, updated_at = now()
           WHERE source = $5 AND source_ref = $6`,
          [
            doc.stream,
            doc.title,
            mergeContent(existing.rows[0].content, doc.content),
            laterIso(existing.rows[0].occurred_at, doc.occurredAt),
            doc.source,
            doc.sourceRef,
          ],
        );
        return;
      }
      // No row yet: fall through and insert the first line normally.
    }

    await this.pool.query(
      `INSERT INTO memory_documents (source, stream, source_ref, title, content, occurred_at, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (source, source_ref) DO UPDATE SET
         stream = excluded.stream,
         title = excluded.title,
         content = excluded.content,
         occurred_at = excluded.occurred_at,
         updated_at = now()`,
      [doc.source, doc.stream, doc.sourceRef, doc.title, doc.content, doc.occurredAt, { ingested_by: 'memoryd' }],
    );
  }

  /**
   * Embed rows whose vectors are missing or stale. Stamps are text-cast
   * timestamps compared as opaque strings (same trick as local: no content
   * hashing). Single writer of memory_embeddings.
   */
  async runEmbeddingBackfill(maxRows = 8): Promise<number> {
    if (!this.embedder?.isReady() || this.state !== 'ready' || this.backfillRunning) return 0;
    this.backfillRunning = true;
    try {
      const model = this.embedder.modelId;
      const pagesPending = await this.pool.query(
        `SELECT 'page' AS kind, p.slug AS ref, p.title AS title, p.content AS content, p.updated_at::text AS stamp
         FROM memory_pages p
         LEFT JOIN memory_embeddings e ON e.kind = 'page' AND e.ref = p.slug AND e.chunk = 0 AND e.model = $1
         WHERE e.ref IS NULL OR e.source_stamp != p.updated_at::text
         LIMIT $2`,
        [model, maxRows],
      );
      const docsPending = await this.pool.query(
        `SELECT 'doc' AS kind, d.id::text AS ref, d.title AS title, d.content AS content,
                COALESCE(d.updated_at, d.created_at)::text AS stamp
         FROM memory_documents d
         LEFT JOIN memory_embeddings e ON e.kind = 'doc' AND e.ref = d.id::text AND e.chunk = 0 AND e.model = $1
         WHERE e.ref IS NULL OR e.source_stamp != COALESCE(d.updated_at, d.created_at)::text
         LIMIT $2`,
        [model, maxRows],
      );
      const pending = [...pagesPending.rows, ...docsPending.rows].slice(0, maxRows) as Array<{
        kind: 'page' | 'doc';
        ref: string;
        title: string | null;
        content: string;
        stamp: string;
      }>;

      for (const row of pending) {
        const chunks = chunkForEmbedding(row.title, row.content);
        const vectors = await this.embedder.embedPassages(chunks);
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM memory_embeddings WHERE kind = $1 AND ref = $2', [row.kind, row.ref]);
          for (let index = 0; index < vectors.length; index += 1) {
            await client.query(
              `INSERT INTO memory_embeddings (kind, ref, chunk, model, source_stamp, embedding)
               VALUES ($1, $2, $3, $4, $5, $6::vector)`,
              [row.kind, row.ref, index, model, row.stamp, vectorLiteral(vectors[index])],
            );
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      return pending.length;
    } finally {
      this.backfillRunning = false;
    }
  }

  private async countPendingEmbeds(): Promise<number> {
    const model = this.embedder!.modelId;
    const result = await this.pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM memory_pages p
          LEFT JOIN memory_embeddings e ON e.kind = 'page' AND e.ref = p.slug AND e.chunk = 0 AND e.model = $1
          WHERE e.ref IS NULL OR e.source_stamp != p.updated_at::text)
        +
        (SELECT COUNT(*)::int FROM memory_documents d
          LEFT JOIN memory_embeddings e ON e.kind = 'doc' AND e.ref = d.id::text AND e.chunk = 0 AND e.model = $1
          WHERE e.ref IS NULL OR e.source_stamp != COALESCE(d.updated_at, d.created_at)::text)
        AS n`,
      [model],
    );
    return result.rows[0].n;
  }

  private async ensureInstanceId(): Promise<string> {
    await this.pool.query(
      'INSERT INTO memory_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      ['instance_id', randomUUID()],
    );
    const stored = await this.pool.query('SELECT value FROM memory_meta WHERE key = $1', ['instance_id']);
    return stored.rows[0].value;
  }
}

/** Overlapping windows over title+content, capped — headline content first. Port of lexical-provider. */
export function chunkForEmbedding(title: string | null, content: string): string[] {
  const text = [title?.trim(), content.trim()].filter(Boolean).join('\n');
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  for (
    let start = 0;
    start < text.length && chunks.length < MAX_CHUNKS_PER_ROW;
    start += CHUNK_CHARS - CHUNK_OVERLAP
  ) {
    chunks.push(text.slice(start, start + CHUNK_CHARS));
  }
  return chunks;
}

/** Append `addition` to `existing`, keeping the most-recent tail within the cap. Port of lexical-provider. */
export function mergeContent(existing: string, addition: string): string {
  const merged = existing ? `${existing}\n${addition}` : addition;
  if (merged.length <= MAX_MERGED_DOC_CHARS) return merged;
  return `…[earlier truncated]\n${merged.slice(merged.length - MAX_MERGED_DOC_CHARS)}`;
}

/** The later of two ISO timestamps (lexicographic works for ISO-8601); tolerates nulls. */
export function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Render a vector as a pgvector text literal for `$n::vector`. */
export function vectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector).join(',')}]`;
}

function deriveTitle(slug: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  const leaf = slug.split('/').at(-1) ?? slug;
  return leaf.replace(/[-_]+/g, ' ').trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
