import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface SkillsStoreShape {
  enabledSlugs: string[];
}

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Vervo', 'skills.json');
}

export class SkillsStore {
  private readonly storePath: string;
  private state: SkillsStoreShape;

  constructor(storePath = process.env.VERVO_SKILLS_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    this.state = this.load();
  }

  isEnabled(slug: string): boolean {
    return this.state.enabledSlugs.includes(slug);
  }

  listEnabled(): string[] {
    return [...this.state.enabledSlugs];
  }

  setEnabled(slug: string, enabled: boolean): void {
    const set = new Set(this.state.enabledSlugs);
    if (enabled) set.add(slug);
    else set.delete(slug);
    this.state = { enabledSlugs: [...set].sort() };
    this.persist();
  }

  private load(): SkillsStoreShape {
    if (!existsSync(this.storePath)) {
      return { enabledSlugs: [] };
    }
    try {
      const raw = readFileSync(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SkillsStoreShape>;
      const slugs = Array.isArray(parsed.enabledSlugs)
        ? parsed.enabledSlugs.filter((s): s is string => typeof s === 'string')
        : [];
      return { enabledSlugs: slugs };
    } catch {
      return { enabledSlugs: [] };
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(this.state, null, 2));
  }
}
