import { describe, expect, it } from "vitest";
import {
  dedupeSubtitleTracks,
  effectiveSourceUrl,
  formatSize,
  formatTimestamp,
  formatUsdCost,
  formatResolution,
  formatViewCount,
  formatLikeRatio,
  parseApiDate,
  parseChapters,
  stripChapterLines,
} from "./utils";

describe("formatTimestamp", () => {
  it("formats mm:ss and hh:mm:ss", () => {
    expect(formatTimestamp(65)).toBe("1:05");
    expect(formatTimestamp(3661)).toBe("1:01:01");
  });
});

describe("formatSize / formatUsdCost / formatResolution", () => {
  it("formats sizes", () => {
    expect(formatSize(null)).toBe("");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
  });
  it("formats costs", () => {
    expect(formatUsdCost(null)).toBe("");
    expect(formatUsdCost(0)).toBe("$0");
    expect(formatUsdCost(0.00001)).toBe("<$0.0001");
    expect(formatUsdCost(0.5)).toBe("$0.500");
  });
  it("formats resolution", () => {
    expect(formatResolution(2160)).toBe("4K");
    expect(formatResolution(1080)).toBe("1080p");
    expect(formatResolution(null)).toBe("");
  });
});

describe("chapters", () => {
  const desc = "Intro\n0:00 Start\n1:00 Middle\n2:30 End\n";
  it("parses ascending chapters", () => {
    const chapters = parseChapters(desc);
    expect(chapters).toHaveLength(3);
    expect(chapters[0]).toEqual({ startSec: 0, title: "Start" });
  });
  it("strips chapter lines", () => {
    expect(stripChapterLines(desc)).toContain("Intro");
    expect(stripChapterLines(desc)).not.toContain("0:00");
  });
});

describe("misc helpers", () => {
  it("dedupes subtitle tracks by base lang", () => {
    const out = dedupeSubtitleTracks([
      { lang: "en-US" },
      { lang: "en" },
      { lang: "es" },
    ]);
    expect(out.map((t) => t.lang).sort()).toEqual(["en", "es"]);
  });
  it("parses timezone-less API dates as UTC", () => {
    const d = parseApiDate("2024-01-15T12:00:00");
    expect(d.toISOString()).toBe("2024-01-15T12:00:00.000Z");
  });
  it("formats view count and like ratio", () => {
    expect(formatViewCount(1500)).toBe("1.5K views");
    expect(formatLikeRatio(92, 8)).toBe("92%");
  });
  it("effectiveSourceUrl falls back to path id", () => {
    expect(
      effectiveSourceUrl({
        source_url: null,
        file_path: "Chan/2024/Title [dQw4w9WgXcQ].mp4",
      })
    ).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
