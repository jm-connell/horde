import { fbm2 } from "./noise";
import { createCanvasLoop, rgba, type EffectController } from "./shared";

export function createWarpGridEffect(
  canvas: HTMLCanvasElement
): EffectController {
  return createCanvasLoop(canvas, ({ ctx, width, height, accent, time }) => {
    ctx.clearRect(0, 0, width, height);

    const spacing = Math.max(28, Math.min(48, Math.floor(width / 36)));
    const amp = spacing * 0.35;
    const cols = Math.ceil(width / spacing) + 2;
    const rows = Math.ceil(height / spacing) + 2;

    ctx.strokeStyle = rgba(accent, 0.18);
    ctx.lineWidth = 1;

    for (let row = 0; row < rows; row++) {
      ctx.beginPath();
      for (let col = 0; col < cols; col++) {
        const bx = col * spacing;
        const by = row * spacing;
        const n = fbm2(col * 0.18 + time * 0.08, row * 0.18, 3, 2);
        const x = bx + (n - 0.5) * amp * 2;
        const y = by + (fbm2(row * 0.18, col * 0.18 + time * 0.08, 3, 9) - 0.5) * amp * 2;
        if (col === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    for (let col = 0; col < cols; col++) {
      ctx.beginPath();
      for (let row = 0; row < rows; row++) {
        const bx = col * spacing;
        const by = row * spacing;
        const n = fbm2(col * 0.18 + time * 0.08, row * 0.18, 3, 2);
        const x = bx + (n - 0.5) * amp * 2;
        const y = by + (fbm2(row * 0.18, col * 0.18 + time * 0.08, 3, 9) - 0.5) * amp * 2;
        if (row === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
}
