import { describe, expect, it } from "vitest";
import { EFFECT_CONTROLS, effectOptions } from "./controls";
import { BACKGROUND_EFFECT_OPTIONS } from "./index";
import { meshPalette } from "./meshGradient";
import { gridOffsets } from "./modernGrid";
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

describe("background list", () => {
  it("is None, Custom image, then the effects by label", () => {
    expect(BACKGROUND_EFFECT_OPTIONS.slice(0, 2).map((o) => o.value)).toEqual([
      "none",
      "custom-image",
    ]);
    const labels = BACKGROUND_EFFECT_OPTIONS.slice(2).map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("has controls for every effect and nothing else", () => {
    expect(Object.keys(EFFECT_CONTROLS).sort()).toEqual(
      BACKGROUND_EFFECT_OPTIONS.slice(2)
        .map((o) => o.value)
        .sort()
    );
  });

  it("gives every slider a unique key and a default inside its range", () => {
    for (const controls of Object.values(EFFECT_CONTROLS)) {
      const keys = controls.sliders.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const s of controls.sliders) {
        expect(s.min).toBeLessThan(s.max);
        expect(s.default).toBeGreaterThanOrEqual(s.min);
        expect(s.default).toBeLessThanOrEqual(s.max);
      }
    }
  });

  it("offers the palette for Mesh gradient only", () => {
    const withPalette = Object.entries(EFFECT_CONTROLS)
      .filter(([, c]) => c.palette)
      .map(([id]) => id);
    expect(withPalette).toEqual(["mesh-gradient"]);
  });
});

describe("effectOptions", () => {
  const angle = EFFECT_CONTROLS.rain.sliders[0];

  it("fills in the defaults", () => {
    expect(effectOptions("rain", undefined)).toEqual({
      [angle.key]: angle.default,
    });
    expect(effectOptions("dust", { anything: 1 })).toEqual({});
  });

  it("keeps a stored value and clamps it into range", () => {
    expect(effectOptions("rain", { angle: 30 })).toEqual({ angle: 30 });
    expect(effectOptions("rain", { angle: 900 })).toEqual({ angle: angle.max });
    expect(effectOptions("rain", { angle: -900 })).toEqual({
      angle: angle.min,
    });
  });

  it("drops non-numbers and keys the effect does not have", () => {
    for (const junk of ["12", null, NaN, Infinity, {}, [3]]) {
      expect(effectOptions("rain", { angle: junk })).toEqual({
        angle: angle.default,
      });
    }
    expect(effectOptions("rain", { angle: 5, wind: 2 })).toEqual({ angle: 5 });
    for (const junk of ["x", 4, null, [1]]) {
      expect(effectOptions("rain", junk)).toEqual({ angle: angle.default });
    }
  });
});

describe("modern grid", () => {
  /** Distance between two offsets on a grid that repeats every `spacing`. */
  const slide = (a: number, b: number, spacing: number) => {
    const d = Math.abs(a - b) % spacing;
    return Math.min(d, spacing - d);
  };

  it("never jumps: each axis wraps by exactly one cell", () => {
    const spacing = 48;
    const dt = 1 / 30;
    // Long enough for both axes to wrap several times.
    for (let frame = 1; frame < 30 * 60; frame++) {
      const [x0, y0] = gridOffsets((frame - 1) * dt, spacing);
      const [x1, y1] = gridOffsets(frame * dt, spacing);
      for (const offset of [x1, y1]) {
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(spacing);
      }
      // The lines sit a cell apart, so a wrap by one cell is invisible; any
      // other step would show as a skip.
      expect(slide(x0, x1, spacing)).toBeLessThan(0.5);
      expect(slide(y0, y1, spacing)).toBeLessThan(0.5);
    }
  });
});
