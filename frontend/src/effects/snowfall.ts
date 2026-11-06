import { createFastNoise } from "./fastNoise";
import { BLACK, WHITE, mixRgb } from "./palette";
import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";
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
  layer: number;
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
  let flakes: Flake[][] = [[], [], []];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  const gusts = createFastNoise();
  const sprite = createSpriteCache();

  const spawn = (
    w: number,
    h: number,
    layer: number,
    size: number,
    anywhere: boolean
  ): Flake => {
    const l = LAYERS[layer];
    const r = rand(l.r[0], l.r[1]) * (layer === 2 ? size : Math.sqrt(size));
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : -r * 2 - Math.random() * 40,
      r,
      fall: rand(l.fall[0], l.fall[1]),
      sway: rand(4, 14) * (0.5 + layer * 0.5),
      rate: rand(0.4, 1.1),
      phase: Math.random() * Math.PI * 2,
      alpha: rand(l.alpha[0], l.alpha[1]),
      layer,
    };
  };

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.round(((w * h) / 7000) * (0.7 + 0.3 * size)) + 60;
    flakes = LAYERS.map((l, i) =>
      Array.from({ length: Math.round(count * l.share) }, () =>
        spawn(w, h, i, size, true)
      )
    );
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, dt, size, isLight }) => {
      if (
        Math.abs(width - lastW) > 8 ||
        Math.abs(height - lastH) > 8 ||
        Math.abs(size - lastSize) > 0.05
      ) {
        lastW = width;
        lastH = height;
        lastSize = size;
        rebuild(width, height, size);
      }
      ctx.clearRect(0, 0, width, height);

      // A steady breeze with gusts either way.
      const wind = 8 + (gusts.fbm(time * 0.06, 3.7, 3) - 0.5) * 110;
      const color = isLight
        ? mixRgb(accent, BLACK, 0.35)
        : mixRgb(accent, WHITE, 0.72);

      for (let layer = 0; layer < LAYERS.length; layer++) {
        const push = wind * LAYERS[layer].wind;
        const list = flakes[layer];
        for (let i = 0; i < list.length; i++) {
          const f = list[i];
          f.y += f.fall * dt;
          f.x += (push + Math.cos(time * f.rate + f.phase) * f.sway) * dt;
          if (f.y > height + f.r * 2)
            list[i] = spawn(width, height, layer, size, false);
          else if (f.x < -f.r * 3) f.x += width + f.r * 6;
          else if (f.x > width + f.r * 3) f.x -= width + f.r * 6;
        }
      }

      // Far: tiny squares. Mid: round flakes. Near: soft discs.
      ctx.fillStyle = rgba(color, 1);
      for (const f of flakes[0]) {
        ctx.globalAlpha = f.alpha;
        ctx.fillRect(f.x, f.y, f.r * 2, f.r * 2);
      }
      for (const f of flakes[1]) {
        ctx.globalAlpha = f.alpha;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
      const disc = sprite(color, "disc");
      for (const f of flakes[2]) {
        ctx.globalAlpha = f.alpha;
        ctx.drawImage(disc, f.x - f.r, f.y - f.r, f.r * 2, f.r * 2);
      }
      ctx.globalAlpha = 1;
    }
  );
}
