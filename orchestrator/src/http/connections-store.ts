import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ConnectionRequestStatus = 'pending' | 'connected' | 'failed' | 'expired';
export type ConnectionStatus = 'active' | 'inactive';

export interface ConnectionRequestRecord {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionRequestStatus;
  redirectUrl: string | null;
  connectedAccountId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionRecord {
  connectedAccountId: string;
  toolkitSlug: string;
  toolkitName: string;
  logoUrl: string | null;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionsStoreShape {
  vervoUserId: string | null;
  requests: ConnectionRequestRecord[];
  connections: ConnectionRecord[];
}

function defaultStorePath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Vervo', 'connections.json');
}

export class ConnectionsStore {
  private readonly storePath: string;

  private state: ConnectionsStoreShape;

  constructor(storePath = process.env.VERVO_CONNECTIONS_STORE_PATH?.trim() || defaultStorePath()) {
    this.storePath = storePath;
    this.state = this.load();
  }

  get path(): string {
    return this.storePath;
  }

  getVervoUserId(): string | null {
    return this.state.vervoUserId;
  }

  ensureVervoUserId(): string {
    if (this.state.vervoUserId) return this.state.vervoUserId;
    this.state.vervoUserId = randomUUID();
    this.save();
    return this.state.vervoUserId;
  }

  listConnections(): ConnectionRecord[] {
    return [...this.state.connections].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  findActiveConnectionByToolkit(toolkitSlug: string): ConnectionRecord | null {
    return this.state.connections.find((connection) =>
      connection.toolkitSlug === toolkitSlug && connection.status === 'active') ?? null;
  }

  upsertConnection(record: ConnectionRecord): ConnectionRecord {
    const existingIndex = this.state.connections.findIndex((item) => item.connectedAccountId === record.connectedAccountId);
    if (existingIndex >= 0) {
      this.state.connections[existingIndex] = record;
    } else {
      this.state.connections.push(record);
    }
    this.save();
    return record;
  }

  getRequest(requestId: string): ConnectionRequestRecord | null {
    return this.state.requests.find((request) => request.id === requestId) ?? null;
  }

  listRequests(): ConnectionRequestRecord[] {
    return [...this.state.requests].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  upsertRequest(record: ConnectionRequestRecord): ConnectionRequestRecord {
    const existingIndex = this.state.requests.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) {
      this.state.requests[existingIndex] = record;
    } else {
      this.state.requests.push(record);
    }
    this.save();
    return record;
  }

  private load(): ConnectionsStoreShape {
    if (!existsSync(this.storePath)) {
      return {
        vervoUserId: null,
        requests: [],
        connections: [],
      };
    }

    try {
      const raw = readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ConnectionsStoreShape>;
      return {
        vervoUserId: typeof parsed.vervoUserId === 'string' ? parsed.vervoUserId : null,
        requests: Array.isArray(parsed.requests)
          ? parsed.requests.filter(isValidRequestRecord)
          : [],
        connections: Array.isArray(parsed.connections)
          ? parsed.connections.filter(isValidConnectionRecord)
          : [],
      };
    } catch {
      return {
        vervoUserId: null,
        requests: [],
        connections: [],
      };
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmpPath = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.storePath);
  }
}

function isValidRequestRecord(value: unknown): value is ConnectionRequestRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ConnectionRequestRecord>;
  return typeof candidate.id === 'string'
    && typeof candidate.toolkitSlug === 'string'
    && typeof candidate.toolkitName === 'string'
    && isNullableString(candidate.logoUrl)
    && isNullableString(candidate.redirectUrl)
    && isNullableString(candidate.connectedAccountId)
    && isNullableString(candidate.errorMessage)
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && isRequestStatus(candidate.status);
}

function isValidConnectionRecord(value: unknown): value is ConnectionRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ConnectionRecord>;
  return typeof candidate.connectedAccountId === 'string'
    && typeof candidate.toolkitSlug === 'string'
    && typeof candidate.toolkitName === 'string'
    && isNullableString(candidate.logoUrl)
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && isConnectionStatus(candidate.status);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRequestStatus(value: unknown): value is ConnectionRequestStatus {
  return value === 'pending' || value === 'connected' || value === 'failed' || value === 'expired';
}

function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return value === 'active' || value === 'inactive';
}
