import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Star {
  x: number;
  y: number;
  r: number;
  tw: number;
  phase: number;
  vx: number;
  vy: number;
}

export function createConstellationEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let stars: Star[] = [];
  let lastW = 0;
  let lastH = 0;

  const rebuild = (w: number, h: number) => {
    const count = Math.floor((w * h) / 14000) + 40;
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: rand(0.6, 1.8),
      tw: rand(0.4, 1.2),
      phase: Math.random() * Math.PI * 2,
      vx: rand(-8, 8),
      vy: rand(-6, 6),
    }));
  };

  return createCanvasLoop(canvas, ({ ctx, width, height, accent, time, dt }) => {
    if (width !== lastW || height !== lastH) {
      lastW = width;
      lastH = height;
      rebuild(width, height);
    }

    ctx.clearRect(0, 0, width, height);

    for (const s of stars) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      // Gentle course corrections so motion stays organic
      s.vx += Math.sin(time * 0.35 + s.phase) * 1.5 * dt;
      s.vy += Math.cos(time * 0.28 + s.phase * 1.3) * 1.2 * dt;
      const speed = Math.hypot(s.vx, s.vy);
      if (speed > 14) {
        s.vx = (s.vx / speed) * 14;
        s.vy = (s.vy / speed) * 14;
      }
      if (s.x < -20) s.x = width + 20;
      if (s.x > width + 20) s.x = -20;
      if (s.y < -20) s.y = height + 20;
      if (s.y > height + 20) s.y = -20;
    }

    const linkDist = Math.min(140, width * 0.12);

    for (let i = 0; i < stars.length; i++) {
      const a = stars[i];
      for (let j = i + 1; j < stars.length; j++) {
        const b = stars[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy);
        if (dist < linkDist) {
          ctx.strokeStyle = rgba(accent, (1 - dist / linkDist) * 0.22);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    for (const s of stars) {
      const pulse = 0.45 + 0.55 * Math.sin(time * s.tw + s.phase);
      ctx.fillStyle = rgba(accent, 0.25 + pulse * 0.55);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
