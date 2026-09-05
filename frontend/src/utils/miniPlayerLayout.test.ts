import { describe, expect, it } from "vitest";
import { miniFrameFromNorthWestResize } from "./miniPlayerLayout";

describe("miniFrameFromNorthWestResize", () => {
  it("keeps the bottom-right corner fixed when growing", () => {
    const start = { left: 120, top: 80, width: 400, height: 225 };
    const next = miniFrameFromNorthWestResize(start, 500);
    expect(next.width).toBe(500);
    expect(next.height).toBe(281.25);
    expect(next.left + next.width).toBe(start.left + start.width);
    expect(next.top + next.height).toBe(start.top + start.height);
    expect(next.left).toBe(20);
    expect(next.top).toBe(23.75);
  });

  it("keeps the bottom-right corner fixed when shrinking", () => {
    const start = { left: 200, top: 150, width: 640, height: 360 };
    const next = miniFrameFromNorthWestResize(start, 320);
    expect(next.left + next.width).toBe(start.left + start.width);
    expect(next.top + next.height).toBe(start.top + start.height);
    expect(next.left).toBe(520);
    expect(next.top).toBe(330);
  });
});
