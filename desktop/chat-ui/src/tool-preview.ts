// Pure helpers that turn raw tool-call inputs into short, human-readable
// previews for the activity stream. Kept free of React so the logic can be
// unit-tested directly (see tool-preview.test.ts).
//
// The activity stream used to surface shell tools by dumping the raw command —
// absolute paths, `2>/dev/null` noise and all — which reads as a wall of
// implementation detail. These helpers translate that into something a person
// skimming the transcript can actually parse.

export interface ToolStepLike {
  name: string;
  input?: unknown;
}

const MAX_PREVIEW_CHARS = 120;

// Tool names (namespace-stripped, lowercased) that carry a shell command.
const SHELL_TOOL_NAMES = new Set([
  'shell',
  'bash',
  'sh',
  'zsh',
  'local_shell',
  'run_terminal_cmd',
  'run_command',
  'exec',
  'exec_command',
  'command',
  'terminal',
]);

// Absolute paths (`/home/agent/github/HugoSanchez/centaur/tools/productivity/memory`,
// `/Users/foo/bar/baz`) and `~/...` paths dominate the stream and carry almost
// no signal. Collapse anything three-or-more segments deep to `…/<last two>` so
// the tail — the recognizable part — survives while the machine-specific prefix
// disappears.
export function shortenPaths(text: string): string {
  if (!text) return text;
  return text.replace(/~?(?:\/[A-Za-z0-9._@+\-]+){2,}/g, (match) => shortenOnePath(match));
}

function shortenOnePath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join('/')}`;
}

// Codex-style shell tools sometimes deliver the command as an argv array
// (`["bash", "-lc", "…"]`); others send a plain string. Normalize to a string.
function commandToString(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) {
    const parts = command.map((part) => (typeof part === 'string' ? part : String(part ?? '')));
    if (
      parts.length === 3 &&
      /(?:^|\/)(?:ba)?sh$/.test(parts[0] ?? '') &&
      /^-[a-z]*c$/.test(parts[1] ?? '')
    ) {
      return parts[2] ?? '';
    }
    return parts.join(' ');
  }
  return null;
}

// Pull the shell command out of a tool step, or null if this isn't a shell tool.
export function shellCommandOf(step: ToolStepLike): string | null {
  const input = step.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const command = (input as Record<string, unknown>).command;
    const asString = commandToString(command);
    if (asString && asString.trim()) return asString;
  }
  if (typeof input === 'string' && input.trim() && isShellToolName(step.name)) {
    return input;
  }
  return null;
}

function isShellToolName(name: string): boolean {
  return SHELL_TOOL_NAMES.has(stripNamespace(name).toLowerCase());
}

// Mirror of MessageList's namespace stripping so this module stays standalone.
function stripNamespace(name: string): string {
  return name
    .replace(/^mcp(?:_+|__)?[a-z0-9]+(?:_+|__)/i, '')
    .replace(/^[a-z0-9]+__/i, '');
}

// Unwrap `bash -lc '…'` / `/bin/bash -lc "…"` down to the inner command, matching
// how the command was actually authored.
function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = /^(?:\/[\w/]+\/)?(?:ba)?sh\s+-[a-z]*c\s+([\s\S]+)$/i.exec(trimmed);
  if (!match?.[1]) return trimmed;
  let inner = match[1].trim();
  if (
    (inner.startsWith("'") && inner.endsWith("'")) ||
    (inner.startsWith('"') && inner.endsWith('"'))
  ) {
    inner = inner.slice(1, -1);
  }
  return inner.trim() || trimmed;
}

// Turn a raw command into a truthful-but-tidy one-liner: unwrap the bash
// wrapper, drop `2>/dev/null`-style noise, shorten paths, collapse whitespace.
export function cleanShellCommand(command: string): string {
  let out = unwrapShellCommand(command);
  // Strip redirections that are pure noise to a reader: `2>/dev/null`,
  // `>/dev/null`, `&>/dev/null`, `2>&1`.
  out = out.replace(/\s*(?:[0-9]?&?>{1,2}\s*\/dev\/null|[0-9]>&[0-9])/g, '');
  out = shortenPaths(out);
  out = out.replace(/\s+/g, ' ').trim();
  return truncate(out, MAX_PREVIEW_CHARS);
}

const READ_COMMANDS = new Set(['cat', 'bat', 'less', 'more', 'head', 'tail']);
const CHECK_COMMANDS = new Set(['which', 'type', 'command', 'whereis']);

// Best-effort friendly phrasing for a *single* simple command. Anything with
// shell operators (`&&`, `;`, `|`, subshells, newlines) is left as the cleaned
// command — summarizing compound pipelines risks describing them wrong, and a
// wrong summary is worse than an honest one.
export function summarizeShellCommand(command: string): string {
  const cleaned = cleanShellCommand(command);
  if (!cleaned) return cleaned;
  if (/[\n;&|`]|\$\(/.test(cleaned)) return cleaned;

  const tokens = cleaned.split(/\s+/);
  const program = tokens[0] ?? '';
  const args = tokens.slice(1).filter((token) => token.length > 0);
  const nonFlagArgs = args.filter((token) => !token.startsWith('-'));
  const lastTarget = nonFlagArgs.length ? nonFlagArgs[nonFlagArgs.length - 1] : '';

  if (READ_COMMANDS.has(program) && lastTarget) return `Reading ${lastTarget}`;
  if (CHECK_COMMANDS.has(program) && lastTarget) return `Checking ${lastTarget}`;
  if (program === 'ls') return lastTarget ? `Listing ${lastTarget}` : 'Listing files';
  if (program === 'find') return 'Searching for files';

  return cleaned;
}

// The single entry point ToolStep uses: shell tools get a friendly command
// summary; everything else falls back to the first meaningful input field with
// paths shortened.
export function toolStepPreview(step: ToolStepLike): string {
  const command = shellCommandOf(step);
  if (command != null) return summarizeShellCommand(command);
  return shortenPaths(previewInput(step.input));
}

// Pick a single representative string from a tool's input for the collapsed
// preview. Prefers well-known argument names, then any string/scalar, then a
// truncated JSON dump.
export function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) {
    return `${input.length} item${input.length === 1 ? '' : 's'}`;
  }
  if (typeof input === 'object') {
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
    try { return JSON.stringify(obj).slice(0, MAX_PREVIEW_CHARS); } catch { return ''; }
  }
  return '';
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
