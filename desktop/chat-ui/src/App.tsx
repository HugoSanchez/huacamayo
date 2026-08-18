import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { CatalogOverlay } from './CatalogOverlay';
import { SkillsCatalogOverlay } from './SkillsCatalogOverlay';
import { SkillDetailPage } from './SkillDetailPage';
import { HubSkillDetailPage } from './HubSkillDetailPage';
import { CronDetailPage } from './CronDetailPage';
import { SettingsPage } from './SettingsPage';
import {
  cancelChatRequest,
  createConnectionRequest,
  createChatSession,
  updateChatSessionModel,
  getAnthropicStatus,
  getChatMessages,
  getCodexStatus,
  getConnectionRequest,
  getConnections,
  getCustomConnectors,
  getSidecarPort,
  getToolkits,
  openConnectionRequest,
  openCustomConnectorAuth,
  openExternalUrl,
  disconnectCustomConnector,
  retryCustomConnector,
  resolveSidecarUrl,
  setSidecarAuthToken,
  setSidecarPort,
  streamChatMessage,
} from './chat';
import type {
  AttachedContext,
  ChatMessage,
  ChatSSEEvent,
  ActivityStep,
  ChatSessionSummary,
  ChatModel,
  OutgoingAttachment,
  ConnectionRequestView,
  ConnectionView,
  CustomConnectorView,
  ReasoningEffort,
  StoredChatMessage,
  ToolkitView,
} from './types';
import { ANTHROPIC_CHAT_MODELS, CHAT_MODEL_LABELS, CODEX_CHAT_MODELS } from './types';
import type { ShellCommand, ShellState } from './shell-protocol';
import { useBrowserShellHost } from './browser-shell-host';
import { applyChatSSEEvent } from './chat-event-reducer';
import { hasNativeShell, postShellAction } from './shell-bridge';

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        chatBridge?: { postMessage: (msg: unknown) => void };
      };
    };
    setSidecarPort?: (port: number) => void;
    __versoSidecarPort?: number;
    __versoSidecarToken?: string;
    __versoShellMode?: 'native' | 'browser';
    __versoPendingCatalogOpen?: boolean;
    __versoPendingSkillsCatalogOpen?: boolean;
    __versoPendingShellState?: ShellState | null;
    __versoPendingShellCommands?: ShellCommand[];
    __versoShellCommandReady?: boolean;
  }
}

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
  // The shell host is the only owner of sessions and selection. Swift drives
  // this snapshot in native mode; BrowserShellHost provides the same contract
  // during browser development.
  const [shellState, setShellState] = useState<ShellState | null>(
    () => (typeof window !== 'undefined' ? window.__versoPendingShellState ?? null : null),
  );
  const sessions = shellState?.sessions ?? [];
  const selectedSessionId = shellState?.selectedSessionId ?? null;
  // Messages live in a per-session bucket so an in-flight stream for session A
  // can't bleed into session B's view when the user switches mid-stream.
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [connected, setConnected] = useState(false);
  // null = unknown (e.g. before the orchestrator is ready or the check is in
  // flight). We only intercept sends when we're sure the user is disconnected,
  // so unknown lets the normal Hermes flow proceed and surface its own error.
  const [codexConnected, setCodexConnected] = useState<boolean | null>(null);
  const [anthropicConnected, setAnthropicConnected] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [customConnectors, setCustomConnectors] = useState<CustomConnectorView[]>([]);
  // Full toolkit catalog — used by the chat UI to render logos in tool-call
  // rows for toolkits the user may not have connected (or whose connection
  // record lacks a logoUrl). Best-effort: failures here just fall back to the
  // initial-letter badge.
  const [toolkitCatalog, setToolkitCatalog] = useState<ToolkitView[]>([]);
  const isLoadingSessions = connected && shellState === null;
  const [isHydratingSession, setIsHydratingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isCatalogOpen, setIsCatalogOpen] = useState<boolean>(
    Boolean(typeof window !== 'undefined' && window.__versoPendingCatalogOpen),
  );
  const [isSkillsCatalogOpen, setIsSkillsCatalogOpen] = useState<boolean>(
    Boolean(typeof window !== 'undefined' && window.__versoPendingSkillsCatalogOpen),
  );
  const [selectedSkillSlug, setSelectedSkillSlug] = useState<string | null>(null);
  const [selectedHubSkillIdentifier, setSelectedHubSkillIdentifier] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedCronId, setSelectedCronId] = useState<string | null>(null);
  // Names resolved by the detail pages (via onTitleResolved) so the header
  // can show "Skills: <name>" / "Routines: <name>" without us re-fetching.
  const [activeSkillName, setActiveSkillName] = useState<string | null>(null);
  const [activeCronName, setActiveCronName] = useState<string | null>(null);
  const [inputDrafts, setInputDrafts] = useState<Record<string, { text: string; attached: AttachedContext | null }>>({});
  // Reasoning effort for the next message. Sticky across sessions (matches the
  // global model/effort footer in Cursor/Claude). 'medium' mirrors the gateway
  // config default so the visible selection and actual behaviour line up.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  // Mirrors the active session's persisted model. A choice made before a
  // session exists is carried into that session when it is created.
  const [model, setModel] = useState<ChatModel | null>(null);
  // The picker is only for choosing a model for a *new* route, so list models
  // whose provider has been positively confirmed as connected. A persisted
  // session model is rendered from `model` separately and is never removed
  // merely because its provider is currently unavailable.
  const availableModels = useMemo<readonly ChatModel[]>(() => {
    const models: ChatModel[] = [];
    if (codexConnected === true) models.push(...CODEX_CHAT_MODELS);
    if (anthropicConnected === true) models.push(...ANTHROPIC_CHAT_MODELS);
    return models;
  }, [anthropicConnected, codexConnected]);
  const defaultModel = useMemo<ChatModel | null>(() => {
    if (codexConnected === true) return CODEX_CHAT_MODELS[0];
    if (anthropicConnected === true) return ANTHROPIC_CHAT_MODELS[0];
    return null;
  }, [anthropicConnected, codexConnected]);
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
    selectedHubSkillIdentifier,
    selectedCronId,
    isSettingsOpen,
  });
  useEffect(() => {
    viewStateRef.current = {
      selectedSessionId,
      isCatalogOpen,
      isSkillsCatalogOpen,
      selectedSkillSlug,
      selectedHubSkillIdentifier,
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
    if (v.selectedSkillSlug || v.selectedHubSkillIdentifier || v.selectedCronId) return false;
    if (v.isSettingsOpen) return false;
    return true;
  }, []);

  const handleCloseCatalog = useCallback(() => {
    setIsCatalogOpen(false);
    postShellAction({ kind: 'catalog-closed' });
  }, []);

  const handleCloseSkillsCatalog = useCallback(() => {
    setIsSkillsCatalogOpen(false);
    postShellAction({ kind: 'skills-catalog-closed' });
  }, []);

  const handleCloseCatalogs = useCallback(() => {
    setIsCatalogOpen(false);
    setIsSkillsCatalogOpen(false);
    postShellAction({ kind: 'catalog-closed' });
    postShellAction({ kind: 'skills-catalog-closed' });
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
      !selectedHubSkillIdentifier &&
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
    selectedHubSkillIdentifier,
    selectedCronId,
    isSettingsOpen,
  ]);

  // Clear the cached detail-page names when their id clears, so the next
  // time you open a routine/skill the header doesn't briefly show the
  // previous one's name.
  useEffect(() => {
    if (!selectedSkillSlug && !selectedHubSkillIdentifier) setActiveSkillName(null);
  }, [selectedSkillSlug, selectedHubSkillIdentifier]);
  useEffect(() => { if (!selectedCronId) setActiveCronName(null); }, [selectedCronId]);
  useEffect(() => {
    if (selectedSessionId !== null || !defaultModel) return;
    setModel((current) => {
      if (!current) return defaultModel;
      if (defaultModel === CODEX_CHAT_MODELS[0] && current.startsWith('claude-')) return defaultModel;
      return current;
    });
  }, [defaultModel, selectedSessionId]);

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

  const refreshConnections = useCallback(async (opts: { fast?: boolean } = {}) => {
    if (!getSidecarPort()) return;
    try {
      const result = await getConnections(opts);
      setConnections(result.connections);
      setCustomConnectors(await getCustomConnectors());
    } catch {
      // Ignore best-effort refresh failures.
    }
  }, []);

  // Custom-connector OAuth completes outside the app (system browser →
  // gateway callback), so no UI action fires when it finishes. Existing
  // OAuth sessions also hydrate instantly from their cached tool count while
  // Hermes warms up. Poll either transient state until the live registry is
  // authoritative, then stop.
  useEffect(() => {
    if (!connected) return;
    if (!customConnectors.some((c) =>
      c.status.state === 'pending_auth'
      || (c.status.state === 'connected' && c.status.cached === true))) return;
    const timer = window.setInterval(() => {
      void refreshConnections();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [connected, customConnectors, refreshConnections]);

  const refreshCodexStatus = useCallback(async () => {
    if (!getSidecarPort()) return;
    try {
      const next = await getCodexStatus();
      setCodexConnected(next.connected);
    } catch {
      // Best-effort: leave codexConnected as-is so we don't accidentally
      // block sends because of a transient status fetch failure.
    }
    try {
      const anthropic = await getAnthropicStatus();
      setAnthropicConnected(anthropic.connected);
    } catch {
      // Same best-effort stance as Codex above.
    }
  }, []);

  // Settings broadcasts this after any provider connect/disconnect so the
  // model selector updates immediately, without waiting for a page switch.
  useEffect(() => {
    const onModelAuthChanged = () => { void refreshCodexStatus(); };
    window.addEventListener('verso:model-auth-changed', onModelAuthChanged);
    return () => window.removeEventListener('verso:model-auth-changed', onModelAuthChanged);
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

  const hydrateSession = useCallback(async (sessionId: string | null) => {
    const token = ++hydrateTokenRef.current;

    if (!sessionId) {
      sessionIdRef.current = null;
      setIsHydratingSession(false);
      return;
    }

    // Flip selection immediately so the header + sidebar highlight respond
    // without waiting on the round-trip. If we don't have a cached bucket for
    // this session yet, seed an empty one so the previous session's messages
    // don't linger in the message list during the fetch.
    sessionIdRef.current = sessionId;
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
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === hydrateTokenRef.current) {
        setIsHydratingSession(false);
      }
    }
  }, []);

  const adoptSession = useCallback((session: ChatSessionSummary, preserveMessages: boolean): string => {
    const nextSession = normalizeSession(session);
    const prevSessionKey = sessionIdRef.current ?? PENDING_SESSION_KEY;
    sessionIdRef.current = nextSession.id;
    setModel(nextSession.model);
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
  }, []);

  useEffect(() => {
    const applyPort = (port: number) => {
      setSidecarPort(port);
      setSidecarAuthToken(window.__versoSidecarToken);
      setConnected(true);
      // Session bootstrap is now driven by the shell host (Swift in native,
      // `useBrowserShellHost` in browser) — both fetch and dispatch a
      // `verso:shell-state` snapshot, which the state subscriber picks up.
      // Fast fetch paints from the sidecar's local cache when the remote
      // sync is slow; the follow-up full fetch rides the same in-flight
      // sync server-side and converges the UI to fresh data.
      void refreshConnections({ fast: true }).then(() => refreshConnections());
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
      const detail = (ev as CustomEvent<{ port?: unknown; token?: unknown }>).detail;
      const rawPort = detail?.port;
      const port = typeof rawPort === 'number' ? rawPort : Number(rawPort);
      if (Number.isFinite(port) && port > 0) {
        if (typeof detail?.token === 'string') window.__versoSidecarToken = detail.token;
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
      // in browser; both end up dispatching a fresh shellState snapshot.
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

  useEffect(() => {
    if (!shellState) return;
    const next = shellState.selectedSessionId;
    if (next === sessionIdRef.current) return;
    const nextSession = shellState.sessions.find((session) => session.id === next);
    if (nextSession) setModel(nextSession.model);
    // Leaving overlays open while switching sessions is jarring — every
    // session click from the leftbar should land you in the chat surface.
    if (next) {
      setSelectedSkillSlug(null);
      setSelectedHubSkillIdentifier(null);
      setSelectedCronId(null);
      setIsSettingsOpen(false);
      handleCloseCatalogs();
    }
    void hydrateSession(next);
  }, [shellState, hydrateSession, handleCloseCatalogs]);

  useEffect(() => {
    const handleShellCommand = (event: Event) => {
      const command = (event as CustomEvent<ShellCommand>).detail;
      if (!command) return;
      switch (command.kind) {
        case 'open-catalog':
          setIsCatalogOpen(true);
          setIsSkillsCatalogOpen(false);
          return;
        case 'close-catalog':
          setIsCatalogOpen(false);
          return;
        case 'open-skills-catalog':
          setIsSkillsCatalogOpen(true);
          setIsCatalogOpen(false);
          return;
        case 'close-skills-catalog':
          setIsSkillsCatalogOpen(false);
          return;
        case 'open-cron':
          setSelectedCronId(command.id);
          setSelectedSkillSlug(null);
          setSelectedHubSkillIdentifier(null);
          setIsCatalogOpen(false);
          setIsSkillsCatalogOpen(false);
          return;
        case 'open-settings':
          setIsSettingsOpen(true);
          setSelectedCronId(null);
          setSelectedSkillSlug(null);
          setSelectedHubSkillIdentifier(null);
          setIsCatalogOpen(false);
          setIsSkillsCatalogOpen(false);
          return;
        case 'focus-chat':
          setSelectedSkillSlug(null);
          setSelectedHubSkillIdentifier(null);
          setSelectedCronId(null);
          setIsSettingsOpen(false);
          setIsCatalogOpen(false);
          setIsSkillsCatalogOpen(false);
          return;
        default: {
          const unhandled: never = command;
          void unhandled;
          return;
        }
      }
    };
    window.addEventListener('verso:shell-command', handleShellCommand as EventListener);
    window.__versoShellCommandReady = true;
    const pending = window.__versoPendingShellCommands ?? [];
    window.__versoPendingShellCommands = [];
    for (const command of pending) {
      handleShellCommand(new CustomEvent<ShellCommand>('verso:shell-command', { detail: command }));
    }
    return () => {
      window.__versoShellCommandReady = false;
      window.removeEventListener('verso:shell-command', handleShellCommand as EventListener);
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

  const handleSelectSkill = useCallback((slug: string) => {
    setSelectedSkillSlug(slug);
    setSelectedHubSkillIdentifier(null);
    handleCloseSkillsCatalog();
  }, [handleCloseSkillsCatalog]);

  const handleSelectHubSkill = useCallback((identifier: string) => {
    setSelectedHubSkillIdentifier(identifier);
    setSelectedSkillSlug(null);
    handleCloseSkillsCatalog();
  }, [handleCloseSkillsCatalog]);

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
            postShellAction({ kind: 'connections-changed' });
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
          postShellAction({ kind: 'connections-changed' });
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
    const session = normalizeSession(await createChatSession(undefined, model ?? defaultModel ?? undefined));
    return adoptSession(session, true);
  }, [adoptSession, defaultModel, model]);

  const handleNewChat = useCallback(() => {
    // Per-session streams: a new chat creates a fresh session, so it can't
    // conflict with anything that's already streaming. Only block on the
    // sidecar connection and on the in-flight hydrate (which would mid-air
    // the bucket migration in adoptSession).
    if (!connected || isHydratingSession) return;

    void (async () => {
      try {
        // A new chat does not inherit the active chat's model. In particular,
        // an old session may display a provider that is no longer connected.
        const session = normalizeSession(await createChatSession(undefined, defaultModel ?? undefined));
        adoptSession(session, false);
      } catch (error: unknown) {
        setSessionError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [adoptSession, connected, defaultModel, isHydratingSession]);

  const handleModelChange = useCallback((nextModel: ChatModel) => {
    setModel(nextModel);
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;

    // Save on selection, rather than on the next send. This makes the choice
    // durable for empty sessions and prevents a reopen from switching a
    // conversation to a different provider.
    void updateChatSessionModel(sessionId, nextModel)
      .then(() => {
        postShellAction({ kind: 'session-mutated', id: sessionId });
      })
      .catch((error: unknown) => {
        setSessionError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  const handleSelectSession = useCallback((sessionId: string) => {
    // Switching sessions while another is streaming is now first-class
    // behavior — the stream keeps running, the new session loads alongside.
    if (isHydratingSession || sessionId === selectedSessionId) return;
    // Route through the shell host so its sessions/selection state stays
    // authoritative — `BrowserShellHost` in browser, Swift in native. The
    // host dispatches a fresh shellState that the state subscriber picks up;
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

    postShellAction({
      kind: session.archivedAt ? 'unarchive-session' : 'archive-session',
      id: selectedSessionId,
    });
  }, [isHydratingSession, selectedSessionId, sessions, streamingSessions]);

  // Wires up the SSE handlers for an assistant placeholder that's already in
  // the pending/current bucket. Shared by the normal send path and the
  // post-connect replay so both flows produce identical streaming behaviour.
  const streamInto = useCallback((assistantId: string, text: string, attached: AttachedContext | null, attachments: OutgoingAttachment[] = []) => {
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
        updateSessionMessages(sessionId, (prev) => prev.map((message) =>
          message.id === assistantId ? { ...message, sessionId } : message,
        ));

        let pendingEvents: ChatSSEEvent[] = [];
        let flushScheduled = false;
        const flushEvents = () => {
          flushScheduled = false;
          if (pendingEvents.length === 0) return;
          const events = pendingEvents;
          pendingEvents = [];
          updateSessionMessages(sessionId, (prev) => prev.map((message) => {
            if (message.id !== assistantId) return message;
            return events.reduce((next, event) => applyChatSSEEvent(next, event), message);
          }));
        };
        const scheduleFlush = () => {
          if (flushScheduled) return;
          flushScheduled = true;
          window.requestAnimationFrame(flushEvents);
        };

        const abort = streamChatMessage(
          sessionId,
          text,
          (event: ChatSSEEvent) => {
            // Catch the Hermes "no credentials" event mid-stream and swap the
            // assistant placeholder for a Codex connect widget instead of
            // letting applyChatSSEEvent surface the raw CLI-flavoured error.
            if (event.type === 'error' && typeof event.message === 'string' && isCodexAuthError(event.message)) {
              flushEvents();
              updateSessionMessages(sessionId, (prev) => prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      kind: 'codex_connect_required' as const,
                      pendingText: text,
                      pendingAttached: attached,
                      pendingAttachments: attachments,
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

            pendingEvents.push(event);
            scheduleFlush();
          },
          () => {
            flushEvents();
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
                      pendingAttachments: attachments,
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
          { attached, attachments, reasoningEffort, model: model ?? defaultModel },
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
                  pendingAttachments: attachments,
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
  }, [defaultModel, ensureSession, isNativeShell, markSessionNotStreaming, markSessionStreaming, model, reasoningEffort, updateSessionMessages]);

  const handleSend = useCallback((text: string, attached: AttachedContext | null = null, attachments: OutgoingAttachment[] = []) => {
    const hasContent = text.trim().length > 0 || attached?.kind === 'cron' || attachments.length > 0;
    if (!hasContent || !connected) return;
    const selectedModel = model ?? defaultModel;
    if (!selectedModel) {
      setSessionError('Choose a model for this conversation before sending.');
      return;
    }
    if (!model) {
      setModel(selectedModel);
    }
    const providerUnavailable = selectedModel.startsWith('claude-')
      ? anthropicConnected === false
      : codexConnected === false;
    if (providerUnavailable) {
      setSessionError(`${CHAT_MODEL_LABELS[selectedModel]} is not currently connected. Choose an available model before sending.`);
      return;
    }

    const sessionKey = sessionIdRef.current ?? PENDING_SESSION_KEY;
    // Per-session: block only if *this* session is already streaming. Other
    // sessions stream independently. Pending sessions (no id yet) are
    // pre-stream; let them through so the optimistic placeholder lands.
    if (sessionIdRef.current && streamingSessions.has(sessionIdRef.current)) return;

    let displayText = attached?.kind === 'cron' && text.trim().length === 0
      ? `[Reviewing routine: ${attached.name}]`
      : text;
    // Mirror the orchestrator's stored form (`appendAttachmentMarkers`) so the
    // optimistic message matches what a reload hydrates from the store.
    if (attachments.length > 0) {
      const markers = attachments
        .map((a) => (a.kind === 'document' ? `[attached document: ${a.name}]` : `[attached image: ${a.name}]`))
        .join('\n');
      displayText = displayText ? `${displayText}\n\n${markers}` : markers;
    }

    // If we know the user hasn't connected any provider yet, don't bother
    // hitting Hermes — it'll just error with a CLI-flavoured "no
    // credentials" message that doesn't help our users. Stash the user's
    // message on the synthetic widget so we can replay the send once they
    // finish auth. An Anthropic API key counts as connected: Claude models
    // route to it, and it may even be the default provider.
    if (codexConnected === false && anthropicConnected !== true) {
      const userMsg: ChatMessage = { id: nextId(), role: 'user', content: displayText };
      const widgetMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        kind: 'codex_connect_required',
        pendingText: text,
        pendingAttached: attached,
        pendingAttachments: attachments,
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
    streamInto(assistantMsg.id, text, attached, attachments);
  }, [anthropicConnected, codexConnected, connected, defaultModel, model, streamInto, streamingSessions, updateSessionMessages]);

  const handleCodexConnected = useCallback((widgetId: string) => {
    setCodexConnected(true);
    const sessionKey = sessionIdRef.current ?? PENDING_SESSION_KEY;
    const currentMessages = messagesBySession[sessionKey] ?? [];
    const widget = currentMessages.find((m) => m.id === widgetId && m.kind === 'codex_connect_required');
    const pendingText = widget?.pendingText ?? '';
    const pendingAttached = widget?.pendingAttached ?? null;
    const pendingAttachments = widget?.pendingAttachments ?? [];

    if (!pendingText && pendingAttachments.length === 0) {
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
    streamInto(assistantMsg.id, pendingText, pendingAttached, pendingAttachments);
  }, [messagesBySession, streamInto, updateSessionMessages]);

  const handleOpenSkillInNewSession = useCallback((slug: string) => {
    // Per-session streams: opens a brand new session, no conflict with
    // anything already streaming.
    if (!connected || isHydratingSession) return;

    sessionIdRef.current = null;
    postShellAction({ kind: 'select-session', id: null });
    setSelectedSkillSlug(null);
    setSelectedHubSkillIdentifier(null);
    setMessagesBySession((prev) => {
      if (!(PENDING_SESSION_KEY in prev)) return prev;
      const next = { ...prev };
      delete next[PENDING_SESSION_KEY];
      return next;
    });
    handleCloseSkillsCatalog();
    const selectedAvailableModel = model && availableModels.includes(model) ? model : defaultModel;
    void (async () => {
      try {
        const session = normalizeSession(await createChatSession(
          slug.replace(/-/g, ' '),
          selectedAvailableModel ?? undefined,
        ));
        adoptSession(session, false);
        if (selectedAvailableModel) {
          handleSend(`/${slug}`);
        } else {
          setSessionError('Choose an available model before starting this skill conversation.');
        }
      } catch (error: unknown) {
        setSessionError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [adoptSession, availableModels, connected, defaultModel, handleCloseSkillsCatalog, handleSend, isHydratingSession, model]);

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
      : selectedSkillSlug || selectedHubSkillIdentifier
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
      {!isNativeShell && !selectedSkillSlug && !selectedHubSkillIdentifier && !selectedCronId && !isSettingsOpen && (
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
      ) : selectedHubSkillIdentifier ? (
        <HubSkillDetailPage
          identifier={selectedHubSkillIdentifier}
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
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={setReasoningEffort}
            model={model}
            onModelChange={handleModelChange}
            availableModels={availableModels}
            onModelMenuOpen={refreshCodexStatus}
            isStreaming={selectedSessionId !== null && streamingSessions.has(selectedSessionId)}
            disabled={!connected || isHydratingSession || !!selectedSession?.archivedAt}
            focusRecoveryEnabled={!isCatalogOpen && !isSkillsCatalogOpen}
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
      onCustomConnectorAdded={() => {
        void refreshConnections();
        bumpCatalogRefresh();
      }}
    />
  );

  const skillsCatalog = (
    <SkillsCatalogOverlay
      isOpen={isSkillsCatalogOpen}
      onClose={handleCloseSkillsCatalog}
      onSelectSkill={handleSelectSkill}
      onSelectHubSkill={handleSelectHubSkill}
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

        <CustomConnectorSection
          connectors={customConnectors}
          onSignIn={(id) => {
            void retryCustomConnector(id)
              .then((connector) => {
                if (connector.status.state === 'pending_auth') openCustomConnectorAuth(connector.id);
              })
              // Failures land in the connector's failed-state reason server-side;
              // the refresh below surfaces them on the row either way.
              .catch(() => {})
              .then(() => refreshConnections());
          }}
          onDisconnect={(id) => {
            setCustomConnectors((current) => current.filter((connector) => connector.id !== id));
            void disconnectCustomConnector(id)
              .catch(() => {})
              .then(() => refreshConnections());
          }}
        />
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
      <div className="chat-header-band-top" data-window-drag>
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

function CustomConnectorSection({
  connectors,
  onSignIn,
  onDisconnect,
}: {
  connectors: CustomConnectorView[];
  onSignIn: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  if (connectors.length === 0) return null;
  return (
    <section className="session-section">
      <div className="session-section-title">Custom</div>
      <div className="custom-connector-list">
        {connectors.map((connector) => (
          <div className="custom-connector-row" key={connector.id}>
            {connector.logoUrl ? (
              <img className="custom-connector-logo" src={resolveSidecarUrl(connector.logoUrl) ?? connector.logoUrl} alt="" aria-hidden="true" />
            ) : (
              <span className="custom-connector-logo is-fallback" aria-hidden="true">
                {connector.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="custom-connector-main">
              <div className="custom-connector-name">
                <span className={`custom-connector-dot is-${connector.status.state}`} />
                <span>{connector.name}</span>
                <span className="custom-connector-tag">custom</span>
              </div>
              {connector.status.state !== 'connected' && (
                <div className="custom-connector-status">{customConnectorStatusText(connector)}</div>
              )}
            </div>
            <div className="custom-connector-actions">
              {connector.status.state !== 'connected' && (
                <button type="button" onClick={() => onSignIn(connector.id)} aria-label={`Sign in to ${connector.name}`}>
                  Sign in
                </button>
              )}
              <button type="button" onClick={() => onDisconnect(connector.id)} aria-label={`Disconnect ${connector.name}`}>
                Disconnect
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function customConnectorStatusText(connector: CustomConnectorView): string {
  if (connector.status.state === 'pending_auth') return 'Waiting for sign-in';
  if (connector.status.state === 'connected') return 'Connected';
  return connector.status.reason;
}

function toUiMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning,
    steps: message.steps,
    startedAt: message.startedAt,
    endedAt: message.endedAt,
  };
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

function notifyNativeResponseReady(isNativeShell: boolean): void {
  if (!isNativeShell) return;
  const bridge = window.webkit?.messageHandlers?.chatBridge;
  bridge?.postMessage({ type: 'notifyResponseReady' });
}
