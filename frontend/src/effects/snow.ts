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

  const rebuild = (w: number, h: number) => {
    const count = Math.floor((w * h) / 11000) + 50;
    flakes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: rand(1, 3.2),
      speed: rand(18, 55),
      drift: rand(8, 28),
      phase: Math.random() * Math.PI * 2,
      alpha: rand(0.25, 0.7),
    }));
  };

  return createCanvasLoop(canvas, ({ ctx, width, height, accent, dt, time }) => {
    if (width !== lastW || height !== lastH) {
      lastW = width;
      lastH = height;
      rebuild(width, height);
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
  });
}
