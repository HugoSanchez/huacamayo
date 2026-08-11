import type { HermesGatewayConfig } from './hermes-supervisor.ts';

export function hermesGatewayAuthHeaders(config: Pick<HermesGatewayConfig, 'apiKey'>): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

export async function fetchRegisteredToolNames(config: Pick<HermesGatewayConfig, 'baseUrl' | 'apiKey'>): Promise<string[] | null> {
  try {
    const res = await fetch(`${config.baseUrl}/v1/toolsets`, {
      method: 'GET',
      headers: hermesGatewayAuthHeaders(config),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { toolsets?: Array<{ tools?: string[] }> } | Array<{ tools?: string[] }>;
    const toolsets = Array.isArray(body) ? body : body?.toolsets;
    if (!Array.isArray(toolsets)) return null;
    return toolsets.flatMap((set) => (Array.isArray(set?.tools) ? set.tools : []));
  } catch {
    return null;
  }
}

export function countCustomConnectorTools(registered: readonly string[], slug: string): number {
  const doublePrefix = `mcp__custom_${slug}__`;
  const singlePrefix = `mcp_custom_${slug}_`;
  return registered.filter((name) => name.startsWith(doublePrefix) || name.startsWith(singlePrefix)).length;
}
