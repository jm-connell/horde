import { describe, expect, it } from "vitest";
import {
  CAPTION_TIMELINE_GAP_PX,
  captionLiftActive,
  captionTimelineLiftPx,
  layoutBoxFromOffsets,
  scrubPositionFromClientX,
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

  it("lifts captions that encroach on the visible seek bar", () => {
    const overlapping = { left: 120, right: 300, top: 60, bottom: 100 };
    expect(captionTimelineLiftPx(overlapping, seek, true)).toBe(
      100 - 80 + CAPTION_TIMELINE_GAP_PX
    );
    expect(captionTimelineLiftPx(overlapping, seek, false)).toBe(0);
    expect(captionTimelineLiftPx(overlapping, null, true)).toBe(0);
    expect(captionTimelineLiftPx(null, seek, true)).toBe(0);
  });

  it("does not lift captions that already sit above the timeline", () => {
    const clear = { left: 120, right: 300, top: 20, bottom: 50 };
    expect(captionTimelineLiftPx(clear, seek, true)).toBe(0);
    const flush = { left: 120, right: 300, top: 40, bottom: 80 };
    expect(captionTimelineLiftPx(flush, seek, true)).toBe(0);
  });

  it("does not lift captions that miss the timeline horizontally", () => {
    const aside = { left: 10, right: 80, top: 60, bottom: 100 };
    expect(captionTimelineLiftPx(aside, seek, true)).toBe(0);
  });

  it("lifts captions that sit in the chrome below the seek bar", () => {
    const overButtons = { left: 120, right: 300, top: 100, bottom: 140 };
    expect(captionTimelineLiftPx(overButtons, seek, true)).toBe(
      140 - 80 + CAPTION_TIMELINE_GAP_PX
    );
  });

  it("does not lift while dragging or until chrome hides after a place", () => {
    expect(captionLiftActive(true, false, false)).toBe(true);
    expect(captionLiftActive(true, true, false)).toBe(false);
    expect(captionLiftActive(true, false, true)).toBe(false);
    expect(captionLiftActive(false, false, false)).toBe(false);
  });

  it("builds a layout box from offset metrics so lift ignores CSS transform", () => {
    expect(
      layoutBoxFromOffsets(
        { left: 40, top: 10 },
        2,
        1,
        { offsetLeft: 20, offsetTop: 30, offsetWidth: 100, offsetHeight: 40 }
      )
    ).toEqual({ left: 62, top: 41, right: 162, bottom: 81 });
  });
});
