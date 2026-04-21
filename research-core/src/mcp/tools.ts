/**
 * MCP Tool Handlers
 *
 * Each tool handler takes the BrainEngine + typed params and returns
 * a structured result. These are pure logic — no MCP protocol concerns.
 */

import type { BrainEngine } from '../engine/engine.ts';
import type { SearchResult, GraphNode, Link } from '../engine/types.ts';
import { hybridSearch } from '../engine/search/hybrid.ts';

// ── context_search ──────────────────────────────────────────────────

export interface ContextSearchParams {
  context_id: string;
  query: string;
  limit?: number;
  mode?: 'fast' | 'deep';
}

export interface ContextSearchResult {
  results: {
    slug: string;
    title: string;
    type: string;
    chunk_text: string;
    score: number;
    citation: string; // "slug#chunk_index"
  }[];
}

export async function contextSearch(
  engine: BrainEngine,
  params: ContextSearchParams,
): Promise<ContextSearchResult> {
  const ctx = await engine.getContext(params.context_id);
  if (!ctx) throw new ToolError(`Context not found: ${params.context_id}`);

  const mode = params.mode ?? 'deep';
  const results = await hybridSearch(engine, params.query, {
    contextId: params.context_id,
    limit: params.limit ?? 10,
    rerank: mode === 'deep',
  });

  return {
    results: results.map((r) => ({
      slug: r.slug,
      title: r.title,
      type: r.type,
      chunk_text: r.chunk_text,
      score: r.score,
      citation: `${r.slug}#${r.chunk_index}`,
    })),
  };
}

// ── context_get ─────────────────────────────────────────────────────

export interface ContextGetParams {
  context_id: string;
  slug: string;
}

export interface ContextGetResult {
  slug: string;
  title: string;
  type: string;
  content: string;
  tags: string[];
  source_id: string | null;
}

export async function contextGet(
  engine: BrainEngine,
  params: ContextGetParams,
): Promise<ContextGetResult> {
  const ctx = await engine.getContext(params.context_id);
  if (!ctx) throw new ToolError(`Context not found: ${params.context_id}`);

  const page = await engine.getPage(params.slug);
  if (!page) throw new ToolError(`Page not found: ${params.slug}`);

  // Verify the page belongs to a source in this context
  if (page.source_id) {
    const sourceIds = await engine.getContextSourceIds(params.context_id);
    if (!sourceIds.includes(page.source_id)) {
      throw new ToolError(`Page "${params.slug}" is not in context "${params.context_id}"`);
    }
  }

  const tags = await engine.getTags(params.slug);
  return {
    slug: page.slug,
    title: page.title,
    type: page.type,
    content: page.compiled_truth,
    tags,
    source_id: page.source_id ?? null,
  };
}

// ── entity_lookup ───────────────────────────────────────────────────

export interface EntityLookupParams {
  context_id: string;
  name_or_slug: string;
}

export interface EntityLookupResult {
  found: boolean;
  page: {
    slug: string;
    title: string;
    type: string;
    content: string;
    tags: string[];
  } | null;
  evidence: {
    slug: string;
    title: string;
    chunk_text: string;
    score: number;
  }[];
}

export async function entityLookup(
  engine: BrainEngine,
  params: EntityLookupParams,
): Promise<EntityLookupResult> {
  const ctx = await engine.getContext(params.context_id);
  if (!ctx) throw new ToolError(`Context not found: ${params.context_id}`);

  // Try exact slug first
  let page = await engine.getPage(params.name_or_slug);

  // Try fuzzy resolution if exact miss
  if (!page) {
    const candidates = await engine.resolveSlugs(params.name_or_slug);
    if (candidates.length > 0) {
      page = await engine.getPage(candidates[0]);
    }
  }

  // Search for evidence mentioning this entity
  const evidence = await hybridSearch(engine, params.name_or_slug, {
    contextId: params.context_id,
    limit: 5,
  });

  if (!page) {
    return {
      found: false,
      page: null,
      evidence: evidence.map((r) => ({
        slug: r.slug,
        title: r.title,
        chunk_text: r.chunk_text,
        score: r.score,
      })),
    };
  }

  const tags = await engine.getTags(page.slug);
  return {
    found: true,
    page: {
      slug: page.slug,
      title: page.title,
      type: page.type,
      content: page.compiled_truth,
      tags,
    },
    evidence: evidence.map((r) => ({
      slug: r.slug,
      title: r.title,
      chunk_text: r.chunk_text,
      score: r.score,
    })),
  };
}

// ── graph_neighbors ─────────────────────────────────────────────────

export interface GraphNeighborsParams {
  context_id: string;
  slug: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  edge_types?: string[];
  limit?: number;
}

