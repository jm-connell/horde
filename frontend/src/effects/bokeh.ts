import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Orb {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  alpha: number;
}

export function createBokehEffect(canvas: HTMLCanvasElement): EffectController {
  let orbs: Orb[] = [];
  let lastW = 0;
  let lastH = 0;

  const rebuild = (w: number, h: number) => {
    const count = Math.floor((w * h) / 45000) + 12;
    orbs = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: rand(30, 110),
      vx: rand(-8, 8),
      vy: rand(-6, 6),
      alpha: rand(0.08, 0.2),
    }));
  };

  return createCanvasLoop(canvas, ({ ctx, width, height, accent, dt }) => {
    if (width !== lastW || height !== lastH) {
      lastW = width;
      lastH = height;
      rebuild(width, height);
    }

    ctx.clearRect(0, 0, width, height);
    for (const o of orbs) {
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      if (o.x < -o.r) o.x = width + o.r;
      if (o.x > width + o.r) o.x = -o.r;
      if (o.y < -o.r) o.y = height + o.r;
      if (o.y > height + o.r) o.y = -o.r;

      const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
      g.addColorStop(0, rgba(accent, o.alpha));
      g.addColorStop(0.55, rgba(accent, o.alpha * 0.35));
      g.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
