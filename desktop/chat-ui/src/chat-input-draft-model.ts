import type { AttachedContext } from './types';

export interface ChatInputDraft {
  text: string;
  attached: AttachedContext | null;
}

export type ChatInputDrafts = Record<string, ChatInputDraft>;

export const EMPTY_CHAT_INPUT_DRAFT: ChatInputDraft = { text: '', attached: null };

export function inputDraftKey(sessionId: string | null): string {
  return sessionId ?? '__none__';
}

export function updateInputDraftText(
  drafts: ChatInputDrafts,
  key: string,
  text: string,
): ChatInputDrafts {
  return {
    ...drafts,
    [key]: { text, attached: drafts[key]?.attached ?? null },
  };
}

export function updateInputDraftAttachment(
  drafts: ChatInputDrafts,
  key: string,
  attached: AttachedContext | null,
): ChatInputDrafts {
  return {
    ...drafts,
    [key]: { text: drafts[key]?.text ?? '', attached },
  };
}
