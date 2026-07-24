import { LocalEmbedder } from '../http/embedder.ts';
import { GdriveSource } from '../http/gdrive-source.ts';
import { GmailSource } from '../http/gmail-source.ts';
import { GranolaSource } from '../http/granola-source.ts';
import { IngestionStore } from '../http/ingestion-store.ts';
import { SlackSource } from '../http/slack-source.ts';
import { ComposioSlackConversationDirectory } from '../http/slack-conversations.ts';
import { ComposioSlackUserDirectory } from '../http/slack-users.ts';
import { SourceIngestionScheduler } from '../http/source-ingestion.ts';
import { ComposioRouterBridge } from './composio-router-bridge.ts';
import { PgMemoryProvider } from './pg-memory-provider.ts';
import { createMemorydServer } from './server.ts';

/**
 * memoryd — headless cloud twin of local Verso memory + ingestion.
 *
 * Reuses the orchestrator's scheduler, source adapters, and embedder verbatim;
 * swaps the seams: memory writes go to the instance Postgres (the tables the
 * sandbox `memory` CLI reads), tool fetches go through the Composio SDK
 * tool-router session (the verso-backend execution path), and the ingestion
 * ledger stays SQLite on a volume (VERSO_INGESTION_STORE_PATH).
 *
 * Required env:
 *   MEMORYD_DATABASE_URL   Postgres DSN for the instance ai_v2 database
 *   COMPOSIO_API_KEY       Composio project key (server-side custody)
 *   COMPOSIO_USER_ID       Composio user/entity id whose connections to use
 * Optional env:
 *   MEMORYD_SOURCES            csv of sources to enable (default all four)
 *   MEMORYD_SOURCE_INTERVAL_MS per-source recheck cadence (default 15 min)
 *   MEMORYD_BACKFILL_ROWS      embed rows per backfill tick (default 16)
 *   MEMORYD_PORT               HTTP port for /embed, /healthz, /status (8787)
 *   MEMORYD_MODEL              embedder model (default Xenova/multilingual-e5-small)
 *   MEMORYD_MODEL_CACHE_DIR    transformers.js model cache (default ./models-cache)
 *   VERSO_INGESTION_STORE_PATH SQLite ledger path (read by IngestionStore)
 *   VERSO_GRANOLA_CONTENT      summary | transcript | both (read by GranolaSource)
 */

const ALL_SOURCES = ['gmail', 'granola', 'slack', 'gdrive'] as const;
const BACKFILL_INTERVAL_MS = 20_000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[memoryd] missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

const dsn = requireEnv('MEMORYD_DATABASE_URL');
const composioApiKey = requireEnv('COMPOSIO_API_KEY');
const composioUserId = requireEnv('COMPOSIO_USER_ID');

const enabledSources = new Set(
  (process.env.MEMORYD_SOURCES?.trim() || ALL_SOURCES.join(','))
    .split(',')
    .map((source) => source.trim())
    .filter((source) => (ALL_SOURCES as readonly string[]).includes(source)),
);
const sourceIntervalMs = Number(process.env.MEMORYD_SOURCE_INTERVAL_MS) || 15 * 60 * 1000;
const backfillRows = Number(process.env.MEMORYD_BACKFILL_ROWS) || 16;
const port = Number(process.env.MEMORYD_PORT) || 8787;

const embedder = new LocalEmbedder({
  enabled: true,
  modelId: process.env.MEMORYD_MODEL?.trim() || 'Xenova/multilingual-e5-small',
  cacheDir: process.env.MEMORYD_MODEL_CACHE_DIR?.trim() || './models-cache',
});
const provider = new PgMemoryProvider(dsn, { embedder });
const bridge = new ComposioRouterBridge({ apiKey: composioApiKey, userId: composioUserId });
const store = new IngestionStore();

const scheduler = new SourceIngestionScheduler(
  store,
  provider,
  [
    new GmailSource(bridge),
    new GranolaSource(bridge),
    new SlackSource(bridge, {
      userDirectory: new ComposioSlackUserDirectory(bridge),
      conversationDirectory: new ComposioSlackConversationDirectory(bridge),
    }),
    new GdriveSource(bridge),
  ],
  {
    extractionGate: () => true,
    // A source is "connected" iff it's in the enabled set — connection truth
    // lives at Composio; a broken connection surfaces as a fetch failure and
    // exponential backoff, which is the behavior we want headless.
    connectionGate: (source) => enabledSources.has(source),
    enabled: () => true,
    sourceIntervalMs,
  },
);

await provider.start();
if (!provider.isReady()) {
  console.error('[memoryd] Postgres is unavailable at startup; exiting for the restart policy to retry.');
  process.exit(1);
}

// Ledger ↔ corpus reconciliation: if ai_v2 was wiped/recreated, the instance
// token changes and the ledger rebuilds (clears processed refs, re-seeds
// cursors) so the corpus re-fetches. Same contract as local.
scheduler.reconcileWithMemoryToken(provider.instanceToken());

for (const source of enabledSources) {
  if (!scheduler.getSourceView(source)?.enabled) {
    scheduler.setSourceEnabled(source, true);
    console.log(`[memoryd] enabled source ${source} (cursor seeded at lookback floor)`);
  }
}

void embedder.start();
scheduler.start();

const backfillTimer = setInterval(() => {
  void provider.runEmbeddingBackfill(backfillRows).then((n) => {
    if (n > 0) console.log(`[memoryd] embedded ${n} row(s)`);
  }).catch((error: unknown) => {
    console.warn(`[memoryd] embedding backfill failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}, BACKFILL_INTERVAL_MS);
backfillTimer.unref();

const server = createMemorydServer({ embedder, provider, scheduler });
server.listen(port, () => {
  console.log(`[memoryd] listening on :${port} — sources [${[...enabledSources].join(', ')}] every ${Math.round(sourceIntervalMs / 60_000)}m, ledger at ${store.path}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[memoryd] ${signal} received; shutting down`);
  clearInterval(backfillTimer);
  scheduler.stop();
  server.close();
  await provider.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
