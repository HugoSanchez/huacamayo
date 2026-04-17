/**
 * Local Embedding Service
 *
 * Uses node-llama-cpp to run bge-m3 locally via GGUF.
 * Metal acceleration on Apple Silicon, CPU fallback elsewhere.
 *
 * Model is lazy-loaded on first call and unloaded after IDLE_TIMEOUT_MS.
 * All callers share a single model + context instance.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

export const EMBEDDING_MODEL = 'bge-m3';
export const EMBEDDING_DIMENSIONS = 1024;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Default model path: ~/Library/Application Support/Vervo/models/
const DEFAULT_MODEL_DIR = join(homedir(), 'Library', 'Application Support', 'Vervo', 'models');
const MODEL_FILENAME = 'bge-m3-f16.gguf';

// Singleton state
let _llama: any = null;
let _model: any = null;
let _context: any = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _loading: Promise<void> | null = null;

/**
 * Override the model path for testing or custom setups.
 * Set to null to reset to default.
 */
let _modelPathOverride: string | null = null;

export function setModelPath(path: string | null): void {
  _modelPathOverride = path;
}

function getModelPath(): string {
  if (_modelPathOverride) return _modelPathOverride;
  const envPath = process.env.VERVO_EMBEDDING_MODEL;
  if (envPath) return envPath;
  return join(DEFAULT_MODEL_DIR, MODEL_FILENAME);
}

function resetIdleTimer(): void {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    dispose().catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

async function ensureLoaded(): Promise<void> {
  if (_context) {
    resetIdleTimer();
    return;
  }

  // Prevent concurrent loads
  if (_loading) {
    await _loading;
    return;
  }

  _loading = (async () => {
    const modelPath = getModelPath();

    if (!existsSync(modelPath)) {
      throw new Error(
        `Embedding model not found at ${modelPath}. ` +
        `Download ${MODEL_FILENAME} and place it in ${DEFAULT_MODEL_DIR}/, ` +
        `or set VERVO_EMBEDDING_MODEL to the full path.`
      );
    }

    const { getLlama } = await import('node-llama-cpp');
    _llama = await getLlama();
    _model = await _llama.loadModel({ modelPath });
    _context = await _model.createEmbeddingContext();
    resetIdleTimer();
  })();

  try {
    await _loading;
  } finally {
    _loading = null;
  }
}

/**
 * Dispose model and context, freeing memory.
 * Safe to call even if not loaded.
 */
export async function dispose(): Promise<void> {
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

/**
 * Check if the embedding model file exists and is ready to load.
 */
export function isAvailable(): boolean {
  return existsSync(getModelPath());
}

/**
 * Check if the model is currently loaded in memory.
 */
export function isLoaded(): boolean {
  return _context != null;
}

/**
 * Embed a single text string.
 */
export async function embed(text: string): Promise<Float32Array> {
  const [result] = await embedBatch([text]);
  return result;
}

/**
 * Embed multiple texts. Calls run concurrently through the shared context
 * (node-llama-cpp handles internal batching).
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  await ensureLoaded();

  const results = await Promise.all(
    texts.map(async (text) => {
      const embedding = await _context.getEmbeddingFor(text);
      return new Float32Array(embedding.vector);
    })
  );

  return results;
}
