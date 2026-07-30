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
                className="model-provider-action"
                disabled={Boolean(pending) || inputs[provider.provider].trim().length === 0}
              >
                {isSaving ? 'Saving...' : connected ? 'Rotate' : 'Save'}
              </button>
              {connected ? (
                <button
                  type="button"
                  className="model-provider-action is-danger"
                  onClick={() => { void handleRemove(provider.provider); }}
                  disabled={Boolean(pending)}
                >
                  {isRemoving ? 'Removing...' : 'Remove'}
                </button>
              ) : null}
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
        <CodexMark size={17} />
      </span>
    );
  }

  return (
    <span className="model-provider-logo" aria-hidden="true">
      <svg width="17" height="17" viewBox="0 0 100 100" fill="currentColor" focusable="false">
        <path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
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
