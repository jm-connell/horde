import { describe, expect, it } from "vitest";
import { askWatchPath, snippetParts } from "./askLinks";

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
