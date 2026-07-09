import { useEffect, useState } from 'react';
import {
  disconnectCodex,
  getCodexStatus,
  getIngestionSources,
  getModelProviders,
  getSidecarPort,
  saveModelProviderKey,
  deleteModelProviderKey,
  toggleIngestionSource,
  type CodexStatus,
  type IngestionSourceView,
  type ModelProvider,
  type ModelProviderConnectionView,
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

          <ModelProvidersSection />

          <IngestionSection />

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

function sourceStatus(source: IngestionSourceView): string | null {
  if (!source.enabled) return null;
  if (source.status === 'running') return 'syncing…';
  if (source.lastError) return 'last sync failed';
  if (source.lastCompletedAt) {
    return `synced ${timeAgo(source.lastCompletedAt)} · ${source.itemCount} ${source.itemCount === 1 ? 'item' : 'items'}`;
  }
  return 'waiting to sync…';
}

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'recently';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const MODEL_PROVIDER_LABELS: Record<ModelProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

function ModelProvidersSection() {
  const [providers, setProviders] = useState<ModelProviderConnectionView[]>([]);
  const [inputs, setInputs] = useState<Record<ModelProvider, string>>({ openai: '', anthropic: '' });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      setProviders(normalizeProviders(await getModelProviders()));
      setError(null);
    } catch (err) {
      setProviders(normalizeProviders([]));
      setError(formatModelProviderError(err));
    }
  }

  async function handleSave(provider: ModelProvider) {
    if (pending) return;
    const apiKey = inputs[provider].trim();
    if (!apiKey) {
      setError(`${MODEL_PROVIDER_LABELS[provider]} key must not be empty.`);
      return;
    }
    setPending(`${provider}:save`);
    try {
      const updated = await saveModelProviderKey(provider, apiKey);
      setProviders((prev) => normalizeProviders(prev.map((item) => item.provider === provider ? updated : item)));
      setInputs((prev) => ({ ...prev, [provider]: '' }));
      setError(null);
    } catch (err) {
      setError(formatModelProviderError(err));
    } finally {
      setPending(null);
    }
  }

  async function handleRemove(provider: ModelProvider) {
    if (pending) return;
    setPending(`${provider}:remove`);
    try {
      const updated = await deleteModelProviderKey(provider);
      setProviders((prev) => normalizeProviders(prev.map((item) => item.provider === provider ? updated : item)));
      setInputs((prev) => ({ ...prev, [provider]: '' }));
      setError(null);
    } catch (err) {
      setError(formatModelProviderError(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="settings-section">
      <h2>Model Providers</h2>
      {error ? <p className="settings-footnote codex-error">{error}</p> : null}
      {normalizeProviders(providers).map((provider) => {
        const connected = provider.status !== 'not_connected';
        const isSaving = pending === `${provider.provider}:save`;
        const isRemoving = pending === `${provider.provider}:remove`;
        return (
          <form
            className="settings-row model-provider-row"
            key={provider.provider}
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave(provider.provider);
            }}
          >
            <span className="settings-label model-provider-label">
              <ProviderLogo provider={provider.provider} />
              <span className="model-provider-text">
                <span className="model-provider-title">{MODEL_PROVIDER_LABELS[provider.provider]}</span>
                <span className="model-provider-meta">
                  {providerStatusLabel(provider.status)}
                  {provider.keyLast4 ? ` · ...${provider.keyLast4}` : ''}
                  {provider.updatedAt ? ` · updated ${timeAgo(provider.updatedAt)}` : ''}
                </span>
              </span>
            </span>
            <span className="model-provider-controls">
              <input
                className="model-provider-key-input"
                type="password"
                value={inputs[provider.provider]}
                onChange={(event) => setInputs((prev) => ({ ...prev, [provider.provider]: event.target.value }))}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="API key"
                disabled={Boolean(pending)}
              />
              <button
                type="submit"
                className="settings-button settings-button-primary"
                disabled={Boolean(pending) || inputs[provider.provider].trim().length === 0}
              >
                {isSaving ? 'Saving...' : connected ? 'Rotate' : 'Save'}
              </button>
              <button
                type="button"
                className="settings-button settings-button-danger"
                onClick={() => { void handleRemove(provider.provider); }}
                disabled={!connected || Boolean(pending)}
              >
                {isRemoving ? 'Removing...' : 'Remove'}
              </button>
            </span>
          </form>
        );
      })}
    </section>
  );
}

