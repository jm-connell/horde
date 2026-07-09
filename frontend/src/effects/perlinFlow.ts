import { fbm2 } from "./noise";
import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Particle {
  x: number;
  y: number;
  px: number;
  py: number;
  life: number;
  maxLife: number;
}

export function createPerlinFlowEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let particles: Particle[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  const seed = Math.floor(Math.random() * 1000);

  const spawn = (w: number, h: number): Particle => {
    const maxLife = rand(2.5, 6);
    const x = Math.random() * w;
    const y = Math.random() * h;
    return { x, y, px: x, py: y, life: Math.random() * maxLife, maxLife };
  };

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.floor(((w * h) / 6500) * size) + Math.floor(90 * size);
    particles = Array.from({ length: count }, () => spawn(w, h));
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

    // Soft trail fade that works on a transparent canvas
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";

    const scale = 0.0022;
    for (const p of particles) {
      p.px = p.x;
      p.py = p.y;
      const angle =
        fbm2(p.x * scale, p.y * scale + time * 0.05, 3, seed) * Math.PI * 4;
      const speed = 28 + fbm2(p.y * scale, p.x * scale, 2, seed + 3) * 55;
      p.x += Math.cos(angle) * speed * dt;
      p.y += Math.sin(angle) * speed * dt;
      p.life += dt;

      if (
        p.life > p.maxLife ||
        p.x < -20 ||
        p.y < -20 ||
        p.x > width + 20 ||
        p.y > height + 20
      ) {
        Object.assign(p, spawn(width, height));
        continue;
      }

      const t = p.life / p.maxLife;
      const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      ctx.strokeStyle = rgba(accent, alpha * 0.55);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  });
}
