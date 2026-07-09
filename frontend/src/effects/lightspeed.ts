import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Streak {
  angle: number;
  dist: number;
  speed: number;
  length: number;
  width: number;
  alpha: number;
}

export function createLightspeedEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let streaks: Streak[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.floor(70 * size) + 30;
    const maxDist = Math.hypot(w, h) * 0.55;
    streaks = Array.from({ length: count }, () => ({
      angle: Math.random() * Math.PI * 2,
      dist: rand(20, maxDist),
      speed: rand(40, 140),
      length: rand(12, 48) * size,
      width: rand(0.6, 1.8) * Math.sqrt(size),
      alpha: rand(0.15, 0.45),
    }));
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
      const cx = width * 0.5;
      const cy = height * 0.5;
      const maxDist = Math.hypot(width, height) * 0.55;

      for (const s of streaks) {
        s.dist += s.speed * dt;
        if (s.dist > maxDist) {
          s.dist = rand(8, 40);
          s.angle = Math.random() * Math.PI * 2;
          s.speed = rand(40, 140);
          s.alpha = rand(0.15, 0.45);
        }

        const cos = Math.cos(s.angle);
        const sin = Math.sin(s.angle);
        const x1 = cx + cos * s.dist;
        const y1 = cy + sin * s.dist;
        const x0 = cx + cos * Math.max(0, s.dist - s.length);
        const y0 = cy + sin * Math.max(0, s.dist - s.length);
        const fade = Math.min(1, s.dist / (maxDist * 0.35));

        ctx.strokeStyle = rgba(
          accent,
          s.alpha * fade * (isLight ? 0.7 : 1)
        );
        ctx.lineWidth = s.width;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  );
}
