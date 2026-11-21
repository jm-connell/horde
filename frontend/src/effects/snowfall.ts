import { createFastNoise } from "./fastNoise";
import { BLACK, WHITE, mixRgb } from "./palette";
import {
  createCanvasLoop,
  rand,
  resizePool,
  rgba,
  type EffectController,
} from "./shared";
import { createSpriteCache } from "./sprites";

/**
 * Snow in three depths that agree with each other: far flakes are fine,
 * slow and faint, near ones large, quick and out of focus. One gusting wind
 * moves them all, the near ones most.
 */

interface Flake {
  x: number;
  y: number;
  r: number;
  fall: number;
  sway: number;
  rate: number;
  phase: number;
  alpha: number;
}

const LAYERS = [
  {
    share: 0.56,
    r: [0.5, 1.1],
    fall: [12, 22],
    alpha: [0.28, 0.5],
    wind: 0.35,
  },
  {
    share: 0.31,
    r: [1.2, 2.2],
    fall: [26, 42],
    alpha: [0.42, 0.72],
    wind: 0.65,
  },
  { share: 0.13, r: [3.5, 7], fall: [55, 85], alpha: [0.14, 0.28], wind: 1 },
] as const;

export function createSnowfallEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const flakes: Flake[][] = LAYERS.map(() => []);
  let lastW = 0;
  let lastH = 0;
  const gusts = createFastNoise();
  const sprite = createSpriteCache();

  /** `r` is the radius at Size 1; the frame scales it. */
  const spawn = (w: number, h: number, layer: number): Flake => {
    const l = LAYERS[layer];
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r: rand(l.r[0], l.r[1]),
      fall: rand(l.fall[0], l.fall[1]),
      sway: rand(4, 14) * (0.5 + layer * 0.5),
      rate: rand(0.4, 1.1),
      phase: Math.random() * Math.PI * 2,
      alpha: rand(l.alpha[0], l.alpha[1]),
    };
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, dt, size, options, isLight }) => {
      if (lastW > 0 && lastH > 0 && (width !== lastW || height !== lastH)) {
        // Spread the snow over the new window instead of redealing it.
        for (const list of flakes) {
          for (const f of list) {
            f.x *= width / lastW;
            f.y *= height / lastH;
          }
        }
      }
      lastW = width;
      lastH = height;
      const count =
        Math.round(((width * height) / 7000) * (0.7 + 0.3 * size)) + 60;
      for (let layer = 0; layer < LAYERS.length; layer++) {
        resizePool(flakes[layer], Math.round(count * LAYERS[layer].share), () =>
          spawn(width, height, layer)
        );
      }
      ctx.clearRect(0, 0, width, height);

      // A steady breeze with gusts either way.
      const wind =
        (8 + (gusts.fbm(time * 0.06, 3.7, 3) - 0.5) * 110) * options.wind;
      const color = isLight
        ? mixRgb(accent, BLACK, 0.35)
        : mixRgb(accent, WHITE, 0.72);
      // The near flakes grow fastest with Size.
      const scales = [Math.sqrt(size), Math.sqrt(size), size];

      for (let layer = 0; layer < LAYERS.length; layer++) {
        const push = wind * LAYERS[layer].wind;
        const scale = scales[layer];
        for (const f of flakes[layer]) {
          const r = f.r * scale;
          f.y += f.fall * dt;
          f.x += (push + Math.cos(time * f.rate + f.phase) * f.sway) * dt;
          if (f.y > height + r * 2) {
            // Back to just above the top, somewhere new.
            f.y = -r * 2 - Math.random() * 40;
            f.x = Math.random() * width;
          } else if (f.x < -r * 3) f.x += width + r * 6;
          else if (f.x > width + r * 3) f.x -= width + r * 6;
        }
      }

      // Far: tiny squares. Mid: round flakes. Near: soft discs.
      ctx.fillStyle = rgba(color, 1);
      for (const f of flakes[0]) {
        const r = f.r * scales[0];
        ctx.globalAlpha = f.alpha;
        ctx.fillRect(f.x, f.y, r * 2, r * 2);
      }
      for (const f of flakes[1]) {
        ctx.globalAlpha = f.alpha;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r * scales[1], 0, Math.PI * 2);
        ctx.fill();
      }
      const disc = sprite(color, "disc");
      for (const f of flakes[2]) {
        const r = f.r * scales[2];
        ctx.globalAlpha = f.alpha;
        ctx.drawImage(disc, f.x - r, f.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
    }
  );
}
