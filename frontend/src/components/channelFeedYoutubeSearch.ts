import type { ChannelFeedEntry } from "../types";

export type FeedSortMode = "recent" | "popular";
export type FeedSortOrder = "asc" | "desc";
export type FeedSortContext = "browse" | "search";

export function isYoutubeChannelUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(
      url.includes("://") ? url : `https://${url}`
    ).hostname
      .replace(/^www\./i, "")
      .toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return /youtube\.com|youtu\.be/i.test(url);
  }
}

function entryKey(entry: ChannelFeedEntry): string | null {
  if (entry.id) return `id:${entry.id}`;
  if (entry.url) return `url:${entry.url}`;
  return null;
}

/** Entries from `incoming` whose YouTube id is not in `knownIds`. */
export function excludeKnownYoutubeIds(
  incoming: ChannelFeedEntry[],
  knownIds: Iterable<string | null | undefined>
): ChannelFeedEntry[] {
  const seen = new Set<string>();
  for (const id of knownIds) {
    if (id) seen.add(id);
  }
  const extras: ChannelFeedEntry[] = [];
  for (const entry of incoming) {
    if (!entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    extras.push(entry);
  }
  return extras;
}

/** Entries from `incoming` whose id/url is not already in `existing`. */
export function unseenFeedEntries(
  existing: ChannelFeedEntry[],
  incoming: ChannelFeedEntry[]
): ChannelFeedEntry[] {
  const seen = new Set<string>();
  for (const entry of existing) {
    const key = entryKey(entry);
    if (key) seen.add(key);
  }
  const extras: ChannelFeedEntry[] = [];
  for (const entry of incoming) {
    const key = entryKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    extras.push(entry);
  }
  return extras;
}

function fillEmptyFeedFields(
  existing: ChannelFeedEntry,
  incoming: ChannelFeedEntry
): ChannelFeedEntry {
  const published_at = existing.published_at || incoming.published_at;
  const published_label = existing.published_label || incoming.published_label;
  const view_count = existing.view_count ?? incoming.view_count;
  const duration = existing.duration ?? incoming.duration;
  const thumbnail_url = existing.thumbnail_url || incoming.thumbnail_url;
  if (
    published_at === existing.published_at &&
    published_label === existing.published_label &&
    view_count === existing.view_count &&
    duration === existing.duration &&
    thumbnail_url === existing.thumbnail_url
  ) {
    return existing;
  }
  return {
    ...existing,
    published_at,
    published_label,
    view_count,
    duration,
    thumbnail_url,
  };
}

/** Append-only merge: existing order and metadata stay unchanged. */
export function appendUnseenFeedEntries(
  existing: ChannelFeedEntry[],
  incoming: ChannelFeedEntry[]
): ChannelFeedEntry[] {
  const extras = unseenFeedEntries(existing, incoming);
  return extras.length ? [...existing, ...extras] : existing;
}

/** Fill empty dates/views on existing cards from YouTube hits, then append new ids. */
export function mergeYoutubeFeedEntries(
  existing: ChannelFeedEntry[],
  incoming: ChannelFeedEntry[]
): ChannelFeedEntry[] {
  if (!incoming.length) return existing;
  const byKey = new Map<string, ChannelFeedEntry>();
  for (const entry of incoming) {
    const key = entryKey(entry);
    if (key) byKey.set(key, entry);
  }
  const filled = existing.map((entry) => {
    const key = entryKey(entry);
    const yt = key ? byKey.get(key) : undefined;
    return yt ? fillEmptyFeedFields(entry, yt) : entry;
  });
  const extras = unseenFeedEntries(filled, incoming);
  if (!extras.length && filled.every((entry, i) => entry === existing[i])) {
    return existing;
  }
  return extras.length ? [...filled, ...extras] : filled;
}

function publishedMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function sortFeedEntries(
  entries: ChannelFeedEntry[],
  sort: FeedSortMode,
  order: FeedSortOrder
): ChannelFeedEntry[] {
  const indexed = entries.map((entry, index) => ({ entry, index }));
  indexed.sort((a, b) => {
    let cmp = 0;
    if (sort === "popular") {
      const av = a.entry.view_count;
      const bv = b.entry.view_count;
      if (av == null && bv == null) return a.index - b.index;
      if (av == null) return 1;
      if (bv == null) return -1;
      cmp = av - bv;
    } else {
      const at = publishedMs(a.entry.published_at);
      const bt = publishedMs(b.entry.published_at);
      if (at == null && bt == null) return a.index - b.index;
      if (at == null) return 1;
      if (bt == null) return -1;
      cmp = at - bt;
    }
    if (cmp === 0) return a.index - b.index;
    return order === "desc" ? -cmp : cmp;
  });
  return indexed.map((item) => item.entry);
}

/** Browse keeps catalog order for Recent; search sorts the combined list by date or views. */
export function applyChannelFeedSort(
  entries: ChannelFeedEntry[],
  sort: FeedSortMode,
  order: FeedSortOrder,
  context: FeedSortContext
): ChannelFeedEntry[] {
  if (sort === "popular") {
    return sortFeedEntries(entries, "popular", order);
  }
  if (context === "search") {
    return sortFeedEntries(entries, "recent", order);
  }
  if (order === "asc") {
    return [...entries].reverse();
  }
  return entries;
}
