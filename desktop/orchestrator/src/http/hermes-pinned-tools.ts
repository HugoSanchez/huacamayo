import { readFileSync } from 'node:fs';

/**
 * Computes the `tools.tool_search.pinned` list written into the managed
 * Hermes config. Pinned tools stay in the model-visible tools array instead
 * of hiding behind the tool_search bridge, so the hot path skips the
 * search → describe → call round trips entirely.
 *
 * Sources, in order:
 * 1. The verso bridge's static tools (connection management + drafts) and,
 *    when memory is on, the memory tools — product-core, always pinned.
 * 2. Usage-ranked Composio tools from the native tool manifest (entries the
 *    usage store marked `origin: 'usage'`), taken in manifest order until
 *    the schema budget or count cap is hit.
 * 3. Cold-start seeds: one obvious tool per connected toolkit that has no
 *    pinned tool yet, so a fresh install isn't all-deferred until usage
 *    accumulates.
 *
 * A pinned name that matches nothing registered is inert on the Hermes side,
 * so this list can be generous about tools that may disappear (disconnected
 * toolkit, renamed slug) between config writes.
 */

const STATIC_PINNED_TOOLS = [
  'mcp_verso_request_connection',
  'mcp_verso_search_toolkits',
  'mcp_verso_list_connections',
  'mcp_verso_get_connection_status',
  'mcp_verso_propose_message_draft',
];

const MEMORY_PINNED_TOOLS = [
  'mcp_verso_search_memory',
  'mcp_verso_get_memory_page',
  'mcp_verso_write_memory_page',
];

// Composio schemas riding in the prompt prefix on every turn. ~4 chars per
// token puts this around 8K tokens — a few percent of context, and stable
// across turns so it stays prompt-cache friendly.
const PINNED_SCHEMA_CHAR_BUDGET = 32_000;
const MAX_USAGE_PINNED = 20;

// Verified against real Composio manifests; a slug that no longer exists in
// the manifest is simply skipped.
const COLD_START_SEEDS: Record<string, string> = {
  slack: 'SLACK_SEARCH_MESSAGES',
  gmail: 'GMAIL_FETCH_EMAILS',
  googledrive: 'GOOGLEDRIVE_FIND_FILE',
  googledocs: 'GOOGLEDOCS_SEARCH_DOCUMENTS',
  googlecalendar: 'GOOGLECALENDAR_EVENTS_LIST',
  notion: 'NOTION_SEARCH_NOTION_PAGE',
  todoist: 'TODOIST_GET_ALL_TASKS',
};

interface ManifestToolEntry {
  nativeName: string;
  toolSlug: string;
  toolkitSlug: string;
  inputParameters: Record<string, unknown>;
  origin?: string;
}

export function computePinnedToolNames(
  manifestPath: string,
  opts: { includeMemoryTools: boolean },
): string[] {
  const pinned: string[] = [...STATIC_PINNED_TOOLS];
  if (opts.includeMemoryTools) pinned.push(...MEMORY_PINNED_TOOLS);

  const tools = readManifestTools(manifestPath);
  if (tools.length === 0) return pinned;

  let budget = PINNED_SCHEMA_CHAR_BUDGET;
  let usagePinned = 0;
  const pinnedNames = new Set<string>();
  const pinnedToolkits = new Set<string>();

  for (const tool of tools) {
    if (tool.origin !== 'usage' || usagePinned >= MAX_USAGE_PINNED) continue;
    const cost = schemaCost(tool);
    if (cost > budget) continue;
    budget -= cost;
    usagePinned += 1;
    pinnedNames.add(tool.nativeName);
    pinnedToolkits.add(tool.toolkitSlug);
  }

  // Cold-start seeds for connected toolkits nothing above covered.
  const bySlug = new Map(tools.map((tool) => [tool.toolSlug.toUpperCase(), tool]));
  for (const tool of tools) {
    if (pinnedToolkits.has(tool.toolkitSlug)) continue;
    const seedSlug = COLD_START_SEEDS[tool.toolkitSlug];
    if (!seedSlug) continue;
    const seed = bySlug.get(seedSlug);
    if (!seed) continue;
    const cost = schemaCost(seed);
    if (cost > budget) continue;
    budget -= cost;
    pinnedNames.add(seed.nativeName);
    pinnedToolkits.add(tool.toolkitSlug);
  }

  pinned.push(...Array.from(pinnedNames, (name) => `mcp_verso_${name}`));
  return pinned;
}

function schemaCost(tool: ManifestToolEntry): number {
  try {
    return JSON.stringify(tool.inputParameters).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function readManifestTools(manifestPath: string): ManifestToolEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  if ((parsed as Record<string, unknown>).version !== 1) return [];
  const rawTools = (parsed as Record<string, unknown>).tools;
  if (!Array.isArray(rawTools)) return [];

  const tools: ManifestToolEntry[] = [];
  for (const raw of rawTools) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const nativeName = typeof entry.nativeName === 'string' ? entry.nativeName.trim() : '';
    const toolSlug = typeof entry.toolSlug === 'string' ? entry.toolSlug.trim() : '';
    const toolkitSlug = typeof entry.toolkitSlug === 'string' ? entry.toolkitSlug.trim().toLowerCase() : '';
    const inputParameters = entry.inputParameters;
    if (!nativeName || !toolSlug || !toolkitSlug) continue;
    if (!inputParameters || typeof inputParameters !== 'object' || Array.isArray(inputParameters)) continue;
    tools.push({
      nativeName,
      toolSlug,
      toolkitSlug,
      inputParameters: inputParameters as Record<string, unknown>,
      origin: typeof entry.origin === 'string' ? entry.origin : undefined,
    });
  }
  return tools;
}
