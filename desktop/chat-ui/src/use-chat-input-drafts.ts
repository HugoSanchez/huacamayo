import { useCallback, useEffect, useState } from 'react';
import type { AttachedContext } from './types';
import {
  EMPTY_CHAT_INPUT_DRAFT,
  inputDraftKey,
  updateInputDraftAttachment,
  updateInputDraftText,
} from './chat-input-draft-model';
import type { ChatInputDrafts } from './chat-input-draft-model';

export function useChatInputDrafts(selectedSessionId: string | null) {
  const [drafts, setDrafts] = useState<ChatInputDrafts>({});
  const selectedDraftKey = inputDraftKey(selectedSessionId);
  const currentDraft = drafts[selectedDraftKey] ?? EMPTY_CHAT_INPUT_DRAFT;

  const setText = useCallback((text: string) => {
    setDrafts((current) => updateInputDraftText(current, selectedDraftKey, text));
  }, [selectedDraftKey]);

  const setAttached = useCallback((attached: AttachedContext | null) => {
    setDrafts((current) => updateInputDraftAttachment(current, selectedDraftKey, attached));
  }, [selectedDraftKey]);

  useEffect(() => {
    const handleAttachCron = (event: Event) => {
      const detail = (event as CustomEvent<{
        id?: unknown;
        name?: unknown;
        sessionId?: unknown;
      }>).detail;
      const id = typeof detail?.id === 'string' ? detail.id : null;
      const name = typeof detail?.name === 'string' ? detail.name : id;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId : selectedSessionId;
      if (!id || !name) return;
      const key = inputDraftKey(sessionId);
      setDrafts((current) => updateInputDraftAttachment(current, key, {
        kind: 'cron',
        id,
        name,
      }));
    };
    window.addEventListener('verso:attach-cron', handleAttachCron as EventListener);
    return () => window.removeEventListener('verso:attach-cron', handleAttachCron as EventListener);
  }, [selectedSessionId]);

  return { currentDraft, setText, setAttached };
}
