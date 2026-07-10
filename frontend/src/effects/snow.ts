import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Flake {
  x: number;
  y: number;
  r: number;
  speed: number;
  drift: number;
  phase: number;
  alpha: number;
}

export function createSnowEffect(canvas: HTMLCanvasElement): EffectController {
  let flakes: Flake[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;

  const rebuild = (w: number, h: number, size: number) => {
    // Mild density scaling — size mainly drives flake radius.
    const density = 0.7 + 0.3 * size;
    const count =
      Math.floor(((w * h) / 11000) * density) + Math.floor(50 * density);
    flakes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: rand(1.2, 3.6) * size,
      speed: rand(18, 55),
      drift: rand(8, 28),
      phase: Math.random() * Math.PI * 2,
      alpha: rand(0.3, 0.78),
    }));
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, dt, time, size }) => {
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
      for (const f of flakes) {
        f.y += f.speed * dt;
        f.x += Math.sin(time * 0.6 + f.phase) * f.drift * dt;
        if (f.y > height + 4) {
          f.y = -4;
          f.x = Math.random() * width;
        }
        if (f.x < -4) f.x = width + 4;
        if (f.x > width + 4) f.x = -4;
        ctx.fillStyle = rgba(accent, f.alpha);
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  );
}
