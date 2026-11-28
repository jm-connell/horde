import { describe, expect, it } from "vitest";
import type {
  ChatReplayItem,
  ChatReplayPage,
  StreamPreviewMeta,
  Video,
} from "../../../types";
import type { WatchSource } from "../useWatchVideo";
import {
  CHAT_KEEP,
  KEEP_BEHIND_MS,
  chatPlacement,
  chatTarget,
  mergeChunk,
  needsNext,
  needsReload,
  trimBehind,
  visibleItems,
} from "./model";

const YT_URL = "https://www.youtube.com/watch?v=abcdefghijk";

function item(offset: number, id = `m${offset}`): ChatReplayItem {
  return {
    id,
    offset_ms: offset,
    kind: "text",
    author: "Ada",
    badges: [],
    runs: [{ text: "hi" }],
  };
}

function page(
  offsets: number[],
  nextCursor: string | null = null
): ChatReplayPage {
  return {
    status: "ok",
    items: offsets.map((o) => item(o)),
    next_cursor: nextCursor,
  };
}

function last<T>(list: T[]): T {
  return list[list.length - 1];
}

/** `count` offsets spread evenly from `start` (inclusive) to `end`. */
function range(start: number, end: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    Math.floor(start + (i * (end - start)) / count)
  );
}

function stream(url: string, meta: Partial<StreamPreviewMeta>): WatchSource {
  return { kind: "stream", url, meta: meta as StreamPreviewMeta };
}

function library(video: Partial<Video>): WatchSource {
  return { kind: "library", video: video as Video };
}

describe("visibleItems", () => {
  it("shows only messages up to the position, newest last, at most CHAT_KEEP", () => {
    const loaded = mergeChunk(null, page(range(0, 1000, 500)), 0);
    const shown = visibleItems(loaded, 600);
    expect(last(shown).offset_ms).toBeLessThanOrEqual(600);
    expect(last(shown).offset_ms).toBeGreaterThan(590);
    expect(visibleItems(loaded, 999_999)).toHaveLength(CHAT_KEEP);
    expect(last(visibleItems(loaded, 999_999)).offset_ms).toBe(998);
    expect(visibleItems(null, 600)).toEqual([]);
  });
});

describe("needsNext", () => {
  it("continues before the loaded stretch runs out", () => {
    const loaded = mergeChunk(null, page([0, 50_000], "50000~T"), 0);
    expect(needsNext(loaded, 20_000)).toBe(false);
    expect(needsNext(loaded, 31_000)).toBe(true);
    expect(needsNext({ ...loaded, nextCursor: null }, 49_000)).toBe(false);
    expect(needsNext(null, 0)).toBe(false);
  });
});

describe("needsReload", () => {
  it("reloads after a seek back before, or far past, what is loaded", () => {
    const loaded = mergeChunk(null, page([600_000, 650_000]), 600_000);
    expect(needsReload(loaded, 610_000)).toBe(false);
    expect(needsReload(loaded, 596_000)).toBe(false); // within the slack
    expect(needsReload(loaded, 100_000)).toBe(true);
    expect(needsReload(loaded, 800_000)).toBe(true);
    expect(needsReload(null, 0)).toBe(true);
  });
});

