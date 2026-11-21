import { mixRgb } from "./palette";
import {
  createCanvasLoop,
  rand,
  resizePool,
  rgba,
  type EffectController,
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

/** Grid drift in px/s: across, and down. */
const DRIFT_X = 8;
const DRIFT_Y = 4.8;

/**
 * How far the grid has slid at `time`, per axis, each within one cell. The
 * axes drift at different rates, so each wraps on its own: a line is only
 * ever replaced by the next one arriving exactly where it was.
 */
export function gridOffsets(time: number, spacing: number): [number, number] {
  return [(time * DRIFT_X) % spacing, (time * DRIFT_Y) % spacing];
}

export function createModernGridEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const specks: Speck[] = [];
  let lastW = 0;
  let lastH = 0;

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, dt, time, size, options, isLight }) => {
      if (lastW > 0 && lastH > 0 && (width !== lastW || height !== lastH)) {
        // Spread the dust over the new window instead of leaving it bunched.
        for (const s of specks) {
          s.x *= width / lastW;
          s.y *= height / lastH;
        }
      }
      lastW = width;
      lastH = height;
      resizePool(
        specks,
        Math.round(((width * height) / 14000 + 40) * options.dust),
        () => ({
          x: Math.random() * width,
          y: Math.random() * height,
          r: rand(0.4, 1.4),
          speed: rand(6, 16),
          wobble: rand(4, 12),
          phase: Math.random() * Math.PI * 2,
          alpha: rand(0.12, 0.35),
        })
      );

      ctx.clearRect(0, 0, width, height);

      const secondary = isLight
        ? mixRgb(accent, [255, 255, 255], 0.4)
        : mixRgb(accent, [80, 60, 200], 0.5);
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, rgba(accent, isLight ? 0.12 : 0.18));
      g.addColorStop(
        0.5 + 0.08 * Math.sin(time * 0.15),
        rgba(secondary, isLight ? 0.08 : 0.12)
      );
      g.addColorStop(1, rgba(accent, isLight ? 0.06 : 0.1));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);

      const spacing = 48 * size;
      const [offsetX, offsetY] = gridOffsets(time, spacing);
      ctx.strokeStyle = rgba(accent, isLight ? 0.08 : 0.12);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = offsetX - spacing; x < width + spacing; x += spacing) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = offsetY - spacing; y < height + spacing; y += spacing) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();

      const scale = Math.sqrt(size);
      ctx.fillStyle = rgba(accent, 1);
      for (const s of specks) {
        s.y -= s.speed * dt;
        s.x += Math.sin(time * 0.35 + s.phase) * s.wobble * dt;
        if (s.y < -4) {
          s.y = height + 4;
          s.x = Math.random() * width;
        }
        ctx.globalAlpha = s.alpha;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  );
}
