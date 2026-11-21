import {
  createCanvasLoop,
  rand,
  resizePool,
  rgba,
  type EffectController,
} from "./shared";

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
  const specks: Speck[] = [];
  let lastW = 0;
  let lastH = 0;

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, dt, time, size }) => {
      if (lastW > 0 && lastH > 0 && (width !== lastW || height !== lastH)) {
        // Spread the motes over the new window instead of leaving them
        // bunched in the old one.
        for (const s of specks) {
          s.x *= width / lastW;
          s.y *= height / lastH;
        }
      }
      lastW = width;
      lastH = height;
      resizePool(
        specks,
        Math.floor(((width * height) / 9000 + 60) * size),
        () => ({
          x: Math.random() * width,
          y: Math.random() * height,
          r: rand(0.5, 1.6),
          speed: rand(8, 22),
          wobble: rand(6, 18),
          phase: Math.random() * Math.PI * 2,
          alpha: rand(0.15, 0.45),
        })
      );

      ctx.clearRect(0, 0, width, height);
      const scale = Math.sqrt(size);
      ctx.fillStyle = rgba(accent, 1);
      for (const s of specks) {
        s.y -= s.speed * dt;
        s.x += Math.sin(time * 0.4 + s.phase) * s.wobble * dt;
        if (s.y < -4) {
          s.y = height + 4;
          s.x = Math.random() * width;
        }
        ctx.globalAlpha = s.alpha;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  );
}
