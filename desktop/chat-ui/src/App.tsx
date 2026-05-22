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
import type { ShellAction, ShellState } from './shell-protocol';
import { useBrowserShellHost } from './browser-shell-host';

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
    __versoPendingCatalogOpen?: boolean;
    __versoPendingSkillsCatalogOpen?: boolean;
    __versoPendingShellState?: ShellState | null;
  }
}

const SESSION_STORAGE_KEY = 'verso.chat.sessionId';

// Bucket key for messages typed before a session exists. `adoptSession` migrates
// this bucket onto the real session id once `createChatSession` resolves so the
// user's first message survives the round-trip without flicker.
const PENDING_SESSION_KEY = '__pending__';

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
  // Session-state consolidation step 2: receive the full Swift shell-state
  // snapshot. Nothing consumes this yet — step 3 will cut over `sessions` and
  // `selectedSessionId` to be derived from here, deleting the dual stores.
  // Initialized from `__versoPendingShellState` so a snapshot pushed before
  // mount (or via the user script's atDocumentStart hook) is already present
  // on first render.
  const [shellState, setShellState] = useState<ShellState | null>(
    () => (typeof window !== 'undefined' ? window.__versoPendingShellState ?? null : null),
  );
  // Messages live in a per-session bucket so an in-flight stream for session A
  // can't bleed into session B's view when the user switches mid-stream.
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
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
  const sessionIdRef = useRef<string | null>(null);
  // Per-session streams: one stream per session, multiple sessions can stream
  // concurrently. The ref holds the abort fn so handleStop can find it; the
  // Set state drives re-renders for guards and the InputBar's Send/Stop swap.
  const streamingControllersRef = useRef<Map<string, () => void>>(new Map());
  const [streamingSessions, setStreamingSessions] = useState<Set<string>>(new Set());
  const idCounter = useRef(0);
  const hydrateTokenRef = useRef(0);
  const connectionPollers = useRef<Map<string, number>>(new Map());

  // In browser mode this hook plays Swift's role: owns the sessions list,
  // dispatches `verso:shell-state` snapshots, and handles `verso:shell-action`
  // posts from `postShellAction`. No-op in native (Swift is the host).
  useBrowserShellHost({ isNativeShell, sidecarReady: connected });

  const markSessionStreaming = useCallback((sessionId: string, abort: () => void) => {
    streamingControllersRef.current.set(sessionId, abort);
    setStreamingSessions((prev) => {
      if (prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
    // Tell the shell host so its leftbar can show a working indicator on
    // this session's row.
    postShellAction({ kind: 'session-streaming', id: sessionId, streaming: true });
  }, []);

  // Sessions whose response landed while the user wasn't looking at their
  // chat surface. The leftbar renders an accent dot for each.
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(new Set());

  // Live mirror of "is the chat surface visible" inputs. Kept in a ref so
  // `isActivelyViewed` can be called from stale closures (the SSE callbacks
  // captured at stream-start) and still see fresh state. Without this, a
  // stream that ends *after* the user navigates elsewhere reads the
  // selectedSessionId frozen at stream-start and concludes the user is
  // still on that session — so the unread dot never appears. Updated in a
  // `useEffect` (so the ref lags one commit, which is fine: every consumer
  // is invoked from event handlers / async callbacks, not during render).
  const viewStateRef = useRef({
    selectedSessionId,
    isCatalogOpen,
    isSkillsCatalogOpen,
    selectedSkillSlug,
    selectedCronId,
    isSettingsOpen,
  });
  useEffect(() => {
    viewStateRef.current = {
      selectedSessionId,
      isCatalogOpen,
      isSkillsCatalogOpen,
      selectedSkillSlug,
      selectedCronId,
      isSettingsOpen,
    };
  });

  // Stable identity (empty deps) — reads live state via the ref above.
  // Safe to call from any callback no matter when it was captured.
  const isActivelyViewed = useCallback((sessionId: string): boolean => {
    const v = viewStateRef.current;
    if (v.selectedSessionId !== sessionId) return false;
    if (v.isCatalogOpen || v.isSkillsCatalogOpen) return false;
    if (v.selectedSkillSlug || v.selectedCronId) return false;
    if (v.isSettingsOpen) return false;
    return true;
  }, []);

  const markSessionNotStreaming = useCallback((sessionId: string) => {
    streamingControllersRef.current.delete(sessionId);
    setStreamingSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    postShellAction({ kind: 'session-streaming', id: sessionId, streaming: false });
    // Flag unread iff the user wasn't looking at this session's chat
    // surface when the response landed. `isActivelyViewed` reads through
    // the ref so it sees the user's current location, not the location at
    // stream-start.
    if (!isActivelyViewed(sessionId)) {
      setUnreadSessionIds((prev) => {
        if (prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.add(sessionId);
        return next;
      });
      postShellAction({ kind: 'session-unread', id: sessionId, unread: true });
    }
  }, [isActivelyViewed]);

  // Clear the unread flag for whatever session is currently actively viewed.
  // Fires on selection change AND when an overlay closes — exactly the two
  // moments a session can transition into "actively viewed". The deps list
  // is the literal definition of "actively viewed" so the effect re-runs
  // whenever any input changes.
  useEffect(() => {
    if (!selectedSessionId) return;
    const activelyViewed =
      !isCatalogOpen &&
      !isSkillsCatalogOpen &&
      !selectedSkillSlug &&
      !selectedCronId &&
      !isSettingsOpen;
    if (!activelyViewed) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
    postShellAction({ kind: 'session-unread', id: selectedSessionId, unread: false });
  }, [
    selectedSessionId,
    isCatalogOpen,
    isSkillsCatalogOpen,
    selectedSkillSlug,
    selectedCronId,
    isSettingsOpen,
  ]);

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

  // Update a single session's bucket. Pure (no read-then-write race) so we can
  // call it from any SSE/poll callback without worrying about stale closures.
  const updateSessionMessages = useCallback((
    sessionKey: string,
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => {
    setMessagesBySession((prev) => ({
      ...prev,
      [sessionKey]: updater(prev[sessionKey] ?? []),
    }));
  }, []);

  // Persist the selected session id for the *next* app launch. In native
  // mode Swift's `@AppStorage("selectedChatSessionId")` is the source of
  // truth, so the JS write is a dead entry — skip it. Browser mode keeps
  // its own localStorage so reloads survive.
  const persistSelectedSessionId = useCallback((sessionId: string | null) => {
    if (isNativeShell) return;
    if (sessionId) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, [isNativeShell]);

  const hydrateSession = useCallback(async (sessionId: string | null) => {
    const token = ++hydrateTokenRef.current;

    if (!sessionId) {
      sessionIdRef.current = null;
      setSelectedSessionId(null);
      persistSelectedSessionId(null);
      setIsHydratingSession(false);
      return;
    }

    // Flip selection immediately so the header + sidebar highlight respond
    // without waiting on the round-trip. If we don't have a cached bucket for
    // this session yet, seed an empty one so the previous session's messages
    // don't linger in the message list during the fetch.
    sessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    persistSelectedSessionId(sessionId);
    setMessagesBySession((prev) => (sessionId in prev ? prev : { ...prev, [sessionId]: [] }));

    // Refetching while a stream is writing into this session's bucket would
    // wipe in-flight content the user can see (the server doesn't have it yet).
    if (streamingControllersRef.current.has(sessionId)) {
      setIsHydratingSession(false);
      setSessionError(null);
      return;
    }

    setIsHydratingSession(true);

    try {
      const storedMessages = await getChatMessages(sessionId);
      if (token !== hydrateTokenRef.current) return;
      setMessagesBySession((prev) => ({ ...prev, [sessionId]: storedMessages.map(toUiMessage) }));
      setSessionError(null);
    } catch (error: unknown) {
      if (token !== hydrateTokenRef.current) return;
      sessionIdRef.current = null;
      setSelectedSessionId(null);
      persistSelectedSessionId(null);
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === hydrateTokenRef.current) {
        setIsHydratingSession(false);
      }
    }
  }, [persistSelectedSessionId]);

  const adoptSession = useCallback((session: ChatSessionSummary, preserveMessages: boolean): string => {
    const nextSession = normalizeSession(session);
    const prevSessionKey = sessionIdRef.current ?? PENDING_SESSION_KEY;
    sessionIdRef.current = nextSession.id;
    setSelectedSessionId(nextSession.id);
    setSessions((prev) => sortSessions(replaceSession(prev, nextSession)));
    persistSelectedSessionId(nextSession.id);
    setMessagesBySession((prev) => {
      if (preserveMessages && prevSessionKey !== nextSession.id) {
        // Carry the pending/current bucket onto the new session id so the
        // optimistic user+assistant pair the caller just added is preserved.
        const next = { ...prev };
        const moved = prev[prevSessionKey] ?? [];
        delete next[prevSessionKey];
        next[nextSession.id] = moved;
        return next;
      }
      if (!preserveMessages) {
        const next = { ...prev };
        delete next[PENDING_SESSION_KEY];
        next[nextSession.id] = [];
        return next;
      }
      return prev;
    });
    setSessionError(null);
    // Tell Swift to take the new session as its current selection so its
    // leftbar highlight and @AppStorage stay in sync. Replaces the legacy
    // `sessionStateChanged` chatBridge message.
    postShellAction({ kind: 'select-session', id: nextSession.id });
    return nextSession.id;
  }, [isNativeShell, persistSelectedSessionId]);

  useEffect(() => {
    const applyPort = (port: number) => {
      setSidecarPort(port);
      setConnected(true);
      // Session bootstrap is now driven by the shell host (Swift in native,
      // `useBrowserShellHost` in browser) — both fetch and dispatch a
      // `verso:shell-state` snapshot, which the mirror effects pick up.
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
  }, [refreshConnections, refreshToolkitCatalog, refreshCodexStatus]);

  // Intra-app `verso:select-session` event (currently fired by
  // `CronDetailPage`'s "Edit in Chat" after creating a fresh session). In
  // native mode we forward to Swift so its leftbar selection follows; in
  // browser mode we hydrate directly. Distinct from the now-removed
  // Swift-driven `verso:select-session` channel, which is replaced by
  // `verso:shell-state`.
  useEffect(() => {
    const onSelectSession = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' && detail.sessionId.length > 0
        ? detail.sessionId
        : null;
      // postShellAction routes to Swift in native and to BrowserShellHost
      // in browser; both end up dispatching a fresh shellState that the
      // mirror effects pick up.
      postShellAction({ kind: 'select-session', id: sessionId });
    };
    window.addEventListener('verso:select-session', onSelectSession as EventListener);
    return () => {
      window.removeEventListener('verso:select-session', onSelectSession as EventListener);
    };
  }, []);

  // Subscribe to the shell host's full state snapshot. Swift owns this in
  // native mode; `BrowserShellHost` (the hook above) owns it in browser
  // mode. Both push fresh state on every change.
  useEffect(() => {
    const onShellState = (event: Event) => {
      const detail = (event as CustomEvent<ShellState | null>).detail;
      setShellState(detail ?? null);
    };
    window.addEventListener('verso:shell-state', onShellState as EventListener);
    return () => {
      window.removeEventListener('verso:shell-state', onShellState as EventListener);
    };
  }, []);

  // Mirror the snapshot into the existing local state. The rest of the
  // chat-ui still reads from `sessions` / `selectedSessionId` — the mirror
  // is what bridges the new single-owner model to that legacy state.
  useEffect(() => {
    if (!shellState) return;
    setSessions(shellState.sessions);
  }, [shellState]);

  useEffect(() => {
    if (!shellState) return;
    const next = shellState.selectedSessionId;
    if (next === sessionIdRef.current) return;
    // Leaving overlays open while switching sessions is jarring — every
    // session click from the leftbar should land you in the chat surface.
    if (next) {
      setSelectedSkillSlug(null);
      setSelectedCronId(null);
      setIsSettingsOpen(false);
    }
    void hydrateSession(next);
  }, [shellState, hydrateSession]);

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

  const ensureSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    // Create the session with the default title ('New chat'). Passing the
    // user's first message as a seed title would suppress the orchestrator's
    // AI-title generation, which only fires when the title is still the
    // default — that's the whole "name this chat after the first response"
    // feature. The leftbar will briefly show 'New chat' during streaming and
    // then refresh to the AI-generated title once the stream completes.
    const session = normalizeSession(await createChatSession());
    return adoptSession(session, true);
  }, [adoptSession]);

  const handleNewChat = useCallback(() => {
    // Per-session streams: a new chat creates a fresh session, so it can't
    // conflict with anything that's already streaming. Only block on the
    // sidecar connection and on the in-flight hydrate (which would mid-air
    // the bucket migration in adoptSession).
    if (!connected || isHydratingSession) return;

    void (async () => {
      try {
        const session = normalizeSession(await createChatSession());
        adoptSession(session, false);
      } catch (error: unknown) {
        setSessionError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [adoptSession, connected, isHydratingSession]);

  const handleSelectSession = useCallback((sessionId: string) => {
    // Switching sessions while another is streaming is now first-class
    // behavior — the stream keeps running, the new session loads alongside.
    if (isHydratingSession || sessionId === selectedSessionId) return;
    // Route through the shell host so its sessions/selection state stays
    // authoritative — `BrowserShellHost` in browser, Swift in native. The
    // host dispatches a fresh shellState that the mirror effect picks up;
    // overlay clears happen there too.
    postShellAction({ kind: 'select-session', id: sessionId });
  }, [isHydratingSession, selectedSessionId]);

  const handleArchiveToggle = useCallback(() => {
    if (!selectedSessionId || isHydratingSession) return;
    // Archiving a session that's actively streaming would orphan the stream.
    // Block only when *this* session is the one streaming.
    if (streamingSessions.has(selectedSessionId)) return;

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
  }, [isHydratingSession, selectedSessionId, sessions, streamingSessions]);

  // Wires up the SSE handlers for an assistant placeholder that's already in
  // the pending/current bucket. Shared by the normal send path and the
  // post-connect replay so both flows produce identical streaming behaviour.
  const streamInto = useCallback((assistantId: string, text: string, attached: AttachedContext | null) => {
    // Bucket the placeholder lives in *right now*. Used only by the
    // pre-ensureSession error path; once ensureSession resolves, all SSE writes
    // target the real session id captured below.
    const initialSessionKey = sessionIdRef.current ?? PENDING_SESSION_KEY;

    void (async () => {
      try {
        const sessionId = await ensureSession();
        // adoptSession migrated PENDING → sessionId if the placeholder came
        // through there, so every SSE update from here on targets `sessionId`
        // — even if the user navigates away mid-stream.

        const abort = streamChatMessage(
          sessionId,
          text,
          (event: ChatSSEEvent) => {
            // Catch the Hermes "no credentials" event mid-stream and swap the
            // assistant placeholder for a Codex connect widget instead of
            // letting applySSEEvent surface the raw CLI-flavoured error.
            if (event.type === 'error' && typeof event.message === 'string' && isCodexAuthError(event.message)) {
              updateSessionMessages(sessionId, (prev) => prev.map((message) =>
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

            updateSessionMessages(sessionId, (prev) => prev.map((message) => {
              if (message.id !== assistantId) return message;
              return applySSEEvent(message, event);
            }));
          },
          () => {
            updateSessionMessages(sessionId, (prev) => prev.map((message) =>
              message.id === assistantId ? { ...message, isStreaming: false, endedAt: Date.now() } : message,
            ));
            markSessionNotStreaming(sessionId);
            // Tell the shell host (Swift or BrowserShellHost) that this
            // session's persisted state changed so its sessions list +
            // any AI-generated title refresh into the next snapshot.
            postShellAction({ kind: 'session-mutated', id: sessionId });
            notifyNativeResponseReady(isNativeShell);
          },
          (err: string) => {
            if (isCodexAuthError(err)) {
              // Our pre-send check missed (status fetch race, or the user
              // ran `hermes auth remove` outside the app). Convert the failed
              // assistant placeholder into a connect widget and stash the
              // payload so finishing auth replays the send.
              updateSessionMessages(sessionId, (prev) => prev.map((message) =>
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
              updateSessionMessages(sessionId, (prev) => prev.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + `\n\n**Error:** ${err}`, isStreaming: false, endedAt: Date.now() }
                  : message,
              ));
            }
            markSessionNotStreaming(sessionId);
            // Tell the shell host (Swift or BrowserShellHost) that this
            // session's persisted state changed so its sessions list +
            // any AI-generated title refresh into the next snapshot.
            postShellAction({ kind: 'session-mutated', id: sessionId });
            notifyNativeResponseReady(isNativeShell);
          },
          { attached },
        );

        // Register the stream now that we have both the sessionId and the
        // abort fn. Drives the InputBar's Send/Stop swap and the leftbar
        // working indicator (via `markSessionStreaming`'s postShellAction).
        markSessionStreaming(sessionId, abort);
      } catch (error: unknown) {
        // ensureSession threw, so we never got a real sessionId — the
        // placeholder is still in the bucket we captured at the top, and we
        // never registered a stream, so there's nothing to unregister.
        const message = error instanceof Error ? error.message : String(error);
        if (isCodexAuthError(message)) {
          updateSessionMessages(initialSessionKey, (prev) => prev.map((entry) =>
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
          updateSessionMessages(initialSessionKey, (prev) => prev.map((entry) =>
            entry.id === assistantId
              ? { ...entry, content: `**Error:** ${message}`, isStreaming: false, endedAt: Date.now() }
              : entry,
          ));
        }
      }
    })();
  }, [ensureSession, isNativeShell, markSessionNotStreaming, markSessionStreaming, updateSessionMessages]);

  const handleSend = useCallback((text: string, attached: AttachedContext | null = null) => {
    const hasContent = text.trim().length > 0 || attached?.kind === 'cron';
    if (!hasContent || !connected) return;

    const sessionKey = sessionIdRef.current ?? PENDING_SESSION_KEY;
    // Per-session: block only if *this* session is already streaming. Other
    // sessions stream independently. Pending sessions (no id yet) are
    // pre-stream; let them through so the optimistic placeholder lands.
    if (sessionIdRef.current && streamingSessions.has(sessionIdRef.current)) return;

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
      updateSessionMessages(sessionKey, (prev) => [...prev, userMsg, widgetMsg]);
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

    updateSessionMessages(sessionKey, (prev) => [...prev, userMsg, assistantMsg]);
    streamInto(assistantMsg.id, text, attached);
  }, [codexConnected, connected, streamInto, streamingSessions, updateSessionMessages]);

  const handleCodexConnected = useCallback((widgetId: string) => {
    setCodexConnected(true);
    const sessionKey = sessionIdRef.current ?? PENDING_SESSION_KEY;
    const currentMessages = messagesBySession[sessionKey] ?? [];
    const widget = currentMessages.find((m) => m.id === widgetId && m.kind === 'codex_connect_required');
    const pendingText = widget?.pendingText ?? '';
    const pendingAttached = widget?.pendingAttached ?? null;

    if (!pendingText) {
      // Nothing to replay (shouldn't happen — handleSend always stashes text
      // before showing the widget). Just remove the widget.
      updateSessionMessages(sessionKey, (prev) => prev.filter((m) => m.id !== widgetId));
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
    updateSessionMessages(sessionKey, (prev) => prev.map((m) => m.id === widgetId ? assistantMsg : m));
    streamInto(assistantMsg.id, pendingText, pendingAttached);
  }, [messagesBySession, streamInto, updateSessionMessages]);

  const handleOpenSkillInNewSession = useCallback((slug: string) => {
    // Per-session streams: opens a brand new session, no conflict with
    // anything already streaming.
    if (!connected || isHydratingSession) return;

    sessionIdRef.current = null;
    setSelectedSessionId(null);
    setSelectedSkillSlug(null);
    setMessagesBySession((prev) => {
      if (!(PENDING_SESSION_KEY in prev)) return prev;
      const next = { ...prev };
      delete next[PENDING_SESSION_KEY];
      return next;
    });
    persistSelectedSessionId(null);
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
  }, [adoptSession, connected, handleCloseSkillsCatalog, handleSend, isHydratingSession, persistSelectedSessionId]);

  const handleStop = useCallback(() => {
    // Per-session streams: the Stop button is in the InputBar of the
    // currently-viewed session, so it stops *that* session's stream. Other
    // sessions' streams keep running.
    if (!selectedSessionId) return;
    const abort = streamingControllersRef.current.get(selectedSessionId);
    if (!abort) return;
    abort();
    void cancelChatRequest(selectedSessionId).catch(() => {});
    updateSessionMessages(selectedSessionId, (prev) => prev.map((message) =>
      message.isStreaming ? { ...message, isStreaming: false, endedAt: Date.now() } : message,
    ));
    markSessionNotStreaming(selectedSessionId);
  }, [markSessionNotStreaming, selectedSessionId, updateSessionMessages]);

  const handleConnect = useCallback((request: ConnectionRequestView) => {
    openConnectionRequest(request.id);
    // The connection step lives in the assistant message of whichever session
    // the user clicked from. Capture that bucket now so a later session switch
    // doesn't redirect the status update.
    const sessionKey = sessionIdRef.current ?? PENDING_SESSION_KEY;
    pollConnectionRequest(request.id, (next) => {
      updateSessionMessages(sessionKey, (prev) => prev.map((message) => ({
        ...message,
        steps: updateConnectionSteps(message.steps, next),
      })));
    });
  }, [pollConnectionRequest, updateSessionMessages]);

  const activeSessions = sessions.filter((session) => !session.archivedAt);
  const archivedSessions = sessions.filter((session) => !!session.archivedAt);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  // Render the bucket for the currently-selected session. Pre-creation drafts
  // live under PENDING_SESSION_KEY; adoptSession migrates them on first send.
  const messages = messagesBySession[selectedSessionId ?? PENDING_SESSION_KEY] ?? [];

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
              disabled={isHydratingSession || (selectedSessionId !== null && streamingSessions.has(selectedSessionId))}
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
            isStreaming={selectedSessionId !== null && streamingSessions.has(selectedSessionId)}
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
            disabled={!connected || isHydratingSession}
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
          disabled={isHydratingSession}
          onSelect={handleSelectSession}
          emptyText={connected ? 'No active sessions yet.' : 'Sessions will appear once the sidecar is ready.'}
        />

        {archivedSessions.length > 0 && (
          <SessionSection
            title="Archived"
            sessions={archivedSessions}
            selectedSessionId={selectedSessionId}
            disabled={isHydratingSession}
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

/// Single consolidated channel for posting a typed `ShellAction` to whichever
/// shell host is active. Routes to Swift's `chatBridge` in native mode and to
/// the in-process `BrowserShellHost` via a CustomEvent in browser mode. Mode
/// detection is implicit: presence of `chatBridge.postMessage` means we're
/// inside Vervo.app.
function postShellAction(action: ShellAction): void {
  const bridge = window.webkit?.messageHandlers?.chatBridge;
  if (bridge) {
    bridge.postMessage({ type: 'action', action });
    return;
  }
  window.dispatchEvent(new CustomEvent<ShellAction>('verso:shell-action', { detail: action }));
}

function notifyNativeResponseReady(isNativeShell: boolean): void {
  if (!isNativeShell) return;
  const bridge = window.webkit?.messageHandlers?.chatBridge;
  bridge?.postMessage({ type: 'notifyResponseReady' });
}
