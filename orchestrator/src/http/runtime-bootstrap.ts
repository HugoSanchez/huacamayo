import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface BundledRuntimePaths {
  /** ~/Library/Application Support/Verso/runtime — venv lives in {runtimeDir}/venv. */
  runtimeDir: string;
  /** <app>/Resources/python — one subdir per arch ({arm64,x86_64}). */
  bundledPythonDir: string;
  /** <app>/Resources/wheels — one subdir per arch, holding .whl files. */
  bundledWheelsDir: string;
  /** <app>/Resources/hermes-defaults — seed config.yaml + SOUL.md + memories/. */
  bundledDefaultsDir: string;
  /** ~/Library/Application Support/Verso/hermes-home — Hermes' on-disk profile. */
  hermesHome: string;
  /** Contents of <app>/Resources/BUNDLE_VERSION — used to decide whether the
   * venv needs to be rebuilt after a Verso app update. */
  bundleVersion: string;
}

export function readBundledRuntimePaths(): BundledRuntimePaths | null {
  const runtimeDir = process.env.VERSO_RUNTIME_DIR?.trim();
  const bundledPythonDir = process.env.VERSO_BUNDLED_PYTHON_DIR?.trim();
  const bundledWheelsDir = process.env.VERSO_BUNDLED_WHEELS_DIR?.trim();
  const bundledDefaultsDir = process.env.VERSO_BUNDLED_DEFAULTS?.trim();
  const hermesHome = process.env.VERSO_HERMES_HOME?.trim();
  const bundleVersion = process.env.VERSO_BUNDLE_VERSION?.trim();

  if (
    !runtimeDir
    || !bundledPythonDir
    || !bundledWheelsDir
    || !bundledDefaultsDir
    || !hermesHome
    || !bundleVersion
  ) {
    return null;
  }

  return { runtimeDir, bundledPythonDir, bundledWheelsDir, bundledDefaultsDir, hermesHome, bundleVersion };
}

export function isBundledRuntime(): boolean {
  return readBundledRuntimePaths() !== null;
}

export function getBundledHermesBin(): string | null {
  const paths = readBundledRuntimePaths();
  return paths ? join(paths.runtimeDir, 'venv', 'bin', 'hermes') : null;
}

export function getBundledVenvPython(): string | null {
  const paths = readBundledRuntimePaths();
  return paths ? join(paths.runtimeDir, 'venv', 'bin', 'python') : null;
}

function archSlug(): string {
  return process.arch === 'x64' ? 'x86_64' : process.arch;
}

/**
 * On first launch (or after a Verso update with a new bundle version),
 * create the user-side venv from bundled Python + offline wheels. No-op
 * outside Release builds (VERSO_RUNTIME_DIR unset).
 *
 * Throws on failure so the caller can surface the error in the gateway state.
 */
export async function ensureRuntimeVenv(): Promise<void> {
  const paths = readBundledRuntimePaths();
  if (!paths) return;

  const venvDir = join(paths.runtimeDir, 'venv');
  const stampPath = join(venvDir, '.bundle_version');
  const hermesBin = join(venvDir, 'bin', 'hermes');

  if (existsSync(hermesBin) && existsSync(stampPath)) {
    try {
      if (readFileSync(stampPath, 'utf8').trim() === paths.bundleVersion) {
        return;
      }
    } catch {
      // fall through and rebuild
    }
  }

  // Either the venv is missing or the stamp doesn't match the shipped bundle —
  // rebuild from scratch. We avoid in-place upgrades because partial pip
  // failures would leave the user wedged with a half-installed Hermes.
  rmSync(venvDir, { recursive: true, force: true });
  mkdirSync(paths.runtimeDir, { recursive: true });

  const arch = archSlug();
  const pythonBin = join(paths.bundledPythonDir, arch, 'python', 'bin', 'python3.11');
  const wheelsDir = join(paths.bundledWheelsDir, arch);

  if (!existsSync(pythonBin)) {
    throw new Error(`Bundled Python missing for arch ${arch} at ${pythonBin}`);
  }
  if (!existsSync(wheelsDir)) {
    throw new Error(`Bundled wheels missing for arch ${arch} at ${wheelsDir}`);
  }

  console.log(`[runtime] creating venv at ${venvDir} (bundle=${paths.bundleVersion})`);
  await execFileAsync(pythonBin, ['-m', 'venv', venvDir], { maxBuffer: 16 * 1024 * 1024 });

  console.log(`[runtime] installing Hermes from bundled wheels (${arch})`);
  const pipBin = join(venvDir, 'bin', 'pip');
  await execFileAsync(
    pipBin,
    [
      'install',
      '--quiet',
      '--no-index',
      '--find-links',
      wheelsDir,
      'hermes-agent[mcp,cli,cron]',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );

  writeFileSync(stampPath, paths.bundleVersion, 'utf8');
  console.log('[runtime] venv ready');
}

/**
 * Seed ~/Library/Application Support/Verso/hermes-home/ from the bundled
 * defaults the first time. Never overwrites existing files — once the user
 * has memories, an auth.json, or a customized config.yaml, they're sacred.
 */
export function seedHermesHomeFromBundle(): void {
  const paths = readBundledRuntimePaths();
  if (!paths) return;

  mkdirSync(paths.hermesHome, { recursive: true });
  copyTreeNoOverwrite(paths.bundledDefaultsDir, paths.hermesHome);
}

function copyTreeNoOverwrite(srcDir: string, dstDir: string): void {
  if (!existsSync(srcDir)) return;
  for (const entry of readdirSync(srcDir)) {
    const src = join(srcDir, entry);
    const dst = join(dstDir, entry);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTreeNoOverwrite(src, dst);
    } else if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
}
