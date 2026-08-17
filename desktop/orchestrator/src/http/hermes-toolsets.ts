import type { HermesGatewayConfig } from './hermes-supervisor.ts';

export function hermesGatewayAuthHeaders(config: Pick<HermesGatewayConfig, 'apiKey'>): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

export async function fetchRegisteredToolNames(config: Pick<HermesGatewayConfig, 'baseUrl' | 'apiKey'>): Promise<string[] | null> {
  // /api/mcp/tools comes from the verso-gateway-mcp-oauth runtime patch and
  // reports the gateway's actual MCP tool registry per server. The previous
  // source, /v1/toolsets, lists only built-in toolsets — MCP servers (verso,
  // composio, custom_*) never appear there, so registration checks against it
  // always came back empty and connector status could never reach "connected".
  try {
    const res = await fetch(`${config.baseUrl}/api/mcp/tools`, {
      method: 'GET',
      headers: hermesGatewayAuthHeaders(config),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { servers?: Record<string, string[]> };
    if (!body?.servers || typeof body.servers !== 'object') return null;
    return Object.values(body.servers).flatMap((tools) => (Array.isArray(tools) ? tools : []));
  } catch {
    return null;
  }
}

export function countCustomConnectorTools(registered: readonly string[], slug: string): number {
  const doublePrefix = `mcp__custom_${slug}__`;
  const singlePrefix = `mcp_custom_${slug}_`;
  return registered.filter((name) => name.startsWith(doublePrefix) || name.startsWith(singlePrefix)).length;
}
