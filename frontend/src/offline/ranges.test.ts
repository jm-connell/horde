import { describe, expect, it } from "vitest";
import { chunkSlices, contentRangeTotal, parseRange } from "./ranges";

describe("parseRange", () => {
  it("returns null without a header", () => {
    expect(parseRange(null, 100)).toBeNull();
  });

  it("parses explicit ranges and clamps the end", () => {
    expect(parseRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1 });
    expect(parseRange("bytes=10-500", 100)).toEqual({ start: 10, end: 99 });
  });

  it("caps open-ended ranges", () => {
    expect(parseRange("bytes=0-", 1000, 64)).toEqual({ start: 0, end: 63 });
    expect(parseRange("bytes=990-", 1000, 64)).toEqual({ start: 990, end: 999 });
  });

  it("handles suffix ranges", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("rejects unsatisfiable ranges", () => {
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=5-2", 100)).toBe("invalid");
    expect(parseRange("bytes=-0", 100)).toBe("invalid");
  });

  it("ignores multi-range and unknown units", () => {
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

describe("chunkSlices", () => {
  it("covers a range inside one chunk", () => {
    expect(chunkSlices({ start: 2, end: 5 }, 10)).toEqual([
      { index: 0, from: 2, to: 6 },
    ]);
  });

  it("spans chunk boundaries", () => {
    expect(chunkSlices({ start: 8, end: 21 }, 10)).toEqual([
      { index: 0, from: 8, to: 10 },
      { index: 1, from: 0, to: 10 },
      { index: 2, from: 0, to: 2 },
    ]);
  });

  it("handles exact chunk edges", () => {
    expect(chunkSlices({ start: 10, end: 19 }, 10)).toEqual([
      { index: 1, from: 0, to: 10 },
    ]);
  });
});

describe("contentRangeTotal", () => {
  it("extracts the total size", () => {
    expect(contentRangeTotal("bytes 0-0/12345")).toBe(12345);
    expect(contentRangeTotal("bytes */12345")).toBe(12345);
    expect(contentRangeTotal(null)).toBeNull();
    expect(contentRangeTotal("bytes 0-0/*")).toBeNull();
  });
});
