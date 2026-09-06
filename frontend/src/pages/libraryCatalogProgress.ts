export type CatalogProgress = {
  indexed: number;
  /** Full YouTube library size when known. */
  total: number | null;
  /** Per-channel index cap from settings. */
  maxVideos: number;
  complete: boolean;
  status: string | null;
  indexing: boolean;
  youtubeSearchOverride?: boolean | null;
  youtubeSearchEffective?: boolean;
  youtubeSearchSystem?: boolean;
};

/** Denominator for UI: real library size if under the cap, else the cap. */
export function catalogDenominator(p: CatalogProgress): number {
  if (p.total != null && p.total > 0) {
    return Math.min(p.total, p.maxVideos);
  }
  return Math.max(1, p.maxVideos);
}

export type FeedSearchPhase = "idle" | "keywords" | "related" | "done";

export function formatSearchMatchCount(n: number): string {
  return n === 1 ? "1 match" : `${n} matches`;
}

export function feedSearchStatusLabel(phase: FeedSearchPhase): string | null {
  if (phase === "keywords") return "Searching indexed catalog…";
  if (phase === "related") return "Finding related matches…";
  return null;
}

export const YOUTUBE_SEARCH_LOADING_LABEL = "Loading YouTube results…";
export const YOUTUBE_SEARCH_PAGE_SIZE = 20;
export const YOUTUBE_SEARCH_LOAD_MORE_LABEL = "Load more";

const MATCH_SOURCE_LABEL: Record<string, string> = {
  description: "description",
  tags: "tags",
  notes: "notes",
};

export function matchedQueryLabel(query: string, snippet?: string | null): string {
  const tokens = (query || "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const hay = (snippet || "").toLowerCase();
  const hits = tokens.filter((t) => t.length > 1 && hay.includes(t));
  if (hits.length) return hits.join(" ");
  if (snippet?.trim()) return "";
  return query.trim();
}

export function formatMatchReasonTip(
  reason: {
    source: string;
    snippet?: string | null;
  },
  query: string
): string {
  const snippet = reason.snippet?.trim();
  const quoted = snippet ? `“${snippet}”` : "";
  if (reason.source === "captions") {
    return quoted ? `In captions: ${quoted}` : "In captions.";
  }
  if (reason.source === "related") {
    return "Related by search index from the title and description.";
  }
  if (reason.source === "youtube") {
    return "Found on YouTube (not in the local catalog).";
  }
  const field = MATCH_SOURCE_LABEL[reason.source] ?? reason.source;
  const term = matchedQueryLabel(query, snippet);
  const head = term
    ? `Matched “${term}” in the ${field}`
    : `Matched in the ${field}`;
  return quoted ? `${head}: ${quoted}` : `${head}.`;
}

/** Tooltip copy when the match is not already obvious from the title. */
export function visibleMatchReasonTip(
  reason: {
    source: string;
    snippet?: string | null;
  } | null | undefined,
  query = ""
): string | null {
  if (!reason || reason.source === "title") return null;
  return formatMatchReasonTip(reason, query);
}

/** Indexed to the real library size or the max-videos cap — not still running. */
export function isCatalogFullyIndexed(p: CatalogProgress): boolean {
  if (p.indexing || p.indexed <= 0) return false;
  return p.complete || p.indexed >= catalogDenominator(p);
}

export function formatCatalogProgress(p: CatalogProgress): string {
  const { indexed, indexing } = p;
  const denom = catalogDenominator(p);

  if (indexing) {
    return `Indexing… ${indexed}/${denom}`;
  }
  if (isCatalogFullyIndexed(p)) {
    return `Fully indexed (${indexed})`;
  }
  if (indexed > 0) {
    return `${indexed}/${denom} indexed`;
  }
  return "Not indexed";
}

/** Header control is only for kick-starting a missing, incomplete, or failed index. */
export function showChannelIndexButton(p: CatalogProgress | null): boolean {
  if (p == null || p.indexing) return false;
  return !isCatalogFullyIndexed(p);
}

export const FEED_SEARCH_TIP =
  "Search this channel’s indexed uploads and your downloads. Also uses search indexes when they’re ready, including captions on downloaded videos. When Direct YouTube search is on, Horde also queries YouTube for extra matches. Results follow the Recent / Popular sort at the top of the page.";

export const FEED_INDEX_TIP =
  "Horde indexes this channel’s uploads (descriptions+captions for 200 recent, titles for up to 1000) so search uses as much as possible. Indexing runs in the background and respects your max-videos setting.";
