import { createCanvasLoop, rgba, type EffectController } from "./shared";

export function createScanlinesEffect(
  canvas: HTMLCanvasElement
): EffectController {
  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, size, options }) => {
      ctx.clearRect(0, 0, width, height);

      // Whole pixels, so every line is as crisp as the next.
      const gap = Math.max(2, Math.round(3 * size));
      const thickness = Math.max(1, Math.round(gap / 3));
      ctx.fillStyle = rgba(accent, 1);
      for (let y = 0; y < height; y += gap) {
        ctx.globalAlpha = 0.04 + 0.03 * Math.sin(time * 1.5 + y * 0.05);
        ctx.fillRect(0, y, width, thickness);
      }
      ctx.globalAlpha = 1;

      // A soft band sweeping slowly down; it starts and ends off screen.
      if (options.sweep <= 0) return;
      const sweepY = ((time * 40) % (height + 80)) - 40;
      const g = ctx.createLinearGradient(0, sweepY - 30, 0, sweepY + 30);
      g.addColorStop(0, rgba(accent, 0));
      g.addColorStop(0.5, rgba(accent, 0.24 * options.sweep));
      g.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, sweepY - 30, width, 60);
    }
  );
}
