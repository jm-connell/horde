import { createCanvasLoop, rand, rgba, type EffectController, type Rgb } from "./shared";

interface Star {
  x: number;
  y: number;
  r: number;
  tw: number;
  phase: number;
  brightness: number;
}

interface Nebula {
  x: number;
  y: number;
  radius: number;
  hueShift: number;
  alpha: number;
  phase: number;
}

function shiftAccent(accent: Rgb, amount: number): Rgb {
  return [
    Math.min(255, Math.max(0, accent[0] + amount)),
    Math.min(255, Math.max(0, accent[1] + amount * 0.6)),
    Math.min(255, Math.max(0, accent[2] - amount * 0.4)),
  ];
}

export function createGalaxyEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let stars: Star[] = [];
  let nebulas: Nebula[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  let rotation = 0;

  const rebuild = (w: number, h: number, size: number) => {
    const area = w * h;
    const starCount =
      Math.floor((area / 9000) * size) + Math.floor(80 * size);
    stars = Array.from({ length: starCount }, () => ({
      x: (Math.random() - 0.5) * w * 1.4,
      y: (Math.random() - 0.5) * h * 1.4,
      r: rand(0.4, 1.6) * Math.sqrt(size),
      tw: rand(0.3, 1.4),
      phase: Math.random() * Math.PI * 2,
      brightness: rand(0.35, 1),
    }));

    const nebulaCount = Math.max(3, Math.floor(5 * size));
    nebulas = Array.from({ length: nebulaCount }, () => ({
      x: (Math.random() - 0.5) * w * 0.7,
      y: (Math.random() - 0.5) * h * 0.55,
      radius: rand(Math.min(w, h) * 0.18, Math.min(w, h) * 0.42) * size,
      hueShift: rand(-60, 80),
      alpha: rand(0.06, 0.14),
      phase: Math.random() * Math.PI * 2,
    }));
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, dt, size, isLight }) => {
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

      rotation += dt * 0.035;
      ctx.clearRect(0, 0, width, height);

      const cx = width * 0.5;
      const cy = height * 0.52;
      const lightMul = isLight ? 0.55 : 1;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);

      for (const n of nebulas) {
        const pulse = 0.85 + 0.15 * Math.sin(time * 0.25 + n.phase);
        const color = shiftAccent(accent, n.hueShift);
        const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.radius);
        grad.addColorStop(0, rgba(color, n.alpha * pulse * lightMul));
        grad.addColorStop(0.45, rgba(color, n.alpha * 0.45 * pulse * lightMul));
        grad.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Soft galactic core
      const coreR = Math.min(width, height) * 0.22 * size;
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
      core.addColorStop(0, rgba(accent, 0.18 * lightMul));
      core.addColorStop(0.5, rgba(shiftAccent(accent, 40), 0.08 * lightMul));
      core.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, coreR, 0, Math.PI * 2);
      ctx.fill();

      for (const s of stars) {
        const pulse = 0.4 + 0.6 * Math.sin(time * s.tw + s.phase);
        ctx.fillStyle = rgba(
          accent,
          (0.2 + pulse * 0.55) * s.brightness * lightMul
        );
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  );
}
