import {
  createCanvasLoop,
  rand,
  resizePool,
  rgba,
  type EffectController,
} from "./shared";

interface Star {
  x: number;
  y: number;
  r: number;
  tw: number;
  phase: number;
  vx: number;
  vy: number;
}

/**
 * Links are drawn in a few opacity steps, one path each, instead of one
 * stroke (and one color string) per link.
 */
const LINK_STEPS = 6;
const LINK_ALPHA = 0.22;

export function createConstellationEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const stars: Star[] = [];
  let lastW = 0;
  let lastH = 0;

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, dt, size, options }) => {
      if (lastW > 0 && lastH > 0 && (width !== lastW || height !== lastH)) {
        // Spread the stars over the new window instead of redealing them.
        for (const s of stars) {
          s.x *= width / lastW;
          s.y *= height / lastH;
        }
      }
      lastW = width;
      lastH = height;
      resizePool(
        stars,
        Math.floor(((width * height) / 14000 + 40) * size),
        () => ({
          x: Math.random() * width,
          y: Math.random() * height,
          r: rand(0.6, 1.8),
          tw: rand(0.4, 1.2),
          phase: Math.random() * Math.PI * 2,
          vx: rand(-8, 8),
          vy: rand(-6, 6),
        })
      );

      ctx.clearRect(0, 0, width, height);

      for (const s of stars) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        // Gentle course corrections so motion stays organic
        s.vx += Math.sin(time * 0.35 + s.phase) * 1.5 * dt;
        s.vy += Math.cos(time * 0.28 + s.phase * 1.3) * 1.2 * dt;
        const speed = Math.hypot(s.vx, s.vy);
        if (speed > 14) {
          s.vx = (s.vx / speed) * 14;
          s.vy = (s.vy / speed) * 14;
        }
        if (s.x < -20) s.x = width + 20;
        if (s.x > width + 20) s.x = -20;
        if (s.y < -20) s.y = height + 20;
        if (s.y > height + 20) s.y = -20;
      }

      const linkDist = Math.min(140, width * 0.12) * options.linkDistance;
      const linkDistSq = linkDist * linkDist;
      const paths = Array.from({ length: LINK_STEPS }, () => new Path2D());
      for (let i = 0; i < stars.length; i++) {
        const a = stars[i];
        for (let j = i + 1; j < stars.length; j++) {
          const b = stars[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = dx * dx + dy * dy;
          if (distSq >= linkDistSq) continue;
          const closeness = 1 - Math.sqrt(distSq) / linkDist;
          const path =
            paths[Math.min(LINK_STEPS - 1, Math.floor(closeness * LINK_STEPS))];
          path.moveTo(a.x, a.y);
          path.lineTo(b.x, b.y);
        }
      }
      ctx.lineWidth = 1;
      for (let k = 0; k < LINK_STEPS; k++) {
        ctx.strokeStyle = rgba(accent, ((k + 0.5) / LINK_STEPS) * LINK_ALPHA);
        ctx.stroke(paths[k]);
      }

      const scale = Math.sqrt(size);
      ctx.fillStyle = rgba(accent, 1);
      for (const s of stars) {
        const pulse = 0.45 + 0.55 * Math.sin(time * s.tw + s.phase);
        ctx.globalAlpha = 0.25 + pulse * 0.55;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  );
}
