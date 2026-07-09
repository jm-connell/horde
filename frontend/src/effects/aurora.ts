import { createCanvasLoop, rgba, type EffectController, type Rgb } from "./shared";

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function createAuroraEffect(canvas: HTMLCanvasElement): EffectController {
  return createCanvasLoop(canvas, ({ ctx, width, height, accent, time, isLight }) => {
    ctx.clearRect(0, 0, width, height);

    const secondary: Rgb = isLight
      ? mix(accent, [255, 255, 255], 0.35)
      : mix(accent, [120, 80, 255], 0.45);
    const tertiary: Rgb = isLight
      ? mix(accent, [200, 220, 255], 0.5)
      : mix(accent, [40, 200, 160], 0.4);

    const blobs = [
      {
        x: width * (0.3 + 0.15 * Math.sin(time * 0.18)),
        y: height * (0.35 + 0.12 * Math.cos(time * 0.14)),
        r: Math.max(width, height) * 0.45,
        color: accent,
      },
      {
        x: width * (0.7 + 0.12 * Math.cos(time * 0.16)),
        y: height * (0.55 + 0.1 * Math.sin(time * 0.2)),
        r: Math.max(width, height) * 0.4,
        color: secondary,
      },
      {
        x: width * (0.5 + 0.18 * Math.sin(time * 0.12 + 1)),
        y: height * (0.7 + 0.08 * Math.cos(time * 0.17 + 2)),
        r: Math.max(width, height) * 0.38,
        color: tertiary,
      },
    ];

    for (const b of blobs) {
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, rgba(b.color, isLight ? 0.28 : 0.35));
      g.addColorStop(0.45, rgba(b.color, isLight ? 0.12 : 0.16));
      g.addColorStop(1, rgba(b.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
