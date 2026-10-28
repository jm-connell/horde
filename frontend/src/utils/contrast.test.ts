import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  mutedTextFor,
  statusTextFor,
  type Rgb,
} from "./contrast";

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

  it("steps a status colour the way it is told, away from the background", () => {
    const red: Rgb = [248, 113, 113];
    // A mid-dark blue where red-400 is under AA: black would make it worse.
    const dark: Rgb[] = [
      [46, 52, 64],
      [59, 66, 82],
    ];
    const lifted = mutedTextFor(dark, red, 4.6, [255, 255, 255]);
    const light: Rgb[] = [
      [250, 250, 250],
      [241, 245, 249],
    ];
    const deepened = mutedTextFor(light, red, 4.6, [0, 0, 0]);
    for (const s of dark)
      expect(contrastRatio(lifted, s)).toBeGreaterThanOrEqual(4.6);
    for (const s of light)
      expect(contrastRatio(deepened, s)).toBeGreaterThanOrEqual(4.6);
    expect(lifted).not.toEqual([255, 255, 255]);
    expect(deepened).not.toEqual([0, 0, 0]);
  });

  it("keeps custom-theme status colours legible on their tints without washing out", () => {
    const mixed = (a: Rgb, b: Rgb, t: number) =>
      a.map((v, i) => Math.round(v + (b[i] - v) * t)) as Rgb;
    const red: Rgb = [248, 113, 113];
    const white: Rgb = [255, 255, 255];
    const cases: [Rgb, boolean, boolean][] = [
      // [background, lighten, hue survives]
      [[13, 15, 20], true, true],
      [[255, 255, 255], false, true],
      [[192, 192, 192], false, true],
      [[56, 56, 56], true, false],
    ];
    for (const [bg, lighten, keepsHue] of cases) {
      const surfaces = [bg, mixed(bg, white, 0.08), mixed(bg, white, 0.14)];
      const c = statusTextFor(surfaces, red, lighten);
      for (const s of surfaces) {
        expect(contrastRatio(c, s)).toBeGreaterThanOrEqual(4.6);
        expect(contrastRatio(c, mixed(s, c, 0.15))).toBeGreaterThanOrEqual(4.6);
      }
      // Still recognisably red where the background allows it.
      if (keepsHue) expect(c[0] - c[1]).toBeGreaterThan(40);
    }
  });
});
