import { useCallback, useRef, useState } from 'react';
import { getChatMessages } from './chat';
import type { ChatMessage, ChatModel, ChatSessionSummary } from './types';
import {
  adoptSessionMessageBucket,
  clearPendingSessionMessageBucket,
  ensureSessionMessageBucket,
  replaceSessionMessageBucket,
  sessionMessageKey,
  toUiMessage,
  updateSessionMessageBucket,
} from './session-message-model';
import { postShellAction } from './shell-bridge';

export interface UseSessionMessagesOptions {
  isSessionStreaming: (sessionId: string) => boolean;
  onSessionModelSelected: (model: ChatModel | null) => void;
}

export function useSessionMessages(options: UseSessionMessagesOptions) {
  const { isSessionStreaming, onSessionModelSelected } = options;
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [isHydratingSession, setIsHydratingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const hydrateTokenRef = useRef(0);

  const getCurrentSessionId = useCallback(() => sessionIdRef.current, []);
  const getCurrentSessionKey = useCallback(() => sessionMessageKey(sessionIdRef.current), []);

  const updateSessionMessages = useCallback((
    sessionKey: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => {
    setMessagesBySession((current) => updateSessionMessageBucket(current, sessionKey, updater));
  }, []);

  const hydrateSession = useCallback(async (sessionId: string | null) => {
    const token = ++hydrateTokenRef.current;

    if (!sessionId) {
      sessionIdRef.current = null;
      setIsHydratingSession(false);
      return;
    }

    sessionIdRef.current = sessionId;
    setMessagesBySession((current) => ensureSessionMessageBucket(current, sessionId));

    // Persisted history does not yet contain an in-flight response. Keep the
    // live bucket authoritative until that stream finishes.
    if (isSessionStreaming(sessionId)) {
      setIsHydratingSession(false);
      setSessionError(null);
      return;
    }

    setIsHydratingSession(true);
    try {
      const storedMessages = await getChatMessages(sessionId);
      if (token !== hydrateTokenRef.current) return;
      setMessagesBySession((current) => replaceSessionMessageBucket(
        current,
        sessionId,
        storedMessages.map(toUiMessage),
      ));
      setSessionError(null);
    } catch (error: unknown) {
      if (token !== hydrateTokenRef.current) return;
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === hydrateTokenRef.current) setIsHydratingSession(false);
    }
  }, [isSessionStreaming]);

  const adoptSession = useCallback((
    session: ChatSessionSummary,
    preserveMessages: boolean,
  ): string => {
    const nextSession = normalizeSession(session);
    const previousSessionId = sessionIdRef.current;
    sessionIdRef.current = nextSession.id;
    onSessionModelSelected(nextSession.model);
    setMessagesBySession((current) => adoptSessionMessageBucket(
      current,
      previousSessionId,
      nextSession.id,
      preserveMessages,
    ));
    setSessionError(null);
    postShellAction({ kind: 'select-session', id: nextSession.id });
    return nextSession.id;
  }, [onSessionModelSelected]);

  const resetPendingSession = useCallback(() => {
    sessionIdRef.current = null;
    setMessagesBySession(clearPendingSessionMessageBucket);
  }, []);

  return {
    messagesBySession,
    isHydratingSession,
    sessionError,
    setSessionError,
    getCurrentSessionId,
    getCurrentSessionKey,
    updateSessionMessages,
    hydrateSession,
    adoptSession,
    resetPendingSession,
  };
}

function normalizeSession(session: ChatSessionSummary): ChatSessionSummary {
  return { ...session, archivedAt: session.archivedAt ?? null };
}
