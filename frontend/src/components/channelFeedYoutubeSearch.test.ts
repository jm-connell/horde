import { describe, expect, it } from "vitest";
import type { ChannelFeedEntry } from "../types";
import {
  appendUnseenFeedEntries,
  applyChannelFeedSort,
  isYoutubeChannelUrl,
  mergeYoutubeFeedEntries,
  sortFeedEntries,
  unseenFeedEntries,
} from "./channelFeedYoutubeSearch";

function entry(
  id: string,
  extra: Partial<ChannelFeedEntry> = {}
): ChannelFeedEntry {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: extra.title ?? id,
    duration: extra.duration ?? 60,
    thumbnail_url: extra.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    view_count: extra.view_count !== undefined ? extra.view_count : 1,
    like_count: extra.like_count ?? null,
    dislike_count: extra.dislike_count ?? null,
    published_at:
      extra.published_at !== undefined ? extra.published_at : "2024-01-01",
    published_label: extra.published_label ?? null,
    channel: extra.channel ?? "Linus Tech Tips",
    in_library: extra.in_library ?? false,
    video_id: extra.video_id ?? null,
    library_height_px: extra.library_height_px ?? null,
    max_height: extra.max_height ?? null,
    match_reason: extra.match_reason ?? { source: "title" },
  };
}

describe("isYoutubeChannelUrl", () => {
  it("accepts youtube hosts and rejects others", () => {
    expect(isYoutubeChannelUrl("https://www.youtube.com/@LinusTechTips")).toBe(
      true
    );
    expect(isYoutubeChannelUrl("https://youtu.be/abc")).toBe(true);
    expect(isYoutubeChannelUrl("https://vimeo.com/123")).toBe(false);
    expect(isYoutubeChannelUrl(null)).toBe(false);
  });
});

describe("appendUnseenFeedEntries", () => {
  it("keeps existing order and metadata, appending only new ids", () => {
    const local = [
      entry("keepA", { title: "Local A", view_count: 10 }),
      entry("keepB", { title: "Local B" }),
    ];
    const youtube = [
      entry("keepA", { title: "YouTube renamed A", view_count: 99 }),
      entry("newC", { title: "From YouTube" }),
    ];
    const merged = appendUnseenFeedEntries(local, youtube);
    expect(merged.map((e) => e.id)).toEqual(["keepA", "keepB", "newC"]);
    expect(merged[0].title).toBe("Local A");
    expect(merged[0].view_count).toBe(10);
    expect(merged[2].title).toBe("From YouTube");
  });

  it("returns the same array reference when nothing is new", () => {
    const local = [entry("keepA")];
    expect(unseenFeedEntries(local, [entry("keepA")])).toEqual([]);
    expect(appendUnseenFeedEntries(local, [entry("keepA")])).toBe(local);
  });
});

describe("mergeYoutubeFeedEntries", () => {
  it("fills empty dates on existing cards and appends new ids", () => {
    const local = [
      entry("keepA", { published_at: null, view_count: 10, title: "Local A" }),
      entry("keepB", { published_at: "2024-01-01" }),
    ];
    const youtube = [
      entry("keepA", {
        title: "YouTube renamed A",
        published_at: "2013-06-01",
        view_count: 99,
      }),
      entry("newC", { title: "From YouTube", published_at: "2020-01-01" }),
    ];
    const merged = mergeYoutubeFeedEntries(local, youtube);
    expect(merged.map((e) => e.id)).toEqual(["keepA", "keepB", "newC"]);
    expect(merged[0].title).toBe("Local A");
    expect(merged[0].view_count).toBe(10);
    expect(merged[0].published_at).toBe("2013-06-01");
    expect(merged[1].published_at).toBe("2024-01-01");
    expect(merged[2].title).toBe("From YouTube");
  });

  it("fills a YouTube relative label onto an existing dated card", () => {
    const local = [entry("keepA", { published_at: "2023-09-03T00:00:00Z" })];
    const youtube = [
      entry("keepA", {
        published_at: "2013-06-01T00:00:00Z",
        published_label: "13 years ago",
      }),
    ];
    const merged = mergeYoutubeFeedEntries(local, youtube);
    expect(merged[0].published_at).toBe("2023-09-03T00:00:00Z");
    expect(merged[0].published_label).toBe("13 years ago");
  });
});

describe("applyChannelFeedSort", () => {
  it("sorts search results by published_at for Recent", () => {
    const list = [
      entry("old", { published_at: "2013-01-01" }),
      entry("mid", { published_at: "2020-01-01" }),
      entry("new", { published_at: "2024-01-01" }),
      entry("undated", { published_at: null }),
    ];
    expect(
      applyChannelFeedSort(list, "recent", "desc", "search").map((e) => e.id)
    ).toEqual(["new", "mid", "old", "undated"]);
    expect(
      applyChannelFeedSort(list, "recent", "asc", "search").map((e) => e.id)
    ).toEqual(["old", "mid", "new", "undated"]);
  });

  it("sorts by view count for Popular and keeps missing last", () => {
    const list = [
      entry("low", { view_count: 10 }),
      entry("high", { view_count: 90 }),
      entry("none", { view_count: null }),
    ];
    expect(
      sortFeedEntries(list, "popular", "desc").map((e) => e.id)
    ).toEqual(["high", "low", "none"]);
  });

  it("reverses browse Recent instead of sorting by date", () => {
    const list = [
      entry("first", { published_at: "2013-01-01" }),
      entry("second", { published_at: "2024-01-01" }),
    ];
    expect(
      applyChannelFeedSort(list, "recent", "desc", "browse").map((e) => e.id)
    ).toEqual(["first", "second"]);
    expect(
      applyChannelFeedSort(list, "recent", "asc", "browse").map((e) => e.id)
    ).toEqual(["second", "first"]);
  });
});
