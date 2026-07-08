import { json, route, type Route } from './router.ts';
import type { SourceIngestionScheduler } from './source-ingestion.ts';

/**
 * Settings → Ingestion routes. These manage per-source state and work
 * regardless of the global VERSO_INGESTION_ENABLED flag (which only gates
 * whether the background loop runs) — so the UI can list and toggle sources
 * even while the feature is globally gated.
 */
export function buildIngestionRoutes(scheduler: SourceIngestionScheduler): Route[] {
  return [
    route('GET', '/ingestion/sources', async (_req, res) => {
      json(res, 200, { sources: scheduler.listSources() });
    }),

    route('POST', '/ingestion/sources/:slug/toggle', async (_req, res, params, body) => {
      const current = scheduler.getSourceView(params.slug);
      if (!current) {
        return json(res, 404, { error: 'not_found', message: `Unknown ingestion source: ${params.slug}` });
      }

      const requested = (body as { enabled?: unknown } | null)?.enabled;
      const next = typeof requested === 'boolean' ? requested : !current.enabled;

      // Don't let a user enable a source whose connection is inactive — the
      // first fetch would just fail. (Disabling is always allowed.)
      if (next && !current.connected) {
        return json(res, 409, { error: 'not_connected', message: `${current.displayName} is not connected.` });
      }

      scheduler.setSourceEnabled(params.slug, next);
      json(res, 200, { source: scheduler.getSourceView(params.slug) });
    }),
  ];
}
