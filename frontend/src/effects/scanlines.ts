import { createCanvasLoop, rgba, type EffectController } from "./shared";

export function createScanlinesEffect(
  canvas: HTMLCanvasElement
): EffectController {
  return createCanvasLoop(canvas, ({ ctx, width, height, accent, time }) => {
    ctx.clearRect(0, 0, width, height);

    const gap = 3;
    ctx.lineWidth = 1;
    for (let y = 0; y < height; y += gap) {
      const pulse = 0.04 + 0.03 * Math.sin(time * 1.5 + y * 0.05);
      ctx.strokeStyle = rgba(accent, pulse);
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }

    // Slow vertical sweep
    const sweepY = ((time * 40) % (height + 80)) - 40;
    const g = ctx.createLinearGradient(0, sweepY - 30, 0, sweepY + 30);
    g.addColorStop(0, rgba(accent, 0));
    g.addColorStop(0.5, rgba(accent, 0.12));
    g.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, sweepY - 30, width, 60);
  });
}
