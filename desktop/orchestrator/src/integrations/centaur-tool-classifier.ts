export type CentaurToolIcon =
  | { type: 'glyph'; name: 'memory' | 'file' | 'git' | 'globe' | 'terminal' | 'search' | 'pencil' }
  | { type: 'url'; url: string; fallback: string };

export interface CentaurToolClassification {
  tool: string;
  icon: CentaurToolIcon;
  label: string;
  detail: unknown;
}

const MAX_LABEL_CHARS = 96;

const COMPOSIO_TOOLKIT_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  slack: 'Slack',
  googledrive: 'Google Drive',
  googlecalendar: 'Google Calendar',
  notion: 'Notion',
  linear: 'Linear',
  granola_mcp: 'Granola',
};

const COMPOSIO_PREFIXES = [
  'GOOGLECALENDAR',
  'GOOGLEDRIVE',
  'GRANOLA_MCP',
  'GMAIL',
  'SLACK',
  'NOTION',
  'LINEAR',
];

export function classifyToolCall(name: string, input: unknown): CentaurToolClassification {
  const detail = input;
  const command = shellCommand(input) ?? (isShellToolName(name) && typeof input === 'string' ? input : null);
  if (command) {
    const memory = classifyMemoryCommand(command);
    if (memory) return { ...memory, tool: 'memory', detail };

    const composio = classifyComposioCommand(command);
    if (composio) return { ...composio, detail };

    const git = classifyGitCommand(command);
    if (git) return { ...git, tool: firstToken(cleanCommand(command)), detail };

    const web = classifyWebCommand(command);
    if (web) return { ...web, tool: firstToken(cleanCommand(command)), detail };

    return {
      tool: 'shell',
      icon: { type: 'glyph', name: 'terminal' },
      label: oneLine(cleanCommand(command)),
      detail,
    };
  }

  const native = classifyNativeTool(name, input);
  if (native) return { ...native, detail };

  const composioName = composioSlugFromText(name);
  if (composioName) return { ...classificationFromComposioSlug(composioName), detail };

  return {
    tool: name || 'tool',
    icon: { type: 'glyph', name: 'terminal' },
    label: oneLine(friendlyToolName(name) || previewInput(input) || 'Running tool'),
    detail,
  };
}

export function summarizeToolResult(content: unknown): { status: 'ok' | 'error'; summary: string } {
  const text = stringify(content).trim();
  const status = /\b(error|failed|exception|traceback|denied|unauthorized)\b/i.test(text) ? 'error' : 'ok';
  return {
    status,
    summary: truncateOneLine(text || (status === 'ok' ? 'Completed' : 'Failed'), MAX_LABEL_CHARS),
  };
}

function classifyMemoryCommand(command: string): Omit<CentaurToolClassification, 'detail' | 'tool'> | null {
  const cleaned = cleanCommand(command);
  if (!/(^|\s|\/)(?:memory|memory\.cli)(\s|$)/.test(cleaned) && !/\/memory(?:\s|$)/.test(cleaned)) {
    return null;
  }

  const search = /(?:^|\s)(?:memory|memory\.cli)\s+search\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(cleaned);
  if (search) {
    return {
      icon: { type: 'glyph', name: 'memory' },
      label: oneLine(`Searching memory for "${search[1] ?? search[2] ?? search[3] ?? ''}"`),
    };
  }

  const write = /(?:^|\s)(?:memory|memory\.cli)\s+write\s+([^\s;&|]+)/i.exec(cleaned);
  if (write?.[1]) {
    return {
      icon: { type: 'glyph', name: 'memory' },
      label: oneLine(`Saving memory page ${write[1]}`),
    };
  }

  const page = /(?:^|\s)(?:memory|memory\.cli)\s+page\s+([^\s;&|]+)/i.exec(cleaned);
  if (page?.[1]) {
    return {
      icon: { type: 'glyph', name: 'memory' },
      label: oneLine(`Reading memory page ${page[1]}`),
    };
  }

  if (/(?:^|\s)(?:memory|memory\.cli)\s+status\b/i.test(cleaned)) {
    return { icon: { type: 'glyph', name: 'memory' }, label: 'Checking memory status' };
  }

  return { icon: { type: 'glyph', name: 'memory' }, label: 'Using memory' };
}

function classifyComposioCommand(command: string): Omit<CentaurToolClassification, 'detail'> | null {
  const slug = composioSlugFromText(command);
  if (!slug) return null;
  return classificationFromComposioSlug(slug, command);
}

function classificationFromComposioSlug(slug: string, context = ''): Omit<CentaurToolClassification, 'detail'> {
  const toolkit = toolkitFromComposioSlug(slug);
  const toolkitName = COMPOSIO_TOOLKIT_NAMES[toolkit] ?? titleCase(toolkit);
  const action = slug.toLowerCase().slice(toolkit.length).replace(/^_+/, '');
  const humanAction = action.replace(/_+/g, ' ').trim();
  const verb = actionVerb(action);
  const query = queryNearComposioSlug(slug, context);
  return {
    tool: slug,
    icon: { type: 'url', url: `https://logos.composio.dev/api/${toolkit}`, fallback: toolkitName },
    label: oneLine(`${verb} ${toolkitName}${query ? `: "${query}"` : humanAction ? ` (${humanAction})` : ''}`),
  };
}

