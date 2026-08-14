import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserConnectionsStore } from '../src/http/browser-connections-store.ts';
import { BrowserSessionBusyError, BrowserSessionManager } from '../src/http/browser-sessions.ts';

// A stand-in Chromium: a node script that parses --remote-debugging-port,
// serves the two CDP HTTP endpoints the manager uses, and exits on SIGTERM.
const FAKE_CHROMIUM_SERVER = `
const http = require('node:http');
const portArg = process.argv.find((a) => a.startsWith('--remote-debugging-port='));
const port = Number(portArg.split('=')[1]);
const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.end(JSON.stringify({ Browser: 'FakeChromium/1.0' }));
  } else if (req.url === '/json/list') {
    res.end(JSON.stringify([
      { type: 'page', url: 'https://app.example.com/receipts', title: 'Receipts' },
    ]));
  } else {
    res.statusCode = 404;
    res.end();
  }
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

const TEST_PORT = 9377;

describe('browser session manager', () => {
  let tempRoot = '';
  let store: BrowserConnectionsStore;
  let manager: BrowserSessionManager;
  let cdpChanges: Array<string | null> = [];
  let guardFile = '';

  const makeManager = (opts: { runTtlMs?: number; chromium?: string | null } = {}) => {
    const fakeChromium = path.join(tempRoot, 'fake-chromium');
    if (!existsSync(fakeChromium)) {
      const serverScript = path.join(tempRoot, 'fake-chromium-server.cjs');
      writeFileSync(serverScript, FAKE_CHROMIUM_SERVER, 'utf8');
      writeFileSync(fakeChromium, `#!/bin/bash\nexec "${process.execPath}" "${serverScript}" "$@"\n`, 'utf8');
      chmodSync(fakeChromium, 0o755);
    }
    return new BrowserSessionManager(store, {
      resolveChromium: () => (opts.chromium === undefined ? fakeChromium : opts.chromium),
      onCdpChange: (url) => cdpChanges.push(url),
      guardFilePath: guardFile,
      port: TEST_PORT,
      runTtlMs: opts.runTtlMs,
    });
  };

  const makeConnection = () => {
    const connection = store.create('Example', path.join(tempRoot, 'profiles'));
    store.complete(connection.id, {
      domain: 'app.example.com',
      startUrl: 'https://app.example.com/receipts',
      title: 'Receipts',
    });
    return store.get(connection.id)!;
  };

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-browser-sessions-'));
    store = new BrowserConnectionsStore(path.join(tempRoot, 'store.sqlite'));
    guardFile = path.join(tempRoot, 'hermes-home', 'verso-browser-guard.json');
    cdpChanges = [];
    manager = makeManager();
  });

  afterEach(async () => {
    await manager.shutdown();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('runs the full run-lease lifecycle: guard file, cdp override, teardown', async () => {
    const connection = makeConnection();
    const lease = await manager.start(connection, 'run');

    expect(lease.connectionId).toBe(connection.id);
    expect(cdpChanges).toEqual([`http://127.0.0.1:${TEST_PORT}`]);
    const guard = JSON.parse(readFileSync(guardFile, 'utf8'));
    expect(guard.domains).toEqual(['app.example.com']);
    expect(guard.start_url).toBe('https://app.example.com/receipts');

    const page = await manager.currentPage();
    expect(page?.url).toBe('https://app.example.com/receipts');

    await manager.end(lease.leaseId, 'done', 'all good');
    expect(cdpChanges).toEqual([`http://127.0.0.1:${TEST_PORT}`, null]);
    expect(existsSync(guardFile)).toBe(false);
    expect(store.lastLease(connection.id)).toMatchObject({ outcome: 'done', summary: 'all good' });
  });

  it('setup leases do not touch the guard file or cdp override', async () => {
    const connection = makeConnection();
    const lease = await manager.start(connection, 'setup');
    expect(cdpChanges).toEqual([]);
    expect(existsSync(guardFile)).toBe(false);
    await manager.end(lease.leaseId, 'done', null);
    expect(cdpChanges).toEqual([]);
  });

  it('rejects a second concurrent lease and mismatched stops', async () => {
    const connection = makeConnection();
    const lease = await manager.start(connection, 'run');
    await expect(manager.start(connection, 'run')).rejects.toBeInstanceOf(BrowserSessionBusyError);
    await expect(manager.end('bogus-lease', 'done', null)).rejects.toThrow(/lease/i);
    await manager.end(lease.leaseId, 'done', null);
  });

  it('kills the browser and logs "expired" when a run lease hits its cap', async () => {
    manager = makeManager({ runTtlMs: 500 });
    const connection = makeConnection();
    await manager.start(connection, 'run');

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const poll = setInterval(() => {
        if (manager.activeLease() === null) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error('lease never expired'));
        }
      }, 100);
    });

    expect(store.lastLease(connection.id)?.outcome).toBe('expired');
    expect(existsSync(guardFile)).toBe(false);
    expect(cdpChanges.at(-1)).toBeNull();
  });

  it('refuses to launch when the port serves a DevTools endpoint we do not own', async () => {
    const connection = makeConnection();
    const lease = await manager.start(connection, 'run');
    const second = makeManager();
    await expect(second.start(makeConnection(), 'run')).rejects.toThrow(/refusing to launch/);
    await manager.end(lease.leaseId, 'done', null);
  });

  it('clearStaleState removes leftovers from a crashed predecessor', () => {
    mkdirSync(path.dirname(guardFile), { recursive: true });
    writeFileSync(guardFile, '{"domains":["x.com"]}', 'utf8');
    manager.clearStaleState();
    expect(existsSync(guardFile)).toBe(false);
    expect(cdpChanges).toEqual([null]);
  });

  it('errors clearly when chromium is not installed', async () => {
    manager = makeManager({ chromium: null });
    await expect(manager.start(makeConnection(), 'run')).rejects.toThrow(/not installed/);
  });
});

