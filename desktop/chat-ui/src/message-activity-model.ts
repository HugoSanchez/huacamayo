import type { ActivityStep } from './types';

export interface ToolkitInfo {
  name: string;
  logoUrl: string | null;
  connected: boolean;
}

export interface CronToolCardModel {
  action: 'create' | 'update' | 'remove' | 'pause' | 'resume' | 'run';
  jobId: string | null;
  name: string | null;
  scheduleDisplay: string | null;
}

export interface ComposioExecuteView {
  toolkitName: string;
  logoUrl: string | null;
  actionLabel: string;
}

export type ToolIconKind = 'search' | 'terminal' | 'pencil' | 'trash' | 'link' | 'fetch' | 'dot';

export function activityStepsWithReasoningFallback(
  steps: ActivityStep[],
  reasoning: string | null | undefined,
): ActivityStep[] {
  const text = reasoning?.trim();
  if (!text || steps.some((step) => step.type === 'reasoning')) return steps;
  return [{ type: 'reasoning', text }, ...steps];
}

// Reasoning summaries can arrive as adjacent bold-titled parts (`**A****B**`).
// Restore a paragraph boundary so markdown does not render the middle stars.
export function normalizeThinking(text: string): string {
  return text.replace(/\*\*\*\*/g, '**\n\n**').trim();
}

export function parseCronToolStep(
  step: Extract<ActivityStep, { type: 'tool' }>,
): CronToolCardModel | null {
  // Hermes can expose native tools with an MCP namespace or nest them inside
  // a generic `tool_call` envelope. Normalize before deciding whether this is
  // a cron mutation so the UI and native sidebar follow the same event path.
  const normalizedStep = unwrapToolCall(step);
  if (stripNamespace(normalizedStep.name).toLowerCase() !== 'cronjob') return null;
  if (typeof normalizedStep.result !== 'string' || normalizedStep.result.length === 0) return null;

  let parsedResult: unknown;
  try {
    parsedResult = JSON.parse(normalizedStep.result);
  } catch {
    return null;
  }
  if (!parsedResult || typeof parsedResult !== 'object') return null;
  const resultObj = parsedResult as Record<string, unknown>;
  if (resultObj.success !== true) return null;

  const inputObj = typeof normalizedStep.input === 'object' && normalizedStep.input !== null
    ? normalizedStep.input as Record<string, unknown>
    : null;
  const action = typeof inputObj?.action === 'string' ? inputObj.action : null;
  if (
    action !== 'create'
    && action !== 'update'
    && action !== 'remove'
    && action !== 'pause'
    && action !== 'resume'
    && action !== 'run'
  ) return null;

  const job = resultObj.job && typeof resultObj.job === 'object'
    ? resultObj.job as Record<string, unknown>
    : null;
  const jobId = action === 'remove'
    ? (typeof inputObj?.job_id === 'string' ? inputObj.job_id : null)
    : (typeof job?.id === 'string' ? job.id : null);
  const name = typeof job?.name === 'string'
    ? job.name
    : typeof inputObj?.name === 'string' ? inputObj.name : null;
  const scheduleDisplay = typeof job?.schedule_display === 'string'
    ? job.schedule_display
    : typeof inputObj?.schedule === 'string' ? inputObj.schedule : null;

  return { action, jobId, name, scheduleDisplay };
}

export function unwrapToolCall(
  step: Extract<ActivityStep, { type: 'tool' }>,
): Extract<ActivityStep, { type: 'tool' }> {
  if (stripNamespace(step.name).toLowerCase() !== 'tool_call') return step;
  const input = step.input;
  if (!input || typeof input !== 'object') return step;
  const inner = input as Record<string, unknown>;
  if (typeof inner.name !== 'string' || inner.name.length === 0) return step;
  return {
    ...step,
    name: inner.name,
    input: 'arguments' in inner ? inner.arguments : input,
  };
}

