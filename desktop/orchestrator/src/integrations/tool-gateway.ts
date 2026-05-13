import { createHash } from 'node:crypto';
import { ComposioBridgeService } from './composio-bridge.ts';
import type {
  RemoteBridgeActionCandidateView,
  RemoteBridgeActionExecutionView,
  RemoteBridgeActionGuidanceView,
  RemoteBridgeActionSchemaView,
} from './composio-bridge-client.ts';

export interface GatewayActionView {
  actionId: string;
  provider: 'composio';
  appSlug: string | null;
  appName: string | null;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  guidance: RemoteBridgeActionGuidanceView | null;
  connection: {
    connected: boolean | null;
    connectedAccountId: string | null;
    status: string | null;
  } | null;
}

export interface GatewayExecutionView {
  actionId: string;
  provider: 'composio';
  appSlug: string | null;
  appName: string | null;
  name: string;
  sanitizedArguments: Record<string, unknown>;
  warnings: string[];
  result: RemoteBridgeActionExecutionView;
}

interface CachedAction {
  actionId: string;
  provider: 'composio';
  providerAction: string;
  appSlug: string | null;
  appName: string | null;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  guidance: RemoteBridgeActionGuidanceView | null;
  connection: GatewayActionView['connection'];
  expiresAt: number;
}

export class ToolGatewayHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ToolGatewayHttpError';
    this.status = status;
  }
}

export class ToolGatewayService {
  private readonly actions = new Map<string, CachedAction>();

  constructor(private readonly composio: ComposioBridgeService) {}

  get configured(): boolean {
    return this.composio.configured;
  }

  async findActions(request: {
    app?: string;
    intent?: string;
    limit?: number;
  }): Promise<GatewayActionView[]> {
    const intent = request.intent?.trim();
    if (!intent) throw new ToolGatewayHttpError(400, 'Missing "intent"');

    const candidates = await this.composio.findActions({
      app: request.app,
      intent,
      limit: request.limit,
    });

    return candidates.map((candidate) => this.cacheAction(candidate));
  }

  async getActionSchema(actionId: string): Promise<GatewayActionView> {
    const action = this.getCachedAction(actionId);
    return toActionView(action);
  }

  async executeAction(actionId: string, args: Record<string, unknown> | undefined): Promise<GatewayExecutionView> {
    const action = this.getCachedAction(actionId);
    const startedAt = Date.now();
    const { arguments: sanitizedArguments, warnings } = sanitizeArguments(action.inputSchema, args ?? {});
    const result = await this.composio.executeAction(action.providerAction, sanitizedArguments);
    console.log(JSON.stringify({
      event: 'tool_gateway_execute',
      provider: action.provider,
      actionId: action.actionId,
      providerAction: action.providerAction,
      appSlug: action.appSlug,
      durationMs: Date.now() - startedAt,
      successful: result.successful,
      hasError: Boolean(result.error),
      logId: result.logId,
    }));

    return {
      actionId: action.actionId,
      provider: action.provider,
      appSlug: action.appSlug,
      appName: action.appName,
      name: action.name,
      sanitizedArguments,
      warnings,
      result,
    };
  }

  private cacheAction(candidate: RemoteBridgeActionCandidateView | RemoteBridgeActionSchemaView): GatewayActionView {
    const actionId = actionIdFor(candidate.provider, candidate.providerAction);
    const existing = this.actions.get(actionId);
    const action: CachedAction = {
      actionId,
      provider: candidate.provider,
      providerAction: candidate.providerAction,
      appSlug: candidate.appSlug,
      appName: candidate.appName,
      name: candidate.name,
      description: candidate.description,
      inputSchema: candidate.inputSchema,
      guidance: 'guidance' in candidate ? candidate.guidance : existing?.guidance ?? null,
      connection: 'connection' in candidate ? candidate.connection : existing?.connection ?? null,
      expiresAt: Date.now() + 30 * 60 * 1000,
    };
    this.actions.set(actionId, action);
    return toActionView(action);
  }

  private getCachedAction(actionId: string): CachedAction {
    const normalized = actionId.trim();
    const action = this.actions.get(normalized);
    if (!action || action.expiresAt <= Date.now()) {
      throw new ToolGatewayHttpError(404, `Unknown action_id "${normalized}". Call apps_find_action again.`);
    }
    return action;
  }
}

function toActionView(action: CachedAction): GatewayActionView {
  return {
    actionId: action.actionId,
    provider: action.provider,
    appSlug: action.appSlug,
    appName: action.appName,
    name: action.name,
    description: action.description,
    inputSchema: action.inputSchema,
    guidance: action.guidance,
    connection: action.connection,
  };
}