describe("mergeChunk", () => {
  it("a continuation appends without duplicates; a jump replaces", () => {
    const first = mergeChunk(null, page([0, 10_000, 20_000], "20000~A"), 0);
    expect(first).toMatchObject({
      startMs: 0,
      endMs: 20_000,
      nextCursor: "20000~A",
    });
    const more = mergeChunk(
      first,
      page([15_000, 20_000, 30_000], "30000~B"),
      null
    );
    expect(more.items.map((i) => i.offset_ms)).toEqual([
      0, 10_000, 15_000, 20_000, 30_000,
    ]);
    expect(more).toMatchObject({
      startMs: 0,
      endMs: 30_000,
      nextCursor: "30000~B",
    });
    const jumped = mergeChunk(more, page([7_000_000]), 7_000_500);
    expect(jumped.items.map((i) => i.offset_ms)).toEqual([7_000_000]);
    expect(jumped).toMatchObject({
      startMs: 7_000_000,
      endMs: 7_000_500,
      nextCursor: null,
    });
  });

  it("an empty page still moves the loaded stretch to where it was asked", () => {
    const empty = mergeChunk(null, page([]), 9_000_000);
    expect(empty).toMatchObject({
      startMs: 9_000_000,
      endMs: 9_000_000,
      items: [],
    });
    expect(needsReload(empty, 9_010_000)).toBe(false);
  });
});

describe("chatTarget", () => {
  it("was_live YouTube streams and library videos; unknown library videos; never post_live", () => {
    expect(chatTarget(stream(YT_URL, { live_status: "was_live" }))).toEqual({
      youtubeId: "abcdefghijk",
      known: true,
      live: false,
    });
    expect(
      chatTarget(stream(YT_URL, { live_status: "post_live", was_live: true }))
    ).toBeNull();
    expect(
      chatTarget(
        stream("https://www.twitch.tv/videos/1", { live_status: "was_live" })
      )
    ).toBeNull();
    expect(
      chatTarget(library({ source_url: YT_URL, live_status: "was_live" }))
    ).toEqual({
      youtubeId: "abcdefghijk",
      known: true,
      live: false,
    });
    expect(
      chatTarget(library({ source_url: YT_URL, live_status: null }))
    ).toEqual({
      youtubeId: "abcdefghijk",
      known: false,
      live: false,
    });
    expect(
      chatTarget(library({ source_url: YT_URL, live_status: "not_live" }))
    ).toBeNull();
    expect(
      chatTarget(
        library({ source_url: "https://vimeo.com/1", live_status: "was_live" })
      )
    ).toBeNull();
  });
});

describe("chatPlacement", () => {
  it("covers every layout", () => {
    expect(
      chatPlacement({
        isMobile: true,
        landscape: true,
        besidePlayer: false,
        wide: false,
      })
    ).toBe("sideways");
    expect(
      chatPlacement({
        isMobile: true,
        landscape: false,
        besidePlayer: false,
        wide: false,
      })
    ).toBe("inline");
    // A phone never gets it, whatever the player mode says.
    expect(
      chatPlacement({
        isMobile: true,
        landscape: false,
        besidePlayer: true,
        wide: false,
      })
    ).toBe("inline");
    expect(
      chatPlacement({
        isMobile: false,
        landscape: false,
        besidePlayer: true,
        wide: true,
      })
    ).toBe("beside-player");
    expect(
      chatPlacement({
        isMobile: false,
        landscape: false,
        besidePlayer: false,
        wide: true,
      })
    ).toBe("sidebar");
    expect(
      chatPlacement({
        isMobile: false,
        landscape: false,
        besidePlayer: false,
        wide: false,
      })
    ).toBe("inline");
  });
});

describe("trimBehind", () => {
  it("drops messages long past, so a long watch does not grow without end", () => {
    const loaded = mergeChunk(null, page(range(0, 3_600_000, 3_600), "c"), 0);
    const trimmed = trimBehind(loaded, 3_000_000);
    expect(trimmed.items[0].offset_ms).toBeGreaterThanOrEqual(
      3_000_000 - KEEP_BEHIND_MS
    );
    expect(trimmed.startMs).toBe(trimmed.items[0].offset_ms);
    expect(trimmed.endMs).toBe(loaded.endMs);
    expect(trimmed.nextCursor).toBe("c");
    // Still shows a full list at the position.
    expect(visibleItems(trimmed, 3_000_000)).toHaveLength(CHAT_KEEP);
    // Nothing to drop: the same object.
    expect(trimBehind(loaded, 0)).toBe(loaded);
  });
});
