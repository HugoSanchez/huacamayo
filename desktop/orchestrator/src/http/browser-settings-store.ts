import os from 'node:os';
import path from 'node:path';
import { readJsonFileOr, writeJsonFileAtomic } from './atomic-json-file.ts';

export interface BrowserSettings {
  /**
   * Lets the agent browser reach localhost/RFC1918 addresses (self-hosted
   * tools). Off by default: private-network reach widens what a prompt-injected
   * page can steer the agent toward, so the user opts in deliberately.
   */
  allowPrivateUrls: boolean;
}

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'browser-settings.json');
}

function decode(value: unknown): BrowserSettings {
  const record = (value ?? {}) as Record<string, unknown>;
  return { allowPrivateUrls: record.allowPrivateUrls === true };
}

function defaults(): BrowserSettings {
  return { allowPrivateUrls: false };
}

export class BrowserSettingsStore {
  private readonly storePath: string;

  constructor(storePath: string = defaultStorePath()) {
    this.storePath = storePath;
  }

  get(): BrowserSettings {
    return readJsonFileOr(this.storePath, decode, defaults);
  }

  setAllowPrivateUrls(allow: boolean): BrowserSettings {
    const next = { ...this.get(), allowPrivateUrls: allow };
    writeJsonFileAtomic(this.storePath, next);
    return next;
  }
}
