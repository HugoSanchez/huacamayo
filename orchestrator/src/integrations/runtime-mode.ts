export type RuntimeMode = 'managed' | 'byo' | 'local';

const VALID_MODES: RuntimeMode[] = ['managed', 'byo', 'local'];

/**
 * V1 ships only `managed` end-to-end, but the orchestrator exposes the mode
 * concept now so the macOS app can render it and so the chat path can branch
 * on it once Phase 8 wires backend-managed inference in.
 */
export function readRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  const raw = env.VERSO_RUNTIME_MODE?.trim().toLowerCase() ?? '';
  if (raw && (VALID_MODES as string[]).includes(raw)) {
    return raw as RuntimeMode;
  }
  return 'managed';
}
