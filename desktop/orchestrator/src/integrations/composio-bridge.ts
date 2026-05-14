import {
  RemoteBridgeHttpError,
  RemoteComposioBridgeClient,
  type RemoteBridgeSearchToolResult,
  type RemoteBridgeToolExecutionView,
  type RemoteBridgeToolSchemaView,
} from './composio-bridge-client.ts';
import { ManagedBackendClient } from './managed-backend-client.ts';

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

/**
 * Local MCP-facing Composio bridge. The desktop never talks to Composio
 * directly; it forwards search/schema/execute calls to the authenticated
 * backend bridge so the Composio project API key stays server-side.
 */
export class ComposioBridgeService {
  private readonly bridgeClient: RemoteComposioBridgeClient;

  constructor(managedBackend: ManagedBackendClient) {
    this.bridgeClient = new RemoteComposioBridgeClient(managedBackend);
  }

  get configured(): boolean {
    return this.bridgeClient.configured;
  }

  async searchTools(query: string, toolkits?: string[]): Promise<ComposioBridgeSearchToolView[]> {
    this.assertConfigured();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new ComposioBridgeHttpError(400, 'Missing "query"');

    try {
      return await this.bridgeClient.searchTools(normalizedQuery, toolkits);
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  async getToolSchemas(toolSlugs: string[]): Promise<ComposioBridgeToolSchemaView[]> {
    this.assertConfigured();
    const wanted = Array.from(new Set(toolSlugs.map((slug) => slug.trim()).filter(Boolean)));
    if (wanted.length === 0) throw new ComposioBridgeHttpError(400, 'Missing "toolSlugs"');

    try {
      return await this.bridgeClient.getToolSchemas(wanted);
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  async executeTool(
    toolSlug: string,
    arguments_: Record<string, unknown>,
  ): Promise<ComposioBridgeToolExecutionView> {
    this.assertConfigured();
    const slug = toolSlug.trim();
    if (!slug) throw new ComposioBridgeHttpError(400, 'Missing "toolSlug"');
    const argumentRecord = asRecord(arguments_);
    if (!argumentRecord) {
      throw new ComposioBridgeHttpError(400, 'Missing required object "arguments".');
    }

    try {
      return await this.bridgeClient.executeTool(slug, argumentRecord);
    } catch (error) {
      throw mapRemoteBridgeError(error);
    }
  }

  private assertConfigured(): void {
    if (this.bridgeClient.configured) return;
    throw new ComposioBridgeHttpError(503, 'Managed backend URL is not configured.');
  }
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
