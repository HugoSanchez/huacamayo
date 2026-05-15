import { useState, useRef, useCallback, useEffect } from 'react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { CatalogOverlay } from './CatalogOverlay';
import { SkillsCatalogOverlay } from './SkillsCatalogOverlay';
import { SkillDetailPage } from './SkillDetailPage';
import { CronDetailPage } from './CronDetailPage';
import { SettingsPage } from './SettingsPage';
import {
  archiveChatSession,
  cancelChatRequest,
  createConnectionRequest,
  createChatSession,
  getChatMessages,
  getChatSessions,
  getCodexStatus,
  getConnectionRequest,
  getConnections,
  getSidecarPort,
  getToolkits,
  openConnectionRequest,
  openExternalUrl,
  setSidecarPort,
  streamChatMessage,
  unarchiveChatSession,
} from './chat';
import type {
  AttachedContext,
  ChatMessage,
  ChatSSEEvent,
  ActivityStep,
  ChatSessionSummary,
  ConnectionRequestView,
  ConnectionView,
  StoredChatMessage,
  ToolkitView,
} from './types';

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        chatBridge?: { postMessage: (msg: unknown) => void };
      };
    };
    setSidecarPort?: (port: number) => void;
    __versoSidecarPort?: number;
    __versoShellMode?: 'native' | 'browser';
    __versoPendingSelectedSessionId?: string | null;
    __versoPendingCatalogOpen?: boolean;
    __versoPendingSkillsCatalogOpen?: boolean;
  }
}

const SESSION_STORAGE_KEY = 'verso.chat.sessionId';

// Hermes surfaces a CLI-flavoured error when there are no Codex creds. We
// match liberally — any of "no codex credentials", "hermes auth", or
// "hermes model" indicates the user needs to (re-)authenticate.
function isCodexAuthError(err: string): boolean {
  return /no\s+codex\s+credentials|hermes\s+auth|hermes\s+model/i.test(err);
}

