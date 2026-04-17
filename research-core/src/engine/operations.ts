/**
 * Contract-first operation definitions. Single source of truth for CLI, MCP, and tools-json.
 * Each operation defines its schema, handler, and optional CLI hints.
 */

import type { BrainEngine } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import { importFromContent } from './import-file.ts';
import { hybridSearch } from './search/hybrid.ts';
import { expandQuery } from './search/expansion.ts';
import { dedupResults } from './search/dedup.ts';
// db.ts (Postgres-only) removed — Vervo uses PGLite exclusively via BrainEngine

// --- Types ---

export type ErrorCode =
  | 'page_not_found'
  | 'invalid_params'
  | 'embedding_failed'
  | 'storage_error'
  | 'bucket_not_found'
  | 'database_error';

export class OperationError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string,
    public docs?: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      suggestion: this.suggestion,
      docs: this.docs,
    };
  }
}

export interface ParamDef {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  items?: ParamDef;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface OperationContext {
  engine: BrainEngine;
  config: GBrainConfig;
  logger: Logger;
  dryRun: boolean;
}

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
  cliHints?: {
    name?: string;
    positional?: string[];
    stdin?: string;
    hidden?: boolean;
  };
}

// --- Page CRUD ---

const get_page: Operation = {
  name: 'get_page',
  description: 'Read a page by slug (supports optional fuzzy matching)',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    fuzzy: { type: 'boolean', description: 'Enable fuzzy slug resolution (default: false)' },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const fuzzy = (p.fuzzy as boolean) || false;

    let page = await ctx.engine.getPage(slug);
    let resolved_slug: string | undefined;

    if (!page && fuzzy) {
      const candidates = await ctx.engine.resolveSlugs(slug);
      if (candidates.length === 1) {
        page = await ctx.engine.getPage(candidates[0]);
        resolved_slug = candidates[0];
      } else if (candidates.length > 1) {
        return { error: 'ambiguous_slug', candidates };
      }
    }

    if (!page) {
      throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug or use fuzzy: true');
    }

    const tags = await ctx.engine.getTags(page.slug);
    return { ...page, tags, ...(resolved_slug ? { resolved_slug } : {}) };
  },
  cliHints: { name: 'get', positional: ['slug'] },
};

const put_page: Operation = {
  name: 'put_page',
  description: 'Write/update a page (markdown with frontmatter). Chunks, embeds, and reconciles tags.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    content: { type: 'string', required: true, description: 'Full markdown content with YAML frontmatter' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'put_page', slug: p.slug };
    const result = await importFromContent(ctx.engine, p.slug as string, p.content as string);
    return { slug: result.slug, status: result.status === 'imported' ? 'created_or_updated' : result.status, chunks: result.chunks };
  },
  cliHints: { name: 'put', positional: ['slug'], stdin: 'content' },
};

const delete_page: Operation = {
  name: 'delete_page',
  description: 'Delete a page',
  params: {
    slug: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'delete_page', slug: p.slug };
    await ctx.engine.deletePage(p.slug as string);
    return { status: 'deleted' };
  },
  cliHints: { name: 'delete', positional: ['slug'] },
};

const list_pages: Operation = {
  name: 'list_pages',
  description: 'List pages with optional filters',
  params: {
    type: { type: 'string', description: 'Filter by page type' },
    tag: { type: 'string', description: 'Filter by tag' },
    limit: { type: 'number', description: 'Max results (default 50)' },
  },
  handler: async (ctx, p) => {
    const pages = await ctx.engine.listPages({
      type: p.type as any,
      tag: p.tag as string,
      limit: (p.limit as number) || 50,
    });
    return pages.map(pg => ({
      slug: pg.slug,
      type: pg.type,
      title: pg.title,
      updated_at: pg.updated_at,
    }));
  },
  cliHints: { name: 'list' },
};

// --- Search ---

