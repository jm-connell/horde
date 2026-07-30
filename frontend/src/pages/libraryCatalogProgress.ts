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
  "Horde indexes this channel’s library in the background so you can search beyond what’s loaded on the page.";

export const FEED_INDEX_TIP =
  "Horde indexes this channel’s uploads (titles, and descriptions for the newest 200) so feed search works across the library without loading every page from YouTube. Indexing runs in the background and respects your max-videos setting.";
