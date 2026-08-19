import { useCallback, useEffect, useRef, useState } from 'react';
import { postShellAction } from './shell-bridge';
import { SessionStreamRegistry } from './session-stream-registry';

export function useSessionStreamRegistry(activelyViewedSessionId: string | null) {
  const registryRef = useRef(new SessionStreamRegistry());
  const activelyViewedSessionIdRef = useRef(activelyViewedSessionId);
  const [streamingSessionIds, setStreamingSessionIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    activelyViewedSessionIdRef.current = activelyViewedSessionId;
    if (!activelyViewedSessionId) return;
    if (!registryRef.current.markViewed(activelyViewedSessionId)) return;
    postShellAction({ kind: 'session-unread', id: activelyViewedSessionId, unread: false });
  }, [activelyViewedSessionId]);

  const startSessionStream = useCallback((sessionId: string, abort: () => void) => {
    setStreamingSessionIds(registryRef.current.start(sessionId, abort));
    postShellAction({ kind: 'session-streaming', id: sessionId, streaming: true });
  }, []);

  const finishSessionStream = useCallback((sessionId: string) => {
    const completion = registryRef.current.finish(sessionId, activelyViewedSessionIdRef.current);
    setStreamingSessionIds(completion.activeSessionIds);
    postShellAction({ kind: 'session-streaming', id: sessionId, streaming: false });
    if (completion.becameUnread) {
      postShellAction({ kind: 'session-unread', id: sessionId, unread: true });
    }
  }, []);

  const abortSessionStream = useCallback((sessionId: string): boolean => (
    registryRef.current.abort(sessionId)
  ), []);

  const isSessionStreaming = useCallback((sessionId: string): boolean => (
    registryRef.current.isStreaming(sessionId)
  ), []);

  return {
    streamingSessionIds,
    startSessionStream,
    finishSessionStream,
    abortSessionStream,
    isSessionStreaming,
  };
}
