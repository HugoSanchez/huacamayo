/**
 * Reranker Service
 *
 * Uses node-llama-cpp's LlamaRankingContext with Qwen3-Reranker-0.6B
 * to re-score search results after RRF fusion.
 *
 * Model is lazy-loaded on first call and unloaded after idle timeout.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { SearchResult } from '../types.ts';

export const RERANKER_MODEL = 'qwen3-reranker-0.6b';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MODEL_DIR = join(homedir(), 'Library', 'Application Support', 'Vervo', 'models');
const MODEL_FILENAME = 'qwen3-reranker-0.6b-q8_0.gguf';

// Singleton state
let _llama: any = null;
let _model: any = null;
let _context: any = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _loading: Promise<void> | null = null;
let _modelPathOverride: string | null = null;

export function setRerankerModelPath(path: string | null): void {
  _modelPathOverride = path;
}

function getModelPath(): string {
  if (_modelPathOverride) return _modelPathOverride;
  const envPath = process.env.VERVO_RERANKER_MODEL;
  if (envPath) return envPath;
  return join(DEFAULT_MODEL_DIR, MODEL_FILENAME);
}

function resetIdleTimer(): void {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    disposeReranker().catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

async function ensureLoaded(): Promise<void> {
  if (_context) {
    resetIdleTimer();
    return;
  }

  if (_loading) {
    await _loading;
    return;
  }

  _loading = (async () => {
    const modelPath = getModelPath();

    if (!existsSync(modelPath)) {
      throw new Error(
        `Reranker model not found at ${modelPath}. ` +
        `Download ${MODEL_FILENAME} and place it in ${DEFAULT_MODEL_DIR}/, ` +
        `or set VERVO_RERANKER_MODEL to the full path.`
      );
    }

    const { getLlama } = await import('node-llama-cpp');
    _llama = await getLlama();
    _model = await _llama.loadModel({ modelPath });

    try {
      _context = await _model.createRankingContext({ flashAttention: true });
    } catch {
      // Retry without flash attention if not supported
      _context = await _model.createRankingContext();
    }

    resetIdleTimer();
  })();

  try {
    await _loading;
  } finally {
    _loading = null;
  }
}

export async function disposeReranker(): Promise<void> {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  if (_context) {
    await _context.dispose();
    _context = null;
  }
  if (_model) {
    await _model.dispose();
    _model = null;
  }
  _llama = null;
}

export function isRerankerAvailable(): boolean {
  return existsSync(getModelPath());
}

export function isRerankerLoaded(): boolean {
  return _context != null;
}

export interface RerankInput {
  text: string;
  /** Original result to carry through */
  result: SearchResult;
}

/**
 * Re-score search results against a query using cross-encoder reranking.
 * Returns results sorted by reranker score (highest first).
 */
export async function rerank(
  query: string,
  inputs: RerankInput[],
): Promise<{ result: SearchResult; score: number }[]> {
  if (inputs.length === 0) return [];

  await ensureLoaded();

  const documents = inputs.map(i => i.text);
  const scores: number[] = await _context.rankAll(query, documents);

  return inputs
    .map((input, i) => ({ result: input.result, score: scores[i] }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Blend RRF scores with reranker scores using position-aware weighting.
 *
 * Top-ranked RRF results (which include exact keyword matches) get more
 * RRF weight to preserve precision. Lower-ranked results trust the
 * reranker more for semantic relevance.
 *
 * Weights (from QMD's proven approach):
 *   Rank 1-3:  75% RRF + 25% reranker
 *   Rank 4-10: 60% RRF + 40% reranker
 *   Rank 11+:  40% RRF + 60% reranker
 */
export function blendScores(
  rrfResults: SearchResult[],
  rerankScores: Map<string, number>,
): SearchResult[] {
  // Normalize RRF scores to 0-1
  const maxRrf = Math.max(...rrfResults.map(r => r.score), 0);

  return rrfResults
    .map((result, rank) => {
      const key = resultKey(result);
      const rerankScore = rerankScores.get(key);
      if (rerankScore == null) return result;

      const normRrf = maxRrf > 0 ? result.score / maxRrf : 0;
      const rrfWeight = rank < 3 ? 0.75 : rank < 10 ? 0.60 : 0.40;
      const blended = rrfWeight * normRrf + (1 - rrfWeight) * rerankScore;

      return { ...result, score: blended };
    })
    .sort((a, b) => b.score - a.score);
}

/** Stable key for a search result (matches the key format used in RRF fusion) */
function resultKey(r: SearchResult): string {
  return `${r.slug}:${r.chunk_id ?? r.chunk_text.slice(0, 50)}`;
}
