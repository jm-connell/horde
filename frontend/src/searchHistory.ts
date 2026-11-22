/** Searches kept per account, newest first. */
export const SEARCH_HISTORY_MAX = 20;
/** Longer queries are cut to this, so the synced preferences stay small. */
export const SEARCH_HISTORY_CHARS = 200;

function clean(query: string): string {
  return query.trim().slice(0, SEARCH_HISTORY_CHARS);
}

/** `query` first, any earlier copy of it (in any case) dropped, at most `SEARCH_HISTORY_MAX`. */
export function addSearch(history: readonly string[], query: string): string[] {
  const q = clean(query);
  if (!q) return [...history];
  const key = q.toLowerCase();
  return [q, ...history.filter((h) => h.toLowerCase() !== key)].slice(
    0,
    SEARCH_HISTORY_MAX
  );
}

export function removeSearch(
  history: readonly string[],
  query: string
): string[] {
  return history.filter((h) => h !== query);
}

/** Saved searches as stored: strings only, trimmed, each once, capped. */
export function normalizeSearchHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const q = clean(item);
    if (q && !out.some((h) => h.toLowerCase() === q.toLowerCase())) out.push(q);
    if (out.length === SEARCH_HISTORY_MAX) break;
  }
  return out;
}
