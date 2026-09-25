import { describe, expect, it } from "vitest";
import {
  atLiveEdge,
  clampSeek,
  liveEdgeTarget,
  readSeekWindow,
  timelineProgress,
} from "./liveTimeline";

const window = { start: 100, end: 250 };

describe("live timeline", () => {
  it("reads the full seekable range", () => {
    const seekable = {
      length: 1,
      start: () => 12,
      end: () => 80,
    };
    expect(readSeekWindow(seekable)).toEqual({ start: 12, end: 80 });
    expect(readSeekWindow({ length: 0, start: () => 0, end: () => 0 })).toBeNull();
  });

  it("clamps arrow-key and drag seeks inside the DVR window", () => {
    expect(clampSeek(90, window)).toBe(100);
    expect(clampSeek(130, window)).toBe(130);
    expect(clampSeek(130 - 5, window)).toBe(125);
    expect(clampSeek(130 + 5, window)).toBe(135);
    expect(clampSeek(1000, window)).toBe(liveEdgeTarget(window));
    expect(clampSeek(-4, null)).toBe(0);
  });

  it("maps the playhead onto the visible bar", () => {
    expect(timelineProgress(100, window)).toBe(0);
    expect(timelineProgress(175, window)).toBe(50);
    expect(timelineProgress(250, window)).toBe(100);
    expect(atLiveEdge(246, window)).toBe(true);
    expect(atLiveEdge(200, window)).toBe(false);
  });
});
