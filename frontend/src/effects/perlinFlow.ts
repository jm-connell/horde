import { fbm2 } from "./noise";
import { createCanvasLoop, rand, rgba, type EffectController } from "./shared";

interface Particle {
  x: number;
  y: number;
  px: number;
  py: number;
  life: number;
  maxLife: number;
  radius: number;
}

export function createPerlinFlowEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let particles: Particle[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  const seed = Math.floor(Math.random() * 1000);

  const spawn = (w: number, h: number, size: number): Particle => {
    // Short lives so trails clear quickly instead of filling the canvas.
    const maxLife = rand(0.7, 1.6);
    const x = Math.random() * w;
    const y = Math.random() * h;
    return {
      x,
      y,
      px: x,
      py: y,
      life: Math.random() * maxLife,
      maxLife,
      radius: rand(1.1, 2.4) * size,
    };
  };

  const rebuild = (w: number, h: number, size: number) => {
    // Mild density scaling — size mainly drives stroke radius / visibility.
    const density = 0.65 + 0.35 * size;
    const count =
      Math.floor(((w * h) / 6500) * density) + Math.floor(90 * density);
    particles = Array.from({ length: count }, () => spawn(w, h, size));
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

    // Aggressive trail fade — trails disappear quickly
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";

    const scale = 0.0022;
    // Mid size (~1x) reads clearly; larger size boosts alpha further.
    const visibility = 0.55 + 0.35 * Math.min(size, 1.5);
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
        Object.assign(p, spawn(width, height, size));
        continue;
      }

      const t = p.life / p.maxLife;
      const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      ctx.strokeStyle = rgba(accent, alpha * visibility);
      ctx.lineWidth = p.radius;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  });
}
