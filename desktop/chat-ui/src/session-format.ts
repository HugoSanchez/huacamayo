import type { ChatSessionSummary } from './types';

export function formatSessionSummary(session: ChatSessionSummary): string {
  if (session.messageCount === 0) return 'Empty session';
  return `${session.messageCount} messages · Updated ${formatRelativeTime(session.updatedAt)}`;
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '';

  const deltaMs = now - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (deltaMs < minute) return 'now';
  if (deltaMs < hour) return `${Math.max(1, Math.floor(deltaMs / minute))}m`;
  if (deltaMs < day) return `${Math.max(1, Math.floor(deltaMs / hour))}h`;
  if (deltaMs < 7 * day) return `${Math.max(1, Math.floor(deltaMs / day))}d`;

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