function actionIdFor(provider: string, providerAction: string): string {
  const digest = createHash('sha256')
    .update(`${provider}\0${providerAction}`)
    .digest('base64url')
    .slice(0, 18);
  return `act_${digest}`;
}

function sanitizeArguments(
  schema: Record<string, unknown> | null,
  args: Record<string, unknown>,
): { arguments: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const properties = asRecord(schema?.properties);
  const required = new Set(asStringArray(schema?.required));
  const sanitized: Record<string, unknown> = {};

  if (!properties) {
    for (const [key, value] of Object.entries(args)) {
      if (!isEmptyValue(value)) sanitized[key] = value;
    }
    applyGenericArgumentPolicies(sanitized, warnings);
    return { arguments: sanitized, warnings };
  }

  for (const [key, property] of Object.entries(properties)) {
    const propertySchema = asRecord(property);
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      const value = args[key];
      if (isEmptyValue(value) && !required.has(key)) {
        warnings.push(key === 'cursor' ? 'Dropped empty cursor.' : `Dropped empty argument "${key}".`);
        continue;
      }
      sanitized[key] = normalizeValueForSchema(key, value, propertySchema, warnings);
    } else if (required.has(key) && propertySchema && Object.prototype.hasOwnProperty.call(propertySchema, 'default')) {
      sanitized[key] = propertySchema.default;
    }
  }

  // Pass through args that aren't named in the schema's properties. Pre-
  // dropping silently caused SLACK_SEARCH_USERS calls to arrive at Composio
  // as {} (Composio returns "Either 'search_query' (or 'query'), or 'email'
  // parameter is required"). We can't reliably tell whether the schema we
  // cached is complete — `oneOf` / `anyOf` siblings, snake/camel mismatches,
  // and stale schemas all make this guess wrong. Composio is the source of
  // truth; let it validate and surface the real error if the arg is bad.
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      sanitized[key] = args[key];
      warnings.push(`Passed through unknown argument "${key}" (not in cached schema).`);
    }
  }

  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(sanitized, key)) {
      throw new ToolGatewayHttpError(400, `Missing required argument "${key}".`);
    }
  }

  applyGenericArgumentPolicies(sanitized, warnings);
  return { arguments: sanitized, warnings };
}

function normalizeValueForSchema(
  key: string,
  value: unknown,
  schema: Record<string, unknown> | null,
  warnings: string[],
): unknown {
  const types = schemaTypes(schema);
  if (types.has('number') || types.has('integer')) {
    const numberValue = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numberValue)) {
      throw new ToolGatewayHttpError(400, `Argument "${key}" must be a number.`);
    }
    let normalized = types.has('integer') ? Math.floor(numberValue) : numberValue;
    const minimum = typeof schema?.minimum === 'number' ? schema.minimum : undefined;
    const maximum = typeof schema?.maximum === 'number' ? schema.maximum : undefined;
    if (typeof minimum === 'number' && normalized < minimum) {
      normalized = minimum;
      warnings.push(`Clamped "${key}" to schema minimum ${minimum}.`);
    }
    if (typeof maximum === 'number' && normalized > maximum) {
      normalized = maximum;
      warnings.push(`Clamped "${key}" to schema maximum ${maximum}.`);
    }
    return normalized;
  }

  if (types.has('boolean')) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new ToolGatewayHttpError(400, `Argument "${key}" must be a boolean.`);
  }

  if (types.has('array') && !Array.isArray(value)) {
    throw new ToolGatewayHttpError(400, `Argument "${key}" must be an array.`);
  }
  if (types.has('object') && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new ToolGatewayHttpError(400, `Argument "${key}" must be an object.`);
  }
  if (types.has('string') && typeof value !== 'string') {
    return String(value);
  }

  return value;
}

function applyGenericArgumentPolicies(args: Record<string, unknown>, warnings: string[]): void {
  if ('cursor' in args && isEmptyValue(args.cursor)) {
    delete args.cursor;
    warnings.push('Dropped empty cursor.');
  }
  if ('page' in args && isEmptyValue(args.page)) {
    delete args.page;
    warnings.push('Dropped empty page.');
  }
  if ('cursor' in args && 'page' in args) {
    delete args.page;
    warnings.push('Dropped page because cursor and page are mutually exclusive pagination styles.');
  }
}

function schemaTypes(schema: Record<string, unknown> | null): Set<string> {
  const raw = schema?.type;
  if (typeof raw === 'string') return new Set([raw]);
  if (Array.isArray(raw)) {
    return new Set(raw.filter((item): item is string => typeof item === 'string'));
  }
  return new Set();
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
