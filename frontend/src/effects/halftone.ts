import { createFastNoise } from "./fastNoise";
import { BLACK, mixRgb } from "./palette";
import { createCanvasLoop, rgba, type EffectController } from "./shared";

/**
 * A halftone screen: a staggered grid of dots whose size follows a soft,
 * slowly moving field (drifting blobs crossed by a long, slow wave), like a
 * printed gradient that will not keep still.
 */

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function createHalftoneEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const field = createFastNoise();

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, size, isLight }) => {
      ctx.clearRect(0, 0, width, height);
      const gap = 22 * size;
      const rowGap = gap * 0.866;
      const maxR = gap * 0.4;
      const dots = new Path2D();
      for (let row = 0, y = gap * 0.5; y < height + gap; row++, y += rowGap) {
        // Every other row sits half a step over: the classic screen.
        const shift = row % 2 ? gap * 0.5 : 0;
        for (let x = shift; x < width + gap; x += gap) {
          const blobs = field.fbm(
            x * 0.0017 + time * 0.03,
            y * 0.0017 - time * 0.02,
            2
          );
          const wave =
            0.5 + 0.5 * Math.sin(x * 0.0055 + y * 0.003 - time * 0.4);
          const r = maxR * smoothstep(0.42, 0.8, blobs * 0.62 + wave * 0.38);
          if (r < 0.45) continue;
          dots.moveTo(x + r, y);
          dots.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = rgba(
        isLight ? mixRgb(accent, BLACK, 0.25) : accent,
        isLight ? 0.36 : 0.42
      );
      ctx.fill(dots);
    },
    { maxFps: 24 }
  );
}
