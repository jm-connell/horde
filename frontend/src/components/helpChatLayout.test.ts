import { describe, expect, it } from "vitest";
import {
  clampHelpFrame,
  defaultHelpFrame,
  MIN_H,
  MIN_W,
  resizeFromTopLeft,
} from "./helpChatLayout";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("defaultHelpFrame", () => {
  it("docks in the bottom-right corner", () => {
    expect(defaultHelpFrame(1280, 800, null)).toEqual({
      left: 1280 - 384 - 16,
      top: 800 - 544 - 16,
      width: 384,
      height: 544,
    });
  });

  it("sits above a mini player in the corner when there is room", () => {
    const f = defaultHelpFrame(1280, 800, rect(880, 560, 384, 224));
    expect(f.top + f.height).toBe(560 - 16);
    expect(f.height).toBe(560 - 32);
  });

  it("moves beside a tall mini player instead", () => {
    const f = defaultHelpFrame(1280, 800, rect(900, 200, 364, 584));
    expect(f.left + f.width).toBe(900 - 16);
  });

  it("leaves a mini player elsewhere alone", () => {
    expect(defaultHelpFrame(1280, 800, rect(16, 560, 384, 224))).toEqual(
      defaultHelpFrame(1280, 800, null)
    );
  });
});

describe("clampHelpFrame", () => {
  it("keeps a dragged panel on screen after the window shrinks", () => {
    const f = clampHelpFrame(
      { left: 1000, top: 600, width: 400, height: 500 },
      800,
      600
    );
    expect(f.left + f.width).toBeLessThanOrEqual(800 - 8);
    expect(f.top).toBeGreaterThanOrEqual(8);
    expect(f.height).toBeLessThanOrEqual(600 - 16);
  });
});

describe("resizeFromTopLeft", () => {
  const start = { left: 500, top: 200, width: 400, height: 500 };

  it("grows up and left, keeping the bottom-right corner", () => {
    const f = resizeFromTopLeft(start, -100, -50, 1280, 800);
    expect(f).toEqual({ left: 400, top: 150, width: 500, height: 550 });
  });

  it("stops at the minimum size and the screen edge", () => {
    const small = resizeFromTopLeft(start, 1000, 1000, 1280, 800);
    expect([small.width, small.height]).toEqual([MIN_W, MIN_H]);
    expect(small.left + small.width).toBe(900);
    const big = resizeFromTopLeft(start, -2000, -2000, 1280, 800);
    expect(big.left).toBe(8);
    expect(big.top).toBe(8);
  });
});
