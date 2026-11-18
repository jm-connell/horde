import { describe, expect, it } from "vitest";
import { flipMenuFixedStyle } from "./useFlipMenu";

const rect = {
  top: 100,
  bottom: 140,
  left: 50,
  right: 250,
  width: 200,
};

describe("flipMenuFixedStyle", () => {
  const viewport = { width: 800, height: 600 };

  it("opens below and left-aligns to the trigger", () => {
    expect(flipMenuFixedStyle(rect, "down", "left", viewport)).toEqual({
      minWidth: 200,
      top: 144,
      left: 50,
    });
  });

  it("opens above and right-aligns to the trigger", () => {
    expect(flipMenuFixedStyle(rect, "up", "right", viewport)).toEqual({
      minWidth: 200,
      bottom: 504,
      right: 550,
    });
  });

  it("shifts a left-aligned menu back inside a narrow window", () => {
    const phone = { width: 375, height: 812 };
    const trigger = { ...rect, left: 295, right: 343, width: 48 };
    expect(flipMenuFixedStyle(trigger, "down", "left", phone, 208)).toEqual({
      minWidth: 48,
      top: 144,
      left: 159,
    });
  });

  it("shifts a right-aligned menu back inside the window", () => {
    const trigger = { ...rect, left: 20, right: 60, width: 40 };
    expect(flipMenuFixedStyle(trigger, "up", "right", viewport, 208)).toEqual({
      minWidth: 40,
      bottom: 504,
      right: 584,
    });
  });

  it("leaves a menu that fits where it is", () => {
    expect(flipMenuFixedStyle(rect, "down", "left", viewport, 208)).toEqual({
      minWidth: 200,
      top: 144,
      left: 50,
    });
  });
});
