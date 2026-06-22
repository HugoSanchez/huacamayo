import { json, route, type Route } from './router.ts';
import type { SourceIngestionScheduler } from './source-ingestion.ts';
import type { SlackSelectionService } from './slack-selection.ts';

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

      // Multi-stream sources (Slack) are configured per channel via the picker.
      if (current.multiStream) {
        return json(res, 400, { error: 'use_picker', message: `${current.displayName} is configured per channel.` });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildSlackIngestionRoutes(service: SlackSelectionService): Route[] {
  return [
    route('GET', '/ingestion/slack/channels', async (_req, res) => {
      try {
        json(res, 200, { channels: await service.listChannels(), dmsEnabled: service.getDmsEnabled() });
      } catch (error: unknown) {
        json(res, 502, { error: 'slack_error', message: errorMessage(error) });
      }
    }),

    route('POST', '/ingestion/slack/channels/:id/toggle', async (_req, res, params, body) => {
      // Slack conversation ids are C/G/D + uppercase alphanumerics. Reject
      // anything else so a stale/garbled id can't be enabled and then fail in
      // the scheduler.
      if (!/^[CGD][A-Z0-9]+$/.test(params.id)) {
        return json(res, 400, { error: 'invalid_channel', message: `Not a valid Slack channel id: ${params.id}` });
      }
      const enabled = Boolean((body as { enabled?: unknown } | null)?.enabled);
      const updated = service.setChannelEnabled(params.id, enabled);
      if (!updated) {
        return json(res, 404, { error: 'not_found', message: 'Slack source is not available.' });
      }
      json(res, 200, { channel: { id: params.id, enabled: updated.enabled } });
    }),

    route('POST', '/ingestion/slack/dms/toggle', async (_req, res, _params, body) => {
      const enabled = Boolean((body as { enabled?: unknown } | null)?.enabled);
      try {
        await service.setDmsEnabled(enabled);
        json(res, 200, { dmsEnabled: service.getDmsEnabled() });
      } catch (error: unknown) {
        json(res, 502, { error: 'slack_error', message: errorMessage(error) });
      }
    }),

    route('POST', '/ingestion/slack/disable-all', async (_req, res) => {
      service.disableAll();
      json(res, 200, { ok: true });
    }),
  ];
}
