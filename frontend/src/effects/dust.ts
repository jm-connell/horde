import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Speck {
  x: number;
  y: number;
  r: number;
  speed: number;
  wobble: number;
  phase: number;
  alpha: number;
}

export function createDustEffect(canvas: HTMLCanvasElement): EffectController {
  let specks: Speck[] = [];
  let lastW = 0;
  let lastH = 0;

  let lastSize = 0;

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.floor(((w * h) / 9000) * size) + Math.floor(60 * size);
    specks = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: rand(0.5, 1.6) * Math.sqrt(size),
      speed: rand(8, 22),
      wobble: rand(6, 18),
      phase: Math.random() * Math.PI * 2,
      alpha: rand(0.15, 0.45),
    }));
  };

  return createCanvasLoop(canvas, ({ ctx, width, height, accent, dt, time, size }) => {
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
    for (const s of specks) {
      s.y -= s.speed * dt;
      s.x += Math.sin(time * 0.4 + s.phase) * s.wobble * dt;
      if (s.y < -4) {
        s.y = height + 4;
        s.x = Math.random() * width;
      }
      ctx.fillStyle = rgba(accent, s.alpha);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