const search: Operation = {
  name: 'search',
  description: 'Keyword search using full-text search',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
  },
  handler: async (ctx, p) => {
    const results = await ctx.engine.searchKeyword(p.query as string, {
      limit: (p.limit as number) || 20,
      offset: (p.offset as number) || 0,
    });
    return dedupResults(results);
  },
  cliHints: { name: 'search', positional: ['query'] },
};

const query: Operation = {
  name: 'query',
  description: 'Hybrid search with vector + keyword + multi-query expansion',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
    expand: { type: 'boolean', description: 'Enable multi-query expansion (default: true)' },
    detail: { type: 'string', description: 'Result detail level: low (compiled truth only), medium (default, all with dedup), high (all chunks)' },
  },
  handler: async (ctx, p) => {
    const expand = p.expand !== false;
    const detail = (p.detail as 'low' | 'medium' | 'high') || undefined;
    return hybridSearch(ctx.engine, p.query as string, {
      limit: (p.limit as number) || 20,
      offset: (p.offset as number) || 0,
      expansion: expand,
      expandFn: expand ? expandQuery : undefined,
      detail,
    });
  },
  cliHints: { name: 'query', positional: ['query'] },
};

// --- Tags ---

const add_tag: Operation = {
  name: 'add_tag',
  description: 'Add tag to page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_tag', slug: p.slug, tag: p.tag };
    await ctx.engine.addTag(p.slug as string, p.tag as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'tag', positional: ['slug', 'tag'] },
};

const remove_tag: Operation = {
  name: 'remove_tag',
  description: 'Remove tag from page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_tag', slug: p.slug, tag: p.tag };
    await ctx.engine.removeTag(p.slug as string, p.tag as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'untag', positional: ['slug', 'tag'] },
};

const get_tags: Operation = {
  name: 'get_tags',
  description: 'List tags for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getTags(p.slug as string);
  },
  cliHints: { name: 'tags', positional: ['slug'] },
};

// --- Links ---

const add_link: Operation = {
  name: 'add_link',
  description: 'Create link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    link_type: { type: 'string', description: 'Link type (e.g., invested_in, works_at)' },
    context: { type: 'string', description: 'Context for the link' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_link', from: p.from, to: p.to };
    await ctx.engine.addLink(
      p.from as string, p.to as string,
      (p.context as string) || '', (p.link_type as string) || '',
    );
    return { status: 'ok' };
  },
  cliHints: { name: 'link', positional: ['from', 'to'] },
};

const remove_link: Operation = {
  name: 'remove_link',
  description: 'Remove link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_link', from: p.from, to: p.to };
    await ctx.engine.removeLink(p.from as string, p.to as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'unlink', positional: ['from', 'to'] },
};

const get_links: Operation = {
  name: 'get_links',
  description: 'List outgoing links from a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getLinks(p.slug as string);
  },
};

const get_backlinks: Operation = {
  name: 'get_backlinks',
  description: 'List incoming links to a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getBacklinks(p.slug as string);
  },
  cliHints: { name: 'backlinks', positional: ['slug'] },
};

const traverse_graph: Operation = {
  name: 'traverse_graph',
  description: 'Traverse link graph from a page',
  params: {
    slug: { type: 'string', required: true },
    depth: { type: 'number', description: 'Max traversal depth (default 5)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.traverseGraph(p.slug as string, (p.depth as number) || 5);
  },
  cliHints: { name: 'graph', positional: ['slug'] },
};

// --- Timeline ---

const add_timeline_entry: Operation = {
  name: 'add_timeline_entry',
  description: 'Add timeline entry to a page',
  params: {
    slug: { type: 'string', required: true },
    date: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    detail: { type: 'string' },
    source: { type: 'string' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_timeline_entry', slug: p.slug };
    await ctx.engine.addTimelineEntry(p.slug as string, {
      date: p.date as string,
      source: (p.source as string) || '',
      summary: p.summary as string,
      detail: (p.detail as string) || '',
    });
    return { status: 'ok' };
  },
  cliHints: { name: 'timeline-add', positional: ['slug', 'date', 'summary'] },
};

const get_timeline: Operation = {
  name: 'get_timeline',
  description: 'Get timeline entries for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getTimeline(p.slug as string);
  },
  cliHints: { name: 'timeline', positional: ['slug'] },
};

// --- Admin ---

const get_stats: Operation = {
  name: 'get_stats',
  description: 'Brain statistics (page count, chunk count, etc.)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getStats();
  },
  cliHints: { name: 'stats' },
};