export interface GraphNeighborsResult {
  slug: string;
  neighbors: {
    slug: string;
    title: string;
    type: string;
    link_type: string;
    direction: 'outgoing' | 'incoming';
  }[];
}

export async function graphNeighbors(
  engine: BrainEngine,
  params: GraphNeighborsParams,
): Promise<GraphNeighborsResult> {
  const ctx = await engine.getContext(params.context_id);
  if (!ctx) throw new ToolError(`Context not found: ${params.context_id}`);

  const page = await engine.getPage(params.slug);
  if (!page) throw new ToolError(`Page not found: ${params.slug}`);

  const direction = params.direction ?? 'both';
  const limit = params.limit ?? 50;
  const neighbors: GraphNeighborsResult['neighbors'] = [];

  if (direction === 'outgoing' || direction === 'both') {
    const links = await engine.getLinks(params.slug);
    for (const link of filterEdgeTypes(links, params.edge_types)) {
      const target = await engine.getPage(link.to_slug);
      if (target) {
        neighbors.push({
          slug: target.slug,
          title: target.title,
          type: target.type,
          link_type: link.link_type,
          direction: 'outgoing',
        });
      }
    }
  }

  if (direction === 'incoming' || direction === 'both') {
    const backlinks = await engine.getBacklinks(params.slug);
    for (const link of filterEdgeTypes(backlinks, params.edge_types)) {
      const source = await engine.getPage(link.from_slug);
      if (source) {
        neighbors.push({
          slug: source.slug,
          title: source.title,
          type: source.type,
          link_type: link.link_type,
          direction: 'incoming',
        });
      }
    }
  }

  return {
    slug: params.slug,
    neighbors: neighbors.slice(0, limit),
  };
}

function filterEdgeTypes(links: Link[], types?: string[]): Link[] {
  if (!types || types.length === 0) return links;
  return links.filter((l) => types.includes(l.link_type));
}

// ── graph_traverse ──────────────────────────────────────────────────

export interface GraphTraverseParams {
  context_id: string;
  slug: string;
  depth?: number;
  edge_types?: string[];
}

export interface GraphTraverseResult {
  root: string;
  nodes: {
    slug: string;
    title: string;
    type: string;
    depth: number;
    links: { to_slug: string; link_type: string }[];
  }[];
}

export async function graphTraverse(
  engine: BrainEngine,
  params: GraphTraverseParams,
): Promise<GraphTraverseResult> {
  const ctx = await engine.getContext(params.context_id);
  if (!ctx) throw new ToolError(`Context not found: ${params.context_id}`);

  const depth = Math.min(params.depth ?? 2, 3); // cap at 3 to avoid explosion
  const nodes = await engine.traverseGraph(params.slug, depth);

  let filtered = nodes;
  if (params.edge_types && params.edge_types.length > 0) {
    const allowed = new Set(params.edge_types);
    filtered = nodes.map((n) => ({
      ...n,
      links: n.links.filter((l) => allowed.has(l.link_type)),
    }));
  }

  return {
    root: params.slug,
    nodes: filtered.map((n) => ({
      slug: n.slug,
      title: n.title,
      type: n.type,
      depth: n.depth,
      links: n.links,
    })),
  };
}

// ── entity_summary ──────────────────────────────────────────────────

export interface EntitySummaryParams {
  context_id: string;
  slug: string;
}

export interface EntitySummaryResult {
  slug: string;
  title: string;
  type: string;
  summary: string;
  tags: string[];
  neighbor_count: number;
  evidence: {
    slug: string;
    title: string;
    chunk_text: string;
    score: number;
  }[];
}

export async function entitySummary(
  engine: BrainEngine,
  params: EntitySummaryParams,
): Promise<EntitySummaryResult> {
  const ctx = await engine.getContext(params.context_id);
  if (!ctx) throw new ToolError(`Context not found: ${params.context_id}`);

  const page = await engine.getPage(params.slug);
  if (!page) throw new ToolError(`Page not found: ${params.slug}`);

  const [tags, links, backlinks, rawEvidence] = await Promise.all([
    engine.getTags(params.slug),
    engine.getLinks(params.slug),
    engine.getBacklinks(params.slug),
    hybridSearch(engine, page.title, {
      contextId: params.context_id,
      limit: 10,
    }),
  ]);

  // Filter out chunks from the entity's own page
  const evidence = rawEvidence.filter((r) => r.slug !== params.slug).slice(0, 5);

  return {
    slug: page.slug,
    title: page.title,
    type: page.type,
    summary: page.compiled_truth,
    tags,
    neighbor_count: links.length + backlinks.length,
    evidence: evidence.map((r) => ({
      slug: r.slug,
      title: r.title,
      chunk_text: r.chunk_text,
      score: r.score,
    })),
  };
}

// ── Error helper ────────────────────────────────────────────────────

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
