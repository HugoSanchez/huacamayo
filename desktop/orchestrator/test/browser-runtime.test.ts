import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_BROWSER_VERSION, BrowserRuntime } from '../src/http/browser-runtime.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeInstall(version: string): { root: string; cli: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verso-browser-runtime-'));
  roots.push(root);
  const cli = path.join(root, 'node_modules', '.bin', 'agent-browser');
  mkdirSync(path.dirname(cli), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'agent-browser'), { recursive: true });
  writeFileSync(cli, '#!/bin/sh\n');
  writeFileSync(
    path.join(root, 'node_modules', 'agent-browser', 'package.json'),
    JSON.stringify({ version }),
  );
  return { root, cli };
}

describe('BrowserRuntime', () => {
  it('only accepts the deliberately pinned agent-browser version', () => {
    const matching = fakeInstall(AGENT_BROWSER_VERSION);
    expect(new BrowserRuntime(matching.root).cliPath()).toBe(matching.cli);

    const stale = fakeInstall('0.33.0');
    expect(new BrowserRuntime(stale.root).cliPath()).toBeNull();
  });

  it('rejects a CLI without a readable package manifest', () => {
    const install = fakeInstall(AGENT_BROWSER_VERSION);
    writeFileSync(path.join(install.root, 'node_modules', 'agent-browser', 'package.json'), '{');
    expect(new BrowserRuntime(install.root).cliPath()).toBeNull();
  });
});
