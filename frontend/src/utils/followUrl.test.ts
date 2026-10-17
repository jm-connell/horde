import { describe, expect, it } from "vitest";
import {
  formatViewers,
  isYoutubeChannelUrl,
  normalizeChannelUrl,
} from "./followUrl";

describe("normalizeChannelUrl", () => {
  it("lowercases host, strips www, trailing slash and tab suffix", () => {
    expect(normalizeChannelUrl("https://www.YouTube.com/@Foo/videos/")).toBe(
      "https://youtube.com/@foo"
    );
    expect(
      normalizeChannelUrl("http://youtube.com/channel/UCabc/streams")
    ).toBe("https://youtube.com/channel/UCabc");
  });
  it("defaults the scheme and keeps channel ids case", () => {
    expect(normalizeChannelUrl("youtube.com/channel/UCAbC/")).toBe(
      "https://youtube.com/channel/UCAbC"
    );
  });
  it("returns null for blanks", () => {
    expect(normalizeChannelUrl("  ")).toBeNull();
  });
});

describe("isYoutubeChannelUrl", () => {
  it("accepts youtube hosts only", () => {
    expect(isYoutubeChannelUrl("https://www.youtube.com/@a")).toBe(true);
    expect(isYoutubeChannelUrl("https://vimeo.com/a")).toBe(false);
    expect(isYoutubeChannelUrl(null)).toBe(false);
  });
});

describe("formatViewers", () => {
  it("formats counts", () => {
    expect(formatViewers(null)).toBeNull();
    expect(formatViewers(950)).toBe("950 watching");
    expect(formatViewers(1234)).toBe("1.2K watching");
    expect(formatViewers(2_500_000)).toBe("2.5M watching");
  });
});

// Same table as NORMALIZE_CASES in backend/tests/test_live_hls.py.
describe("normalizeChannelUrl matches the server", () => {
  const cases: [string, string][] = [
    ["https://www.youtube.com/@Foo/live", "https://youtube.com/@foo"],
    ["http://youtube.com:443/@Foo/Videos/", "https://youtube.com/@foo"],
    ["m.youtube.com/channel/UCabc?x=1", "https://youtube.com/channel/UCabc"],
    [
      "https://www.youtube.com/channel/UCAbC/streams",
      "https://youtube.com/channel/UCAbC",
    ],
    ["youtube.com/c/SomeName", "https://youtube.com/c/SomeName"],
    ["https://youtube.com/@x/featured/live", "https://youtube.com/@x"],
  ];
  it.each(cases)("%s", (raw, expected) => {
    expect(normalizeChannelUrl(raw)).toBe(expected);
  });
});
