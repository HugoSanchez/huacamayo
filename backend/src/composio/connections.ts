import { ComposioServiceError } from './errors.ts';
import type {
  BridgeConnectionRequestView,
  BridgeConnectionView,
  ComposioClient,
  ConnectedAccountItem,
} from './contracts.ts';
import type { ComposioToolkitCatalog } from './toolkit-catalog.ts';
import { mapConnectedAccountStatus, normalizeUserId } from './shared.ts';

export interface ComposioConnectionsOptions {
  client: ComposioClient;
  catalog: ComposioToolkitCatalog;
  onConnectionsChanged?: (userId: string) => void;
}

/** Owns connected-account lifecycle and the user-ownership security boundary. */
export class ComposioConnections {
  constructor(private readonly options: ComposioConnectionsOptions) {}

  async list(userId: string): Promise<BridgeConnectionView[]> {
    const normalizedUserId = normalizeUserId(userId);
    const accounts: ConnectedAccountItem[] = [];
    for await (const page of this.accountPages(normalizedUserId, ['ACTIVE', 'INACTIVE'])) {
      accounts.push(...page);
    }
    const items = await Promise.all(accounts
      .filter((item) => !item.isDisabled)
      .map(async (item) => {
        const metadata = await this.options.catalog.getMetadata(item.toolkit.slug);
        return {
          connectedAccountId: item.id,
          toolkitSlug: item.toolkit.slug,
          toolkitName: metadata.toolkitName,
          logoUrl: metadata.logoUrl,
          status: item.status === 'INACTIVE' ? 'inactive' : 'active',
        } satisfies BridgeConnectionView;
      }));
    return items.sort((left, right) => left.toolkitName.localeCompare(right.toolkitName));
  }

  async delete(userId: string, connectedAccountId: string): Promise<void> {
    const normalizedUserId = normalizeUserId(userId);
    const id = connectedAccountId.trim();
    if (!id) throw new ComposioServiceError(400, 'Missing "connectedAccountId"');

    // The SDK delete endpoint accepts an id without checking its owner. Verify
    // membership under the authenticated user before performing any mutation.
    if (!await this.userOwnsAccount(normalizedUserId, id, ['ACTIVE', 'INACTIVE'])) {
      throw new ComposioServiceError(404, `Connected account "${id}" not found.`);
    }

    // Disable makes the UI update immediately while Composio's soft delete
    // converges. Deletion remains the security-critical operation.
    try {
      await this.options.client.connectedAccounts.disable(id);
    } catch {
      // Best effort only; continue revoking the account.
    }
    await this.options.client.connectedAccounts.delete(id);
    this.options.onConnectionsChanged?.(normalizedUserId);
  }

  async request(userId: string, toolkitInput: string, callbackUrl: string): Promise<BridgeConnectionRequestView> {
    const normalizedUserId = normalizeUserId(userId);
    const toolkit = await this.options.catalog.resolve(toolkitInput);
    const activeConnections = await this.list(normalizedUserId);
    const existing = activeConnections.find((connection) =>
      connection.toolkitSlug === toolkit.slug && connection.status === 'active');
    if (existing) {
      return {
        id: existing.connectedAccountId,
        toolkitSlug: existing.toolkitSlug,
        toolkitName: existing.toolkitName,
        logoUrl: existing.logoUrl,
        status: 'connected',
        redirectUrl: null,
        connectedAccountId: existing.connectedAccountId,
        errorMessage: null,
      };
    }

    const session = await this.options.client.create(normalizedUserId, {
      toolkits: [toolkit.slug],
      manageConnections: false,
    });
    if (!session.authorize) throw new ComposioServiceError(502, 'Composio returned an invalid connection session.');
    const request = await session.authorize(toolkit.slug, { callbackUrl });
    return {
      id: request.id,
      toolkitSlug: toolkit.slug,
      toolkitName: toolkit.name,
      logoUrl: toolkit.logoUrl,
      status: mapConnectedAccountStatus(request.status),
      redirectUrl: request.redirectUrl ?? null,
      connectedAccountId: request.status === 'ACTIVE' ? request.id : null,
      errorMessage: null,
    };
  }

  async getRequest(userId: string, requestId: string): Promise<BridgeConnectionRequestView> {
    const normalizedUserId = normalizeUserId(userId);
    const id = requestId.trim();
    if (!id) throw new ComposioServiceError(400, 'Missing "requestId"');

    // `connectedAccounts.get(id)` is project-scoped and does not enforce the
    // authenticated app user's ownership. Verify against the user's complete,
    // paginated account list first and use one indistinguishable 404 for both a
    // foreign id and a missing id so callers cannot probe other users' requests.
    if (!await this.userOwnsAccount(normalizedUserId, id)) {
      throw new ComposioServiceError(404, `Connection request "${id}" not found.`);
    }

    const connectedAccount = await this.options.client.connectedAccounts.get(id);
    const metadata = await this.options.catalog.getMetadata(connectedAccount.toolkit.slug);
    return {
      id: connectedAccount.id,
      toolkitSlug: connectedAccount.toolkit.slug,
      toolkitName: metadata.toolkitName,
      logoUrl: metadata.logoUrl,
      status: mapConnectedAccountStatus(connectedAccount.status),
      redirectUrl: null,
      connectedAccountId: connectedAccount.status === 'ACTIVE' ? connectedAccount.id : null,
      errorMessage: connectedAccount.statusReason ?? null,
    };
  }

  private async userOwnsAccount(
    userId: string,
    connectedAccountId: string,
    statuses?: string[],
  ): Promise<boolean> {
    for await (const page of this.accountPages(userId, statuses)) {
      if (page.some((item) => item.id === connectedAccountId)) return true;
    }
    return false;
  }

  private async *accountPages(
    userId: string,
    statuses?: string[],
  ): AsyncGenerator<ConnectedAccountItem[]> {
    let cursor: string | undefined;
    const visitedCursors = new Set<string>();
    while (true) {
      const response = await this.options.client.connectedAccounts.list({
        userIds: [userId],
        ...(statuses ? { statuses } : {}),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      yield response.items;
      const nextCursor = response.nextCursor?.trim() || undefined;
      if (!nextCursor || visitedCursors.has(nextCursor)) return;
      visitedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
}
