import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChatActivityStep,
  ChatMessageRecord,
} from './chat-store.ts';

interface HermesMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number;
}

interface ReadHermesMessagesOptions {
  hermesHome: string | null;
  hermesSessionId: string | null;
  versoSessionId: string;
  localMessages: ChatMessageRecord[];
}

interface MapHermesRowsOptions {
  hermesSessionId: string;
  versoSessionId: string;
  localMessages?: ChatMessageRecord[];
}

interface MutableChatMessageRecord extends ChatMessageRecord {
  steps?: ChatActivityStep[];
}

export function readHermesChatMessages(
  options: ReadHermesMessagesOptions,
): ChatMessageRecord[] | null {
  if (!options.hermesHome || !options.hermesSessionId) return null;

  const dbPath = join(options.hermesHome, 'state.db');
  if (!existsSync(dbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC
    `).all(options.hermesSessionId) as unknown as HermesMessageRow[];

    if (rows.length === 0) return null;

    const messages = mapHermesRowsToChatMessages(rows, {
      hermesSessionId: options.hermesSessionId,
      versoSessionId: options.versoSessionId,
      localMessages: options.localMessages,
    });
    return messages.length > 0 ? messages : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function mapHermesRowsToChatMessages(
  rows: HermesMessageRow[],
  options: MapHermesRowsOptions,
): ChatMessageRecord[] {
  const hermesMessages = buildHermesTranscript(rows, options)
    .filter((message) => message.content.trim().length > 0 || (message.steps?.length ?? 0) > 0)
    .map((message) => ({
      ...message,
      steps: message.steps && message.steps.length > 0 ? message.steps : undefined,
    }));

  if (options.localMessages && options.localMessages.length > 0) {
    return mergeWithLocalMessageSkeleton(hermesMessages, options.localMessages);
  }

  return hermesMessages;
}

function buildHermesTranscript(
  rows: HermesMessageRow[],
  options: MapHermesRowsOptions,
): MutableChatMessageRecord[] {
  const messages: MutableChatMessageRecord[] = [];
  let currentAssistant: MutableChatMessageRecord | null = null;
  let currentTurnStartedAt: number | undefined;

  const ensureAssistant = (row: HermesMessageRow, forceNew = false): MutableChatMessageRecord => {
    if (currentAssistant && !forceNew) return currentAssistant;

    const timestamp = timestampToMs(row.timestamp);
    currentAssistant = {
      id: `hermes-${options.hermesSessionId}-assistant-${row.id}`,
      sessionId: options.versoSessionId,
      role: 'assistant',
      content: '',
      createdAt: timestampToIso(row.timestamp),
      startedAt: forceNew ? timestamp : (currentTurnStartedAt ?? timestamp),
      endedAt: timestamp,
      steps: [],
    };
    messages.push(currentAssistant);
    return currentAssistant;
  };

  for (const row of rows) {
    const timestamp = timestampToMs(row.timestamp);

    if (row.role === 'user') {
      currentAssistant = null;
      currentTurnStartedAt = timestamp;

      const content = row.content ?? '';
      if (content.trim().length === 0) continue;
      messages.push({
        id: `hermes-${options.hermesSessionId}-${row.id}`,
        sessionId: options.versoSessionId,
        role: 'user',
        content,
        createdAt: timestampToIso(row.timestamp),
      });
      continue;
    }

    if (row.role === 'assistant') {
      const toolCalls = parseToolCalls(row.tool_calls);
      const content = row.content ?? '';

      if (toolCalls.length === 0 && content.trim().length === 0) continue;

      const startsNewImplicitTurn = toolCalls.length > 0
        && hasAssistantContent(currentAssistant);
      const assistant = ensureAssistant(row, startsNewImplicitTurn);
      assistant.endedAt = timestamp;
      assistant.createdAt = timestampToIso(row.timestamp);

      if (toolCalls.length > 0) {
        if (content.trim().length > 0) {
          assistant.steps = [...(assistant.steps ?? []), { type: 'text', text: content }];
        }
        assistant.steps = [
          ...(assistant.steps ?? []),
          ...toolCalls.map(toolCallToStep),
        ];
      } else if (assistant.content.trim().length > 0) {
        assistant.content = `${assistant.content}\n\n${content}`;
      } else {
        assistant.content = content;
      }
      continue;
    }

    if (row.role === 'tool') {
      const assistant = ensureAssistant(row);
      assistant.endedAt = timestamp;
      assistant.createdAt = timestampToIso(row.timestamp);
      attachToolResult(
        assistant,
        row.tool_call_id ?? undefined,
        row.content ?? '',
        row.tool_name ?? undefined,
      );
    }
  }

  return messages;
}

function hasAssistantContent(message: MutableChatMessageRecord | null): boolean {
  return (message?.content.trim().length ?? 0) > 0;
}

function parseToolCalls(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function toolCallToStep(toolCall: unknown): ChatActivityStep {
  const record = asRecord(toolCall) ?? {};
  const fn = asRecord(record.function) ?? {};
  const id = stringValue(record.call_id) ?? stringValue(record.id);
  const name = stringValue(fn.name) ?? stringValue(record.name) ?? 'tool';
  const input = parseJsonMaybe(fn.arguments ?? record.arguments ?? record.input);

  return {
    type: 'tool',
    ...(id ? { id } : {}),
    name,
    ...(input === undefined ? {} : { input }),
  };
}

function attachToolResult(
  assistant: MutableChatMessageRecord,
  toolUseId: string | undefined,
  result: string,
  fallbackName: string | undefined,
): void {
  const steps = [...(assistant.steps ?? [])];

  if (toolUseId) {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step.type === 'tool' && step.id === toolUseId && !step.result) {
        steps[index] = { ...step, result };
        assistant.steps = steps;
        return;
      }
    }
  }

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.type === 'tool' && !step.result) {
      steps[index] = { ...step, result };
      assistant.steps = steps;
      return;
    }
  }

  steps.push({
    type: 'tool',
    ...(toolUseId ? { id: toolUseId } : {}),
    name: fallbackName || 'tool',
    result,
  });
  assistant.steps = steps;
}

function mergeWithLocalMessageSkeleton(
  hermesMessages: ChatMessageRecord[],
  localMessages: ChatMessageRecord[],
): ChatMessageRecord[] {
  const hermesAssistantMessages = hermesMessages.filter((message) => message.role === 'assistant');
  const merged: ChatMessageRecord[] = [];
  let assistantCursor = 0;
  let lastUserStartedAt: number | undefined;

  for (const localMessage of localMessages) {
    if (localMessage.role === 'user') {
      lastUserStartedAt = isoToMs(localMessage.createdAt);
      merged.push(localMessage);
      continue;
    }

    const hermesMessage = hermesAssistantMessages[assistantCursor] ?? null;
    if (hermesMessage) assistantCursor += 1;

    const endedAt = isoToMs(localMessage.createdAt) ?? hermesMessage?.endedAt;
    const startedAt = lastUserStartedAt ?? hermesMessage?.startedAt;
    merged.push({
      ...localMessage,
      content: localMessage.content || hermesMessage?.content || '',
      steps: hermesMessage?.steps,
      startedAt,
      endedAt,
    });
  }

  for (const remaining of hermesAssistantMessages.slice(assistantCursor)) {
    merged.push(remaining);
  }

  return merged;
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestampToMs(timestamp: number): number {
  return timestamp * 1000;
}

function timestampToIso(timestamp: number): string {
  return new Date(timestampToMs(timestamp)).toISOString();
}

function isoToMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
