import { describe, expect, it } from "vitest";
import { contrastRatio, mutedTextFor, type Rgb } from "./contrast";

describe("contrast", () => {
  it("matches the WCAG reference ratios", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(
      4.48,
      1
    );
  });

  it("derives a muted colour that meets AA on dark and light surfaces", () => {
    // Mid-greys cannot reach AA with any text colour, so they are not covered.
    for (const bg of [
      [13, 15, 20],
      [250, 250, 250],
      [40, 60, 90],
    ] as Rgb[]) {
      const surfaces = [bg, bg.map((v) => Math.round(v * 0.9)) as Rgb];
      const muted = mutedTextFor(surfaces, bg);
      for (const s of surfaces) {
        expect(contrastRatio(muted, s)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
