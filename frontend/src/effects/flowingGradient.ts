import {
  createCanvasLoop,
  rgba,
  type EffectController,
  type Rgb,
} from "./shared";

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function createFlowingGradientEffect(
  canvas: HTMLCanvasElement
): EffectController {
  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, isLight }) => {
      ctx.clearRect(0, 0, width, height);

      const baseHue =
        (Math.atan2(accent[1] - accent[0], accent[2] - accent[0]) * 180) /
          Math.PI +
        180;
      const t = time * 28;
      const colors: Rgb[] = [
        mix(accent, hslToRgb(baseHue + t, 0.75, isLight ? 0.55 : 0.45), 0.55),
        hslToRgb(baseHue + 120 + t * 0.7, 0.7, isLight ? 0.5 : 0.4),
        hslToRgb(baseHue + 240 + t * 0.5, 0.65, isLight ? 0.48 : 0.38),
        mix(accent, hslToRgb(baseHue + 60 + t, 0.8, isLight ? 0.52 : 0.42), 0.4),
      ];

      const angle = time * 0.12;
      const cx = width * 0.5;
      const cy = height * 0.5;
      const dx = Math.cos(angle) * width;
      const dy = Math.sin(angle) * height;
      const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
      const alpha = isLight ? 0.22 : 0.32;
      g.addColorStop(0, rgba(colors[0], alpha));
      g.addColorStop(0.33, rgba(colors[1], alpha * 0.9));
      g.addColorStop(0.66, rgba(colors[2], alpha * 0.85));
      g.addColorStop(1, rgba(colors[3], alpha));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);

      // Soft secondary wash for keyboard-RGB depth
      const g2 = ctx.createRadialGradient(
        width * (0.3 + 0.2 * Math.sin(time * 0.2)),
        height * (0.4 + 0.15 * Math.cos(time * 0.17)),
        0,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.7
      );
      g2.addColorStop(0, rgba(colors[1], isLight ? 0.1 : 0.16));
      g2.addColorStop(1, rgba(colors[1], 0));
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, width, height);
    }
  );
}
