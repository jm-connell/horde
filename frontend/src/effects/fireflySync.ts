import { createFastNoise } from "./fastNoise";
import { BLACK, mixRgb } from "./palette";
import { createCanvasLoop, rand, type EffectController } from "./shared";
import { createSpriteCache } from "./sprites";

/**
 * Fireflies that flash the way real ones do (a quick rise, a fade, a few
 * seconds dark) and, like the synchronous species, gradually fall into step
 * with each other. Each keeps its own rhythm and is nudged toward the
 * swarm's (Kuramoto coupling); the nudge comes and goes over a couple of
 * minutes, so the swarm drifts into unison and back out of it.
 */

interface Fly {
  x: number;
  y: number;
  vx: number;
  vy: number;
  layer: number;
  /** Where in its flash cycle, 0–1; the flash starts at 0. */
  cycle: number;
  /** Flashes per second on its own. */
  rate: number;
  seed: number;
}

/** Depth layers, far to near: near ones are larger, softer and faster. */
const LAYERS = [
  { share: 0.45, halo: 10, core: 1.3, speed: 0.55, alpha: 0.75 },
  { share: 0.35, halo: 16, core: 1.9, speed: 0.8, alpha: 0.95 },
  { share: 0.2, halo: 34, core: 2.8, speed: 1.15, alpha: 0.6 },
];

/** Seconds for the coupling to rise, hold and let go again. */
const SYNC_CYCLE = 140;
/** Strongest pull toward the swarm's rhythm, cycles per second. */
const MAX_PULL = 0.17;

function pickLayer(): number {
  const r = Math.random();
  return r < LAYERS[0].share
    ? 0
    : r < LAYERS[0].share + LAYERS[1].share
      ? 1
      : 2;
}

/** Flash brightness over the cycle: a fast rise, then an exponential fade. */
export function flashLevel(cycle: number): number {
  if (cycle < 0.03) return cycle / 0.03;
  if (cycle < 0.24) return Math.exp(-(cycle - 0.03) / 0.045);
  return 0;
}

/** How strongly fireflies pull together at `time` (0–1). */
export function couplingAt(time: number): number {
  const s = (time % SYNC_CYCLE) / SYNC_CYCLE;
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return smooth(0.12, 0.5, s) * (1 - smooth(0.74, 0.94, s));
}

export function createFireflySyncEffect(
  canvas: HTMLCanvasElement
): EffectController {
  let flies: Fly[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  const field = createFastNoise();
  const sprite = createSpriteCache();

  const rebuild = (w: number, h: number, size: number) => {
    const area = (w * h) / (1440 * 900);
    const count = Math.round(64 * area * Math.sqrt(size)) + 12;
    flies = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      // Most of them low, over the "meadow".
      y: h * (1 - Math.pow(Math.random(), 1.6) * 0.85),
      vx: 0,
      vy: 0,
      layer: pickLayer(),
      cycle: Math.random(),
      rate: 1 / rand(3.4, 5.4),
      seed: Math.random() * 100,
    }));
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, time, dt, size, isLight }) => {
      if (
        width !== lastW ||
        height !== lastH ||
        Math.abs(size - lastSize) > 0.05
      ) {
        lastW = width;
        lastH = height;
        lastSize = size;
        rebuild(width, height, size);
      }
      ctx.clearRect(0, 0, width, height);

      // The swarm's shared rhythm (the order parameter).
      let sumC = 0;
      let sumS = 0;
      for (const f of flies) {
        sumC += Math.cos(f.cycle * Math.PI * 2);
        sumS += Math.sin(f.cycle * Math.PI * 2);
      }
      const together = Math.hypot(sumC, sumS) / Math.max(1, flies.length);
      const shared = Math.atan2(sumS, sumC) / (Math.PI * 2);
      const pull = MAX_PULL * couplingAt(time) * together;

      const halo = isLight ? mixRgb(accent, BLACK, 0.2) : accent;
      const core = isLight
        ? mixRgb(accent, BLACK, 0.35)
        : mixRgb(accent, [255, 250, 222], 0.55);
      const haloSprite = sprite(halo, "soft");
      const coreSprite = sprite(core, "core");
      const scale = Math.sqrt(size);
      ctx.globalCompositeOperation = isLight ? "source-over" : "lighter";

      for (const f of flies) {
        const layer = LAYERS[f.layer];
        // Drift through a slowly changing current, a little faster up close.
        const turn =
          field.noise(f.x * 0.0016 + f.seed, f.y * 0.0016 + time * 0.04) *
          Math.PI *
          4;
        const speed = 15 * layer.speed;
        // Keep them off the very top and inside the bottom edge.
        const lift = f.y < height * 0.15 ? 10 : f.y > height * 0.97 ? -10 : 0;
        const ease = Math.min(1, dt * 0.8);
        f.vx += (Math.cos(turn) * speed - f.vx) * ease;
        f.vy += (Math.sin(turn) * speed * 0.6 + lift - f.vy) * ease;
        f.x += f.vx * dt;
        f.y += (f.vy + Math.sin(time * 0.7 + f.seed) * 4) * dt;
        if (f.x < -30) f.x = width + 30;
        if (f.x > width + 30) f.x = -30;

        // Its own rate, plus the pull toward the swarm's phase.
        f.cycle +=
          (f.rate + pull * Math.sin((shared - f.cycle) * Math.PI * 2)) * dt;
        f.cycle -= Math.floor(f.cycle);

        // A faint glow between flashes keeps the swarm in view.
        const level = flashLevel(f.cycle) + 0.09;
        const glowR = layer.halo * scale;
        ctx.globalAlpha = Math.min(1, level * layer.alpha);
        ctx.drawImage(
          haloSprite,
          f.x - glowR,
          f.y - glowR,
          glowR * 2,
          glowR * 2
        );
        if (level > 0.08) {
          const coreR = layer.core * 3 * scale;
          ctx.globalAlpha = Math.min(1, level * (isLight ? 0.6 : 0.95));
          ctx.drawImage(
            coreSprite,
            f.x - coreR,
            f.y - coreR,
            coreR * 2,
            coreR * 2
          );
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  );
}
