import { createCanvasLoop, rand, rgba, type EffectController, type Rgb } from "./shared";

interface Building {
  x: number;
  w: number;
  h: number;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Calm scrolling skyline — soft silhouettes, no flashing window lights. */
export function createCityscapeEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let buildings: Building[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  let scroll = 0;

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.max(14, Math.floor((w / 48) * size) + 10);
    buildings = [];
    let x = -40;
    for (let i = 0; i < count; i++) {
      const bw = rand(22, 58) * Math.sqrt(size);
      const bh = rand(h * 0.1, h * 0.38) * (0.75 + 0.25 * size);
      buildings.push({ x, w: bw, h: bh });
      x += bw + rand(6, 22);
    }
    while (x < w * 2.2) {
      const bw = rand(22, 58) * Math.sqrt(size);
      const bh = rand(h * 0.1, h * 0.38) * (0.75 + 0.25 * size);
      buildings.push({ x, w: bw, h: bh });
      x += bw + rand(6, 22);
    }
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, dt, size, isLight }) => {
      if (
        width !== lastW ||
        height !== lastH ||
        Math.abs(size - lastSize) > 0.05
      ) {
        lastW = width;
        lastH = height;
        lastSize = size;
        rebuild(width, height, size);
      }

      ctx.clearRect(0, 0, width, height);

      const skyTop = isLight
        ? mix(accent, [190, 215, 245], 0.75)
        : mix(accent, [12, 16, 28], 0.7);
      const skyBot = isLight
        ? mix(accent, [240, 230, 210], 0.55)
        : mix(accent, [18, 22, 36], 0.45);
      const sky = ctx.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, rgba(skyTop, isLight ? 0.18 : 0.3));
      sky.addColorStop(0.7, rgba(skyBot, isLight ? 0.1 : 0.18));
      sky.addColorStop(1, rgba(skyBot, 0));
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, height);

      // Slow, steady scroll — no flicker
      scroll += 8 * dt;
      const stripW =
        buildings.reduce((max, b) => Math.max(max, b.x + b.w), 0) || width;
      const offset = scroll % stripW;
      const groundY = height * 0.74;
      const far = isLight
        ? mix(accent, [90, 105, 130], 0.7)
        : mix(accent, [14, 18, 28], 0.8);
      const near = isLight
        ? mix(accent, [50, 60, 80], 0.75)
        : mix(accent, [6, 8, 14], 0.9);

      const drawStrip = (shift: number, color: Rgb, alpha: number, yScale: number) => {
        for (const b of buildings) {
          const bx = b.x - offset + shift;
          if (bx + b.w < -20 || bx > width + 20) continue;
          const bh = b.h * yScale;
          const by = groundY - bh;
          ctx.fillStyle = rgba(color, alpha);
          ctx.fillRect(bx, by, b.w, bh);
        }
      };

      // Two depth layers for a softer skyline
      drawStrip(0, far, isLight ? 0.22 : 0.35, 0.72);
      drawStrip(stripW * 0.35, far, isLight ? 0.18 : 0.28, 0.72);
      drawStrip(0, near, isLight ? 0.32 : 0.5, 1);
      drawStrip(stripW, near, isLight ? 0.32 : 0.5, 1);

      ctx.fillStyle = rgba(near, isLight ? 0.35 : 0.55);
      ctx.fillRect(0, groundY, width, height - groundY);
    }
  );
}
