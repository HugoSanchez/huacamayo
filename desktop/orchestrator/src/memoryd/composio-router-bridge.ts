import { Composio } from '@composio/core';
import type { IngestionBridge } from '../http/ingestion-source.ts';

/**
 * Headless IngestionBridge over the Composio SDK tool-router session — the
 * SAME execution path verso-backend uses (backend/src/composio/service.ts):
 * client.create(userId) → session.execute(slug, args). This surface serves
 * both native toolkits (GMAIL_*, SLACK_*, GOOGLEDRIVE_*) and MCP-type
 * toolkits (GRANOLA_MCP_*), which the raw REST tools/execute endpoint does
 * not. Pin @composio/core to the backend's version so behavior matches.
 *
 * No schema precheck here (the backend does one for agent-facing calls): the
 * adapters send fixed, known-good arguments, and Granola's schemas are
 * malformed upstream anyway — the backend itself skips the precheck for them.
 */

const SESSION_TTL_MS = 10 * 60 * 1000;

interface ToolRouterSessionLike {
  execute(toolSlug: string, arguments_: Record<string, unknown>): Promise<unknown>;
}

export class ComposioRouterBridge implements IngestionBridge {
  private readonly client: Composio;
  private readonly userId: string;
  private session: ToolRouterSessionLike | null = null;
  private sessionExpiresAt = 0;
  private sessionPromise: Promise<ToolRouterSessionLike> | null = null;

  constructor(opts: { apiKey: string; userId: string }) {
    this.client = new Composio({ apiKey: opts.apiKey });
    this.userId = opts.userId;
  }

  async executeTool(
    toolSlug: string,
    arguments_: Record<string, unknown>,
    _opts?: { recordUsage?: boolean },
  ): Promise<{ data: unknown; error: string | null; logId: string | null }> {
    const session = await this.getSession();
    const result = await session.execute(toolSlug, arguments_);
    const record = asRecord(result);
    return {
      data: record && 'data' in record ? record.data : result ?? null,
      error: record ? asString(record.error) : null,
      logId: record ? asString(record.logId ?? record.log_id) : null,
    };
  }

  private async getSession(): Promise<ToolRouterSessionLike> {
    if (this.session && this.sessionExpiresAt > Date.now()) return this.session;
    if (this.sessionPromise) return this.sessionPromise;

    this.sessionPromise = (async () => {
      const session = await (this.client as unknown as {
        create(userId: string, opts: Record<string, unknown>): Promise<ToolRouterSessionLike>;
      }).create(this.userId, { manageConnections: false });
      this.session = session;
      this.sessionExpiresAt = Date.now() + SESSION_TTL_MS;
      return session;
    })().finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
