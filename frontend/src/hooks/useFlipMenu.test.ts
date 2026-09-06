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
});
