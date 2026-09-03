export type CatalogProgress = {
  indexed: number;
  /** Full YouTube library size when known. */
  total: number | null;
  /** Per-channel index cap from settings. */
  maxVideos: number;
  complete: boolean;
  status: string | null;
  indexing: boolean;
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

const MATCH_SOURCE_LABEL: Record<string, string> = {
  description: "description",
  tags: "tags",
  notes: "notes",
};

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
  const field = MATCH_SOURCE_LABEL[reason.source] ?? reason.source;
  const term = query.trim();
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

export function formatCatalogProgress(p: CatalogProgress): string {
  const { indexed, total, complete, indexing } = p;
  const denom = catalogDenominator(p);
  const capped = total != null && total > p.maxVideos;

  if (indexing) {
    return `Indexing… ${indexed}/${denom}`;
  }
  if (complete && indexed > 0) {
    if (!capped && (total == null || indexed >= total || indexed >= denom)) {
      return `Fully indexed (${indexed})`;
    }
    return `${indexed}/${denom} indexed`;
  }
  if (indexed > 0) {
    return `${indexed}/${denom} indexed`;
  }
  return "Not indexed";
}

export const FEED_SEARCH_TIP =
  "Search this channel’s indexed uploads and your downloads. Also uses search indexes when they’re ready, including captions on downloaded videos.";

export const FEED_INDEX_TIP =
  "Horde indexes this channel’s uploads (descriptions+captions for 200 recent, titles for up to 1000) so search uses as much as possible. Indexing runs in the background and respects your max-videos setting.";
