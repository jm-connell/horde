import type { Rgb } from "./shared";

/** Hue in degrees (0–360), saturation and lightness 0–1. */
export type Hsl = [number, number, number];

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

export function hslToRgb([h, s, l]: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * The accent turned `degrees` round the hue wheel. Saturation and lightness
 * are kept unless given; a grey accent stays grey.
 */
export function shiftHue(
  rgb: Rgb,
  degrees: number,
  saturation?: number,
  lightness?: number
): Rgb {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([h + degrees, saturation ?? s, lightness ?? l]);
}

/**
 * The direction a second hue should turn from `rgb` so the pair reads as
 * cool light (toward blue and violet): warm accents turn back toward magenta,
 * cool ones forward toward violet.
 */
export function coolTurn(rgb: Rgb): 1 | -1 {
  const h = rgbToHsl(rgb)[0];
  return h >= 90 && h <= 270 ? 1 : -1;
}

/** 0–255 channels to 0–1, for WebGL uniforms. */
export function unit(rgb: Rgb): [number, number, number] {
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}

export const WHITE: Rgb = [255, 255, 255];
export const BLACK: Rgb = [0, 0, 0];
