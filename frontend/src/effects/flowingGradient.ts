import {
  createCanvasLoop,
  rgba,
  type EffectController,
  type Rgb,
} from "./shared";

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
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

interface Blob {
  hueOffset: number;
  speed: number;
  phaseX: number;
  phaseY: number;
  orbitX: number;
  orbitY: number;
  radius: number;
  lightness: number;
}

export function createFlowingGradientEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const blobs: Blob[] = [
    {
      hueOffset: 0,
      speed: 0.18,
      phaseX: 0.2,
      phaseY: 1.1,
      orbitX: 0.22,
      orbitY: 0.18,
      radius: 0.72,
      lightness: 0.45,
    },
    {
      hueOffset: 120,
      speed: 0.14,
      phaseX: 2.4,
      phaseY: 0.6,
      orbitX: 0.28,
      orbitY: 0.24,
      radius: 0.85,
      lightness: 0.4,
    },
    {
      hueOffset: 240,
      speed: 0.11,
      phaseX: 4.1,
      phaseY: 3.2,
      orbitX: 0.2,
      orbitY: 0.26,
      radius: 0.78,
      lightness: 0.42,
    },
  ];

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, isLight, size }) => {
      ctx.clearRect(0, 0, width, height);

      const baseHue =
        (Math.atan2(accent[1] - accent[0], accent[2] - accent[0]) * 180) /
          Math.PI +
        180;
      const maxDim = Math.max(width, height);
      const alpha = isLight ? 0.2 : 0.28;

      for (const blob of blobs) {
        const cx =
          width *
          (0.5 +
            Math.sin(time * blob.speed + blob.phaseX) * blob.orbitX * size);
        const cy =
          height *
          (0.5 +
            Math.cos(time * blob.speed * 0.85 + blob.phaseY) *
              blob.orbitY *
              size);
        const radius = maxDim * blob.radius * (0.75 + 0.35 * size);
        const color = mix(
          accent,
          hslToRgb(
            baseHue + blob.hueOffset + time * 8,
            0.72,
            isLight ? blob.lightness + 0.1 : blob.lightness
          ),
          0.45
        );

        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        g.addColorStop(0, rgba(color, alpha));
        g.addColorStop(0.45, rgba(color, alpha * 0.45));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }
    }
  );
}