function ProviderLogo({ provider }: { provider: ModelProvider }) {
  if (provider === 'openai') {
    return (
      <span className="model-provider-logo" aria-hidden="true">
        <CodexMark size={16} />
      </span>
    );
  }

  return (
    <span className="model-provider-logo" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" focusable="false">
        <path d="M13.74 3.5h-3.48L3.75 20.5h3.18l1.32-3.69h7.5l1.32 3.69h3.18L13.74 3.5Zm-4.5 10.56L12 6.35l2.76 7.71H9.24Z" />
      </svg>
    </span>
  );
}

function normalizeProviders(providers: ModelProviderConnectionView[]): ModelProviderConnectionView[] {
  return (['openai', 'anthropic'] as ModelProvider[]).map((provider) => (
    providers.find((item) => item.provider === provider) ?? {
      provider,
      status: 'not_connected',
      keyLast4: null,
      keySha256Prefix: null,
      updatedAt: null,
    }
  ));
}

function providerStatusLabel(status: ModelProviderConnectionView['status']): string {
  if (status === 'connected') return 'Connected';
  if (status === 'needs_attention') return 'Needs attention';
  return 'Not connected';
}

function formatModelProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('/v1/model-providers') && message.toLowerCase().includes('not found')) {
    return 'Model provider settings are not available from the current backend. Restart or update the managed backend, then retry.';
  }
  return message;
}

function IngestionSection() {
  const [sources, setSources] = useState<IngestionSourceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    // Poll while Settings is open so the per-source status updates live.
    const id = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(id);
  }, []);

  async function refresh() {
    try {
      setSources(await getIngestionSources());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggle(source: IngestionSourceView) {
    if (pending) return;
    if (!source.enabled && !source.connected) {
      setError(`${source.displayName} is not connected. Connect it first.`);
      return;
    }
    setPending(source.source);
    try {
      const updated = await toggleIngestionSource(source.source, !source.enabled);
      setSources((prev) => (prev ? prev.map((s) => (s.source === updated.source ? updated : s)) : prev));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  // Still loading and nothing to report yet — don't flash an empty section.
  if (sources === null && !error) return null;
  if (sources !== null && sources.length === 0) return null;

  return (
    <section className="settings-section">
      <div className="ingestion-header">
        <h2>Ingestion</h2>
        <p className="settings-footnote">Let Verso automatically remember from your connected apps.</p>
      </div>
      {error ? <p className="settings-footnote codex-error">{error}</p> : null}
      {sources?.map((source) => {
        const on = source.enabled;
        return (
          <div className="settings-row" key={source.source}>
            <span className="settings-label ingestion-source">
              {source.logoUrl ? (
                <img className="catalog-row-logo" src={source.logoUrl} alt="" aria-hidden="true" />
              ) : (
                <span className="catalog-row-logo-fallback" aria-hidden="true">{source.displayName.charAt(0)}</span>
              )}
              <span className="ingestion-source-text">
                <span>
                  {source.displayName}
                  {!source.connected ? <span className="settings-value"> · not connected</span> : null}
                </span>
                {sourceStatus(source) ? (
                  <span className="ingestion-source-status">{sourceStatus(source)}</span>
                ) : null}
              </span>
            </span>
            <span
              className={`skill-row-toggle is-${on ? 'on' : 'off'}`}
              role="switch"
              aria-checked={on}
              aria-disabled={pending === source.source || (!source.enabled && !source.connected)}
              onClick={() => handleToggle(source)}
            >
              <span className="skill-row-toggle-thumb" />
            </span>
          </div>
        );
      })}
    </section>
  );
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
