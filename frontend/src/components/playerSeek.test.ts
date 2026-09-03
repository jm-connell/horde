import { describe, expect, it } from "vitest";
import {
  pointInClientRect,
  scrubPositionFromClientX,
  shouldPassthroughSeek,
} from "./playerSeek";

const seek = { left: 100, right: 500, top: 80, bottom: 96 };

describe("playerSeek", () => {
  it("maps client X to a time along the bar", () => {
    expect(scrubPositionFromClientX(100, { left: 100, width: 400 }, 200)).toEqual(
      { time: 0, pct: 0 }
    );
    expect(scrubPositionFromClientX(300, { left: 100, width: 400 }, 200)).toEqual(
      { time: 100, pct: 50 }
    );
    expect(scrubPositionFromClientX(80, { left: 100, width: 400 }, 200)).toEqual(
      { time: 0, pct: 0 }
    );
    expect(scrubPositionFromClientX(600, { left: 100, width: 400 }, 200)).toEqual(
      { time: 200, pct: 100 }
    );
    expect(scrubPositionFromClientX(300, { left: 100, width: 400 }, 0)).toBeNull();
  });

  it("steals caption clicks only on the visible seek strip", () => {
    expect(pointInClientRect(120, 88, seek)).toBe(true);
    expect(pointInClientRect(120, 40, seek)).toBe(false);
    expect(shouldPassthroughSeek(120, 88, seek, true)).toBe(true);
    expect(shouldPassthroughSeek(120, 40, seek, true)).toBe(false);
    expect(shouldPassthroughSeek(120, 88, seek, false)).toBe(false);
    expect(shouldPassthroughSeek(120, 88, null, true)).toBe(false);
  });
});
