import { describe, expect, it } from "vitest";
import { clipBarRange, clipMarkAtBar } from "./clipMarkers";

describe("clipBarRange", () => {
  it("places a past stream's marks on its own timeline", () => {
    const range = clipBarRange(
      { start: { kind: "time", sec: 4253 }, end: { kind: "time", sec: 7099 } },
      null,
      0
    );
    expect(range).toEqual({ start: 4253, end: 7099 });
  });

  it("places live marks within the DVR window as the edge moves on", () => {
    // DVR window 1000..4600 (media time); a mark made 600 s ago at the edge
    // now sits 600 s behind it: 4000 media, 3000 along the bar.
    const win = { start: 1000, end: 4600, isLive: true };
    const range = clipBarRange(
      { start: { kind: "live", atMs: 400_000 }, end: null },
      win,
      1_000_000
    );
    expect(range).toEqual({ start: 3000, end: null });
  });

  it("leaves live marks off until the window is known", () => {
    expect(
      clipBarRange({ start: { kind: "live", atMs: 0 }, end: null }, null, 0)
    ).toEqual({ start: null, end: null });
  });
});

describe("clipMarkAtBar", () => {
  it("rounds a past stream's position to the second", () => {
    expect(clipMarkAtBar(4253.4, false, null, 0)).toEqual({
      kind: "time",
      sec: 4253,
    });
  });

  it("is the inverse of clipBarRange on a live bar", () => {
    const win = { start: 1000, end: 4600, isLive: true };
    const mark = clipMarkAtBar(3000, true, win, 1_000_000);
    expect(mark).toEqual({ kind: "live", atMs: 400_000 });
    expect(clipBarRange({ start: mark, end: null }, win, 1_000_000).start).toBe(
      3000
    );
  });
});
