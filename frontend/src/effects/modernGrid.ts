import {
  createCanvasLoop,
  rand,
  rgba,
  type EffectController,
  type Rgb,
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

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function createModernGridEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let specks: Speck[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.floor(((w * h) / 14000) * size) + Math.floor(40 * size);
    specks = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: rand(0.4, 1.4) * Math.sqrt(size),
      speed: rand(6, 16),
      wobble: rand(4, 12),
      phase: Math.random() * Math.PI * 2,
      alpha: rand(0.12, 0.35),
    }));
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, dt, time, size, isLight }) => {
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

      const secondary = isLight
        ? mix(accent, [255, 255, 255], 0.4)
        : mix(accent, [80, 60, 200], 0.5);
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, rgba(accent, isLight ? 0.12 : 0.18));
      g.addColorStop(
        0.5 + 0.08 * Math.sin(time * 0.15),
        rgba(secondary, isLight ? 0.08 : 0.12)
      );
      g.addColorStop(1, rgba(accent, isLight ? 0.06 : 0.1));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);

      const spacing = Math.max(28, 48 / size);
      const offset = (time * 8) % spacing;
      ctx.strokeStyle = rgba(accent, isLight ? 0.08 : 0.12);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = -spacing + offset; x < width + spacing; x += spacing) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = -spacing + offset * 0.6; y < height + spacing; y += spacing) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();

      for (const s of specks) {
        s.y -= s.speed * dt;
        s.x += Math.sin(time * 0.35 + s.phase) * s.wobble * dt;
        if (s.y < -4) {
          s.y = height + 4;
          s.x = Math.random() * width;
        }
        ctx.fillStyle = rgba(accent, s.alpha);
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  );
}
