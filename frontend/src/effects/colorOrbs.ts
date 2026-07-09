import { createCanvasLoop, rand, rgba, type EffectController, type Rgb } from "./shared";

interface ColorOrb {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  hueShift: number;
  alpha: number;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function shiftHue(rgb: Rgb, amount: number): Rgb {
  const palette: Rgb[] = [
    rgb,
    mix(rgb, [255, 80, 160], 0.55),
    mix(rgb, [80, 120, 255], 0.55),
    mix(rgb, [40, 220, 160], 0.5),
    mix(rgb, [255, 180, 60], 0.45),
  ];
  const i = Math.floor(((amount % 1) + 1) % 1 * palette.length);
  return palette[i] ?? rgb;
}

export function createColorOrbsEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let orbs: ColorOrb[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.max(4, Math.floor(5 * size) + 2);
    orbs = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: rand(80, 220) * size,
      vx: rand(-18, 18),
      vy: rand(-14, 14),
      hueShift: Math.random(),
      alpha: rand(0.12, 0.28),
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
      for (const o of orbs) {
        o.x += o.vx * dt;
        o.y += o.vy * dt;
        if (o.x < -o.r) o.x = width + o.r;
        if (o.x > width + o.r) o.x = -o.r;
        if (o.y < -o.r) o.y = height + o.r;
        if (o.y > height + o.r) o.y = -o.r;

        const color = shiftHue(accent, o.hueShift);
        const a = isLight ? o.alpha * 0.75 : o.alpha;
        const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
        g.addColorStop(0, rgba(color, a));
        g.addColorStop(0.45, rgba(color, a * 0.4));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  );
}