const get_health: Operation = {
  name: 'get_health',
  description: 'Brain health dashboard (embed coverage, stale pages, orphans)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getHealth();
  },
  cliHints: { name: 'health' },
};

const get_versions: Operation = {
  name: 'get_versions',
  description: 'Page version history',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getVersions(p.slug as string);
  },
  cliHints: { name: 'history', positional: ['slug'] },
};

const revert_version: Operation = {
  name: 'revert_version',
  description: 'Revert page to a previous version',
  params: {
    slug: { type: 'string', required: true },
    version_id: { type: 'number', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'revert_version', slug: p.slug, version_id: p.version_id };
    await ctx.engine.createVersion(p.slug as string);
    await ctx.engine.revertToVersion(p.slug as string, p.version_id as number);
    return { status: 'reverted' };
  },
  cliHints: { name: 'revert', positional: ['slug', 'version_id'] },
};

// sync_brain operation removed — Vervo uses its own source/context model

// --- Raw Data ---

const put_raw_data: Operation = {
  name: 'put_raw_data',
  description: 'Store raw API response data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: { type: 'string', required: true, description: 'Data source (e.g., crustdata, happenstance)' },
    data: { type: 'object', required: true, description: 'Raw data object' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'put_raw_data', slug: p.slug, source: p.source };
    await ctx.engine.putRawData(p.slug as string, p.source as string, p.data as object);
    return { status: 'ok' };
  },
};

const get_raw_data: Operation = {
  name: 'get_raw_data',
  description: 'Retrieve raw data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: { type: 'string', description: 'Filter by source' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getRawData(p.slug as string, p.source as string | undefined);
  },
};

// --- Resolution & Chunks ---

const resolve_slugs: Operation = {
  name: 'resolve_slugs',
  description: 'Fuzzy-resolve a partial slug to matching page slugs',
  params: {
    partial: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.resolveSlugs(p.partial as string);
  },
};

const get_chunks: Operation = {
  name: 'get_chunks',
  description: 'Get content chunks for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getChunks(p.slug as string);
  },
};

// --- Ingest Log ---

const log_ingest: Operation = {
  name: 'log_ingest',
  description: 'Log an ingestion event',
  params: {
    source_type: { type: 'string', required: true },
    source_ref: { type: 'string', required: true },
    pages_updated: { type: 'array', required: true, items: { type: 'string' } },
    summary: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'log_ingest' };
    await ctx.engine.logIngest({
      source_type: p.source_type as string,
      source_ref: p.source_ref as string,
      pages_updated: p.pages_updated as string[],
      summary: p.summary as string,
    });
    return { status: 'ok' };
  },
};

const get_ingest_log: Operation = {
  name: 'get_ingest_log',
  description: 'Get recent ingestion log entries',
  params: {
    limit: { type: 'number', description: 'Max entries (default 20)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getIngestLog({ limit: (p.limit as number) || 20 });
  },
};

// File operations removed — Vervo uses its own source/normalize pipeline

// --- Exports ---

export const operations: Operation[] = [
  // Page CRUD
  get_page, put_page, delete_page, list_pages,
  // Search
  search, query,
  // Tags
  add_tag, remove_tag, get_tags,
  // Links
  add_link, remove_link, get_links, get_backlinks, traverse_graph,
  // Timeline
  add_timeline_entry, get_timeline,
  // Admin
  get_stats, get_health, get_versions, revert_version,
  // Raw data
  put_raw_data, get_raw_data,
  // Resolution & chunks
  resolve_slugs, get_chunks,
  // Ingest log
  log_ingest, get_ingest_log,
];

export const operationsByName = Object.fromEntries(
  operations.map(op => [op.name, op]),
) as Record<string, Operation>;
