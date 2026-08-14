import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelBrowserSetup,
  completeBrowserSetup,
  getBrowserSetupState,
  startBrowserSetup,
  type BrowserConnectionView,
} from './chat';

export type BrowserConnectPhase =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'launching' }
  | { kind: 'waiting_login'; currentUrl: string | null; currentTitle: string | null }
  | { kind: 'completing' }
  | { kind: 'connected'; connection: BrowserConnectionView }
  | { kind: 'error'; message: string };

const POLL_MS = 1500;

/**
 * Drives the website-connection setup flow: open a dedicated browser window,
 * wait for the user to sign in, capture the page they land on. Shared by the
 * inline chat card and the routine page's Reconnect button.
 */
export function useBrowserConnect(connectionId: string, onConnected?: (connection: BrowserConnectionView) => void) {
  const [phase, setPhase] = useState<BrowserConnectPhase>({ kind: 'idle' });
  const pollRef = useRef<number | null>(null);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(async () => {
    try {
      const state = await getBrowserSetupState(connectionId);
      switch (state.phase.kind) {
        case 'installing':
          setPhase({ kind: 'installing' });
          break;
        case 'launching':
          setPhase({ kind: 'launching' });
          break;
        case 'waiting_login':
          setPhase({ kind: 'waiting_login', currentUrl: state.currentUrl, currentTitle: state.currentTitle });
          break;
        case 'error':
          stopPolling();
          setPhase({ kind: 'error', message: state.phase.message });
          break;
        default:
          break;
      }
    } catch {
      // Transient poll failures are fine — keep the last known phase.
    }
  }, [connectionId, stopPolling]);

  const start = useCallback(async () => {
    setPhase({ kind: 'launching' });
    try {
      await startBrowserSetup(connectionId);
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    stopPolling();
    void poll();
    pollRef.current = window.setInterval(() => void poll(), POLL_MS);
  }, [connectionId, poll, stopPolling]);

  const complete = useCallback(async () => {
    stopPolling();
    setPhase({ kind: 'completing' });
    try {
      const connection = await completeBrowserSetup(connectionId);
      setPhase({ kind: 'connected', connection });
      onConnectedRef.current?.(connection);
    } catch (error) {
      // Back to waiting so the user can open the right page and retry.
      setPhase({ kind: 'waiting_login', currentUrl: null, currentTitle: null });
      pollRef.current = window.setInterval(() => void poll(), POLL_MS);
      throw error;
    }
  }, [connectionId, poll, stopPolling]);

  const cancel = useCallback(() => {
    stopPolling();
    setPhase({ kind: 'idle' });
    void cancelBrowserSetup(connectionId);
  }, [connectionId, stopPolling]);

  return { phase, start, complete, cancel };
}

export function BrowserConnectFlow({ phase, onComplete, onCancel }: {
  phase: BrowserConnectPhase;
  onComplete: () => Promise<void>;
  onCancel: () => void;
}) {
  const [completeError, setCompleteError] = useState<string | null>(null);

  if (phase.kind === 'idle') return null;

  if (phase.kind === 'installing') {
    return <div className="browser-connect-status">Setting up the automation browser (one-time download)…</div>;
  }
  if (phase.kind === 'launching') {
    return <div className="browser-connect-status">Opening a browser window…</div>;
  }
  if (phase.kind === 'completing') {
    return <div className="browser-connect-status">Saving the connection…</div>;
  }
  if (phase.kind === 'error') {
    return (
      <div className="browser-connect-error-row">
        <div className="browser-connect-error">{phase.message}</div>
        <button type="button" className="settings-button" onClick={onCancel}>Dismiss</button>
      </div>
    );
  }
  if (phase.kind === 'connected') {
    return (
      <div className="browser-connect-connected">
        ✓ Connected to <strong>{phase.connection.domain ?? phase.connection.name}</strong>
      </div>
    );
  }

  // waiting_login
  return (
    <div className="browser-connect-waiting">
      <div className="browser-connect-status">
        A browser window is open. Sign in and go to the page the routine should
        work on, then come back here.
        {phase.currentTitle ? (
          <span className="browser-connect-current"> Currently open: {phase.currentTitle}</span>
        ) : null}
      </div>
      <div className="browser-connect-actions">
        <button
          type="button"
          className="settings-button settings-button-primary"
          onClick={() => {
            setCompleteError(null);
            void onComplete().catch((error) => {
              setCompleteError(error instanceof Error ? error.message : String(error));
            });
          }}
        >
          I'm signed in — continue
        </button>
        <button type="button" className="settings-button" onClick={onCancel}>Cancel</button>
      </div>
      {completeError && <div className="browser-connect-error">{completeError}</div>}
    </div>
  );
}

/**
 * Inline chat card rendered when the agent calls request_browser_connection.
 * On success it dispatches `verso:browser-connected`; App turns that into the
 * follow-up chat message that lets the agent finish creating the routine.
 */
export function BrowserConnectCard({ connectionId, siteName }: { connectionId: string; siteName: string | null }) {
  const { phase, start, complete, cancel } = useBrowserConnect(connectionId, (connection) => {
    window.dispatchEvent(new CustomEvent('verso:browser-connected', {
      detail: { connectionId: connection.id, domain: connection.domain, title: connection.title },
    }));
  });

  return (
    <div className="codex-connect-card browser-connect-card">
      <div className="codex-connect-card-text">
        {phase.kind === 'connected'
          ? 'Website connected. The routine can now use this sign-in.'
          : <>To automate {siteName ? <strong>{siteName}</strong> : 'this website'}, Verso opens a
            dedicated browser window where you sign in once. Your login stays on this Mac.</>}
      </div>
      {phase.kind === 'idle' ? (
        <div className="browser-connect-actions">
          <button type="button" className="settings-button settings-button-primary" onClick={() => void start()}>
            Open browser window
          </button>
        </div>
      ) : (
        <BrowserConnectFlow phase={phase} onComplete={complete} onCancel={cancel} />
      )}
    </div>
  );
}
