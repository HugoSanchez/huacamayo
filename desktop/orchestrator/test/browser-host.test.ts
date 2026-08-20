import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserHost } from '../src/http/browser-host.ts';

const FAKE_CHROME = fileURLToPath(new URL('./fixtures/fake-chrome.mjs', import.meta.url));

const quietLogger = { info: () => undefined, warn: () => undefined };

function makeHost(baseDir: string, overrides: Partial<{ binary: string | null }> = {}): BrowserHost {
  return new BrowserHost({
    baseDir,
    binary: 'binary' in overrides ? overrides.binary : FAKE_CHROME,
    logger: quietLogger,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Condition not reached in time.');
}

describe('BrowserHost', () => {
  let baseDir: string;
  let host: BrowserHost | null = null;

  afterEach(async () => {
    if (host) await host.shutdown();
    host = null;
    rmSync(baseDir, { recursive: true, force: true });
  });

  function freshBase(): string {
    baseDir = mkdtempSync(path.join(os.tmpdir(), 'browser-host-test-'));
    return baseDir;
  }

  it('starts the browser, verifies port ownership, and exposes the CDP URL', async () => {
    host = makeHost(freshBase());
    expect(host.isEnabled()).toBe(false);
    expect(host.cdpUrl()).toBeNull();

    await host.ensureStarted();

    expect(host.isRunning()).toBe(true);
    expect(host.isEnabled()).toBe(true);
    const cdpUrl = host.cdpUrl();
    expect(cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${cdpUrl}/json/version`);
    expect(response.ok).toBe(true);
  });

  it('seeds the profile with Chrome password saving disabled', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();

    const preferences = JSON.parse(
      readFileSync(path.join(host.profileDir, 'Default', 'Preferences'), 'utf8'),
    );
    expect(preferences.credentials_enable_service).toBe(false);
    expect(preferences.profile.password_manager_enabled).toBe(false);
  });

  it('reset stops the browser and deletes the profile', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();
    const profileDir = host.profileDir;
    expect(existsSync(profileDir)).toBe(true);

    await host.reset();

    expect(host.isRunning()).toBe(false);
    expect(existsSync(profileDir)).toBe(false);
    expect(host.isEnabled()).toBe(false);
    expect(host.cdpUrl()).toBeNull();
  });

  it('respawns after an unexpected browser exit', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();
    const statePath = path.join(baseDir, 'agent-browser-host.json');
    const firstPid = JSON.parse(readFileSync(statePath, 'utf8')).pid as number;

    process.kill(firstPid, 'SIGKILL');
    await waitFor(() => {
      if (!host!.isRunning()) return false;
      const currentPid = JSON.parse(readFileSync(statePath, 'utf8')).pid as number | null;
      return currentPid !== null && currentPid !== firstPid;
    }, 10_000);

    expect(host.isRunning()).toBe(true);
  }, 15_000);

  it('keeps the same port across a browser restart', async () => {
    host = makeHost(freshBase());
    await host.ensureStarted();
    const firstUrl = host.cdpUrl();

    await host.shutdown();
    await host.ensureStarted();

    expect(host.cdpUrl()).toBe(firstUrl);
  });

  it('sweeps a stale process only when its identity matches', async () => {
    host = makeHost(freshBase());
    const statePath = path.join(baseDir, 'agent-browser-host.json');

    // A live process whose command line does NOT reference our binary+profile
    // must survive the sweep even when the pidfile points at it.
    const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeFileSync(statePath, JSON.stringify({
      pid: bystander.pid,
      binary: FAKE_CHROME,
      userDataDir: host.profileDir,
      port: null,
    }));
    await host.sweepStaleProcess();
    expect(bystander.exitCode).toBeNull();
    bystander.kill('SIGKILL');

    // A process that matches the recorded binary and profile dir is ours from
    // a previous run and must be killed.
    const stale = spawn(FAKE_CHROME, [
      `--user-data-dir=${host.profileDir}`,
      '--remote-debugging-port=0',
    ], { stdio: 'ignore' });
    await waitFor(() => stale.pid !== undefined);
    writeFileSync(statePath, JSON.stringify({
      pid: stale.pid,
      binary: FAKE_CHROME,
      userDataDir: host.profileDir,
      port: null,
    }));
    await host.sweepStaleProcess();
    await waitFor(() => stale.exitCode !== null || stale.signalCode !== null, 5_000);
  }, 15_000);

  it('reports unsupported when no browser binary exists', async () => {
    host = makeHost(freshBase(), { binary: null });
    expect(host.status().supported).toBe(false);
    await expect(host.ensureStarted()).rejects.toThrow(/No Chromium-family browser/);
  });
});
