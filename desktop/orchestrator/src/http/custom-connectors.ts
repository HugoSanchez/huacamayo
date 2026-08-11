import { spawn } from 'node:child_process';
import { createReadStream, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { json, route, type Route } from './router.ts';
import { CustomConnectorsStore, sanitizeCustomConnectorSlug, type CustomConnectorRecord } from './custom-connectors-store.ts';
import { CustomConnectorKeychain } from './keychain.ts';
import { probeMcpServer } from './mcp-probe.ts';
import { countCustomConnectorTools, fetchRegisteredToolNames } from './hermes-toolsets.ts';
import type { HermesSupervisor } from './hermes-supervisor.ts';

export type CustomConnectorStatus =
  | { state: 'connected'; toolCount: number }
  | { state: 'pending_auth'; toolCount: 0 }
  | { state: 'failed'; toolCount: 0; reason: string };

export interface CustomConnectorView extends CustomConnectorRecord {
  status: CustomConnectorStatus;
}

export function buildCustomConnectorRoutes(
  store: CustomConnectorsStore,
  keychain: CustomConnectorKeychain,
  hermes: HermesSupervisor,
): Route[] {
  const service = new CustomConnectorService(store, keychain, hermes);
  return [
    route('GET', '/connectors/custom', async (_req, res) => {
      json(res, 200, { connectors: await service.list() });
    }),
    route('GET', '/connectors/custom/:id/icon', async (_req, res, params) => {
      await service.streamIcon(params.id, res);
    }),
    route('GET', '/connectors/custom/:id/open', async (_req, res, params) => {
      await service.openAuth(params.id, res);
    }),
    route('POST', '/connectors/custom', async (_req, res, _params, body) => {
      try {
        json(res, 201, { connector: await service.add(body) });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),
    route('DELETE', '/connectors/custom/:id', async (_req, res, params) => {
      await service.remove(params.id);
      res.writeHead(204);
      res.end();
    }),
    route('POST', '/connectors/custom/:id/retry', async (_req, res, params) => {
      try {
        json(res, 200, { connector: await service.retry(params.id) });
      } catch (error: unknown) {
        handleError(res, error);
      }
    }),
  ];
}

export class CustomConnectorService {
  constructor(
    private readonly store: CustomConnectorsStore,
    private readonly keychain: CustomConnectorKeychain,
    private readonly hermes: HermesSupervisor,
    private readonly opts: { registrationDelayMs?: number; registrationAttempts?: number } = {},
  ) {}

  async list(): Promise<CustomConnectorView[]> {
    const registered = await fetchRegisteredToolNames(this.hermes.gatewayConfig);
    return this.store.list().map((record) => viewFor(record, registered));
  }

  async add(body: unknown): Promise<CustomConnectorView> {
    const parsed = parseCreateBody(body);
    const slug = sanitizeCustomConnectorSlug(parsed.name);
    if (!slug) throw new HttpInputError('Connector name must include letters or numbers.');
    const probe = await probeMcpServer(parsed.url, { token: parsed.token });
    const auth = parsed.token ? 'bearer' : probe.auth;
    const record = this.store.create({
      name: parsed.name,
      slug,
      url: parsed.url,
      transport: probe.transport,
      auth,
      logoUrl: null,
      iconPath: probe.iconPath,
      iconContentType: probe.iconContentType,
    });
    const displayRecord = this.store.update(record.id, {
      logoUrl: probe.iconPath ? `/connectors/custom/${encodeURIComponent(record.id)}/icon` : probe.logoUrl,
    });
    try {
      if (auth === 'bearer') await this.keychain.setSecret(record.id, parsed.token ?? '');
      await this.hermes.restart();
      await this.hermes.waitUntilReady(90_000);
      return viewFor(displayRecord, await this.waitForConnectorTools(displayRecord));
    } catch (error) {
      this.store.delete(record.id);
      await this.keychain.deleteSecret(record.id);
      throw error;
    }
  }

  async retry(id: string): Promise<CustomConnectorView> {
    const current = this.store.get(id);
    if (!current) throw new HttpInputError(`Unknown custom connector: ${id}`, 404);
    const token = current.auth === 'bearer' ? await this.keychain.getSecret(current.id) : null;
    const probe = await probeMcpServer(current.url, { token });
    const updated = this.store.update(id, {
      transport: probe.transport,
      auth: current.auth === 'bearer' ? 'bearer' : probe.auth,
      logoUrl: probe.iconPath ? `/connectors/custom/${encodeURIComponent(current.id)}/icon` : probe.logoUrl ?? current.logoUrl,
      iconPath: probe.iconPath ?? current.iconPath ?? null,
      iconContentType: probe.iconContentType ?? current.iconContentType ?? null,
    });
    await this.hermes.restart();
    await this.hermes.waitUntilReady(90_000);
    return viewFor(updated, await this.waitForConnectorTools(updated));
  }

  getAuthRedirectUrl(id: string): string | null {
    const record = this.store.get(id);
    if (!record || record.auth !== 'oauth') return null;
    return record.url;
  }

  async openAuth(id: string, res: ServerResponse): Promise<void> {
    const record = this.store.get(id);
    if (!record || record.auth !== 'oauth') {
      json(res, 404, { error: 'not_found', message: 'This custom connector is not waiting for sign-in.' });
      return;
    }

    const result = await this.startHermesMcpLogin(record);
    if (result.kind === 'redirect') {
      res.writeHead(302, { Location: result.url });
      res.end();
      return;
    }
    sendHtml(res, 500, 'Sign-in unavailable', result.message);
  }

  async remove(id: string): Promise<void> {
    const removed = this.store.delete(id);
    if (!removed) return;
    await this.keychain.deleteSecret(removed.id);
    removeHermesOAuthFiles(this.hermes.hermesHome, `custom_${removed.slug}`);
    await this.hermes.restart();
  }

  async streamIcon(id: string, res: ServerResponse): Promise<void> {
    const record = this.store.get(id);
    if (!record?.iconPath || !existsSync(record.iconPath)) {
      json(res, 404, { error: 'not_found', message: 'No icon for custom connector.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': record.iconContentType || contentTypeForPath(record.iconPath),
      'Cache-Control': 'public, max-age=86400',
    });
    createReadStream(record.iconPath).pipe(res);
  }

  private async waitForConnectorTools(record: CustomConnectorRecord): Promise<string[] | null> {
    return waitForCustomConnectorTools(record, () => fetchRegisteredToolNames(this.hermes.gatewayConfig), {
      attempts: this.opts.registrationAttempts ?? 4,
      delayMs: this.opts.registrationDelayMs ?? 4_000,
    });
  }

  private async startHermesMcpLogin(record: CustomConnectorRecord): Promise<
    | { kind: 'redirect'; url: string }
    | { kind: 'error'; message: string }
  > {
    const invocation = this.hermes.invoke(['mcp', 'login', `custom_${record.slug}`]);
    if (!invocation) {
      return { kind: 'error', message: 'Hermes command is not configured. Install Hermes or set VERSO_HERMES_COMMAND.' };
    }

    return new Promise((resolve) => {
      let settled = false;
      let stderrTail = '';
      let outputBuffer = '';
      let timeout: NodeJS.Timeout;
      const child = spawn(invocation.command, invocation.args, {
        cwd: this.hermes.launchCwd ?? undefined,
        env: {
          ...process.env,
          ...invocation.env,
          HERMES_HOME: this.hermes.hermesHome,
          PYTHONUNBUFFERED: '1',
          NO_COLOR: '1',
          CLICOLOR: '0',
          // We handle the browser open by redirecting this route. Marking the
          // subprocess as "remote" makes Hermes print the authorization URL
          // instead of trying to open a second browser tab itself.
          SSH_CLIENT: process.env.SSH_CLIENT || '127.0.0.1 0 0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const finish = (result: { kind: 'redirect'; url: string } | { kind: 'error'; message: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      const consume = (chunk: string) => {
        outputBuffer = (outputBuffer + chunk).slice(-4096);
        const url = extractExternalUrl(outputBuffer);
        if (url) finish({ kind: 'redirect', url });
      };

      timeout = setTimeout(() => {
        child.kill('SIGTERM');
        finish({
          kind: 'error',
          message: [
            'Timed out waiting for Hermes to produce an MCP authorization URL.',
            outputBuffer.trim() ? `Recent output: ${stripAnsi(outputBuffer).trim()}` : null,
          ].filter(Boolean).join(' '),
        });
      }, 90_000);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', consume);
      child.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2048);
        consume(chunk);
      });
      child.on('error', (error) => finish({ kind: 'error', message: error.message }));
      child.on('close', (code) => {
        if (code === 0) {
          void this.hermes.restart().catch(() => {});
          finish({
            kind: 'error',
            message: 'Hermes finished MCP sign-in without returning an authorization URL.',
          });
          return;
        }
        const message = stripAnsi(stderrTail).trim() || `hermes mcp login exited with code ${code ?? 'unknown'}.`;
        finish({ kind: 'error', message });
      });
    });
  }
}

export async function waitForCustomConnectorTools(
  record: Pick<CustomConnectorRecord, 'slug' | 'auth'>,
  fetcher: () => Promise<string[] | null>,
  opts: { attempts: number; delayMs: number; delayFn?: (ms: number) => Promise<void> },
): Promise<string[] | null> {
  let last: string[] | null = null;
  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    if (attempt > 0) await (opts.delayFn ?? delay)(opts.delayMs);
    last = await fetcher();
    if (last === null) return null;
    if (countCustomConnectorTools(last, record.slug) > 0) return last;
    if (record.auth === 'oauth') return last;
  }
  return last;
}

export function removeHermesOAuthFiles(hermesHome: string, serverName: string): void {
  const safe = serverName.replace(/[^\w-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 128) || 'default';
  for (const suffix of ['.json', '.client.json', '.meta.json']) {
    rmSync(path.join(hermesHome, 'mcp-tokens', `${safe}${suffix}`), { force: true });
  }
}

function viewFor(record: CustomConnectorRecord, registered: string[] | null): CustomConnectorView {
  const toolCount = registered ? countCustomConnectorTools(registered, record.slug) : 0;
  if (toolCount > 0) return { ...record, status: { state: 'connected', toolCount } };
  if (record.auth === 'oauth') return { ...record, status: { state: 'pending_auth', toolCount: 0 } };
  return {
    ...record,
    status: {
      state: 'failed',
      toolCount: 0,
      reason: registered === null ? 'Gateway status unavailable.' : 'No tools registered.',
    },
  };
}

function parseCreateBody(body: unknown): { name: string; url: string; token: string | null } {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const token = typeof input.token === 'string' && input.token.length > 0 ? input.token : null;
  if (!name) throw new HttpInputError('Missing "name".');
  if (!url) throw new HttpInputError('Missing "url".');
  return { name, url, token };
}

class HttpInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function handleError(res: Parameters<typeof json>[0], error: unknown): void {
  if (error instanceof HttpInputError) {
    json(res, error.status, { error: 'bad_request', message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { error: 'internal_error', message });
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/x-icon';
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

export function extractExternalUrl(text: string): string | null {
  const urls = stripAnsi(text).match(URL_PATTERN) ?? [];
  return urls.find((url) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost';
    } catch {
      return false;
    }
  }) ?? null;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function sendHtml(res: ServerResponse, status: number, title: string, message: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 32px;">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </body>
</html>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] ?? char));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
