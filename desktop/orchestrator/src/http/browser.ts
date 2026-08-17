import { randomUUID } from 'node:crypto';
import { json, route, type Route } from './router.ts';
import type { BrowserRuntime } from './browser-runtime.ts';

export const BROWSER_RESTORE_KEY = 'verso-browser';
export const BROWSER_NAMESPACE = 'verso';
const LOGIN_SESSION = 'verso-browser-login';

export type BrowserLoginPhase =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'launching' }
  | { kind: 'waiting_login' }
  | { kind: 'error'; message: string };

export interface BrowserLoginRequest {
  id: string;
  name: string;
  url: string;
  phase: BrowserLoginPhase;
}

export interface BrowserLoginPage {
  url: string;
  title: string | null;
  domain: string;
}

export interface BrowserCommandRuntime {
  isReady(): boolean;
  ensureInstalled(): Promise<void>;
  runCli(args: string[], timeoutMs?: number): Promise<string>;
}

/**
 * The only browser lifecycle Verso owns: a single headed window where the
 * user can establish authentication. Routine runs are entirely Hermes-native.
 * agent-browser saves cookies/local storage under BROWSER_RESTORE_KEY and
 * Hermes restores that same key into each isolated browser-tool session.
 */
export class BrowserLoginService {
  private readonly requests = new Map<string, BrowserLoginRequest>();
  private activeId: string | null = null;

  constructor(private readonly runtime: BrowserCommandRuntime) {}

  request(name: string, rawUrl: string): BrowserLoginRequest {
    const url = normalizeWebUrl(rawUrl);
    if (!url) throw new Error('A valid http(s) URL is required for browser sign-in.');
    const request: BrowserLoginRequest = {
      id: randomUUID(),
      name: name.trim() || new URL(url).hostname,
      url,
      phase: { kind: 'idle' },
    };
    this.requests.set(request.id, request);
    return request;
  }

  get(id: string): BrowserLoginRequest | null {
    return this.requests.get(id) ?? null;
  }

  begin(id: string): Promise<void> {
    const request = this.require(id);
    if (this.activeId && this.activeId !== id) {
      throw new Error('Another browser sign-in window is already active. Finish or cancel it first.');
    }
    if (request.phase.kind === 'installing' || request.phase.kind === 'launching' || request.phase.kind === 'waiting_login') {
      return Promise.resolve();
    }

    this.activeId = id;
    request.phase = this.runtime.isReady() ? { kind: 'launching' } : { kind: 'installing' };
    return this.launch(request);
  }

  async page(id: string): Promise<BrowserLoginPage | null> {
    const request = this.require(id);
    if (request.phase.kind !== 'waiting_login') return null;
    const urlResult = parseCliResult(await this.runtime.runCli(this.args(['get', 'url'])));
    const titleResult = parseCliResult(await this.runtime.runCli(this.args(['get', 'title'])));
    const url = typeof urlResult.url === 'string' ? normalizeWebUrl(urlResult.url) : null;
    if (!url) return null;
    return {
      url,
      title: typeof titleResult.title === 'string' && titleResult.title.trim() ? titleResult.title.trim() : null,
      domain: new URL(url).hostname,
    };
  }

  async complete(id: string): Promise<BrowserLoginPage> {
    const request = this.require(id);
    if (request.phase.kind !== 'waiting_login') {
      throw new Error('No browser sign-in window is ready for this request.');
    }
    const page = await this.page(id);
    if (!page) throw new Error('Could not read the open website. Leave the sign-in window open and try again.');
    await this.runtime.runCli(this.args(['close']));
    this.activeId = null;
    this.requests.delete(id);
    return page;
  }

  async cancel(id: string): Promise<void> {
    const request = this.requests.get(id);
    if (!request) return;
    this.requests.delete(id);
    if (this.activeId !== id) return;
    this.activeId = null;
    if (request.phase.kind === 'launching' || request.phase.kind === 'waiting_login') {
      await this.runtime.runCli(this.args(['close'])).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.activeId) return;
    await this.cancel(this.activeId);
  }

