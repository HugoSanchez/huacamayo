import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ComposioToolUsageInput {
  slug: string;
  name: string;
  description: string | null;
  toolkitSlug: string;
  toolkitName: string | null;
  inputParameters: Record<string, unknown>;
}

export interface ComposioNativeToolManifestTool {
  nativeName: string;
  toolSlug: string;
  toolkitSlug: string;
  name: string;
  description: string | null;
  inputParameters: Record<string, unknown>;
}

export interface ComposioNativeToolManifest {
  version: 1;
  generatedAt: string;
  tools: ComposioNativeToolManifestTool[];
}

interface UsageRow {
  tool_slug: string;
  toolkit_slug: string;
  name: string;
  description: string | null;
  input_parameters: string;
  success_count: number;
  last_used_at: string;
}

const DEFAULT_MANIFEST_LIMIT = 25;

// Slug we use to identify the synthetic "draft a message for review" tool when
// the orchestrator intercepts execute calls. Kept in this module so both the
// manifest writer and the bridge interceptor stay in sync.
export const PROPOSE_MESSAGE_DRAFT_SLUG = 'PROPOSE_MESSAGE_DRAFT';
export const PROPOSE_MESSAGE_DRAFT_NATIVE_NAME = 'propose_message_draft';

// Always-on tool description injected into every manifest write so Hermes
// registers the draft tool even before any real Composio call has happened.
// The tool doesn't belong to a Composio toolkit — execution is short-circuited
// in ComposioBridgeService.executeTool and held until the user approves or
// rejects from the inline widget. The result tells the caller exactly which
// values to use when actually dispatching the message.
const PROPOSE_MESSAGE_DRAFT_TOOL: ComposioNativeToolManifestTool = {
  nativeName: PROPOSE_MESSAGE_DRAFT_NATIVE_NAME,
  toolSlug: PROPOSE_MESSAGE_DRAFT_SLUG,
  toolkitSlug: 'verso',
  name: 'Propose message draft',
  description:
    [
      'Surface a draft message to the user for review before sending. Use this whenever the user asks you to send a message via any tool (Slack, Gmail, SMS, WhatsApp, Discord, Telegram, etc). Always call this BEFORE the underlying send tool — never send first.',
      '',
      'The result\'s `status` tells you what to do next:',
      '- status="pending_review": Slack and Gmail are handled directly by Verso. The user reviews and sends the message themselves from the widget — you are DONE. Do NOT call any send tool. Reply in one short sentence that you\'ve prepared it for review, then stop.',
      '- status="approved": (other channels) the user confirmed but you must dispatch the send yourself. Call the appropriate Composio tool for the channel (e.g. WHATSAPP_SEND_MESSAGE) using `final_to`, `final_body`, `final_subject`, `final_cc` from the result — NOT your original input, since the user may have edited them.',
      '- status="rejected": the user discarded the draft. Acknowledge briefly, do not send, and ask what they\'d like to do instead.',
    ].join('\n'),
  inputParameters: {
    type: 'object',
    required: ['channel', 'body'],
    properties: {
      channel: {
        type: 'string',
        description:
          'Toolkit slug of the channel ("slack", "gmail", "whatsapp", "telegram", "discord", etc.). Used to look up the widget\'s logo and label.',
      },
      channel_label: {
        type: 'string',
        description:
          'Optional display name for the channel (e.g. "WhatsApp"). Set this for channels Verso may not know about. Defaults to a title-cased `channel` otherwise.',
      },
      channel_logo_url: {
        type: 'string',
        description:
          'Optional URL to the channel\'s logo for the widget header. Only needed for channels that aren\'t in the connected toolkit catalog — Slack/Gmail and similar resolve automatically.',
      },
      to: {
        type: 'string',
        description:
          'Recipient identifier in whatever form the channel expects (email address, "#channel", user id, phone number, etc.). For Slack: channel name, channel id (Cxxx/Gxxx), user id (Uxxx) or DM id (Dxxx). Keep this precise — it is what the user will edit and what eventually gets sent.',
      },
      to_display: {
        type: 'string',
        description:
          'Human-readable name to show the user when `to` is an opaque id (e.g. "#design" or "Alice Wong"). The widget displays this instead of the raw id. Omit if `to` is already friendly.',
      },
      to_avatar_url: {
        type: 'string',
        description:
          'Optional avatar URL for a single-recipient message (Slack DM, SMS contact, etc.). Shown as a small circle next to the To field.',
      },
      cc: {
        type: 'string',
        description: 'Comma-separated secondary recipients. Mainly Gmail. Optional.',
      },
      subject: {
        type: 'string',
        description: 'Subject line. Mainly Gmail. Optional but recommended where the channel supports it.',
      },
      body: {
        type: 'string',
        description: 'Message body. Markdown is fine for chat-style channels; plain text or HTML for email.',
      },
      threadId: {
        type: 'string',
        description: 'Optional thread identifier for reply-style channels (Slack thread ts, email message id, etc.).',
      },
    },
    additionalProperties: false,
  },
};

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'verso', 'composio-tool-usage.sqlite');
}

