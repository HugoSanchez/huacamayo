import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, route, type Route } from './router.ts';
import type { SkillsStore } from './skills-store.ts';

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  prerequisites: string[];
  platforms: string[];
  enabled: boolean;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  frontmatter: Record<string, unknown>;
  path: string;
}

interface ParsedSkill {
  slug: string;
  category: string | null;
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

const HERMES_SKILLS_DIR = path.join(os.homedir(), '.hermes', 'skills');

export function buildSkillsRoutes(store: SkillsStore): Route[] {
  return [
    route('GET', '/skills', async (_req, res) => {
      const skills = scanSkills().map((skill) => toSummary(skill, store.isEnabled(skill.slug)));
      json(res, 200, { skills });
    }),

    route('GET', '/skills/:slug', async (_req, res, params) => {
      const skill = scanSkills().find((candidate) => candidate.slug === params.slug);
      if (!skill) {
        return json(res, 404, { error: 'not_found', message: `Unknown skill: ${params.slug}` });
      }
      json(res, 200, { skill: toDetail(skill, store.isEnabled(skill.slug)) });
    }),

    route('POST', '/skills/:slug/toggle', async (_req, res, params, body) => {
      const skill = scanSkills().find((candidate) => candidate.slug === params.slug);
      if (!skill) {
        return json(res, 404, { error: 'not_found', message: `Unknown skill: ${params.slug}` });
      }
      const requested = (body as { enabled?: unknown } | null)?.enabled;
      const next = typeof requested === 'boolean' ? requested : !store.isEnabled(skill.slug);
      store.setEnabled(skill.slug, next);
      json(res, 200, { skill: toSummary(skill, next) });
    }),
  ];
}

export function findSkillBySlug(slug: string): ParsedSkill | null {
  return scanSkills().find((candidate) => candidate.slug === slug) ?? null;
}

export function buildSkillInvocationPrompt(skill: ParsedSkill, userPrompt: string): string {
  const skillBody = skill.content.trim();
  const intro = `The user has invoked the "${skill.slug}" skill. Use the skill instructions below to guide your response. Do not repeat the skill content back to the user verbatim — apply it.`;
  const sections = [intro, '--- BEGIN SKILL: ' + skill.slug + ' ---', skillBody, '--- END SKILL ---'];
  if (userPrompt.trim().length > 0) {
    sections.push('User prompt:', userPrompt.trim());
  } else {
    sections.push('No additional prompt was provided. Greet the user briefly and explain what the skill can do.');
  }
  return sections.join('\n\n');
}

const SLASH_SKILL_PATTERN = /^\/([a-z0-9][a-z0-9_-]*)\b/i;

export function extractSlashSkillRequest(input: string): { slug: string; remainder: string } | null {
  const match = input.match(SLASH_SKILL_PATTERN);
  if (!match) return null;
  const slug = match[1].toLowerCase();
  const remainder = input.slice(match[0].length).trim();
  return { slug, remainder };
}

function scanSkills(): ParsedSkill[] {
  return walk(HERMES_SKILLS_DIR, [])
    .map((filePath) => parseSkillFile(filePath))
    .filter((skill): skill is ParsedSkill => skill !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function walk(dir: string, segments: string[]): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      found.push(...walk(full, [...segments, entry]));
    } else if (info.isFile() && entry === 'SKILL.md') {
      found.push(full);
    }
  }
  return found;
}

function parseSkillFile(filePath: string): ParsedSkill | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  const nameField = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const directorySlug = path.basename(path.dirname(filePath));
  const slug = (nameField || directorySlug).toLowerCase();
  if (!slug) return null;
  const category = inferCategory(filePath);
  return { slug, category, path: filePath, frontmatter, content: body };
}

function inferCategory(filePath: string): string | null {
  const relative = path.relative(HERMES_SKILLS_DIR, path.dirname(filePath));
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length <= 1) return null;
  return segments[0] || null;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 3);
  if (end < 0) {
    return { frontmatter: {}, body: raw };
  }
  const yaml = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  return { frontmatter: parseSimpleYaml(yaml), body };
}

function parseSimpleYaml(input: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = input.split(/\r?\n/);
  const stack: { indent: number; container: Record<string, unknown> | unknown[] }[] = [{ indent: -1, container: result }];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      if (Array.isArray(top.container)) {
        top.container.push(parseScalar(trimmed.slice(2).trim()));
      }
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const valueStr = trimmed.slice(colon + 1).trim();

    if (!Array.isArray(top.container)) {
      if (!valueStr) {
        // Possible nested map or list — peek next line.
        const next = lines.slice(i + 1).find((candidate) => candidate.trim().length > 0);
        const nextIndent = next ? next.match(/^\s*/)?.[0].length ?? 0 : indent + 2;
        if (next && next.trim().startsWith('- ') && nextIndent > indent) {
          const arr: unknown[] = [];
          top.container[key] = arr;
          stack.push({ indent, container: arr });
        } else {
          const obj: Record<string, unknown> = {};
          top.container[key] = obj;
          stack.push({ indent, container: obj });
        }
      } else if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
        top.container[key] = valueStr
          .slice(1, -1)
          .split(',')
          .map((item) => parseScalar(item.trim()))
          .filter((item) => item !== '');
      } else {
        top.container[key] = parseScalar(valueStr);
      }
    }
  }

  return result;
}

function parseScalar(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const stripped = value.replace(/^['"]|['"]$/g, '');
  const asNumber = Number(stripped);
  if (!Number.isNaN(asNumber) && /^-?\d+(\.\d+)?$/.test(stripped)) return asNumber;
  return stripped;
}

function toSummary(skill: ParsedSkill, enabled: boolean): SkillSummary {
  const fm = skill.frontmatter;
  return {
    slug: skill.slug,
    name: typeof fm.name === 'string' ? (fm.name as string) : skill.slug,
    description: typeof fm.description === 'string' ? (fm.description as string) : '',
    category: skill.category,
    tags: extractTags(fm),
    prerequisites: extractPrerequisites(fm),
    platforms: extractStringArray(fm.platforms),
    enabled,
  };
}

function toDetail(skill: ParsedSkill, enabled: boolean): SkillDetail {
  return {
    ...toSummary(skill, enabled),
    content: skill.content,
    frontmatter: skill.frontmatter,
    path: skill.path,
  };
}

function extractTags(frontmatter: Record<string, unknown>): string[] {
  const meta = frontmatter.metadata;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const hermes = (meta as Record<string, unknown>).hermes;
    if (hermes && typeof hermes === 'object' && !Array.isArray(hermes)) {
      return extractStringArray((hermes as Record<string, unknown>).tags);
    }
  }
  return [];
}

function extractPrerequisites(frontmatter: Record<string, unknown>): string[] {
  const prereq = frontmatter.prerequisites;
  if (prereq && typeof prereq === 'object' && !Array.isArray(prereq)) {
    return extractStringArray((prereq as Record<string, unknown>).commands);
  }
  return [];
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}
