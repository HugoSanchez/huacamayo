import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelBrowserLogin,
  completeBrowserLogin,
  getBrowserLoginState,
  startBrowserLogin,
  type BrowserLoginSite,
} from './chat';

type BrowserLoginPhase =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'launching' }
  | { kind: 'waiting_login'; currentTitle: string | null }
  | { kind: 'completing' }
  | { kind: 'complete'; site: BrowserLoginSite }
  | { kind: 'error'; message: string };

const POLL_MS = 1500;

function useBrowserLogin(setupId: string, onComplete: (site: BrowserLoginSite) => void) {
  const [phase, setPhase] = useState<BrowserLoginPhase>({ kind: 'idle' });
  const pollRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(async () => {
    try {
      const state = await getBrowserLoginState(setupId);
      if (state.phase.kind === 'installing') setPhase({ kind: 'installing' });
      if (state.phase.kind === 'launching') setPhase({ kind: 'launching' });
      if (state.phase.kind === 'waiting_login') {
        setPhase({ kind: 'waiting_login', currentTitle: state.currentTitle });
      }
      if (state.phase.kind === 'error') {
        stopPolling();
        setPhase({ kind: 'error', message: state.phase.message });
      }
    } catch {
      // A short sidecar restart should not make the card flap to an error.
    }
  }, [setupId, stopPolling]);

  const start = useCallback(async () => {
    setPhase({ kind: 'launching' });
    try {
      await startBrowserLogin(setupId);
      stopPolling();
      void poll();
      pollRef.current = window.setInterval(() => void poll(), POLL_MS);
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [poll, setupId, stopPolling]);

  const complete = useCallback(async () => {
    stopPolling();
    setPhase({ kind: 'completing' });
    try {
      const site = await completeBrowserLogin(setupId);
      setPhase({ kind: 'complete', site });
      onCompleteRef.current(site);
    } catch (error) {
      setPhase({ kind: 'waiting_login', currentTitle: null });
      pollRef.current = window.setInterval(() => void poll(), POLL_MS);
      throw error;
    }
  }, [poll, setupId, stopPolling]);

  const cancel = useCallback(() => {
    stopPolling();
    setPhase({ kind: 'idle' });
    void cancelBrowserLogin(setupId);
  }, [setupId, stopPolling]);

  return { phase, start, complete, cancel };
}

export function BrowserLoginCard({ setupId, siteName }: { setupId: string; siteName: string | null }) {
  const [completeError, setCompleteError] = useState<string | null>(null);
  const { phase, start, complete, cancel } = useBrowserLogin(setupId, (site) => {
    window.dispatchEvent(new CustomEvent('verso:browser-login-ready', { detail: site }));
  });

  return (
    <div className="codex-connect-card browser-connect-card">
      <div className="codex-connect-card-text">
        {phase.kind === 'complete'
          ? <>Sign-in saved for <strong>{phase.site.domain}</strong>.</>
          : <>To automate {siteName ? <strong>{siteName}</strong> : 'this website'} while signed in,
            Verso opens a dedicated Chrome window where you can sign in normally. Your credentials never
            enter chat; only the browser session is saved on this Mac.</>}
      </div>
      {phase.kind === 'idle' && (
        <div className="browser-connect-actions">
          <button type="button" className="settings-button settings-button-primary" onClick={() => void start()}>
            Open sign-in window
          </button>
        </div>
      )}
      {phase.kind === 'installing' && <div className="browser-connect-status">Installing the browser (one-time download)…</div>}
      {phase.kind === 'launching' && <div className="browser-connect-status">Opening a dedicated Chrome sign-in window…</div>}
      {phase.kind === 'completing' && <div className="browser-connect-status">Saving sign-in…</div>}
      {phase.kind === 'error' && (
        <div className="browser-connect-error-row">
          <div className="browser-connect-error">{phase.message}</div>
          <button type="button" className="settings-button" onClick={cancel}>Dismiss</button>
        </div>
      )}
      {phase.kind === 'waiting_login' && (
        <div className="browser-connect-waiting">
          <div className="browser-connect-status">
            Sign in in the browser window, then return here. Do not enter credentials in chat.
            {phase.currentTitle && <span className="browser-connect-current"> Open: {phase.currentTitle}</span>}
          </div>
          <div className="browser-connect-actions">
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={() => {
                setCompleteError(null);
                void complete().catch((error) => setCompleteError(error instanceof Error ? error.message : String(error)));
              }}
            >
              I'm signed in — continue
            </button>
            <button type="button" className="settings-button" onClick={cancel}>Cancel</button>
          </div>
          {completeError && <div className="browser-connect-error">{completeError}</div>}
        </div>
      )}
    </div>
  );
}