export class ComposioToolUsageStore {
  private readonly storePath: string;
  private readonly db: DatabaseSync;

  constructor(storePath = process.env.VERSO_COMPOSIO_TOOL_USAGE_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.db = new DatabaseSync(this.storePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS composio_tool_usage (
        tool_slug TEXT PRIMARY KEY,
        toolkit_slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        input_parameters TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_composio_tool_usage_rank
        ON composio_tool_usage(success_count DESC, last_used_at DESC);
      CREATE INDEX IF NOT EXISTS idx_composio_tool_usage_toolkit
        ON composio_tool_usage(toolkit_slug);
    `);
  }

  get path(): string {
    return this.storePath;
  }

  recordSuccessfulUse(tool: ComposioToolUsageInput, usedAt = new Date().toISOString()): void {
    const slug = tool.slug.trim();
    const toolkitSlug = tool.toolkitSlug.trim().toLowerCase();
    const name = tool.name.trim() || slug;
    if (!slug || !toolkitSlug) return;

    const inputParameters = normalizeInputParameters(tool.inputParameters);
    this.db.prepare(`
      INSERT INTO composio_tool_usage (
        tool_slug,
        toolkit_slug,
        name,
        description,
        input_parameters,
        success_count,
        last_used_at
      )
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(tool_slug) DO UPDATE SET
        toolkit_slug = excluded.toolkit_slug,
        name = excluded.name,
        description = excluded.description,
        input_parameters = excluded.input_parameters,
        success_count = composio_tool_usage.success_count + 1,
        last_used_at = excluded.last_used_at
    `).run(
      slug,
      toolkitSlug,
      name,
      tool.description,
      JSON.stringify(inputParameters),
      usedAt,
    );
  }

  listManifestTools(activeToolkitSlugs: Iterable<string>, limit = DEFAULT_MANIFEST_LIMIT): ComposioNativeToolManifestTool[] {
    const active = normalizeToolkitSet(activeToolkitSlugs);
    if (active.size === 0 || limit <= 0) return [];

    const placeholders = Array.from(active, () => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT tool_slug, toolkit_slug, name, description, input_parameters, success_count, last_used_at
      FROM composio_tool_usage
      WHERE toolkit_slug IN (${placeholders})
      ORDER BY success_count DESC, last_used_at DESC, tool_slug ASC
      LIMIT ?
    `).all(...active, Math.floor(limit)) as unknown as UsageRow[];

    return rows
      .map(rowToManifestTool)
      .filter((tool): tool is ComposioNativeToolManifestTool => tool !== null);
  }

  writeManifest(
    manifestPath: string,
    activeToolkitSlugs: Iterable<string>,
    limit = DEFAULT_MANIFEST_LIMIT,
  ): ComposioNativeToolManifest {
    // Synthetic verso tools always lead so Hermes can register them even
    // when no Composio toolkit is connected yet. The propose-message-draft
    // tool is the first of these.
    const tools: ComposioNativeToolManifestTool[] = [
      PROPOSE_MESSAGE_DRAFT_TOOL,
      ...this.listManifestTools(activeToolkitSlugs, limit),
    ];
    const manifest: ComposioNativeToolManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      tools,
    };

    writeJsonAtomic(manifestPath, manifest);
    return manifest;
  }
}

export function nativeNameForComposioToolSlug(toolSlug: string): string {
  const normalized = toolSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!normalized) return 'composio_tool';
  return /^[a-z]/.test(normalized) ? normalized : `tool_${normalized}`;
}

function rowToManifestTool(row: UsageRow): ComposioNativeToolManifestTool | null {
  const parsedInputParameters = parseJsonRecord(row.input_parameters);
  if (!parsedInputParameters) return null;

  return {
    nativeName: nativeNameForComposioToolSlug(row.tool_slug),
    toolSlug: row.tool_slug,
    toolkitSlug: row.toolkit_slug,
    name: row.name,
    description: row.description,
    inputParameters: normalizeInputParameters(parsedInputParameters),
  };
}

function normalizeInputParameters(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...value };
  if (typeof normalized.type !== 'string') {
    normalized.type = 'object';
  }
  if (!normalized.properties || typeof normalized.properties !== 'object' || Array.isArray(normalized.properties)) {
    normalized.properties = {};
  }
  return normalized;
}

function normalizeToolkitSet(values: Iterable<string>): Set<string> {
  return new Set(
    Array.from(values)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
  if (existsSync(tmpPath)) {
    rmSync(tmpPath, { force: true });
  }
}