function classifyNativeTool(name: string, input: unknown): Omit<CentaurToolClassification, 'detail'> | null {
  const normalized = stripNamespace(name);
  const lower = normalized.toLowerCase();
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const path = stringValue(value.file_path) ?? stringValue(value.path) ?? stringValue(value.pattern);

  if (['read', 'read_file'].includes(lower) || lower === 'cat') {
    return { tool: normalized, icon: { type: 'glyph', name: 'file' }, label: oneLine(`Reading ${basename(path) || 'file'}`) };
  }
  if (['write', 'write_file', 'edit', 'multi_edit'].includes(lower)) {
    return { tool: normalized, icon: { type: 'glyph', name: 'file' }, label: oneLine(`${lower.includes('write') ? 'Writing' : 'Editing'} ${basename(path) || 'file'}`) };
  }
  if (['glob', 'grep', 'search'].includes(lower)) {
    return { tool: normalized, icon: { type: 'glyph', name: 'search' }, label: oneLine(`Searching ${path || previewInput(input) || 'files'}`) };
  }
  return null;
}

function classifyGitCommand(command: string): Omit<CentaurToolClassification, 'detail' | 'tool'> | null {
  const cleaned = cleanCommand(command);
  const tokens = cleaned.split(/\s+/);
  const program = tokens[0] ?? '';
  if (program !== 'git' && program !== 'gh') return null;
  return {
    icon: { type: 'glyph', name: 'git' },
    label: oneLine(`${program}: ${tokens.slice(1, 4).join(' ') || 'command'}`),
  };
}

function classifyWebCommand(command: string): Omit<CentaurToolClassification, 'detail' | 'tool'> | null {
  const cleaned = cleanCommand(command);
  const tokens = cleaned.split(/\s+/);
  const program = tokens[0] ?? '';
  if (program !== 'curl' && program !== 'wget') return null;
  const url = tokens.find((token) => /^https?:\/\//i.test(token));
  return {
    icon: { type: 'glyph', name: 'globe' },
    label: oneLine(`Fetching ${hostOf(url) || 'URL'}`),
  };
}

function composioSlugFromText(text: string): string | null {
  const match = new RegExp(`\\b(${COMPOSIO_PREFIXES.join('|')})_[A-Z0-9_]+\\b`).exec(text);
  return match?.[0] ?? null;
}

function toolkitFromComposioSlug(slug: string): string {
  const upper = slug.toUpperCase();
  if (upper.startsWith('GOOGLEDRIVE_')) return 'googledrive';
  if (upper.startsWith('GOOGLECALENDAR_')) return 'googlecalendar';
  if (upper.startsWith('GRANOLA_MCP_')) return 'granola_mcp';
  return slug.split('_')[0]?.toLowerCase() ?? slug.toLowerCase();
}

function queryNearComposioSlug(slug: string, context: string): string | null {
  const afterSlug = new RegExp(`${escapeRegex(slug)}[\\s\\S]{0,240}`, 'i').exec(context)?.[0];
  if (!afterSlug) return null;
  const match = /\b(?:query|q|search|keyword|keywords)\b['"]?\s*[:=]\s*['"]([^'"\n]{2,80})['"]/i.exec(afterSlug);
  return match?.[1] ?? null;
}

function actionVerb(action: string): string {
  if (/^(search|find|query|list|get|fetch|retrieve|read)/.test(action)) return 'Searching';
  if (/^(send|create|draft|write|update|reply|add)/.test(action)) return 'Updating';
  if (/^(delete|remove|archive)/.test(action)) return 'Updating';
  return 'Using';
}

function shellCommand(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const command = (input as Record<string, unknown>).command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.map((part) => String(part ?? '')).join(' ');
  return null;
}

function cleanCommand(command: string): string {
  let cleaned = command.trim();
  const wrapper = /^(?:\/[\w/]+\/)?(?:ba)?sh\s+-[a-z]*c\s+([\s\S]+)$/i.exec(cleaned);
  if (wrapper?.[1]) {
    cleaned = wrapper[1].trim();
    if (
      (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
      (cleaned.startsWith('"') && cleaned.endsWith('"'))
    ) {
      cleaned = cleaned.slice(1, -1);
    }
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

function isShellToolName(name: string): boolean {
  return ['shell', 'bash', 'sh', 'zsh', 'terminal', 'exec', 'exec_command', 'run_command']
    .includes(stripNamespace(name).toLowerCase());
}

function stripNamespace(name: string): string {
  return name
    .replace(/^mcp(?:_+|__)?[a-z0-9]+(?:_+|__)/i, '')
    .replace(/^[a-z0-9]+__/i, '');
}

function friendlyToolName(name: string): string {
  const stripped = stripNamespace(name).replace(/_+/g, ' ').trim();
  return stripped ? titleCase(stripped) : name;
}

function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) return `${input.length} item${input.length === 1 ? '' : 's'}`;
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of ['file_path', 'path', 'query', 'pattern', 'url', 'name', 'slug', 'title', 'message']) {
      const value = obj[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return '';
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => typeof entry === 'string' ? entry : stringify(entry)).join('\n');
  }
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function oneLine(label: string): string {
  return truncateOneLine(label.replace(/\s+/g, ' ').trim(), MAX_LABEL_CHARS);
}

function truncateOneLine(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function basename(value: string | null | undefined): string {
  if (!value) return '';
  return value.split('/').filter(Boolean).pop() ?? value;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstToken(value: string): string {
  return value.split(/\s+/)[0] ?? '';
}

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
