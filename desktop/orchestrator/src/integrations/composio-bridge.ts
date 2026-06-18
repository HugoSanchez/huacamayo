import {
  RemoteBridgeHttpError,
  RemoteComposioBridgeClient,
  type RemoteBridgeSearchToolResult,
  type RemoteBridgeToolExecutionView,
  type RemoteBridgeToolSchemaView,
} from './composio-bridge-client.ts';
import { ManagedBackendClient } from './managed-backend-client.ts';
import {
  PROPOSE_MESSAGE_DRAFT_SLUG,
  type ComposioToolUsageStore,
} from '../http/composio-tool-usage-store.ts';

export interface ComposioBridgeSearchToolView extends RemoteBridgeSearchToolResult {}
export interface ComposioBridgeToolSchemaView extends RemoteBridgeToolSchemaView {}
export interface ComposioBridgeToolExecutionView extends RemoteBridgeToolExecutionView {}

export class ComposioBridgeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ComposioBridgeHttpError';
    this.status = status;
  }
}

export interface ComposioBridgeUsageOptions {
  store: ComposioToolUsageStore;
  manifestPath: string;
  getActiveToolkitSlugs: () => string[];
  manifestLimit?: number;
}

export interface ToolUsageMetadata {
  slug: string;
  name: string | null;
  description: string | null;
  toolkitSlug: string | null;
  toolkitName: string | null;
}

/**
 * Local MCP-facing Composio bridge. The desktop never talks to Composio
 * directly; it forwards search/schema/execute calls to the authenticated
 * backend bridge so the Composio project API key stays server-side.
 */

// Maximum time we'll hold a propose_message_draft tool call open while waiting
// for the user to approve or reject. After this, the call resolves with a
// timeout rejection so Hermes doesn't sit forever and so we don't pin
// resources on a forgotten widget.
const DRAFT_HOLD_TIMEOUT_MS = 10 * 60 * 1000;

// Channels where Verso dispatches the send itself (cleanest UX). For these the
// draft tool returns immediately with `pending_review` — the model ends its
// turn and the widget's Send button fires an independent /drafts/send call, so
// the model never re-engages on send. Every other channel uses the held
// pattern below, where the agent dispatches the send after approval.
export const NATIVE_DRAFT_CHANNELS = new Set(['gmail', 'slack']);

// Outcome of a HELD (generic-channel) draft call, fed back to Hermes as the
// tool result. Native channels never produce one of these — they return
// `pending_review` immediately instead.
// - "approved": user confirmed; agent must dispatch the send itself using final_*.
// - "rejected": user discarded the draft.
export type DraftResolution =
  | {
      status: 'approved';
      was_edited: boolean;
      channel: string;
      final_to: string;
      final_cc: string;
      final_subject: string;
      final_body: string;
      final_thread_id: string;
    }
  | { status: 'rejected'; reason: 'discarded_by_user' | 'timeout' | 'session_ended' };

interface PendingDraftEntry {
  resolve: (resolution: DraftResolution) => void;
  timer: NodeJS.Timeout;
  args: Record<string, unknown>;
}

// Process-lifetime registry of in-flight draft holds, keyed by a deterministic
// hash of the agent's call arguments. Both the orchestrator (here) and the
// chat UI compute the same hash from the same args, so they agree on the key
// without any explicit coordination.
const pendingDrafts = new Map<string, PendingDraftEntry>();

/**
 * Deterministic id for a draft, derived from the agent's tool args. The chat
 * UI computes the same id from the same args (via stableStringify + FNV-1a)
 * so neither side needs to coordinate with the other. The hash space is
 * 32-bit, which is fine for the handful of concurrent drafts we'll ever see.
 */
