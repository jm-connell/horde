import { describe, expect, it } from "vitest";
import type { AskChannel } from "../../types";
import { askIndexedLabel, askWatchPath, snippetParts } from "./askLinks";

const channel = (over: Partial<AskChannel>): AskChannel => ({
  id: 1,
  channel_url: "https://youtube.com/@kiln",
  status: "ready",
  limit: 500,
  videos: 500,
  fetched: 480,
  pending: 0,
  no_captions: 20,
  unavailable: 0,
  passages: 9000,
  include_streams: false,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("askIndexedLabel", () => {
  it("counts against everything the channel uploaded", () => {
    expect(askIndexedLabel(channel({ channel_total: 2310 }))).toBe(
      "500 of 2,310 indexed"
    );
    expect(
      askIndexedLabel(channel({ channel_total: 2310, pending: 380 }))
    ).toBe("120 of 2,310 indexed");
  });

  it("says there is more when the total is unknown and the limit was reached", () => {
    expect(askIndexedLabel(channel({}))).toBe("500 of 500+ indexed");
    expect(askIndexedLabel(channel({ videos: 40, fetched: 40 }))).toBe(
      "40 of 40 indexed"
    );
  });

  it("covers a channel Ask does not have, one just added and a paused one", () => {
    expect(askIndexedLabel(null)).toBe("Not indexed");
    expect(askIndexedLabel(channel({ videos: 0, status: "queued" }))).toBe(
      "Indexing…"
    );
    expect(askIndexedLabel(channel({ videos: 0, status: "error" }))).toBe(
      "Indexing failed"
    );
    expect(
      askIndexedLabel(channel({ channel_total: 900, status: "paused" }))
    ).toBe("500 of 900 indexed · paused");
  });
});

describe("askWatchPath", () => {
  it("opens the library copy at the moment", () => {
    expect(
      askWatchPath({
        yt_id: "abcdefghijk",
        start_sec: 95.7,
        library_video_id: 4,
      })
    ).toBe("/watch/4?t=95");
  });

  it("streams a video that is not downloaded", () => {
    expect(askWatchPath({ yt_id: "abcdefghijk", start_sec: 12 })).toBe(
      "/watch?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk&t=12"
    );
  });
});

describe("snippetParts", () => {
  it("splits marked matches", () => {
    expect(snippetParts("the \u0002timing\u0003 belt \u0002x\u0003")).toEqual([
      { text: "the ", mark: false },
      { text: "timing", mark: true },
      { text: " belt ", mark: false },
      { text: "x", mark: true },
    ]);
  });

  it("keeps unmarked text whole", () => {
    expect(snippetParts("plain")).toEqual([{ text: "plain", mark: false }]);
  });
});
