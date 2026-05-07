const defaultBackendUrl = 'http://127.0.0.1:8788';
const defaultRedirectUri = 'vervo://auth/callback';

export const frontendRuntimeConfig = {
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '',
  backendBaseUrl: normalizeBaseUrl(process.env.NEXT_PUBLIC_BACKEND_URL ?? defaultBackendUrl),
  redirectUri: process.env.NEXT_PUBLIC_VERVO_REDIRECT_URI ?? defaultRedirectUri,
};

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
