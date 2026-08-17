import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HermesSupervisor } from '../src/http/hermes-supervisor.ts';

// Regression coverage for the connector add/remove restart failures:
//  - concurrent restart() calls used to run two full shutdown+start cycles,
//    with the second shutdown() SIGTERMing the healthy gateway the first
//    restart had just started ("did not become ready" while a good gateway
//    was running);
//  - restarting onto the previous child's port raced its TIME_WAIT socket,
//    which Hermes treats as a non-retryable bind failure (exit 78).
describe('HermesSupervisor restart', () => {
  let supervisor: HermesSupervisor | null = null;
  let tempHome = '';
  let envSnapshot: Record<string, string | undefined> = {};

  beforeAll(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'verso-supervisor-restart-'));
    envSnapshot = {
      VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
      VERSO_HERMES_COMMAND: process.env.VERSO_HERMES_COMMAND,
      VERSO_HERMES_ARGS: process.env.VERSO_HERMES_ARGS,
      VERSO_HERMES_CWD: process.env.VERSO_HERMES_CWD,
      VERSO_HERMES_MANAGED: process.env.VERSO_HERMES_MANAGED,
      VERSO_HERMES_HOME: process.env.VERSO_HERMES_HOME,
      API_SERVER_KEY: process.env.API_SERVER_KEY,
      VERSO_HERMES_API_SERVER_KEY: process.env.VERSO_HERMES_API_SERVER_KEY,
    };
    // No VERSO_HERMES_GATEWAY_URL: exercise the dynamic-port managed path the
    // desktop app uses, where every spawn must land on a fresh port.
    delete process.env.VERSO_HERMES_GATEWAY_URL;
    delete process.env.API_SERVER_KEY;
    delete process.env.VERSO_HERMES_API_SERVER_KEY;
    process.env.VERSO_HERMES_COMMAND = process.execPath;
    process.env.VERSO_HERMES_ARGS = JSON.stringify([
      path.resolve(process.cwd(), 'test/fixtures/fake-hermes-gateway.mjs'),
    ]);
    process.env.VERSO_HERMES_CWD = process.cwd();
    process.env.VERSO_HERMES_MANAGED = 'true';
    process.env.VERSO_HERMES_HOME = tempHome;
    supervisor = new HermesSupervisor();
  });

  afterAll(async () => {
    await supervisor?.shutdown();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('coalesces concurrent restarts and lands healthy on a fresh port', async () => {
    const first = await supervisor!.ensureReady();
    const portBefore = new URL(first.baseUrl).port;

    // Slow the next boots down so the second restart() reliably arrives while
    // the first is mid-health-wait — the window where, pre-fix, its shutdown
    // SIGTERMed the child the first restart had just spawned.
    process.env.FAKE_HERMES_BOOT_DELAY_MS = '1000';
    try {
      const firstRestart = supervisor!.restart();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const secondRestart = supervisor!.restart();
      const results = await Promise.allSettled([firstRestart, secondRestart]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    } finally {
      delete process.env.FAKE_HERMES_BOOT_DELAY_MS;
    }

    const status = await supervisor!.getStatus();
    expect(status.reachable).toBe(true);
    const portAfter = new URL(status.baseUrl).port;
    expect(portAfter).not.toBe(portBefore);

    // Sequential restart also lands healthy on another fresh port.
    await supervisor!.restart();
    const statusAfter = await supervisor!.getStatus();
    expect(statusAfter.reachable).toBe(true);
    expect(new URL(statusAfter.baseUrl).port).not.toBe(portAfter);
  }, 30_000);
});
