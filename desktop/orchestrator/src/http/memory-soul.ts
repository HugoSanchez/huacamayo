/**
 * The marker-delimited memory section managed inside the profile's SOUL.md.
 * It teaches the visible agent that the memory tools ARE its memory — without
 * it the model pattern-matches "what do you know about X" to web search.
 *
 * The markers keep the historical `gbrain` name on purpose: they are what
 * lets existing installs swap section text cleanly in place. Don't rename.
 */

const MEMORY_SOUL_START = '<!-- verso:gbrain-memory:start -->';
const MEMORY_SOUL_END = '<!-- verso:gbrain-memory:end -->';

const MEMORY_SOUL_SECTION = [
  '## Your memory',
  '',
  'You have a persistent, private memory about this user — people, companies, projects, meetings, decisions, preferences — stored locally on their machine. It contains memories you have written yourself AND raw history from past conversations and their connected apps (email, Slack, meeting notes), so it routinely knows things that never came up in the current chat.',
  '',
  '- For ANY question about what you know or remember about a person, company, project, topic, or decision, call search_memory FIRST — before session search, web search, or answering from general knowledge. If wording might differ, try a second reworded query.',
  '- NEVER say you have nothing in memory about something unless search_memory actually came back empty for it.',
  '- When the user asks you to remember something, or you learn a durable fact, preference, decision, or commitment worth keeping, save it with write_memory_page. Search first and update the existing page rather than creating a near-duplicate. Confirm briefly when the user explicitly asked ("Saved.").',
  '- Read full entries with get_memory_page (works on page slugs and doc:<id> results).',
  '- When memory informs an answer, weave it in naturally and cite the source where useful. If a search returns nothing relevant, proceed normally without mentioning it.',
].join('\n');

/**
 * Adds/removes the managed memory section in a SOUL.md document.
 * Idempotent: re-applying replaces the managed block in place, and anything
 * the user wrote outside the markers is preserved verbatim.
 */
export function applyMemorySoulSection(soul: string, enabled: boolean): string {
  const startIdx = soul.indexOf(MEMORY_SOUL_START);
  const endIdx = soul.indexOf(MEMORY_SOUL_END);
  let stripped = soul;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    stripped = soul.slice(0, startIdx).trimEnd() + soul.slice(endIdx + MEMORY_SOUL_END.length);
  }
  if (!enabled) {
    return stripped.trimEnd() ? `${stripped.trimEnd()}\n` : stripped;
  }
  return [
    stripped.trimEnd(),
    '',
    MEMORY_SOUL_START,
    MEMORY_SOUL_SECTION,
    MEMORY_SOUL_END,
    '',
  ].join('\n');
}
