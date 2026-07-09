import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Firefly {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  speed: number;
  size: number;
}

export function createFirefliesEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let bugs: Firefly[] = [];
  let lastW = 0;
  let lastH = 0;

  let lastSize = 0;

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.floor(((w * h) / 28000) * size) + Math.floor(18 * size);
    bugs = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: rand(-12, 12),
      vy: rand(-10, 10),
      phase: Math.random() * Math.PI * 2,
      speed: rand(0.6, 1.4),
      size: rand(1.5, 3) * Math.sqrt(size),
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
    for (const b of bugs) {
      b.vx += Math.sin(time * b.speed + b.phase) * 8 * dt;
      b.vy += Math.cos(time * b.speed * 0.8 + b.phase) * 8 * dt;
      b.vx *= 0.98;
      b.vy *= 0.98;
      b.x += b.vx * dt * 8;
      b.y += b.vy * dt * 8;

      if (b.x < 0) b.x = width;
      if (b.x > width) b.x = 0;
      if (b.y < 0) b.y = height;
      if (b.y > height) b.y = 0;

      const glow = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(time * b.speed * 2 + b.phase));
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.size * 6);
      g.addColorStop(0, rgba(accent, glow * 0.7));
      g.addColorStop(0.35, rgba(accent, glow * 0.25));
      g.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.size * 6, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