describe('browser connections store', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-browser-store-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates pending connections and completes them with a capture', () => {
    const store = new BrowserConnectionsStore(path.join(tempRoot, 'store.sqlite'));
    const created = store.create('Website', path.join(tempRoot, 'profiles'));
    expect(created.status).toBe('pending');
    expect(created.profileDir).toBe(path.join(tempRoot, 'profiles', created.id));

    store.complete(created.id, { domain: 'holded.com', startUrl: 'https://holded.com/x', title: 'Holded', name: 'Holded' });
    const loaded = store.get(created.id)!;
    expect(loaded.status).toBe('connected');
    expect(loaded.domain).toBe('holded.com');
    expect(loaded.name).toBe('Holded');

    store.setStatus(created.id, 'needs_login');
    expect(store.get(created.id)!.status).toBe('needs_login');

    store.delete(created.id);
    expect(store.get(created.id)).toBeNull();
  });

  it('keeps a lease log per connection', () => {
    const store = new BrowserConnectionsStore(path.join(tempRoot, 'store.sqlite'));
    const connection = store.create('W', tempRoot);
    store.logLeaseStart('lease-1', connection.id, 'run');
    store.logLeaseEnd('lease-1', 'needs_login', 'login page hit');
    expect(store.lastLease(connection.id)).toMatchObject({
      leaseId: 'lease-1',
      mode: 'run',
      outcome: 'needs_login',
      summary: 'login page hit',
    });
  });
});

describe('registrable domain capture', () => {
  it('maps hosts to their registrable domain so sign-in subdomain hops stay allowed', async () => {
    const { registrableDomain } = await import('../src/http/browser.ts');
    expect(registrableDomain('app.example.com')).toBe('example.com');
    expect(registrableDomain('docs.google.com')).toBe('google.com');
    expect(registrableDomain('login.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('localhost')).toBe('localhost');
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('paused-jobs bookkeeping', () => {
  it('tracks and clears the jobs paused by the needs_login fan-out', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-paused-jobs-'));
    try {
      const store = new BrowserConnectionsStore(path.join(tempRoot, 'store.sqlite'));
      const connection = store.create('W', tempRoot);
      expect(store.pausedJobs(connection.id)).toEqual([]);
      store.setPausedJobs(connection.id, ['job-a', 'job-b']);
      expect(store.pausedJobs(connection.id)).toEqual(['job-a', 'job-b']);
      store.setPausedJobs(connection.id, []);
      expect(store.pausedJobs(connection.id)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