  private require(id: string): BrowserLoginRequest {
    const request = this.requests.get(id);
    if (!request) throw new Error('Unknown browser sign-in request.');
    return request;
  }

  private async launch(request: BrowserLoginRequest): Promise<void> {
    try {
      await this.runtime.ensureInstalled();
      if (this.requests.get(request.id) !== request) return;
      request.phase = { kind: 'launching' };
      // Close a stale setup daemon left by an app crash. This is deliberately
      // only the dedicated login session; Hermes' routine sessions are never
      // touched here.
      await this.runtime.runCli(this.args(['close'])).catch(() => undefined);
      if (this.requests.get(request.id) !== request) return;
      await this.runtime.runCli(this.args(['--headed', 'open', request.url]), 60_000);
      if (this.requests.get(request.id) !== request) {
        await this.runtime.runCli(this.args(['close'])).catch(() => undefined);
        return;
      }
      request.phase = { kind: 'waiting_login' };
    } catch (error) {
      if (this.requests.get(request.id) !== request) return;
      request.phase = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
      this.activeId = null;
    }
  }

  private args(command: string[]): string[] {
    return [
      '--namespace', BROWSER_NAMESPACE,
      '--session', LOGIN_SESSION,
      '--restore', BROWSER_RESTORE_KEY,
      '--restore-save', 'always',
      '--json',
      ...command,
    ];
  }
}

export function buildBrowserRoutes(runtime: BrowserRuntime): { routes: Route[]; login: BrowserLoginService } {
  const login = new BrowserLoginService(runtime);
  const routes = [
    route('POST', '/browser/login/request', async (_req, res, _params, body) => {
      const payload = (body ?? {}) as { name?: unknown; url?: unknown };
      try {
        const request = login.request(
          typeof payload.name === 'string' ? payload.name : '',
          typeof payload.url === 'string' ? payload.url : '',
        );
        json(res, 201, { ok: true, setup: view(request) });
      } catch (error) {
        json(res, 400, { ok: false, error: 'invalid_url', message: error instanceof Error ? error.message : String(error) });
      }
    }),

    route('POST', '/browser/login/:id/start', async (_req, res, params) => {
      const request = login.get(params.id);
      if (!request) return json(res, 404, { ok: false, error: 'unknown_setup' });
      try {
        void login.begin(params.id);
        json(res, 200, { ok: true, phase: request.phase });
      } catch (error) {
        json(res, 409, { ok: false, error: 'browser_busy', message: error instanceof Error ? error.message : String(error) });
      }
    }),

    route('GET', '/browser/login/:id/state', async (_req, res, params) => {
      const request = login.get(params.id);
      if (!request) return json(res, 404, { ok: false, error: 'unknown_setup' });
      let page: BrowserLoginPage | null = null;
      if (request.phase.kind === 'waiting_login') {
        page = await login.page(params.id).catch(() => null);
      }
      json(res, 200, {
        ok: true,
        phase: request.phase,
        currentUrl: page?.url ?? null,
        currentTitle: page?.title ?? null,
        setup: view(request),
      });
    }),

    route('POST', '/browser/login/:id/complete', async (_req, res, params) => {
      if (!login.get(params.id)) return json(res, 404, { ok: false, error: 'unknown_setup' });
      try {
        const page = await login.complete(params.id);
        json(res, 200, { ok: true, site: page });
      } catch (error) {
        json(res, 409, { ok: false, error: 'not_ready', message: error instanceof Error ? error.message : String(error) });
      }
    }),

    route('POST', '/browser/login/:id/cancel', async (_req, res, params) => {
      await login.cancel(params.id);
      json(res, 200, { ok: true });
    }),
  ];
  return { routes, login };
}

function normalizeWebUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseCliResult(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as { success?: unknown; data?: unknown; error?: unknown };
  if (parsed.success !== true || !parsed.data || typeof parsed.data !== 'object') {
    throw new Error(typeof parsed.error === 'string' ? parsed.error : 'Browser command failed');
  }
  return parsed.data as Record<string, unknown>;
}

function view(request: BrowserLoginRequest) {
  return { id: request.id, name: request.name, url: request.url };
}
