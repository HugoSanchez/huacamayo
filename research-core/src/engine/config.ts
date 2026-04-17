import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EngineConfig } from './types.ts';

function getConfigDir() { return join(homedir(), 'Library', 'Application Support', 'Vervo'); }
function getConfigPath() { return join(getConfigDir(), 'config.json'); }

export interface VervoConfig {
  engine: 'pglite';
  database_path?: string;
}

export function loadConfig(): VervoConfig | null {
  let fileConfig: VervoConfig | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    fileConfig = JSON.parse(raw) as VervoConfig;
  } catch { /* no config file */ }

  if (!fileConfig) return null;

  return {
    ...fileConfig,
    engine: 'pglite',
  };
}

export function saveConfig(config: VervoConfig): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(getConfigPath(), 0o600);
  } catch {
    // chmod may fail on some platforms
  }
}

export function toEngineConfig(config: VervoConfig): EngineConfig {
  return {
    engine: 'pglite',
    database_path: config.database_path || join(getConfigDir(), 'brain.db'),
  };
}

export function configDir(): string {
  return getConfigDir();
}

export function configPath(): string {
  return getConfigPath();
}

// Re-export as GBrainConfig for compatibility with operations.ts
export type GBrainConfig = VervoConfig;
