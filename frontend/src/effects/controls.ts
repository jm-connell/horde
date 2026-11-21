import type { BackgroundEffect } from "../hooks/settings/types";

/** A slider only one background has; its value reaches the effect as
 * `frame.options[key]`. */
export interface EffectSlider {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** How the value is shown: a multiplier, 0–1 as a percentage, degrees. */
  format: "x" | "percent" | "deg";
}

/** Which of the shared controls a background answers to, and its own. */
export interface EffectControls {
  speed: boolean;
  size: boolean;
  color: boolean;
  palette: boolean;
  /** What Size means here when "Size" is misleading, e.g. "Density". */
  sizeLabel?: string;
  sliders: EffectSlider[];
}

export type AnimatedEffect = Exclude<BackgroundEffect, "none" | "custom-image">;

const SHARED = { speed: true, size: true, color: true, palette: false };

const multiplier = (
  key: string,
  label: string,
  min: number,
  max: number
): EffectSlider => ({
  key,
  label,
  min,
  max,
  step: 0.1,
  default: 1,
  format: "x",
});

const percent = (
  key: string,
  label: string,
  min: number,
  max: number,
  fallback: number
): EffectSlider => ({
  key,
  label,
  min,
  max,
  step: 0.05,
  default: fallback,
  format: "percent",
});

const degrees = (
  key: string,
  label: string,
  min: number,
  max: number,
  fallback: number
): EffectSlider => ({
  key,
  label,
  min,
  max,
  step: 1,
  default: fallback,
  format: "deg",
});

export const EFFECT_CONTROLS: Record<AnimatedEffect, EffectControls> = {
  constellation: {
    ...SHARED,
    sliders: [multiplier("linkDistance", "Link distance", 0.5, 2)],
  },
  contours: {
    ...SHARED,
    sliders: [multiplier("spacing", "Line spacing", 0.5, 2)],
  },
  dust: { ...SHARED, sliders: [] },
  lightspeed: {
    ...SHARED,
    sizeLabel: "Density",
    sliders: [multiplier("length", "Streak length", 0.5, 3)],
  },
  matrix: {
    ...SHARED,
    sliders: [multiplier("trail", "Trail length", 0.5, 2)],
  },
  "mesh-gradient": {
    ...SHARED,
    palette: true,
    sliders: [percent("softness", "Softness", 0, 1, 0.5)],
  },
  "modern-grid": {
    ...SHARED,
    sizeLabel: "Grid size",
    sliders: [multiplier("dust", "Dust", 0, 2)],
  },
  "northern-lights": {
    ...SHARED,
    sliders: [percent("height", "Height", 0.2, 0.8, 0.5)],
  },
  rain: {
    ...SHARED,
    sizeLabel: "Density",
    sliders: [degrees("angle", "Angle", -45, 45, 12)],
  },
  scanlines: {
    ...SHARED,
    sizeLabel: "Line spacing",
    sliders: [percent("sweep", "Sweep", 0, 1, 0.5)],
  },
  silk: {
    ...SHARED,
    sliders: [percent("sheen", "Sheen", 0, 1, 0.6)],
  },
  snowfall: {
    ...SHARED,
    sliders: [multiplier("wind", "Wind", 0, 3)],
  },
  "spiral-galaxy": {
    ...SHARED,
    sliders: [degrees("tilt", "Tilt", 0, 80, 63)],
  },
  "warp-grid": {
    ...SHARED,
    sizeLabel: "Grid size",
    sliders: [multiplier("warp", "Warp", 0, 2)],
  },
};

/** Defaults for `effect`, overlaid with the valid, clamped numbers in `stored`. */
export function effectOptions(
  effect: AnimatedEffect,
  stored: unknown
): Record<string, number> {
  const saved =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  const out: Record<string, number> = {};
  for (const slider of EFFECT_CONTROLS[effect].sliders) {
    const value = saved[slider.key];
    out[slider.key] =
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(slider.max, Math.max(slider.min, value))
        : slider.default;
  }
  return out;
}
