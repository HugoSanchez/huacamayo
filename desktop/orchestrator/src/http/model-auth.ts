import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, route, type Route } from './router.ts';
import type { HermesSupervisor } from './hermes-supervisor.ts';

const execFile = promisify(execFileCb);

const PROVIDER = 'openai-codex';
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const VERIFICATION_URL_PATTERN = /https?:\/\/auth\.openai\.com\/codex\/device\S*/;
const USER_CODE_PATTERN = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;

interface CodexStatus {
  connected: boolean;
  count: number;
}

export class CodexAuthService {
  constructor(private readonly hermes: HermesSupervisor) {}

  private resolveCommand(): { command: string; cwd: string | null } {
    const command = this.hermes.launchCommand;
    if (!command) {
      throw new Error('Hermes command is not configured. Set VERSO_HERMES_COMMAND or install hermes locally.');
    }
    return { command, cwd: this.hermes.launchCwd };
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HERMES_HOME: this.hermes.hermesHome,
      // Python block-buffers stdout when stdout is a pipe rather than a
      // TTY. Without this the device-code prompt sits in the buffer until
      // the subprocess exits, so we'd never see the user_code in time to
      // render the prompt event. Forcing line-buffered output is mandatory.
      PYTHONUNBUFFERED: '1',
      // Hermes uses ANSI escape codes for color emphasis; we strip them
      // anyway, but disabling color also shortens the parsed lines.
      NO_COLOR: '1',
      CLICOLOR: '0',
    };
  }

  async getStatus(): Promise<CodexStatus> {
    const { command, cwd } = this.resolveCommand();
    try {
      const { stdout } = await execFile(command, ['auth', 'list', PROVIDER], {
        env: this.env(),
        cwd: cwd ?? undefined,
        timeout: 10_000,
      });
      const stripped = stdout.replace(ANSI_PATTERN, '');
      const match = stripped.match(/\((\d+)\s+credentials?\)/);
      const count = match ? parseInt(match[1], 10) : 0;
      return { connected: count > 0, count };
    } catch {
      return { connected: false, count: 0 };
    }
  }

  // Repeatedly remove credential #1 until the pool is empty. Cheaper than
  // parsing every label/id, and matches the only mutation the UI offers
  // ("disconnect" = forget everything).
  async disconnect(): Promise<{ removed: number }> {
    const { command, cwd } = this.resolveCommand();
    let removed = 0;
    for (let i = 0; i < 20; i++) {
      const status = await this.getStatus();
      if (status.count === 0) break;
      try {
        await execFile(command, ['auth', 'remove', PROVIDER, '1'], {
          env: this.env(),
          cwd: cwd ?? undefined,
          timeout: 10_000,
        });
        removed++;
      } catch {
        break;
      }
    }
    return { removed };
  }

  // Spawns `hermes auth add openai-codex --type oauth --no-browser` and
  // streams its lifecycle as SSE. The child prints the device URL + user
  // code, then blocks polling OpenAI. When the child exits 0, the
  // credentials are already saved to ~/.hermes/auth.json and the gateway
  // will pick them up on its next request.
  startLogin(req: IncomingMessage, res: ServerResponse): void {
    let command: string;
    let cwd: string | null;
    try {
      const resolved = this.resolveCommand();
      command = resolved.command;
      cwd = resolved.cwd;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      writeSseHeaders(res);
      sendEvent(res, { type: 'error', message });
      res.end();
      return;
    }

    writeSseHeaders(res);

    const child = spawn(
      command,
      ['auth', 'add', PROVIDER, '--type', 'oauth', '--no-browser'],
      {
        env: this.env(),
        cwd: cwd ?? undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const state = { url: null as string | null, code: null as string | null };
    let promptSent = false;
    let errorMessage: string | null = null;
    let stderrTail = '';

    function maybeEmitPrompt(): void {
      if (promptSent) return;
      if (state.url && state.code) {
        promptSent = true;
        sendEvent(res, { type: 'prompt', url: state.url, code: state.code });
      }
    }

    function parseLine(line: string): void {
      const clean = line.replace(ANSI_PATTERN, '').trim();
      if (!clean) return;
      if (!state.url) {
        const m = clean.match(VERIFICATION_URL_PATTERN);
        if (m) state.url = m[0];
      }
      if (!state.code) {
        const m = clean.match(USER_CODE_PATTERN);
        if (m) state.code = m[1];
      }
      maybeEmitPrompt();
    }

    let stdoutBuffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) parseLine(line);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Keep the last ~2KB so we can surface a meaningful error if the
      // child fails before reaching the prompt.
      stderrTail = (stderrTail + chunk).slice(-2048);
    });

    child.on('error', (err) => {
      errorMessage = err instanceof Error ? err.message : String(err);
    });

    let closed = false;
    const closeOnce = (): void => {
      if (closed) return;
      closed = true;
      res.end();
    };

    child.on('close', (code) => {
      if (stdoutBuffer.length > 0) parseLine(stdoutBuffer);
      if (code === 0) {
        sendEvent(res, { type: 'connected' });
      } else {
        const message = errorMessage
          ?? stderrTail.replace(ANSI_PATTERN, '').trim().split(/\r?\n/).pop()
          ?? `hermes auth add exited with code ${code ?? 'unknown'}`;
        sendEvent(res, { type: 'error', message });
      }
      closeOnce();
    });

    // If the UI closes the EventSource (modal dismissed, navigated away),
    // kill the subprocess so we don't leave a 15-minute poller orphaned.
    req.on('close', () => {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGTERM');
      }
      closeOnce();
    });
  }
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Push initial headers so the client opens the connection immediately
  // even if the first parseable line takes a couple of seconds.
  res.write(': open\n\n');
}

function sendEvent(res: ServerResponse, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function buildModelAuthRoutes(service: CodexAuthService): Route[] {
  return [
    route('GET', '/model-auth/codex/status', async (_req, res) => {
      const status = await service.getStatus();
      json(res, 200, status);
    }),

    route('GET', '/model-auth/codex/start', async (req, res) => {
      service.startLogin(req, res);
    }),

    route('POST', '/model-auth/codex/disconnect', async (_req, res) => {
      const result = await service.disconnect();
      json(res, 200, result);
    }),
  ];
}

