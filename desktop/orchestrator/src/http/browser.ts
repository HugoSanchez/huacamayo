import type { BrowserHost } from './browser-host.ts';
import type { BrowserSettingsStore } from './browser-settings-store.ts';
import { json, route, type Route } from './router.ts';

interface HermesRestarter {
  restart(): Promise<unknown>;
}

/**
 * Routes for the agent browser. The browser process itself is desired-state
 * managed by the orchestrator; these routes exist for the explicit user
 * actions (open to log in, clear data, toggle private URLs) and status.
 */
export function buildBrowserRoutes(
  browserHost: BrowserHost,
  settings: BrowserSettingsStore,
  hermes: HermesRestarter,
): Route[] {
  // Hermes captures BROWSER_CDP_URL and browser.* config at spawn, so any
  // change to either must restart it. Serialized on the supervisor's own
  // coalesced restart(); fire-and-forget so the HTTP response stays snappy.
  const restartHermes = () => {
    void hermes.restart().catch((error: unknown) => {
      console.warn('[browser] Hermes restart failed:', error instanceof Error ? error.message : String(error));
    });
  };

  return [
    route('GET', '/browser/status', async (_req, res) => {
      json(res, 200, { ...browserHost.status(), settings: settings.get() });
    }),

    route('POST', '/browser/open', async (_req, res, _params, body) => {
      const url = typeof (body as Record<string, unknown> | null)?.url === 'string'
        ? String((body as Record<string, unknown>).url)
        : undefined;
      const wasEnabled = browserHost.isEnabled();
      try {
        await browserHost.openUrl(url);
      } catch (error) {
        json(res, 502, { error: 'browser_unavailable', message: error instanceof Error ? error.message : String(error) });
        return;
      }
      // First-ever open creates the profile, which turns CDP attach on;
      // Hermes must relaunch to pick up the endpoint.
      if (!wasEnabled && browserHost.isEnabled()) restartHermes();
      json(res, 200, browserHost.status());
    }),

    route('POST', '/browser/reset', async (_req, res) => {
      await browserHost.reset();
      restartHermes();
      json(res, 200, browserHost.status());
    }),

    route('POST', '/browser/settings', async (_req, res, _params, body) => {
      const record = (body ?? {}) as Record<string, unknown>;
      if (typeof record.allowPrivateUrls !== 'boolean') {
        json(res, 400, { error: 'bad_request', message: 'allowPrivateUrls must be a boolean.' });
        return;
      }
      const next = settings.setAllowPrivateUrls(record.allowPrivateUrls);
      restartHermes();
      json(res, 200, { settings: next });
    }),
  ];
}
