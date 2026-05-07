'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { frontendRuntimeConfig } from '../lib/runtime-config';

interface ExchangeResponse {
  session: {
    token: string;
    expiresAt: string;
  };
  user: {
    id: string;
    privyUserId: string;
    email: string | null;
    displayName: string | null;
  };
  device: {
    id: string;
    label: string;
    platform: string;
  };
  entitlements: Array<{
    mode: string;
    status: string;
    allowedModels: string[] | null;
  }>;
}

type FlowState = 'idle' | 'awaiting_login' | 'exchanging' | 'redirecting' | 'error';

export function LoginFlow() {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const [flowState, setFlowState] = useState<FlowState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const redirectStartedRef = useRef(false);

  const hasPrivyConfig = Boolean(frontendRuntimeConfig.privyAppId);

  useEffect(() => {
    if (!hasPrivyConfig || !ready || !authenticated || redirectStartedRef.current) {
      return;
    }

    redirectStartedRef.current = true;
    void exchangeAndRedirect();
  }, [authenticated, hasPrivyConfig, ready]);

  async function exchangeAndRedirect() {
    try {
      setErrorMessage(null);
      setFlowState('exchanging');

      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error('Privy did not return an access token.');
      }

      const response = await fetch(`${frontendRuntimeConfig.backendBaseUrl}/v1/auth/privy/exchange`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          privyAccessToken: accessToken,
          deviceLabel: 'Vervo for macOS',
          platform: 'macos',
        }),
      });

      const payload = await response.json().catch(() => null) as ExchangeResponse | { error?: string; message?: string } | null;
      if (!response.ok) {
        throw new Error(
          payload && typeof payload === 'object' && 'message' in payload && payload.message
            ? payload.message
            : 'Backend exchange failed.',
        );
      }

      const data = payload as ExchangeResponse;
      const params = new URLSearchParams({
        session_token: data.session.token,
        expires_at: data.session.expiresAt,
        user_id: data.user.id,
      });
      if (data.user.email) {
        params.set('email', data.user.email);
      }
      if (data.user.displayName) {
        params.set('display_name', data.user.displayName);
      }

      setFlowState('redirecting');
      window.location.assign(`${frontendRuntimeConfig.redirectUri}?${params.toString()}`);
    } catch (error: unknown) {
      redirectStartedRef.current = false;
      setFlowState('error');
      setErrorMessage(error instanceof Error ? error.message : 'Unknown login error.');
    }
  }

  function handleLogin() {
    setErrorMessage(null);
    setFlowState('awaiting_login');
    login();
  }

  async function handleReset() {
    setErrorMessage(null);
    redirectStartedRef.current = false;
    if (authenticated) {
      await logout();
    }
    setFlowState('idle');
  }

  return (
    <main className="page-shell">
      <section className="card">
        <div className="eyebrow">Login</div>
        <h1>Sign in to Vervo</h1>
        <p className="form-copy">
          This browser flow authenticates with Privy, exchanges the Privy access token with the Vervo backend,
          and then redirects to <span className="mono">{frontendRuntimeConfig.redirectUri}</span>.
        </p>

        <div className="grid">
          <div className="card">
            <div className="eyebrow">Current flow</div>
            <div className="status-list">
              <div className="status-row">
                <span>Privy auth</span>
                <strong>{ready ? (authenticated ? 'Authenticated' : 'Ready') : 'Loading'}</strong>
              </div>
              <div className="status-row">
                <span>Backend exchange</span>
                <strong>{labelForFlowState(flowState)}</strong>
              </div>
              <div className="status-row">
                <span>Native session storage</span>
                <strong>Next spike</strong>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="eyebrow">Configuration</div>
            <div className="status-list">
              <div className="status-row">
                <span>Privy app ID</span>
                <strong>{hasPrivyConfig ? 'Configured' : 'Missing'}</strong>
              </div>
              <div className="status-row">
                <span>Backend URL</span>
                <strong className="mono">{frontendRuntimeConfig.backendBaseUrl}</strong>
              </div>
              <div className="status-row">
                <span>Redirect URI</span>
                <strong className="mono">{frontendRuntimeConfig.redirectUri}</strong>
              </div>
            </div>
          </div>
        </div>

        {user ? (
          <div className="notice">
            <div className="status-row">
              <span>Authenticated user</span>
              <strong>{user.email?.address ?? user.id}</strong>
            </div>
          </div>
        ) : null}

        {!hasPrivyConfig ? (
          <div className="error-banner">
            Add <span className="mono">NEXT_PUBLIC_PRIVY_APP_ID</span> to <span className="mono">frontend/.env</span> to enable login.
          </div>
        ) : null}

        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

        <div className="actions">
          <Link className="button" href="/">
            Back home
          </Link>
          <Link className="button" href="/handoff">
            Inspect handoff page
          </Link>
          <button
            className="button"
            disabled={!hasPrivyConfig || !ready || flowState === 'exchanging' || flowState === 'redirecting'}
            onClick={handleReset}
            type="button"
          >
            Reset
          </button>
          <button
            className="button button-primary"
            disabled={!hasPrivyConfig || !ready || flowState === 'exchanging' || flowState === 'redirecting'}
            onClick={handleLogin}
            type="button"
          >
            {buttonLabel(flowState, authenticated)}
          </button>
        </div>
      </section>
    </main>
  );
}

function labelForFlowState(flowState: FlowState): string {
  switch (flowState) {
    case 'awaiting_login':
      return 'Waiting for Privy';
    case 'exchanging':
      return 'Exchanging';
    case 'redirecting':
      return 'Redirecting';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}

function buttonLabel(flowState: FlowState, authenticated: boolean): string {
  if (flowState === 'exchanging') return 'Exchanging...';
  if (flowState === 'redirecting') return 'Redirecting...';
  if (authenticated) return 'Continue to Vervo';
  return 'Sign in with Privy';
}
