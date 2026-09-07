import { describe, expect, it } from "vitest";
import { overlayThumbLayout } from "./overlayThumbLayout";

describe("overlayThumbLayout", () => {
  it("returns null when content fits", () => {
    expect(overlayThumbLayout(0, 100, 100)).toBeNull();
    expect(overlayThumbLayout(0, 100, 101)).toBeNull();
  });

  it("sizes the thumb to the visible fraction of the inset track", () => {
    const t = overlayThumbLayout(0, 200, 100);
    expect(t).toEqual({ top: 4, height: 46 });
  });

  it("places the thumb at the bottom when fully scrolled", () => {
    const t = overlayThumbLayout(100, 200, 100);
    expect(t).toEqual({ top: 50, height: 46 });
  });

  it("never shrinks below the minimum thumb height", () => {
    const t = overlayThumbLayout(0, 10_000, 100);
    expect(t?.height).toBe(16);
    expect(t?.top).toBe(4);
  });
});
