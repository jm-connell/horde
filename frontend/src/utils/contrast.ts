/** WCAG 2.x relative luminance / contrast helpers (sRGB, 0-255 channels). */

export type Rgb = [number, number, number];

export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x
  );
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Muted-text colour for a custom theme: the smallest step from `surface`
 * towards black or white (whichever contrasts more) that reaches `min`
 * against every given surface.
 */
export function mutedTextFor(
  surfaces: readonly Rgb[],
  base: Rgb,
  min = 4.6
): Rgb {
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];
  const target =
    contrastRatio(white, base) >= contrastRatio(black, base) ? white : black;
  for (let step = 0; step <= 100; step += 1) {
    const t = step / 100;
    const c = base.map((v, i) => Math.round(v + (target[i] - v) * t)) as Rgb;
    if (surfaces.every((s) => contrastRatio(c, s) >= min)) return c;
  }
  return target;
}
