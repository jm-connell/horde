import { createFastNoise } from "./fastNoise";
import { createCanvasLoop, rgba, type EffectController } from "./shared";

export function createWarpGridEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const field = createFastNoise();
  let points = new Float32Array(0);

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, size, options }) => {
      ctx.clearRect(0, 0, width, height);

      const spacing = Math.max(28, Math.min(48, Math.floor(width / 36))) * size;
      const amp = spacing * 0.7 * options.warp;
      // One cell beyond every edge, so the grid's own border never shows.
      const cols = Math.ceil(width / spacing) + 3;
      const rows = Math.ceil(height / spacing) + 3;
      if (points.length < cols * rows * 2) {
        points = new Float32Array(cols * rows * 2);
      }

      // Where each crossing has drifted to; both sets of lines share them.
      const drift = time * 0.08;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const i = (row * cols + col) * 2;
          const nx = field.fbm(col * 0.18 + drift, row * 0.18, 3);
          const ny = field.fbm(row * 0.18 + 31.7, col * 0.18 + drift + 57.3, 3);
          points[i] = (col - 1) * spacing + (nx - 0.5) * amp;
          points[i + 1] = (row - 1) * spacing + (ny - 0.5) * amp;
        }
      }

      ctx.strokeStyle = rgba(accent, 0.18);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const i = (row * cols + col) * 2;
          if (col === 0) ctx.moveTo(points[i], points[i + 1]);
          else ctx.lineTo(points[i], points[i + 1]);
        }
      }
      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const i = (row * cols + col) * 2;
          if (row === 0) ctx.moveTo(points[i], points[i + 1]);
          else ctx.lineTo(points[i], points[i + 1]);
        }
      }
      ctx.stroke();
    }
  );
}
