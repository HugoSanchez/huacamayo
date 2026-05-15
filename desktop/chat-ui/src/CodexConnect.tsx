import { useEffect, useRef, useState } from 'react';
import { codexConnectUrl, openExternalUrl } from './chat';

export type CodexConnectPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; url: string; code: string }
  | { kind: 'connected' }
  | { kind: 'error'; message: string };

interface UseCodexConnectOptions {
  onConnected?: () => void;
}

interface UseCodexConnectResult {
  phase: CodexConnectPhase;
  start: () => void;
  cancel: () => void;
  reset: () => void;
}

// Manages the EventSource lifecycle for /model-auth/codex/start. Owns the
// phase state and surfaces start/cancel handlers. Renderers (settings,
// chat widget) compose this with their own intro + button styling.
export function useCodexConnect({ onConnected }: UseCodexConnectOptions = {}): UseCodexConnectResult {
  const [phase, setPhase] = useState<CodexConnectPhase>({ kind: 'idle' });
  const sourceRef = useRef<EventSource | null>(null);
  const browserOpenedRef = useRef(false);
  // We keep the callback in a ref so the start function doesn't have to be
  // re-created when the parent re-renders with a different onConnected — the
  // EventSource handlers always read the latest version.
  const onConnectedRef = useRef(onConnected);
  useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);

  useEffect(() => () => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  function closeStream() {
    sourceRef.current?.close();
    sourceRef.current = null;
  }

  function start() {
    closeStream();
    browserOpenedRef.current = false;
    setPhase({ kind: 'starting' });

    const source = new EventSource(codexConnectUrl());
    sourceRef.current = source;

    source.onmessage = (event) => {
      let payload: { type?: string; url?: string; code?: string; message?: string };
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type === 'prompt' && payload.url && payload.code) {
        setPhase({ kind: 'waiting', url: payload.url, code: payload.code });
        if (!browserOpenedRef.current) {
          browserOpenedRef.current = true;
          openExternalUrl(payload.url);
        }
      } else if (payload.type === 'connected') {
        setPhase({ kind: 'connected' });
        closeStream();
        onConnectedRef.current?.();
      } else if (payload.type === 'error') {
        setPhase({ kind: 'error', message: payload.message ?? 'Login failed.' });
        closeStream();
      }
    };

    source.onerror = () => {
      // EventSource auto-retries on its own, which we don't want for a
      // one-shot device-code flow. Surface the failure if we haven't reached
      // a terminal state.
      if (sourceRef.current !== source) return;
      closeStream();
      setPhase((current) => {
        if (current.kind === 'starting' || current.kind === 'waiting') {
          return { kind: 'error', message: 'Connection to the local sidecar was lost.' };
        }
        return current;
      });
    };
  }

  function cancel() {
    closeStream();
    setPhase({ kind: 'idle' });
  }

  function reset() {
    closeStream();
    setPhase({ kind: 'idle' });
  }

  return { phase, start, cancel, reset };
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard access can fail in some webviews; the code is still
      // visible on screen for the user to type manually.
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      className={`codex-copy-icon-button${copied ? ' is-copied' : ''}`}
      onClick={handleCopy}
      aria-label={copied ? 'Code copied' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
    >
      {copied ? <CheckMark /> : <ClipboardIcon />}
    </button>
  );
}

function ClipboardIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SuccessBadge() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="11" fill="#2e7d32" />
      <polyline
        points="7 12.5 10.5 16 17 9"
        fill="none"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Renders the OpenAI / Codex flower glyph. fill="currentColor" so it inherits
// whatever text color the surrounding button uses.
export function CodexMark({ size = 16 }: { size?: number } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

// Renders the non-idle phase of a Codex connect flow (starting → waiting →
// connected → error). The parent owns the idle/Connect-button layout.
export function CodexConnectFlow({ phase, onRetry, onCancel }: {
  phase: CodexConnectPhase;
  onRetry: () => void;
  onCancel: () => void;
}) {
  if (phase.kind === 'idle') return null;

  if (phase.kind === 'starting') {
    return <p className="settings-footnote">Starting login…</p>;
  }

  if (phase.kind === 'waiting') {
    return (
      <div className="codex-prompt">
        <p className="codex-prompt-text">
          We opened OpenAI&rsquo;s sign-in page in your browser.{' '}
          <strong>Enter this code there:</strong>
        </p>
        <div className="codex-code-row">
          <code className="codex-code">{phase.code}</code>
          <CopyCodeButton code={phase.code} />
        </div>
        <p className="settings-footnote">
          Didn&rsquo;t open?{' '}
          <button
            type="button"
            className="codex-link-button"
            onClick={() => openExternalUrl(phase.url)}
          >
            Open the sign-in page
          </button>
        </p>
        <div className="codex-actions">
          <button type="button" className="settings-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === 'connected') {
    return (
      <div className="codex-connected">
        <SuccessBadge />
        <span className="codex-connected-text">You&rsquo;re good to go!</span>
      </div>
    );
  }

  // phase.kind === 'error'
  return (
    <div>
      <p className="settings-footnote codex-error">{phase.message}</p>
      <div className="codex-actions">
        <button type="button" className="settings-button" onClick={onRetry}>
          Retry
        </button>
        <button type="button" className="settings-button" onClick={onCancel}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