export function draftIdForArgs(args: Record<string, unknown>): string {
  const canonical = stableStringify(args);
  return `draft_${fnv1a32(canonical)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function resolvePendingDraft(draftId: string, resolution: DraftResolution): boolean {
  const entry = pendingDrafts.get(draftId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingDrafts.delete(draftId);
  entry.resolve(resolution);
  return true;
}

export function rejectAllPendingDrafts(reason: 'session_ended'): void {
  for (const [draftId, entry] of pendingDrafts) {
    clearTimeout(entry.timer);
    pendingDrafts.delete(draftId);
    entry.resolve({ status: 'rejected', reason });
  }
}

export class ComposioBridgeService {
  private readonly bridgeClient: RemoteComposioBridgeClient;
  private readonly usage: ComposioBridgeUsageOptions | null;
  private readonly toolMetadataBySlug = new Map<string, ToolUsageMetadata>();

  constructor(managedBackend: ManagedBackendClient, usage: ComposioBridgeUsageOptions | null = null) {
    this.bridgeClient = new RemoteComposioBridgeClient(managedBackend);
    this.usage = usage;
  }

  get configured(): boolean {
    return this.bridgeClient.configured;
  }

  async searchTools(query: string, toolkits?: string[]): Promise<ComposioBridgeSearchToolView[]> {
    this.assertConfigured();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new ComposioBridgeHttpError(400, 'Missing "query"');

    try {
      const results = await this.bridgeClient.searchTools(normalizedQuery, toolkits);
      results.forEach((tool) => this.rememberToolMetadata(tool));
      return results;
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  async getToolSchemas(toolSlugs: string[]): Promise<ComposioBridgeToolSchemaView[]> {
    this.assertConfigured();
    const wanted = Array.from(new Set(toolSlugs.map((slug) => slug.trim()).filter(Boolean)));
    if (wanted.length === 0) throw new ComposioBridgeHttpError(400, 'Missing "toolSlugs"');

    try {
      const schemas = await this.bridgeClient.getToolSchemas(wanted);
      schemas.forEach((tool) => this.rememberToolMetadata(tool));
      return schemas;
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  async executeTool(
    toolSlug: string,
    arguments_: Record<string, unknown>,
    opts: { recordUsage?: boolean } = {},
  ): Promise<ComposioBridgeToolExecutionView> {
    const slug = toolSlug.trim();
    if (!slug) throw new ComposioBridgeHttpError(400, 'Missing "toolSlug"');
    const argumentRecord = asRecord(arguments_);
    if (!argumentRecord) {
      throw new ComposioBridgeHttpError(400, 'Missing required object "arguments".');
    }

    // propose_message_draft never reaches the remote bridge.
    if (slug.toUpperCase() === PROPOSE_MESSAGE_DRAFT_SLUG) {
      const channel = typeof argumentRecord.channel === 'string'
        ? argumentRecord.channel.trim().toLowerCase()
        : '';

      // Native channels (Slack/Gmail): return immediately so the model wraps
      // up its turn ("I've prepared it for review"). Verso dispatches the
      // actual send when the user clicks Send in the widget — the model is
      // not involved, which is what makes that flow feel instant.
      if (NATIVE_DRAFT_CHANNELS.has(channel)) {
        return {
          data: {
            status: 'pending_review',
            channel,
            note: 'Draft surfaced to the user for review in Verso. The user will edit and send (or discard) it themselves, and Verso handles the actual send for this channel. Do NOT call any send tool. Reply in one short sentence that you have prepared it for review.',
          },
          error: null,
          logId: null,
        };
      }

      // Generic channels: hold the call open until the user approves/rejects,
      // then hand the final values back so the agent dispatches the send.
      const resolution = await holdDraftForReview(argumentRecord);
      return {
        data: resolution,
        error: null,
        logId: null,
      };
    }

    this.assertConfigured();
    try {
      const result = await this.bridgeClient.executeTool(slug, argumentRecord);
      if (!result.error && opts.recordUsage !== false) {
        // Background ingestion fetches pass recordUsage:false so read/list
        // tools are not surfaced/ranked in the visible agent's tool manifest.
        await this.recordSuccessfulToolUse(slug).catch(() => undefined);
      }
      return result;
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  private assertConfigured(): void {
    if (this.bridgeClient.configured) return;
    throw new ComposioBridgeHttpError(503, 'Managed backend URL is not configured.');
  }

  private async recordSuccessfulToolUse(toolSlug: string): Promise<void> {
    if (!this.usage) return;

    const schemas = await this.getToolSchemas([toolSlug]);
    const usageInput = buildComposioToolUsageInput(
      toolSlug,
      schemas[0] ?? null,
      this.toolMetadataBySlug.get(normalizeToolSlugKey(toolSlug)) ?? null,
      this.usage.getActiveToolkitSlugs(),
    );
    if (!usageInput) return;

    this.usage.store.recordSuccessfulUse(usageInput);
    const activeToolkits = new Set(this.usage.getActiveToolkitSlugs());
    activeToolkits.add(usageInput.toolkitSlug);
    this.usage.store.writeManifest(
      this.usage.manifestPath,
      activeToolkits,
      this.usage.manifestLimit,
    );
  }

  private rememberToolMetadata(tool: RemoteBridgeSearchToolResult | RemoteBridgeToolSchemaView): void {
    const slug = cleanString(tool.slug);
    if (!slug) return;
    const key = normalizeToolSlugKey(slug);
    const existing = this.toolMetadataBySlug.get(key);
    this.toolMetadataBySlug.set(key, {
      slug,
      name: usefulMetadataName(tool) ?? existing?.name ?? null,
      description: usefulDescription(tool.description) ?? existing?.description ?? null,
      toolkitSlug: normalizeToolkitSlug(tool.toolkitSlug) ?? existing?.toolkitSlug ?? null,
      toolkitName: cleanString(tool.toolkitName) ?? existing?.toolkitName ?? null,
    });
  }
}

function holdDraftForReview(args: Record<string, unknown>): Promise<DraftResolution> {
  const draftId = draftIdForArgs(args);

  // If the same draft is already pending (agent retried with the exact same
  // args), reject the older hold so this new one supersedes it — otherwise
  // the old timer would fire later and leak a stale resolution.
  const existing = pendingDrafts.get(draftId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.resolve({ status: 'rejected', reason: 'session_ended' });
    pendingDrafts.delete(draftId);
  }

  return new Promise<DraftResolution>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingDrafts.get(draftId)) {
        pendingDrafts.delete(draftId);
        resolve({ status: 'rejected', reason: 'timeout' });
      }
    }, DRAFT_HOLD_TIMEOUT_MS);
    pendingDrafts.set(draftId, { resolve, timer, args });
  });
}

function mapRemoteBridgeError(error: unknown): Error {
  if (error instanceof RemoteBridgeHttpError) {
    return new ComposioBridgeHttpError(error.status, error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function buildComposioToolUsageInput(
  requestedToolSlug: string,
  schema: RemoteBridgeToolSchemaView | null,
  metadata: ToolUsageMetadata | null,
  activeToolkitSlugs: Iterable<string>,
) {
  const slug = cleanString(schema?.slug) ?? cleanString(metadata?.slug) ?? requestedToolSlug.trim();
  if (!slug) return null;

  const activeToolkits = Array.from(activeToolkitSlugs)
    .map(normalizeToolkitSlug)
    .filter((toolkitSlug): toolkitSlug is string => toolkitSlug !== null);
  const toolkitSlug = normalizeToolkitSlug(schema?.toolkitSlug)
    ?? normalizeToolkitSlug(metadata?.toolkitSlug)
    ?? inferToolkitSlugFromToolSlug(slug, activeToolkits);
  if (!toolkitSlug) return null;

  const inputParameters = asRecord(schema?.inputParameters) ?? permissiveInputParameters();
  return {
    slug,
    name: usefulSchemaName(schema) ?? cleanString(metadata?.name) ?? slug,
    description: usefulDescription(schema?.description) ?? usefulDescription(metadata?.description),
    toolkitSlug,
    toolkitName: cleanString(schema?.toolkitName) ?? cleanString(metadata?.toolkitName),
    inputParameters,
  };
}

function inferToolkitSlugFromToolSlug(toolSlug: string, activeToolkitSlugs: string[]): string | null {
  const normalizedToolSlug = normalizeToolSlugPrefix(toolSlug);
  return activeToolkitSlugs.find((toolkitSlug) => {
    const prefix = `${normalizeToolSlugPrefix(toolkitSlug)}_`;
    return normalizedToolSlug.startsWith(prefix);
  }) ?? null;
}

function permissiveInputParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function normalizeToolSlugKey(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeToolSlugPrefix(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

function normalizeToolkitSlug(value: unknown): string | null {
  const cleaned = cleanString(value);
  return cleaned ? cleaned.toLowerCase() : null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function usefulDescription(value: unknown): string | null {
  const description = cleanString(value);
  if (!description) return null;
  if (description.toLowerCase().includes('schema unavailable from composio')) return null;
  return description;
}

function usefulSchemaName(schema: RemoteBridgeToolSchemaView | null): string | null {
  if (!schema) return null;
  if (!schema.inputParameters && !schema.toolkitSlug) return null;
  return cleanString(schema.name);
}

function usefulMetadataName(tool: RemoteBridgeSearchToolResult | RemoteBridgeToolSchemaView): string | null {
  if ('inputParameters' in tool && !tool.inputParameters && !tool.toolkitSlug) return null;
  return cleanString(tool.name);
}
