'use client';

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

export function LoginFlow() {
  const { ready, authenticated, login, getAccessToken, user } = usePrivy();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const exchangeStartedRef = useRef(false);
  const autoOpenedRef = useRef(false);

  const hasPrivyConfig = Boolean(frontendRuntimeConfig.privyAppId);

  // Pop the Privy modal as soon as the SDK is ready.
  useEffect(() => {
    if (!hasPrivyConfig || !ready || authenticated || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    login();
  }, [authenticated, hasPrivyConfig, login, ready]);

  // Once Privy has authenticated, exchange with the backend and bounce to the app.
  useEffect(() => {
    if (!hasPrivyConfig || !ready || !authenticated || exchangeStartedRef.current) return;
    exchangeStartedRef.current = true;
    void exchangeAndRedirect();
  }, [authenticated, hasPrivyConfig, ready]);

  async function exchangeAndRedirect() {
    try {
      setErrorMessage(null);

      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error('Privy did not return an access token.');
      }

      const response = await fetch(`${frontendRuntimeConfig.backendBaseUrl}/v1/auth/privy/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          privyAccessToken: accessToken,
          deviceLabel: 'verso for macOS',
          platform: 'macos',
          email: user?.email?.address ?? null,
          displayName: null,
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
      if (data.user.email) params.set('email', data.user.email);
      if (data.user.displayName) params.set('display_name', data.user.displayName);

      window.location.assign(`${frontendRuntimeConfig.redirectUri}?${params.toString()}`);
    } catch (error: unknown) {
      exchangeStartedRef.current = false;
      setErrorMessage(error instanceof Error ? error.message : 'Unknown login error.');
    }
  }

  function retry() {
    setErrorMessage(null);
    exchangeStartedRef.current = false;
    autoOpenedRef.current = false;
    if (ready && !authenticated) {
      autoOpenedRef.current = true;
      login();
    }
  }

  if (!hasPrivyConfig) {
    return (
      <main className="login-shell">
        <div className="login-error">
          <div className="error-banner">
            Privy is not configured. Add <span className="mono">NEXT_PUBLIC_PRIVY_APP_ID</span> to <span className="mono">frontend/.env</span>.
          </div>
        </div>
      </main>
    );
  }

  if (errorMessage) {
    return (
      <main className="login-shell">
        <div className="login-error">
          <div className="error-banner">{errorMessage}</div>
          <div className="actions">
            <button className="button button-primary" onClick={retry} type="button">
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="login-shell">
      <div className="mac-spinner" aria-label="Loading" role="status">
        {Array.from({ length: 12 }).map((_, i) => <span key={i} />)}
      </div>
    </main>
  );
}
