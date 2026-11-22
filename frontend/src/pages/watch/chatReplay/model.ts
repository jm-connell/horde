/**
 * Chat replay that follows playback: which messages show at a position, when
 * to read the next stretch, when a seek needs a fresh read, which videos get
 * chat and where the panel goes. Pure, so it is unit-tested; `useChatReplay`
 * drives it.
 */
import type { ChatReplayItem, ChatReplayPage } from "../../../types";
import { youtubeVideoIdFromUrl } from "../../../utils";
import type { WatchSource } from "../useWatchVideo";

/** Messages kept in the list at most (older ones scroll away). */
export const CHAT_KEEP = 300;
/** Read the next stretch this long before the loaded one runs out. */
export const PREFETCH_MS = 20_000;
/** A seek back this close to the loaded stretch keeps it. */
export const SEEK_BACK_SLACK_MS = 5_000;
/** A seek this far past the loaded stretch reads afresh instead of continuing. */
export const JUMP_AHEAD_MS = 60_000;

/** The stretch of chat loaded so far. */
export type Loaded = {
  startMs: number;
  endMs: number;
  items: ChatReplayItem[];
  nextCursor: string | null;
};

/**
 * Add a page to what is loaded. A jump (`atMs` set) replaces it; a continuation
 * (`atMs` null) appends, each message once, in offset order.
 */
export function mergeChunk(
  loaded: Loaded | null,
  page: ChatReplayPage,
  atMs: number | null
): Loaded {
  const base = atMs === null && loaded ? loaded.items : [];
  const seen = new Set(base.map((i) => i.id));
  const items = [...base];
  for (const item of page.items ?? []) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }
  items.sort((a, b) => a.offset_ms - b.offset_ms);
  const first = items[0]?.offset_ms;
  const last = items[items.length - 1]?.offset_ms;
  const startMs =
    atMs === null && loaded
      ? loaded.startMs
      : Math.min(first ?? atMs ?? 0, atMs ?? Infinity);
  const endMs = Math.max(
    last ?? 0,
    atMs ?? 0,
    atMs === null && loaded ? loaded.endMs : 0
  );
  return { startMs, endMs, items, nextCursor: page.next_cursor ?? null };
}

/** The messages up to `positionMs`, newest last, at most `keep`. */
export function visibleItems(
  loaded: Loaded | null,
  positionMs: number,
  keep = CHAT_KEEP
): ChatReplayItem[] {
  if (!loaded) return [];
  let end = loaded.items.length;
  while (end > 0 && loaded.items[end - 1].offset_ms > positionMs) end -= 1;
  return loaded.items.slice(Math.max(0, end - keep), end);
}

/** Time to read the stretch after the loaded one. */
export function needsNext(loaded: Loaded | null, positionMs: number): boolean {
  return (
    Boolean(loaded?.nextCursor) && positionMs >= loaded!.endMs - PREFETCH_MS
  );
}

/** The position is outside what is loaded: read afresh from it. */
export function needsReload(
  loaded: Loaded | null,
  positionMs: number
): boolean {
  if (!loaded) return true;
  return (
    positionMs < loaded.startMs - SEEK_BACK_SLACK_MS ||
    positionMs > loaded.endMs + JUMP_AHEAD_MS
  );
}

/**
 * The YouTube video whose chat replay the page should read, if any. `known` is
 * false for a library video not yet known to be a stream: the server finds out.
 * Never a stream YouTube is still processing (`post_live`), whose timeline does
 * not match the chat's, nor another site's past stream.
 */
export function chatTarget(
  source: WatchSource
): { youtubeId: string; known: boolean } | null {
  if (source.kind === "stream") {
    const id = youtubeVideoIdFromUrl(source.url);
    return id && source.meta.live_status === "was_live"
      ? { youtubeId: id, known: true }
      : null;
  }
  const id = youtubeVideoIdFromUrl(source.video.source_url);
  const status = source.video.live_status;
  if (!id) return null;
  if (status === "was_live") return { youtubeId: id, known: true };
  if (status == null) return { youtubeId: id, known: false };
  return null;
}

export type ChatPlacement = "sidebar" | "beside-info" | "inline" | "sideways";

/** Where the chat panel goes for this layout. */
export function chatPlacement(o: {
  isMobile: boolean;
  landscape: boolean;
  theater: boolean;
  wide: boolean;
}): ChatPlacement {
  if (o.isMobile) return o.landscape ? "sideways" : "inline";
  if (o.theater) return "beside-info";
  return o.wide ? "sidebar" : "inline";
}
