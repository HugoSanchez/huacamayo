import { describe, expect, it } from 'vitest';
import {
  BROWSER_NAMESPACE,
  BROWSER_RESTORE_KEY,
  BrowserLoginService,
  type BrowserCommandRuntime,
} from '../src/http/browser.ts';

class FakeRuntime implements BrowserCommandRuntime {
  ready = true;
  commands: string[][] = [];
  ensure: () => Promise<void> = async () => undefined;
  openFailures = 0;
  loginUrls: string[] = [];
  loginCloseCount = 0;

  isReady(): boolean {
    return this.ready;
  }

  ensureInstalled(): Promise<void> {
    return this.ensure();
  }

  async runCli(args: string[]): Promise<string> {
    this.commands.push(args);
    if (args.at(-2) === 'get' && args.at(-1) === 'url') {
      return JSON.stringify({ success: true, data: { url: 'https://example.com/account' }, error: null });
    }
    if (args.at(-2) === 'get' && args.at(-1) === 'title') {
      return JSON.stringify({ success: true, data: { title: 'Your account' }, error: null });
    }
    return JSON.stringify({ success: true, data: { closed: args.at(-1) === 'close' }, error: null });
  }

  async openLoginBrowser(url: string): Promise<number> {
    this.loginUrls.push(url);
    if (this.openFailures > 0) {
      this.openFailures -= 1;
      throw new Error('transient browser launch failure');
    }
    return 9333;
  }

  async closeLoginBrowser(): Promise<void> {
    this.loginCloseCount += 1;
  }
}

describe('BrowserLoginService', () => {
  it('rejects missing and non-web URLs', () => {
    const login = new BrowserLoginService(new FakeRuntime());
    expect(() => login.request('Example', '')).toThrow(/valid http/);
    expect(() => login.request('Example', 'file:///tmp/example')).toThrow(/valid http/);
  });

  it('imports a normal Chrome login into one native restore key', async () => {
    const runtime = new FakeRuntime();
    const login = new BrowserLoginService(runtime);
    const request = login.request('Example', 'https://example.com/login');

    await login.begin(request.id);
    expect(request.phase).toEqual({ kind: 'waiting_login' });
    expect(runtime.loginUrls).toEqual(['https://example.com/login']);
    expect(runtime.commands.some((args) => args.includes('--cdp') && args.includes('open'))).toBe(true);
    expect(runtime.commands.every((args) => !args.includes('--headed'))).toBe(true);
    for (const args of runtime.commands) {
      expect(args).toContain(BROWSER_NAMESPACE);
      expect(args).toContain(BROWSER_RESTORE_KEY);
      expect(args).toContain('always');
    }
    for (const args of runtime.commands.filter((args) => args.includes('open'))) {
      expect(args).toContain('9333');
    }

    const page = await login.complete(request.id);
    expect(page).toEqual({
      url: 'https://example.com/account',
      title: 'Your account',
      domain: 'example.com',
    });
    expect(runtime.commands.at(-1)?.at(-1)).toBe('close');
    expect(runtime.loginCloseCount).toBe(1);
    expect(login.get(request.id)).toBeNull();
  });

  it('allows only one headed sign-in flow at a time', () => {
    const runtime = new FakeRuntime();
    runtime.ready = false;
    runtime.ensure = () => new Promise(() => undefined);
    const login = new BrowserLoginService(runtime);
    const first = login.request('First', 'https://first.example');
    const second = login.request('Second', 'https://second.example');

    void login.begin(first.id);
    expect(() => login.begin(second.id)).toThrow(/already active/);
  });

  it('cleans up and retries one transient normal Chrome launch failure', async () => {
    const runtime = new FakeRuntime();
    runtime.openFailures = 1;
    const login = new BrowserLoginService(runtime);
    const request = login.request('Example', 'https://example.com/login');

    await login.begin(request.id);

    expect(request.phase).toEqual({ kind: 'waiting_login' });
    expect(runtime.loginUrls).toHaveLength(2);
    expect(runtime.loginCloseCount).toBe(1);
  });

  it('surfaces a permanent launch failure after one retry', async () => {
    const runtime = new FakeRuntime();
    runtime.openFailures = 2;
    const login = new BrowserLoginService(runtime);
    const request = login.request('Example', 'https://example.com/login');

    await login.begin(request.id);

    expect(request.phase).toEqual({
      kind: 'error',
      message: 'transient browser launch failure (launch retry also failed)',
    });
    expect(runtime.loginUrls).toHaveLength(2);
    expect(runtime.loginCloseCount).toBe(2);
  });

  it('disconnects agent-browser and closes the dedicated Chrome window on cancel', async () => {
    const runtime = new FakeRuntime();
    const login = new BrowserLoginService(runtime);
    const request = login.request('Example', 'https://example.com/login');

    await login.begin(request.id);
    await login.cancel(request.id);

    expect(runtime.commands.at(-1)).toContain('--cdp');
    expect(runtime.commands.at(-1)?.at(-1)).toBe('close');
    expect(runtime.loginCloseCount).toBe(1);
    expect(login.get(request.id)).toBeNull();
  });

  it('does not open a window when cancelled during installation', async () => {
    const runtime = new FakeRuntime();
    runtime.ready = false;
    let finishInstall!: () => void;
    runtime.ensure = () => new Promise<void>((resolve) => { finishInstall = resolve; });
    const login = new BrowserLoginService(runtime);
    const request = login.request('Example', 'https://example.com');

    const launch = login.begin(request.id);
    await login.cancel(request.id);
    finishInstall();
    await launch;

    expect(runtime.commands).toHaveLength(0);
    expect(runtime.loginUrls).toHaveLength(0);
    expect(login.get(request.id)).toBeNull();
  });
});