export function App() {
  const isNativeShell = hasNativeShell();
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  // null = unknown (e.g. before the orchestrator is ready or the check is in
  // flight). We only intercept sends when we're sure the user is disconnected,
  // so unknown lets the normal Hermes flow proceed and surface its own error.
  const [codexConnected, setCodexConnected] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  // Full toolkit catalog — used by the chat UI to render logos in tool-call
  // rows for toolkits the user may not have connected (or whose connection
  // record lacks a logoUrl). Best-effort: failures here just fall back to the
  // initial-letter badge.
  const [toolkitCatalog, setToolkitCatalog] = useState<ToolkitView[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [isHydratingSession, setIsHydratingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isCatalogOpen, setIsCatalogOpen] = useState<boolean>(
    Boolean(typeof window !== 'undefined' && window.__versoPendingCatalogOpen),
  );
  const [isSkillsCatalogOpen, setIsSkillsCatalogOpen] = useState<boolean>(
    Boolean(typeof window !== 'undefined' && window.__versoPendingSkillsCatalogOpen),
  );
  const [selectedSkillSlug, setSelectedSkillSlug] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedCronId, setSelectedCronId] = useState<string | null>(null);
  // Names resolved by the detail pages (via onTitleResolved) so the header
  // can show "Skills: <name>" / "Routines: <name>" without us re-fetching.
  const [activeSkillName, setActiveSkillName] = useState<string | null>(null);
  const [activeCronName, setActiveCronName] = useState<string | null>(null);
  const [inputDrafts, setInputDrafts] = useState<Record<string, { text: string; attached: AttachedContext | null }>>({});
  const [catalogRefreshToken, setCatalogRefreshToken] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const idCounter = useRef(0);
  const hydrateTokenRef = useRef(0);
  const connectionPollers = useRef<Map<string, number>>(new Map());

  // Clear the cached detail-page names when their id clears, so the next
  // time you open a routine/skill the header doesn't briefly show the
  // previous one's name.
  useEffect(() => { if (!selectedSkillSlug) setActiveSkillName(null); }, [selectedSkillSlug]);
  useEffect(() => { if (!selectedCronId) setActiveCronName(null); }, [selectedCronId]);

  // System sleep: tear down anything that would otherwise keep waking the
  // CPU. Connection pollers are cheap to restart by the user (they just
  // click Connect again), so we don't bother resuming on wake here.
  useEffect(() => {
    const onSleep = () => {
      for (const handle of connectionPollers.current.values()) {
        window.clearInterval(handle);
      }
      connectionPollers.current.clear();
    };
    window.addEventListener('verso:system-sleep', onSleep);
    return () => {
      window.removeEventListener('verso:system-sleep', onSleep);
    };
  }, []);

  const refreshConnections = useCallback(async () => {
    if (!getSidecarPort()) return;
    try {
      const result = await getConnections();
      setConnections(result.connections);
    } catch {
      // Ignore best-effort refresh failures.
    }
  }, []);

  const refreshCodexStatus = useCallback(async () => {
    if (!getSidecarPort()) return;
    try {
      const next = await getCodexStatus();
      setCodexConnected(next.connected);
    } catch {
      // Best-effort: leave codexConnected as-is so we don't accidentally
      // block sends because of a transient status fetch failure.
    }
  }, []);

  const refreshToolkitCatalog = useCallback(async () => {
    if (!getSidecarPort()) return;
    try {
      // Walk the cursor through every page. The backend caps each page at
      // 100 toolkits, so a single fetch can miss toolkits whose slug only
      // appears in tool_slug parsing (e.g. multi-segment slugs like
      // `granola_mcp`). 20 pages is well over the current catalog size.
      const collected: ToolkitView[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await getToolkits({
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        collected.push(...result.toolkits);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      setToolkitCatalog(collected);
    } catch {
      // Best-effort — chat rows just fall back to initial-letter badges.
    }
  }, []);

  const refreshSessionList = useCallback(async (): Promise<ChatSessionSummary[]> => {
    if (!getSidecarPort()) return [];

    setIsLoadingSessions(true);
    try {
      const nextSessions = sortSessions(await getChatSessions());
      setSessions(nextSessions);
      setSessionError(null);
      return nextSessions;
    } catch (error: unknown) {
      setSessionError(error instanceof Error ? error.message : String(error));
      return [];
    } finally {
      setIsLoadingSessions(false);
    }
  }, []);

  const hydrateSession = useCallback(async (sessionId: string | null) => {
    const token = ++hydrateTokenRef.current;

    if (!sessionId) {
      sessionIdRef.current = null;
      setSelectedSessionId(null);
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      setMessages([]);
      setIsHydratingSession(false);
      notifyNativeSessionState(isNativeShell, null);
      return;
    }

    setIsHydratingSession(true);
    setMessages([]);

    try {
      const storedMessages = await getChatMessages(sessionId);
      if (token !== hydrateTokenRef.current) return;
      sessionIdRef.current = sessionId;
      setSelectedSessionId(sessionId);
      window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
      setMessages(storedMessages.map(toUiMessage));
      setSessionError(null);
      notifyNativeSessionState(isNativeShell, sessionId);
    } catch (error: unknown) {
      if (token !== hydrateTokenRef.current) return;
      sessionIdRef.current = null;
      setSelectedSessionId(null);
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      setMessages([]);
      setSessionError(error instanceof Error ? error.message : String(error));
      notifyNativeSessionState(isNativeShell, null);
    } finally {
      if (token === hydrateTokenRef.current) {
        setIsHydratingSession(false);
      }
    }
  }, [isNativeShell]);

  const bootstrapSessions = useCallback(async () => {
    const nextSessions = await refreshSessionList();
    const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    const pendingNativeSessionId = normalizeNativeSessionId(window.__versoPendingSelectedSessionId);
    const initialSessionId = isNativeShell
      ? resolveNativeBootstrapSessionId(nextSessions, pendingNativeSessionId, storedSessionId)
      : pickInitialSessionId(nextSessions, storedSessionId);
    await hydrateSession(initialSessionId);
  }, [hydrateSession, isNativeShell, refreshSessionList]);

  const adoptSession = useCallback((session: ChatSessionSummary, preserveMessages: boolean): string => {
    const nextSession = normalizeSession(session);
    sessionIdRef.current = nextSession.id;
    setSelectedSessionId(nextSession.id);
    setSessions((prev) => sortSessions(replaceSession(prev, nextSession)));
    window.localStorage.setItem(SESSION_STORAGE_KEY, nextSession.id);
    if (!preserveMessages) {
      setMessages([]);
    }
    setSessionError(null);
    notifyNativeSessionState(isNativeShell, nextSession.id);
    return nextSession.id;
  }, [isNativeShell]);

  useEffect(() => {
    const applyPort = (port: number) => {
      setSidecarPort(port);
      setConnected(true);
      void bootstrapSessions();
      void refreshConnections();
      void refreshToolkitCatalog();
      void refreshCodexStatus();
      // Re-broadcast so descendants (InputBar etc.) that mount before
      // App's effect runs can hear about the now-available port.
      window.dispatchEvent(new CustomEvent('verso:sidecar-port-ready', { detail: { port } }));
    };

    window.setSidecarPort = (port: number) => {
      window.__versoSidecarPort = port;
      applyPort(port);
    };

    if (typeof window.__versoSidecarPort === 'number' && window.__versoSidecarPort > 0) {
      applyPort(window.__versoSidecarPort);
    }

    const onPortEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<{ port?: unknown }>).detail;
      const rawPort = detail?.port;
      const port = typeof rawPort === 'number' ? rawPort : Number(rawPort);
      if (Number.isFinite(port) && port > 0) {
        window.__versoSidecarPort = port;
        applyPort(port);
      }
    };
    window.addEventListener('verso:sidecar-port', onPortEvent as EventListener);

    const params = new URLSearchParams(window.location.search);
    const devPort = params.get('port');
    if (devPort) {
      const parsed = parseInt(devPort, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        applyPort(parsed);
      }
    }

    return () => {
      window.removeEventListener('verso:sidecar-port', onPortEvent as EventListener);
      window.setSidecarPort = undefined;
      for (const poller of connectionPollers.current.values()) {
        window.clearInterval(poller);
      }
      connectionPollers.current.clear();
    };
  }, [bootstrapSessions, refreshConnections, refreshToolkitCatalog, refreshCodexStatus]);

  useEffect(() => {
    if (!isNativeShell) return;

    const handleNativeSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown }>).detail;
      const requestedSessionId = normalizeNativeSessionId(detail?.sessionId);

      void (async () => {
        const nextSessions = await refreshSessionList();
        const resolvedSessionId = requestedSessionId && nextSessions.some((session) => session.id === requestedSessionId)
          ? requestedSessionId
          : null;

        if (resolvedSessionId) {
          setSelectedSkillSlug(null);
          setSelectedCronId(null);
          setIsSettingsOpen(false);
        }

        if (resolvedSessionId === sessionIdRef.current) {
          sessionIdRef.current = resolvedSessionId;
          setSelectedSessionId(resolvedSessionId);
          if (resolvedSessionId) {
            window.localStorage.setItem(SESSION_STORAGE_KEY, resolvedSessionId);
          } else {
            window.localStorage.removeItem(SESSION_STORAGE_KEY);
          }
          return;
        }

        await hydrateSession(resolvedSessionId);
      })();
    };

    window.addEventListener('verso:select-session', handleNativeSelection as EventListener);
    return () => {
      window.removeEventListener('verso:select-session', handleNativeSelection as EventListener);
    };
  }, [hydrateSession, isNativeShell, refreshSessionList]);

  useEffect(() => {
    const handleCatalogToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: unknown }>).detail;
      const open = typeof detail?.open === 'boolean' ? detail.open : !isCatalogOpen;
      setIsCatalogOpen(open);
    };

    window.addEventListener('verso:toggle-catalog', handleCatalogToggle as EventListener);
    return () => {
      window.removeEventListener('verso:toggle-catalog', handleCatalogToggle as EventListener);
    };
  }, [isCatalogOpen]);

  useEffect(() => {
    const handleSkillsCatalogToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: unknown }>).detail;
      const open = typeof detail?.open === 'boolean' ? detail.open : !isSkillsCatalogOpen;
      setIsSkillsCatalogOpen(open);
    };

    window.addEventListener('verso:toggle-skills-catalog', handleSkillsCatalogToggle as EventListener);
    return () => {
      window.removeEventListener('verso:toggle-skills-catalog', handleSkillsCatalogToggle as EventListener);
    };
  }, [isSkillsCatalogOpen]);

  useEffect(() => {
    const handleOpenCron = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: unknown }>).detail;
      const id = typeof detail?.id === 'string' ? detail.id : null;
      if (!id) return;
      setSelectedCronId(id);
      setSelectedSkillSlug(null);
      setIsCatalogOpen(false);
      setIsSkillsCatalogOpen(false);
    };
    window.addEventListener('verso:open-cron-detail', handleOpenCron as EventListener);
    return () => {
      window.removeEventListener('verso:open-cron-detail', handleOpenCron as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleOpenSettings = () => {
      setIsSettingsOpen(true);
      setSelectedCronId(null);
      setSelectedSkillSlug(null);
      setIsCatalogOpen(false);
      setIsSkillsCatalogOpen(false);
    };
    window.addEventListener('verso:open-settings', handleOpenSettings as EventListener);
    return () => {
      window.removeEventListener('verso:open-settings', handleOpenSettings as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleAttachCron = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: unknown; name?: unknown; sessionId?: unknown }>).detail;
      const id = typeof detail?.id === 'string' ? detail.id : null;
      const name = typeof detail?.name === 'string' ? detail.name : id;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId : null;
      if (!id || !name) return;
      const targetKey = sessionId ?? selectedSessionId ?? '__none__';
      setInputDrafts((prev) => ({
        ...prev,
        [targetKey]: { text: prev[targetKey]?.text ?? '', attached: { kind: 'cron', id, name } },
      }));
    };
    window.addEventListener('verso:attach-cron', handleAttachCron as EventListener);
    return () => {
      window.removeEventListener('verso:attach-cron', handleAttachCron as EventListener);
    };
  }, [selectedSessionId]);

  const handleCloseCatalog = useCallback(() => {
    setIsCatalogOpen(false);
    if (isNativeShell) {
      window.webkit?.messageHandlers?.chatBridge?.postMessage({
        type: 'catalogStateChanged',
        open: false,
      });
    }
  }, [isNativeShell]);

  const handleCloseSkillsCatalog = useCallback(() => {
    setIsSkillsCatalogOpen(false);
    if (isNativeShell) {
      window.webkit?.messageHandlers?.chatBridge?.postMessage({
        type: 'skillsCatalogStateChanged',
        open: false,
      });
    }
  }, [isNativeShell]);

  const handleSelectSkill = useCallback((slug: string) => {
    setSelectedSkillSlug(slug);
    setIsSkillsCatalogOpen(false);
    if (isNativeShell) {
      window.webkit?.messageHandlers?.chatBridge?.postMessage({
        type: 'skillsCatalogStateChanged',
        open: false,
      });
    }
  }, [isNativeShell]);

  const bumpCatalogRefresh = useCallback(() => {
    setCatalogRefreshToken((value) => value + 1);
  }, []);

  const pollConnectionRequest = useCallback((
    requestId: string,
    onUpdate?: (request: ConnectionRequestView) => void,
  ) => {
    const existing = connectionPollers.current.get(requestId);
    if (existing) {
      window.clearInterval(existing);
      connectionPollers.current.delete(requestId);
    }

    const poller = window.setInterval(() => {
      void (async () => {
        try {
          const next = await getConnectionRequest(requestId);
          onUpdate?.(next);

          if (next.status !== 'pending') {
            window.clearInterval(poller);
            connectionPollers.current.delete(requestId);
            await refreshConnections();
            bumpCatalogRefresh();
            window.webkit?.messageHandlers?.chatBridge?.postMessage({ type: 'connectionsChanged' });
          }
        } catch {
          window.clearInterval(poller);
          connectionPollers.current.delete(requestId);
        }
      })();
    }, 1500);

    connectionPollers.current.set(requestId, poller);
  }, [bumpCatalogRefresh, refreshConnections]);

  const handleConnectToolkit = useCallback((toolkit: { slug: string }) => {
    void (async () => {
      try {
        const request = await createConnectionRequest(toolkit.slug);
        bumpCatalogRefresh();

        if (request.status === 'pending') {
          openConnectionRequest(request.id);
          pollConnectionRequest(request.id);
        } else {
          await refreshConnections();
          bumpCatalogRefresh();
          window.webkit?.messageHandlers?.chatBridge?.postMessage({ type: 'connectionsChanged' });
        }
      } catch (error: unknown) {
        setSessionError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [bumpCatalogRefresh, pollConnectionRequest, refreshConnections]);

  const nextId = () => String(++idCounter.current);

  const ensureSession = useCallback(async (seedText: string) => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const session = normalizeSession(await createChatSession(seedText));
    return adoptSession(session, true);
  }, [adoptSession]);

  const handleNewChat = useCallback(() => {
    if (!connected || isStreaming || isHydratingSession) return;

    void (async () => {
      try {
        const session = normalizeSession(await createChatSession());
        adoptSession(session, false);
      } catch (error: unknown) {
        setSessionError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [adoptSession, connected, isHydratingSession, isStreaming]);

  const handleSelectSession = useCallback((sessionId: string) => {
    if (isStreaming || isHydratingSession || sessionId === selectedSessionId) return;
    setSelectedSkillSlug(null);
    setSelectedCronId(null);
    setIsSettingsOpen(false);
    void hydrateSession(sessionId);
  }, [hydrateSession, isHydratingSession, isStreaming, selectedSessionId]);

  const handleArchiveToggle = useCallback(() => {
    if (!selectedSessionId || isStreaming || isHydratingSession) return;

    const session = sessions.find((candidate) => candidate.id === selectedSessionId);
    if (!session) return;

    void (async () => {
      try {
        const nextSession = normalizeSession(session.archivedAt
          ? await unarchiveChatSession(selectedSessionId)
          : await archiveChatSession(selectedSessionId));
        setSessions((prev) => sortSessions(replaceSession(prev, nextSession)));
        setSessionError(null);
      } catch (error: unknown) {
        setSessionError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [isHydratingSession, isStreaming, selectedSessionId, sessions]);

  // Wires up the SSE handlers for an assistant placeholder that's already in
  // `messages`. Shared by the normal send path and the post-connect replay so
  // both flows produce identical streaming behaviour.
  const streamInto = useCallback((assistantId: string, text: string, attached: AttachedContext | null) => {
    setIsStreaming(true);
    void (async () => {
      try {
        const sessionId = await ensureSession(text);
        const abort = streamChatMessage(
          sessionId,
          text,
          (event: ChatSSEEvent) => {
            const resolvedSessionId = extractSessionId(event);
            if (resolvedSessionId) {
              sessionIdRef.current = resolvedSessionId;
              setSelectedSessionId(resolvedSessionId);
              window.localStorage.setItem(SESSION_STORAGE_KEY, resolvedSessionId);
            }

            // Catch the Hermes "no credentials" event mid-stream and swap the
            // assistant placeholder for a Codex connect widget instead of
            // letting applySSEEvent surface the raw CLI-flavoured error.
            if (event.type === 'error' && typeof event.message === 'string' && isCodexAuthError(event.message)) {
              setMessages((prev) => prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      kind: 'codex_connect_required' as const,
                      pendingText: text,
                      pendingAttached: attached,
                      content: '',
                      steps: [],
                      isStreaming: false,
                      endedAt: Date.now(),
                    }
                  : message,
              ));
              setCodexConnected(false);
              return;
            }

            setMessages((prev) => prev.map((message) => {
              if (message.id !== assistantId) return message;
              return applySSEEvent(message, event);
            }));
          },
          () => {
            setMessages((prev) => prev.map((message) =>
              message.id === assistantId ? { ...message, isStreaming: false, endedAt: Date.now() } : message,
            ));
            setIsStreaming(false);
            abortRef.current = null;
            void refreshSessionList().then(() => {
              notifyNativeSessionState(isNativeShell, sessionIdRef.current);
            });
          },
          (err: string) => {
            if (isCodexAuthError(err)) {
              // Our pre-send check missed (status fetch race, or the user
              // ran `hermes auth remove` outside the app). Convert the failed
              // assistant placeholder into a connect widget and stash the
              // payload so finishing auth replays the send.
              setMessages((prev) => prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      kind: 'codex_connect_required' as const,
                      pendingText: text,
                      pendingAttached: attached,
                      content: '',
                      steps: [],
                      isStreaming: false,
                      endedAt: Date.now(),
                    }
                  : message,
              ));
              setCodexConnected(false);
            } else {
              setMessages((prev) => prev.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + `\n\n**Error:** ${err}`, isStreaming: false, endedAt: Date.now() }
                  : message,
              ));
            }
            setIsStreaming(false);
            abortRef.current = null;
            void refreshSessionList().then(() => {
              notifyNativeSessionState(isNativeShell, sessionIdRef.current);
            });
          },
          { attached },
        );

        abortRef.current = abort;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (isCodexAuthError(message)) {
          setMessages((prev) => prev.map((entry) =>
            entry.id === assistantId
              ? {
                  ...entry,
                  kind: 'codex_connect_required' as const,
                  pendingText: text,
                  pendingAttached: attached,
                  content: '',
                  steps: [],
                  isStreaming: false,
                  endedAt: Date.now(),
                }
              : entry,
          ));
          setCodexConnected(false);
        } else {
          setMessages((prev) => prev.map((entry) =>
            entry.id === assistantId
              ? { ...entry, content: `**Error:** ${message}`, isStreaming: false, endedAt: Date.now() }
              : entry,
          ));
        }
        setIsStreaming(false);
      }
    })();
  }, [ensureSession, isNativeShell, refreshSessionList]);

  const handleSend = useCallback((text: string, attached: AttachedContext | null = null) => {
    const hasContent = text.trim().length > 0 || attached?.kind === 'cron';
    if (!hasContent || isStreaming || !connected) return;

    const displayText = attached?.kind === 'cron' && text.trim().length === 0
      ? `[Reviewing routine: ${attached.name}]`
      : text;

    // If we know the user hasn't connected Codex yet, don't bother hitting
    // Hermes — it'll just error with a CLI-flavoured "no credentials"
    // message that doesn't help our users. Stash the user's message on the
    // synthetic widget so we can replay the send once they finish auth.
    if (codexConnected === false) {
      const userMsg: ChatMessage = { id: nextId(), role: 'user', content: displayText };
      const widgetMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        kind: 'codex_connect_required',
        pendingText: text,
        pendingAttached: attached,
      };
      setMessages((prev) => [...prev, userMsg, widgetMsg]);
      return;
    }

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: displayText };
    const assistantMsg: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      steps: [],
      isStreaming: true,
      startedAt: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    streamInto(assistantMsg.id, text, attached);
  }, [codexConnected, connected, isStreaming, streamInto]);

  const handleCodexConnected = useCallback((widgetId: string) => {
    setCodexConnected(true);
    const widget = messages.find((m) => m.id === widgetId && m.kind === 'codex_connect_required');
    const pendingText = widget?.pendingText ?? '';
    const pendingAttached = widget?.pendingAttached ?? null;

    if (!pendingText) {
      // Nothing to replay (shouldn't happen — handleSend always stashes text
      // before showing the widget). Just remove the widget.
      setMessages((prev) => prev.filter((m) => m.id !== widgetId));
      return;
    }

    // Swap the widget for a fresh assistant placeholder and start streaming.
    // The user's original message stays in place above it, so the result
    // looks identical to a normal send.
    const assistantMsg: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      steps: [],
      isStreaming: true,
      startedAt: Date.now(),
    };
    setMessages((prev) => prev.map((m) => m.id === widgetId ? assistantMsg : m));
    streamInto(assistantMsg.id, pendingText, pendingAttached);
  }, [messages, streamInto]);

  const handleOpenSkillInNewSession = useCallback((slug: string) => {
    if (!connected || isStreaming || isHydratingSession) return;

    sessionIdRef.current = null;
    setSelectedSessionId(null);
    setSelectedSkillSlug(null);
    setMessages([]);
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    handleCloseSkillsCatalog();
    void (async () => {
      try {
        const session = normalizeSession(await createChatSession(slug.replace(/-/g, ' ')));
        adoptSession(session, false);
        handleSend(`/${slug}`);
      } catch (error: unknown) {
        setSessionError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [adoptSession, connected, handleCloseSkillsCatalog, handleSend, isHydratingSession, isStreaming]);

  const handleStop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    if (sessionIdRef.current) {
      void cancelChatRequest(sessionIdRef.current).catch(() => {});
    }
    setIsStreaming(false);
    setMessages((prev) => prev.map((message) =>
      message.isStreaming ? { ...message, isStreaming: false, endedAt: Date.now() } : message,
    ));
  }, []);

  const handleConnect = useCallback((request: ConnectionRequestView) => {
    openConnectionRequest(request.id);
    pollConnectionRequest(request.id, (next) => {
      setMessages((prev) => prev.map((message) => ({
        ...message,
        steps: updateConnectionSteps(message.steps, next),
      })));
    });
  }, [pollConnectionRequest]);

  const activeSessions = sessions.filter((session) => !session.archivedAt);
  const archivedSessions = sessions.filter((session) => !!session.archivedAt);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  // Header title is computed from the active view; the detail pages report
  // their resolved name via `onTitleResolved` so we don't double-fetch.
  // Reset the cached name when the active id clears so a stale name doesn't
  // flash on the next navigation.
  const headerTitle = isSettingsOpen
    ? 'Settings'
    : selectedCronId
      ? activeCronName ? `Routines: ${activeCronName}` : 'Routines'
      : selectedSkillSlug
        ? activeSkillName ? `Skills: ${activeSkillName}` : 'Skills'
        : selectedSession?.title ?? 'New chat';
  const headerSubtitle = !connected
    ? 'Connecting'
    : selectedSession?.archivedAt
      ? 'Archived. Restore this session to continue chatting.'
      : isHydratingSession
        ? 'Loading messages'
        : selectedSession
          ? formatSessionSummary(selectedSession)
          : isNativeShell
            ? 'Create a new chat in the sidebar or start typing.'
            : 'Start a new chat or resume an existing session';

  const draftKey = selectedSessionId ?? '__none__';
  const currentDraft = inputDrafts[draftKey] ?? { text: '', attached: null };
  const handleDraftTextChange = useCallback((next: string) => {
    setInputDrafts((prev) => ({
      ...prev,
      [draftKey]: { text: next, attached: prev[draftKey]?.attached ?? null },
    }));
  }, [draftKey]);
  const handleDraftAttachedChange = useCallback((attached: AttachedContext | null) => {
    setInputDrafts((prev) => ({
      ...prev,
      [draftKey]: { text: prev[draftKey]?.text ?? '', attached },
    }));
  }, [draftKey]);

  const mainPanel = (
    <main className="chat-panel">
      {isNativeShell && <ChatHeaderScaffold title={headerTitle} />}
      {!isNativeShell && !selectedSkillSlug && !selectedCronId && !isSettingsOpen && (
        <div className="chat-toolbar">
          <div>
            <div className="chat-toolbar-title">{selectedSession?.title ?? 'New Chat'}</div>
            <div className="chat-toolbar-subtitle">{headerSubtitle}</div>
          </div>
          {selectedSession && (
            <button
              className="chat-toolbar-button"
              type="button"
              onClick={handleArchiveToggle}
              disabled={isStreaming || isHydratingSession}
            >
              {selectedSession.archivedAt ? 'Restore' : 'Archive'}
            </button>
          )}
        </div>
      )}

      {isSettingsOpen ? (
        <SettingsPage onBack={() => { setIsSettingsOpen(false); void refreshCodexStatus(); }} />
      ) : selectedCronId ? (
        <CronDetailPage
          id={selectedCronId}
          onBack={() => setSelectedCronId(null)}
          onTitleResolved={setActiveCronName}
        />
      ) : selectedSkillSlug ? (
        <SkillDetailPage
          slug={selectedSkillSlug}
          onOpenInNewSession={handleOpenSkillInNewSession}
          onTitleResolved={setActiveSkillName}
        />
      ) : (
        <>
          <div className="chat-thread">
            <MessageList
              messages={messages}
              onConnect={handleConnect}
              connections={connections}
              onCodexConnected={handleCodexConnected}
              toolkitCatalog={toolkitCatalog}
            />
          </div>

          <InputBar
            text={currentDraft.text}
            attached={currentDraft.attached}
            onTextChange={handleDraftTextChange}
            onAttachedChange={handleDraftAttachedChange}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            disabled={!connected || isHydratingSession || !!selectedSession?.archivedAt}
          />
        </>
      )}
    </main>
  );

  const catalog = (
    <CatalogOverlay
      isOpen={isCatalogOpen}
      refreshToken={catalogRefreshToken}
      onClose={handleCloseCatalog}
      onConnect={handleConnectToolkit}
    />
  );

  const skillsCatalog = (
    <SkillsCatalogOverlay
      isOpen={isSkillsCatalogOpen}
      onClose={handleCloseSkillsCatalog}
      onSelectSkill={handleSelectSkill}
    />
  );

  if (isNativeShell) {
    return (
      <div className="chat-shell-native">
        {mainPanel}
        {catalog}
        {skillsCatalog}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="session-sidebar">
        <div className="session-sidebar-head">
          <div>
            <div className="session-sidebar-label">Sessions</div>
            <div className="session-sidebar-caption">
              {!connected ? 'Offline' : isLoadingSessions ? 'Refreshing' : `${activeSessions.length} active`}
            </div>
          </div>
          <button
            className="sidebar-primary-button"
            type="button"
            onClick={handleNewChat}
            disabled={!connected || isStreaming || isHydratingSession}
          >
            New Chat
          </button>
        </div>

        {sessionError && (
          <div className="session-sidebar-error">{sessionError}</div>
        )}

        <SessionSection
          title="Recent"
          sessions={activeSessions}
          selectedSessionId={selectedSessionId}
          disabled={isStreaming || isHydratingSession}
          onSelect={handleSelectSession}
          emptyText={connected ? 'No active sessions yet.' : 'Sessions will appear once the sidecar is ready.'}
        />

        {archivedSessions.length > 0 && (
          <SessionSection
            title="Archived"
            sessions={archivedSessions}
            selectedSessionId={selectedSessionId}
            disabled={isStreaming || isHydratingSession}
            onSelect={handleSelectSession}
            emptyText="No archived sessions."
          />
        )}
      </aside>

      {mainPanel}
      {catalog}
      {skillsCatalog}
    </div>
  );
}

function ChatHeaderScaffold({ title }: { title?: string }) {
  return (
    <div className="chat-header-scaffold">
      <div className="chat-header-band-top">
        {title && <span className="chat-header-title">{title}</span>}
      </div>
      {/* Second band (tabs) is hidden for launch — bring back when tabs ship.
      <div className="chat-header-band-tabs">
        <div className="chat-header-active-line" />
      </div>
      */}
    </div>
  );
}

function SessionSection({
  title,
  sessions,
  selectedSessionId,
  disabled,
  onSelect,
  emptyText,
}: {
  title: string;
  sessions: ChatSessionSummary[];
  selectedSessionId: string | null;
  disabled: boolean;
  onSelect: (sessionId: string) => void;
  emptyText: string;
}) {
  return (
    <section className="session-section">
      <div className="session-section-title">{title}</div>
      {sessions.length === 0 ? (
        <div className="session-section-empty">{emptyText}</div>
      ) : (
        <div className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-list-item${session.id === selectedSessionId ? ' is-active' : ''}`}
              onClick={() => onSelect(session.id)}
              disabled={disabled}
            >
              <div className="session-list-item-head">
                <span className="session-list-item-title">{session.title}</span>
                <span className="session-list-item-time">{formatRelativeTime(session.archivedAt ?? session.updatedAt)}</span>
              </div>
              <div className="session-list-item-preview">
                {session.lastMessagePreview || 'No messages yet'}
              </div>
              <div className="session-list-item-meta">
                {session.messageCount === 0 ? 'Empty' : `${session.messageCount} messages`}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function extractSessionId(event: ChatSSEEvent): string | undefined {
  const sessionId = (event as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function applySSEEvent(msg: ChatMessage, event: ChatSSEEvent): ChatMessage {
  const steps = msg.steps ?? [];
  const ev = event as any;

  if (event.type === 'assistant') {
    const blocks = ev.message?.content ?? ev.content ?? [];
    let newSteps = steps;
    let newContent = msg.content;

    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        newContent = block.text;
      } else if (block.type === 'tool_use') {
        // Any intermediate prose accumulated in `content` (from streaming
        // deltas) needs to land in `steps` *before* this tool, so the
        // collapsible renders text and tool calls in true chronological
        // order. Once promoted, clear `content` so subsequent deltas for the
        // next text block start fresh instead of appending to the old text.
        const trimmed = newContent.trim();
        if (trimmed) {
          newSteps = [...newSteps, { type: 'text', text: trimmed }];
        }
        newContent = '';
        newSteps = [...newSteps, {
          type: 'tool',
          id: block.id,
          name: block.name ?? 'tool',
          input: block.input,
        }];
      }
    }
    return { ...msg, steps: newSteps, content: newContent };
  }

  if (event.type === 'user') {
    const blocks = ev.message?.content ?? ev.content ?? [];
    if (!Array.isArray(blocks)) return msg;
    let newSteps = steps;
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id;
      const result = stringifyToolResult(block.content);
      newSteps = attachResult(newSteps, toolUseId, result, block.content);
    }
    return { ...msg, steps: newSteps };
  }

  if (event.type === 'content_block_delta' || event.type === 'text') {
    const delta = ev.delta?.text ?? ev.text ?? '';
    return { ...msg, content: msg.content + delta };
  }

  if (event.type === 'result') {
    const text = ev.result ?? '';
    if (text) return { ...msg, content: text };
  }

  if (event.type === 'error') {
    return { ...msg, content: msg.content + `\n\n**Error:** ${event.message ?? 'Unknown error'}` };
  }

  if (event.type === 'done') {
    return { ...msg, isStreaming: false, endedAt: Date.now() };
  }

  return msg;
}

function toUiMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
  };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => (typeof entry === 'string' ? entry : entry?.text ?? JSON.stringify(entry)))
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function attachResult(
  steps: ActivityStep[],
  toolUseId: string | undefined,
  result: string,
  rawContent?: unknown,
): ActivityStep[] {
  const items = [...steps];
  const connection = parseConnectionRequest(rawContent);
  if (toolUseId) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const step = items[index];
      if (step.type === 'tool' && step.id === toolUseId && !step.result) {
        items[index] = connection ? { ...step, result, connection } : { ...step, result };
        return items;
      }
    }
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const step = items[index];
    if (step.type === 'tool' && !step.result) {
      items[index] = connection ? { ...step, result, connection } : { ...step, result };
      return items;
    }
  }
  return items;
}

function parseConnectionRequest(content: unknown): ConnectionRequestView | null {
  const target = unwrapConnectionPayload(content);
  if (!target) return null;

  const id = typeof target.id === 'string' ? target.id : '';
  const toolkitSlug = typeof target.toolkitSlug === 'string' ? target.toolkitSlug : '';
  const toolkitName = typeof target.toolkitName === 'string' ? target.toolkitName : '';
  const status = target.status;
  if (!id || !toolkitSlug || !toolkitName) return null;
  if (status !== 'pending' && status !== 'connected' && status !== 'failed' && status !== 'expired') {
    return null;
  }

  return {
    id,
    toolkitSlug,
    toolkitName,
    logoUrl: typeof target.logoUrl === 'string' ? target.logoUrl : null,
    status,
    redirectUrl: typeof target.redirectUrl === 'string' ? target.redirectUrl : null,
    connectedAccountId: typeof target.connectedAccountId === 'string' ? target.connectedAccountId : null,
    errorMessage: typeof target.errorMessage === 'string' ? target.errorMessage : null,
  };
}

function unwrapConnectionPayload(content: unknown): Record<string, unknown> | null {
  let current = normalizeConnectionPayload(content);

  for (let index = 0; index < 4; index += 1) {
    if (!current) return null;

    if (current.kind === 'connection_request') {
      return asRecord(current.request) ?? current;
    }

    if (current.structuredContent !== undefined) {
      current = normalizeConnectionPayload(current.structuredContent);
      continue;
    }

    if (current.result !== undefined) {
      current = normalizeConnectionPayload(current.result);
      continue;
    }

    return current;
  }

  return current;
}

function normalizeConnectionPayload(content: unknown): Record<string, unknown> | null {
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      return asRecord(parsed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => asRecord(item))
      .map((item) => typeof item?.text === 'string' ? item.text : '')
      .filter(Boolean)
      .join('\n')
      .trim();
    return text ? normalizeConnectionPayload(text) : null;
  }

  return asRecord(content);
}

function updateConnectionSteps(
  steps: ActivityStep[] | undefined,
  request: ConnectionRequestView,
): ActivityStep[] | undefined {
  if (!steps) return steps;
  return steps.map((step) => {
    if (step.type !== 'tool' || !step.connection) return step;
    if (step.connection.id !== request.id) return step;
    return {
      ...step,
      connection: request,
    };
  });
}

function normalizeSession(session: ChatSessionSummary): ChatSessionSummary {
  return {
    ...session,
    archivedAt: session.archivedAt ?? null,
  };
}

function replaceSession(sessions: ChatSessionSummary[], nextSession: ChatSessionSummary): ChatSessionSummary[] {
  const filtered = sessions.filter((session) => session.id !== nextSession.id);
  return [nextSession, ...filtered];
}

function sortSessions(sessions: ChatSessionSummary[]): ChatSessionSummary[] {
  return [...sessions].sort((left, right) => {
    const leftArchived = !!left.archivedAt;
    const rightArchived = !!right.archivedAt;
    if (leftArchived !== rightArchived) {
      return leftArchived ? 1 : -1;
    }

    const leftSortKey = left.archivedAt ?? left.updatedAt;
    const rightSortKey = right.archivedAt ?? right.updatedAt;
    return rightSortKey.localeCompare(leftSortKey);
  });
}

function pickInitialSessionId(sessions: ChatSessionSummary[], storedSessionId: string | null): string | null {
  if (storedSessionId && sessions.some((session) => session.id === storedSessionId)) {
    return storedSessionId;
  }

  return sessions.find((session) => !session.archivedAt)?.id ?? sessions[0]?.id ?? null;
}

function resolveNativeBootstrapSessionId(
  sessions: ChatSessionSummary[],
  requestedSessionId: string | null,
  storedSessionId: string | null,
): string | null {
  const preferred = requestedSessionId ?? storedSessionId;
  if (!preferred) return null;
  return sessions.some((session) => session.id === preferred) ? preferred : null;
}

function formatSessionSummary(session: ChatSessionSummary): string {
  if (session.messageCount === 0) return 'Empty session';
  return `${session.messageCount} messages · Updated ${formatRelativeTime(session.updatedAt)}`;
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '';

  const deltaMs = Date.now() - timestamp;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasNativeShell(): boolean {
  return window.__versoShellMode === 'native'
    || typeof window.webkit?.messageHandlers?.chatBridge?.postMessage === 'function';
}

function normalizeNativeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function notifyNativeSessionState(isNativeShell: boolean, sessionId: string | null): void {
  if (!isNativeShell) return;
  const bridge = window.webkit?.messageHandlers?.chatBridge;
  bridge?.postMessage({
    type: 'sessionStateChanged',
    sessionId,
  });
}
