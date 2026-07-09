import { createCanvasLoop, rand, rgba, type EffectController, type Rgb } from "./shared";

interface Building {
  x: number;
  w: number;
  h: number;
  windows: { ox: number; oy: number; on: boolean; phase: number }[];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function createCityscapeEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let buildings: Building[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  let scroll = 0;

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.max(12, Math.floor((w / 55) * size) + 8);
    const ground = h * 0.72;
    buildings = [];
    let x = -40;
    for (let i = 0; i < count; i++) {
      const bw = rand(28, 70) * Math.sqrt(size);
      const bh = rand(h * 0.12, h * 0.45) * (0.7 + 0.3 * size);
      const windows: Building["windows"] = [];
      const cols = Math.max(2, Math.floor(bw / 10));
      const rows = Math.max(3, Math.floor(bh / 14));
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          windows.push({
            ox: 4 + col * (bw / cols),
            oy: 6 + row * (bh / rows),
            on: Math.random() > 0.35,
            phase: Math.random() * Math.PI * 2,
          });
        }
      }
      buildings.push({ x, w: bw, h: bh, windows });
      x += bw + rand(4, 18);
    }
    // Ensure strip is wider than viewport for seamless scroll
    while (x < w * 2) {
      const bw = rand(28, 70) * Math.sqrt(size);
      const bh = rand(h * 0.12, h * 0.45) * (0.7 + 0.3 * size);
      buildings.push({
        x,
        w: bw,
        h: bh,
        windows: Array.from(
          { length: Math.max(6, Math.floor((bw * bh) / 400)) },
          () => ({
            ox: rand(4, bw - 8),
            oy: rand(6, bh - 10),
            on: Math.random() > 0.35,
            phase: Math.random() * Math.PI * 2,
          })
        ),
      });
      x += bw + rand(4, 18);
    }
    void ground;
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, dt, time, size, isLight }) => {
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
        ? mix(accent, [180, 210, 255], 0.7)
        : mix(accent, [10, 14, 28], 0.65);
      const skyBot = isLight
        ? mix(accent, [255, 220, 180], 0.5)
        : mix(accent, [20, 24, 40], 0.4);
      const sky = ctx.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, rgba(skyTop, isLight ? 0.2 : 0.35));
      sky.addColorStop(0.65, rgba(skyBot, isLight ? 0.12 : 0.22));
      sky.addColorStop(1, rgba(skyBot, 0));
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, height);

      scroll += 18 * dt;
      const stripW =
        buildings.reduce((max, b) => Math.max(max, b.x + b.w), 0) || width;
      const offset = scroll % stripW;
      const groundY = height * 0.72;
      const silhouette = isLight
        ? mix(accent, [40, 50, 70], 0.75)
        : mix(accent, [8, 10, 16], 0.85);
      const windowOn = mix(accent, [255, 220, 120], 0.35);

      const drawStrip = (shift: number) => {
        for (const b of buildings) {
          const bx = b.x - offset + shift;
          if (bx + b.w < -20 || bx > width + 20) continue;
          const by = groundY - b.h;
          ctx.fillStyle = rgba(silhouette, isLight ? 0.35 : 0.55);
          ctx.fillRect(bx, by, b.w, b.h);
          for (const win of b.windows) {
            const lit =
              win.on &&
              (0.55 + 0.45 * Math.sin(time * 0.8 + win.phase)) > 0.35;
            if (!lit) continue;
            ctx.fillStyle = rgba(windowOn, isLight ? 0.35 : 0.55);
            ctx.fillRect(bx + win.ox, by + win.oy, 3, 4);
          }
        }
      };

      drawStrip(0);
      drawStrip(stripW);

      ctx.fillStyle = rgba(silhouette, isLight ? 0.4 : 0.65);
      ctx.fillRect(0, groundY, width, height - groundY);
    }
  );
}
