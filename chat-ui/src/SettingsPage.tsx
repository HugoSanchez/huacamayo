import { useEffect, useState } from 'react';
import { getSidecarPort } from './chat';

interface UsageSummary {
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
  };
  mode: string;
  usage: {
    monthToDateUsd: number;
    dayToDateUsd: number;
    monthStart: string;
    dayStart: string;
  };
  limits: {
    monthlyUsdLimit: number | null;
    dailyUsdLimit: number | null;
  };
}

interface Props {
  onBack: () => void;
}

export function SettingsPage({ onBack }: Props) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
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
        const res = await fetch(`http://127.0.0.1:${port}/managed/usage`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setError(
            (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string')
              ? body.message
              : `Failed to load usage (HTTP ${res.status}).`,
          );
        } else {
          setSummary(body as UsageSummary);
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
        <h1>Settings</h1>
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
      ) : summary ? (
        <div className="settings-body">
          <section className="settings-section">
            <h2>Account</h2>
            <div className="settings-row">
              <span className="settings-label">Signed in as</span>
              <span className="settings-value">
                {summary.user.email || summary.user.displayName || summary.user.id}
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Mode</span>
              <span className="settings-value">{titleCase(summary.mode)}</span>
            </div>
          </section>

          <section className="settings-section">
            <h2>Usage</h2>
            <UsageBar
              label="This month"
              used={summary.usage.monthToDateUsd}
              limit={summary.limits.monthlyUsdLimit}
            />
            <UsageBar
              label="Today"
              used={summary.usage.dayToDateUsd}
              limit={summary.limits.dailyUsdLimit}
            />
            <p className="settings-footnote">
              Resets at the start of each {summary.limits.monthlyUsdLimit ? 'month / day' : 'period'} (UTC).
              Only completed requests count toward the totals.
            </p>
          </section>

          <section className="settings-section">
            <button
              type="button"
              className="settings-button settings-signout"
              onClick={handleSignOut}
              disabled={isSigningOut}
            >
              {isSigningOut ? 'Signing out…' : 'Sign out'}
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="usage-bar-row">
      <div className="usage-bar-header">
        <span className="settings-label">{label}</span>
        <span className="settings-value">
          {formatUsd(used)}
          {limit !== null ? <span className="usage-bar-limit"> / {formatUsd(limit)}</span> : null}
        </span>
      </div>
      {limit !== null ? (
        <div className="usage-bar-track">
          <div className="usage-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <div className="usage-bar-unlimited">No limit set</div>
      )}
    </div>
  );
}

function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
