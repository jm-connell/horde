import { describe, expect, it } from "vitest";
import { couplingAt, flashLevel } from "./fireflySync";
import { meshPalette } from "./meshGradient";
import { coolTurn, hslToRgb, rgbToHsl, shiftHue } from "./palette";

describe("palette", () => {
  it("round-trips colors through HSL", () => {
    for (const rgb of [
      [34, 211, 238],
      [248, 113, 113],
      [8, 9, 12],
      [255, 255, 255],
    ] as const) {
      expect(hslToRgb(rgbToHsl([...rgb]))).toEqual([...rgb]);
    }
  });

  it("leaves a grey accent grey when the hue turns", () => {
    expect(shiftHue([128, 128, 128], 90)).toEqual([128, 128, 128]);
  });

  it("turns cool accents forward and warm ones back toward violet", () => {
    expect(coolTurn([34, 211, 238])).toBe(1);
    expect(coolTurn([249, 115, 22])).toBe(-1);
  });
});

describe("meshPalette", () => {
  it("gives five colors, lighter on light themes", () => {
    const dark = meshPalette([34, 211, 238], "theme", false, 0);
    const light = meshPalette([34, 211, 238], "theme", true, 0);
    expect(dark).toHaveLength(5);
    const lightness = (c: [number, number, number]) => rgbToHsl(c)[2];
    dark.forEach((c, i) =>
      expect(lightness(light[i])).toBeGreaterThan(lightness(c))
    );
  });
});

describe("firefly flashes", () => {
  it("rise fast, fade, then stay dark for the rest of the cycle", () => {
    expect(flashLevel(0)).toBe(0);
    expect(flashLevel(0.03)).toBeCloseTo(1);
    expect(flashLevel(0.1)).toBeLessThan(flashLevel(0.05));
    expect(flashLevel(0.5)).toBe(0);
  });

  it("start out of step, pull together mid-cycle, then let go", () => {
    expect(couplingAt(0)).toBe(0);
    expect(couplingAt(140 * 0.6)).toBe(1);
    expect(couplingAt(140 * 0.98)).toBe(0);
    // And the cycle repeats.
    expect(couplingAt(140 + 140 * 0.6)).toBe(1);
  });
});
