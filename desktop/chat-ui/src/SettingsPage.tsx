import { useEffect, useState } from 'react';
import {
  disconnectCodex,
  getCodexStatus,
  getSidecarPort,
  type CodexStatus,
} from './chat';
import { CodexMark, CodexConnectFlow, useCodexConnect } from './CodexConnect';

interface ManagedAccountView {
  backend: {
    configured: boolean;
    baseUrl: string | null;
  };
  session: {
    present: boolean;
    userId: string | null;
    email: string | null;
    displayName: string | null;
    expiresAt: string | null;
    receivedAt: string | null;
    expired: boolean;
  };
  account: {
    state: string;
    error: string | null;
    user: {
      id: string;
      email: string | null;
      displayName: string | null;
    } | null;
    entitlements: Array<{
      id: string;
      mode: string;
      status: string;
    }>;
  };
}

interface Props {
  onBack: () => void;
}

export function SettingsPage({ onBack }: Props) {
  const [account, setAccount] = useState<ManagedAccountView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const port = getSidecarPort();
      if (!port) {
        if (!cancelled) {
          setError('Orchestrator is not ready yet — try again in a moment.');
          setIsLoading(false);
        }
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/managed/account`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setError(
            (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string')
              ? body.message
              : `Failed to load account (HTTP ${res.status}).`,
          );
        } else {
          setAccount(body as ManagedAccountView);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    const port = getSidecarPort();
    if (port) {
      // Tell the orchestrator to clear local session + call backend revoke.
      // We don't await success: the macOS shell separately clears Keychain
      // and the chat-ui will be torn down when the app reverts to SignInView.
      try {
        await fetch(`http://127.0.0.1:${port}/managed/session`, { method: 'DELETE' });
      } catch {
        // best-effort — the app shell handles the rest
      }
    }
    // Notify the macOS shell so it clears Keychain and switches to SignInView.
    window.webkit?.messageHandlers?.chatBridge?.postMessage({ type: 'signOut' });
    setIsSigningOut(false);
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button type="button" className="settings-back" onClick={onBack}>
          ← Back
        </button>
      </div>

      {isLoading ? (
        <div className="settings-loading">Loading…</div>
      ) : error ? (
        <div className="settings-error">
          <p>{error}</p>
          <button type="button" className="settings-button" onClick={() => { setError(null); setIsLoading(true); window.location.reload(); }}>
            Retry
          </button>
        </div>
      ) : account ? (
        <div className="settings-body">
          <section className="settings-section">
            <h2>Account</h2>
            <div className="settings-row">
              <span className="settings-label">Signed in as</span>
              <span className="settings-value">
                {account.account.user?.email
                  || account.account.user?.displayName
                  || account.session.email
                  || account.session.displayName
                  || account.session.userId
                  || 'Not signed in'}
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Status</span>
              <span className="settings-value">{titleCase(account.account.state.replace(/_/g, ' '))}</span>
            </div>
            {account.account.entitlements[0] ? (
              <div className="settings-row">
                <span className="settings-label">Mode</span>
                <span className="settings-value">{titleCase(account.account.entitlements[0].mode)}</span>
              </div>
            ) : null}
          </section>

          <CodexSection />

          <section className="settings-section settings-section-signout">
            <div className="settings-row">
              <span className="settings-label">Session</span>
              <button
                type="button"
                className="settings-button settings-button-danger"
                onClick={handleSignOut}
                disabled={isSigningOut}
              >
                {isSigningOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function CodexSection() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const { phase, start, cancel, reset } = useCodexConnect({
    onConnected: () => { void refreshStatus(); },
  });

  useEffect(() => { void refreshStatus(); }, []);

  async function refreshStatus() {
    try {
      const next = await getCodexStatus();
      setStatus(next);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDisconnect() {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    try {
      await disconnectCodex();
      await refreshStatus();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDisconnecting(false);
    }
  }

  return (
    <section className="settings-section">
      <h2>Codex</h2>

      {statusError ? (
        <p className="settings-footnote codex-error">{statusError}</p>
      ) : null}

      {phase.kind === 'idle' && status !== null ? (
        <div className="settings-row">
          <span className="settings-label">Connection</span>
          {status.connected ? (
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
            >
              <CodexMark />
              <span>{isDisconnecting ? 'Disconnecting…' : 'Disconnect'}</span>
            </button>
          ) : (
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={start}
            >
              <CodexMark />
              <span>Connect Codex</span>
            </button>
          )}
        </div>
      ) : null}

      <CodexConnectFlow phase={phase} onRetry={start} onCancel={phase.kind === 'error' ? reset : cancel} />
    </section>
  );
}
