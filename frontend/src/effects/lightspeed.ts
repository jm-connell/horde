import {
  createCanvasLoop,
  rand,
  resizePool,
  rgba,
  type EffectController,
} from "./shared";

interface Streak {
  angle: number;
  /** Distance from the centre, as a fraction of the way to the rim. */
  dist: number;
  speed: number;
  length: number;
  width: number;
  alpha: number;
}

export function createLightspeedEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const streaks: Streak[] = [];

  const spawn = (): Streak => ({
    angle: Math.random() * Math.PI * 2,
    dist: Math.random(),
    speed: rand(40, 140),
    length: rand(12, 48),
    width: rand(0.6, 1.8),
    alpha: rand(0.15, 0.45),
  });

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, dt, size, options, isLight }) => {
      resizePool(streaks, Math.floor(70 * size) + 30, spawn);

      ctx.clearRect(0, 0, width, height);
      const cx = width * 0.5;
      const cy = height * 0.5;
      // Just past the corners, so streaks leave off screen.
      const maxDist = Math.hypot(width, height) * 0.55;
      const thickness = Math.sqrt(size);
      ctx.strokeStyle = rgba(accent, 1);
      ctx.lineCap = "round";

      for (const s of streaks) {
        s.dist += (s.speed * dt) / maxDist;
        if (s.dist > 1) {
          // Start again near the centre, where the fade below hides it.
          s.dist = rand(0.01, 0.04);
          s.angle = Math.random() * Math.PI * 2;
          s.speed = rand(40, 140);
          s.alpha = rand(0.15, 0.45);
        }

        const head = s.dist * maxDist;
        // Never shorter than a frame's travel, so the motion reads as one
        // line sliding rather than a row of dashes.
        const length = Math.max(s.length * options.length, s.speed * dt * 1.5);
        const tail = Math.max(0, head - length);
        const cos = Math.cos(s.angle);
        const sin = Math.sin(s.angle);
        const fade = Math.min(1, s.dist / 0.35);

        ctx.globalAlpha = s.alpha * fade * (isLight ? 0.7 : 1);
        ctx.lineWidth = s.width * thickness;
        ctx.beginPath();
        ctx.moveTo(cx + cos * tail, cy + sin * tail);
        ctx.lineTo(cx + cos * head, cy + sin * head);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  );
}
