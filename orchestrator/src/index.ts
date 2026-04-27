/**
 * Vervo sidecar runtime.
 *
 * Hermes-only local chat bridge for the macOS app.
 */

export { startServer } from './http/server.ts';
export { buildChatRoutes } from './http/chat.ts';
export { ChatStore, type ChatMessageRecord, type ChatSessionRecord, type ChatSessionSummary } from './http/chat-store.ts';
export { HermesSupervisor, getHermesGatewayConfig, type HermesRuntimeSnapshot } from './http/hermes-supervisor.ts';
