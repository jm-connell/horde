import { describe, expect, it } from "vitest";
import { jellyKeyframes } from "./liquidJelly";

const a = { left: 0, top: 0, width: 80, height: 36 };
const b = { left: 200, top: 0, width: 100, height: 36 };

describe("jellyKeyframes", () => {
  it("starts on the old item and rests on the new one", () => {
    const frames = jellyKeyframes(a, b);
    expect(frames[0]).toMatchObject({ left: "0px", width: "80px" });
    expect(frames[frames.length - 1]).toMatchObject({
      left: "200px",
      width: "100px",
      transform: "scaleY(1)",
    });
  });

  it("stretches toward the destination before the trailing edge follows", () => {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const stretch = jellyKeyframes(from, to)[1];
      const width = parseFloat(String(stretch.width));
      expect(width).toBeGreaterThan(Math.max(from.width, to.width));
      expect(stretch.transform).toBe("scaleY(0.86)");
    }
  });

  it("travels along the vertical axis for stacked items", () => {
    const frames = jellyKeyframes(
      { left: 0, top: 0, width: 200, height: 40 },
      { left: 0, top: 120, width: 200, height: 40 }
    );
    expect(frames[frames.length - 1]).toMatchObject({
      top: "120px",
      height: "40px",
    });
    expect(frames[1].transform).toBe("scaleX(0.86)");
  });
});
