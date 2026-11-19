import { rgba, type Rgb } from "./shared";

/** How a glow sprite falls off from its middle. */
export type GlowShape = "soft" | "core" | "disc";

const STOPS: Record<GlowShape, [number, number][]> = {
  // A wide, even bloom (bokeh, nebula clouds).
  soft: [
    [0, 1],
    [0.3, 0.6],
    [0.65, 0.18],
    [1, 0],
  ],
  // A bright point inside a faint halo (stars, fireflies, motes).
  core: [
    [0, 1],
    [0.1, 0.85],
    [0.24, 0.32],
    [0.5, 0.08],
    [1, 0],
  ],
  // An out-of-focus disc with a soft rim (near snowflakes).
  disc: [
    [0, 0.85],
    [0.62, 0.7],
    [0.82, 0.32],
    [1, 0],
  ],
};

/**
 * A round glow drawn once into its own canvas, so a frame stamps it with
 * `drawImage` instead of building a radial gradient per particle. Glows are
 * smooth, so one 64 px sprite scales to any size.
 */
export function glowSprite(
  rgb: Rgb,
  shape: GlowShape = "soft"
): HTMLCanvasElement {
  const size = 64;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext("2d");
  if (!ctx) return sprite;
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  for (const [at, alpha] of STOPS[shape]) g.addColorStop(at, rgba(rgb, alpha));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return sprite;
}

/**
 * Remembers sprites by color and shape, so an accent change rebuilds them
 * once instead of every frame.
 */
export function createSpriteCache() {
  const cache = new Map<string, HTMLCanvasElement>();
  return (rgb: Rgb, shape: GlowShape = "soft"): HTMLCanvasElement => {
    const key = `${rgb[0]},${rgb[1]},${rgb[2]}:${shape}`;
    let sprite = cache.get(key);
    if (!sprite) {
      // A handful of colors per effect; drop old ones after a few theme changes.
      if (cache.size > 24) cache.clear();
      sprite = glowSprite(rgb, shape);
      cache.set(key, sprite);
    }
    return sprite;
  };
}