export function parseComposioExecute(
  step: Extract<ActivityStep, { type: 'tool' }>,
  toolkits: Map<string, ToolkitInfo>,
): ComposioExecuteView | null {
  const strippedName = stripNamespace(step.name).toLowerCase();
  if (strippedName !== 'execute_composio_tool') {
    const match = matchComposioToolkitPrefix(strippedName, toolkits);
    if (!match || match.info?.connected !== true) return null;
    return composioViewFromMatchedPrefix(strippedName, match);
  }

  const input = step.input;
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const rawSlug = record.tool_slug ?? record.toolSlug;
  if (typeof rawSlug !== 'string' || rawSlug.length === 0) return null;

  const lowered = rawSlug.toLowerCase();
  const match = matchComposioToolkitPrefix(lowered, toolkits);
  if (match) return composioViewFromMatchedPrefix(lowered, match);
  const fallbackSlug = lowered.split('_')[0] ?? lowered;
  return composioViewFromMatchedPrefix(lowered, { slug: fallbackSlug, info: undefined });
}

function matchComposioToolkitPrefix(
  loweredToolSlug: string,
  toolkits: Map<string, ToolkitInfo>,
): { slug: string; info: ToolkitInfo | undefined } | null {
  const parts = loweredToolSlug.split('_');
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const candidate = parts.slice(0, i).join('_');
    const info = toolkits.get(candidate) ?? toolkits.get(candidate.replace(/_/g, '-'));
    if (info) return { slug: candidate, info };
  }
  return null;
}

function composioViewFromMatchedPrefix(
  loweredToolSlug: string,
  match: { slug: string; info: ToolkitInfo | undefined },
): ComposioExecuteView {
  const actionRaw = loweredToolSlug.slice(match.slug.length + 1);
  const toolkitName = match.info?.name ?? titleCase(match.slug);
  const actionLabel = actionRaw.replace(/_+/g, ' ').trim() || loweredToolSlug;
  return { toolkitName, logoUrl: match.info?.logoUrl ?? null, actionLabel };
}

function titleCase(slug: string): string {
  if (!slug) return slug;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

const SEARCH_VERBS = new Set(['search', 'find', 'list', 'get', 'read', 'look', 'lookup', 'query', 'inspect', 'show', 'view', 'check']);
const TERMINAL_VERBS = new Set(['run', 'exec', 'execute', 'terminal', 'bash', 'shell', 'invoke', 'spawn', 'launch']);
const WRITE_VERBS = new Set(['write', 'create', 'edit', 'update', 'set', 'save', 'append', 'modify', 'patch', 'rename']);
const DELETE_VERBS = new Set(['delete', 'remove', 'clear', 'drop', 'archive', 'unarchive']);
const LINK_VERBS = new Set(['connect', 'disconnect', 'auth', 'authorize', 'authenticate', 'login', 'logout', 'request']);
const FETCH_VERBS = new Set(['fetch', 'download', 'pull', 'sync', 'import']);

export function iconForTool(name: string): ToolIconKind {
  const verb = stripNamespace(name).split(/[_\s]+/)[0]?.toLowerCase() ?? '';
  if (SEARCH_VERBS.has(verb)) return 'search';
  if (TERMINAL_VERBS.has(verb)) return 'terminal';
  if (WRITE_VERBS.has(verb)) return 'pencil';
  if (DELETE_VERBS.has(verb)) return 'trash';
  if (LINK_VERBS.has(verb)) return 'link';
  if (FETCH_VERBS.has(verb)) return 'fetch';
  return 'dot';
}

export function stripNamespace(name: string): string {
  return name
    .replace(/^mcp(?:_+|__)?[a-z0-9]+(?:_+|__)/i, '')
    .replace(/^[a-z0-9]+__/i, '');
}

export function friendlyToolName(name: string): string {
  const stripped = stripNamespace(name).replace(/_+/g, ' ').trim();
  if (!stripped) return name;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function prettyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) return `${input.length} item${input.length === 1 ? '' : 's'}`;
  if (typeof input !== 'object') return '';

  const obj = input as Record<string, unknown>;
  for (const key of [
    'command', 'file_path', 'path', 'query', 'pattern', 'url',
    'name', 'slug', 'toolkit', 'search', 'title', 'message',
  ]) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  for (const value of Object.values(obj)) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  try {
    return JSON.stringify(obj).slice(0, 120);
  } catch {
    return '';
  }
}

export function formatElapsed(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = (totalSec - min * 60).toFixed(1);
  return `${min}m ${sec}s`;
}
