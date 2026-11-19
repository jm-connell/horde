import { BLACK, WHITE, mixRgb, shiftHue } from "./palette";
import {
  createCanvasLoop,
  rand,
  rgba,
  type EffectController,
  type Rgb,
} from "./shared";
import { createSpriteCache } from "./sprites";

/**
 * A tilted spiral galaxy. Every star orbits on its own ellipse and each
 * ellipse is turned a little more than the one inside it, so the crowding
 * where they overlap draws two arms that keep their shape however long it
 * turns (the density-wave picture, rather than arms that wind up).
 */

/** How flat the disc looks: 1 is face on. */
const INCLINATION = 0.46;
/** The disc's slant on screen, radians. */
const SLANT = -0.36;
/** Radians each ellipse turns from the core to the rim. */
const TWIST = 3.4;
/** How fast the arm pattern itself turns, radians per second. */
const PATTERN_SPEED = 0.006;

interface Orbiter {
  a: number;
  b: number;
  cosT: number;
  sinT: number;
  phase: number;
  omega: number;
}

interface Star extends Orbiter {
  size: number;
}

interface Cloud extends Orbiter {
  radius: number;
  alpha: number;
  tone: number;
}

interface FieldStar {
  x: number;
  y: number;
  alpha: number;
  rate: number;
  phase: number;
}

/** Brightness steps a star can take; a few bright ones, many faint. */
const LEVELS = [0.34, 0.52, 0.76, 1];
const LEVEL_WEIGHTS = [0.46, 0.3, 0.16, 0.08];

function pickLevel(): number {
  let r = Math.random();
  for (let i = 0; i < LEVEL_WEIGHTS.length; i++) {
    r -= LEVEL_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return LEVELS.length - 1;
}

/** Disc radius (0–1.25 of the galaxy): exponential, thinning at the rim. */
function discRadius(): number {
  for (;;) {
    const r =
      -Math.log((Math.random() || 1e-9) * (Math.random() || 1e-9)) * 0.28;
    if (r < 1.25) return r;
  }
}

/**
 * How deep in an arm an orbiter is: stars crowd at the ends of their
 * ellipse, and those ends, turned a little more per orbit, are the arms.
 */
function inArm(phase: number): number {
  const c = Math.cos(phase);
  return 0.2 + 0.8 * c * c;
}

function orbit(r: number, R: number, phase: number): Orbiter {
  // Rounder towards the rim; inner orbits turn faster. Each ellipse turns
  // back against the rotation the further out it is, so the arms trail.
  const a = r * R;
  const tilt = -r * TWIST;
  return {
    a,
    b: a * (0.5 + 0.36 * Math.min(1, r)),
    cosT: Math.cos(tilt),
    sinT: Math.sin(tilt),
    phase,
    omega: 0.075 / (0.3 + r * 1.7),
  };
}

export function createSpiralGalaxyEffect(
  canvas: HTMLCanvasElement
): EffectController {
  // Stars bucketed by tone (core, disc, accent) and brightness level, so a
  // frame sets each fill style once.
  let buckets: Star[][] = [];
  let clouds: Cloud[] = [];
  let field: FieldStar[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  const sprite = createSpriteCache();

  const rebuild = (w: number, h: number, size: number) => {
    const R = Math.hypot(w, h) * 0.3 * size;
    const area = Math.min(1.5, Math.max(0.4, (w * h) / (1920 * 1080)));
    const discCount = Math.round(3600 * area * Math.sqrt(size));
    buckets = Array.from({ length: 3 * LEVELS.length }, () => []);
    const add = (tone: number, star: Star) =>
      buckets[tone * LEVELS.length + pickLevel()].push(star);

    for (let i = 0; i < discCount; i++) {
      const r = discRadius();
      const star = orbit(r, R, Math.random() * Math.PI * 2);
      // Stars wander a little off their ellipse, or the arms look drawn.
      const scatter = 1 + (Math.random() - 0.5) * 0.12;
      add(Math.random() < 0.16 ? 2 : 1, {
        ...star,
        a: star.a * scatter,
        b: star.b * scatter,
        size: Math.random() < 0.12 ? 2 : 1.3,
      });
    }
    // The bulge: a dense, round knot of older (warmer) stars.
    const bulgeCount = Math.round(discCount * 0.24);
    for (let i = 0; i < bulgeCount; i++) {
      const r = Math.abs(rand(-1, 1) * rand(0, 1)) * 0.16;
      const star = orbit(r, R, Math.random() * Math.PI * 2);
      add(0, { ...star, b: star.a * rand(0.8, 1), size: 1.3 });
    }

    clouds = Array.from({ length: Math.round(90 * area) }, () => {
      const r = rand(0.18, 1.05);
      return {
        ...orbit(r, R, Math.random() * Math.PI * 2),
        radius: rand(0.05, 0.13) * R,
        alpha: rand(0.08, 0.2),
        tone: Math.floor(Math.random() * 3),
      };
    });

    field = Array.from({ length: Math.round((w * h) / 6500) }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      alpha: rand(0.1, 0.4),
      rate: rand(0.4, 1.6),
      phase: Math.random() * Math.PI * 2,
    }));
  };

  let pattern = 0;

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

      const cx = width * 0.5;
      const cy = height * 0.5;
      const R = Math.hypot(width, height) * 0.3 * size;
      pattern += dt * PATTERN_SPEED;
      const cosP = Math.cos(pattern);
      const sinP = Math.sin(pattern);
      const cosS = Math.cos(SLANT);
      const sinS = Math.sin(SLANT);
      const dim = isLight ? 0.6 : 1;

      // Where an orbiter is on screen now; advances its phase.
      let sx = 0;
      let sy = 0;
      const place = (o: Orbiter) => {
        o.phase += o.omega * dt;
        const ex = o.a * Math.cos(o.phase);
        const ey = o.b * Math.sin(o.phase);
        // Turn the ellipse (its own twist plus the pattern), flatten, slant.
        const ct = o.cosT * cosP - o.sinT * sinP;
        const st = o.sinT * cosP + o.cosT * sinP;
        const x = ex * ct - ey * st;
        const y = (ex * st + ey * ct) * INCLINATION;
        sx = cx + x * cosS - y * sinS;
        sy = cy + x * sinS + y * cosS;
      };

      const tones: Rgb[] = isLight
        ? [
            mixRgb(accent, BLACK, 0.45),
            mixRgb(accent, BLACK, 0.3),
            mixRgb(accent, BLACK, 0.15),
          ]
        : [
            mixRgb(accent, [255, 238, 214], 0.72),
            mixRgb(accent, WHITE, 0.6),
            accent,
          ];

      // Background stars, twinkling slowly.
      ctx.fillStyle = rgba(tones[1], 1);
      for (const s of field) {
        ctx.globalAlpha =
          s.alpha * dim * (0.55 + 0.45 * Math.sin(time * s.rate + s.phase));
        ctx.fillRect(s.x, s.y, 1, 1);
      }
      ctx.globalAlpha = 1;

      // Gas along the arms, then the core's glow.
      ctx.globalCompositeOperation = isLight ? "source-over" : "lighter";
      const cloudTones = [accent, shiftHue(accent, -46), shiftHue(accent, 38)];
      for (const c of clouds) {
        place(c);
        // Gas lights up as it passes through an arm (its orbit's ends).
        ctx.globalAlpha = c.alpha * dim * inArm(c.phase);
        const r = c.radius;
        ctx.drawImage(sprite(cloudTones[c.tone]), sx - r, sy - r, r * 2, r * 2);
      }
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(SLANT);
      ctx.scale(1, INCLINATION * 1.25);
      const halo = R * 0.42;
      ctx.globalAlpha = 0.5 * dim;
      ctx.drawImage(sprite(tones[0]), -halo, -halo, halo * 2, halo * 2);
      const core = R * 0.11;
      ctx.globalAlpha = dim;
      ctx.drawImage(sprite(tones[0], "core"), -core, -core, core * 2, core * 2);
      ctx.restore();
      ctx.globalAlpha = 1;

      // The stars themselves, one fill style per bucket. The young (accent)
      // stars shine brightest in the arms, where they are born.
      for (let b = 0; b < buckets.length; b++) {
        const tone = Math.floor(b / LEVELS.length);
        const level = LEVELS[b % LEVELS.length];
        const young = tone === 2;
        ctx.fillStyle = rgba(tones[tone], young ? 1 : level * dim);
        for (const s of buckets[b]) {
          place(s);
          if (young) ctx.globalAlpha = level * dim * inArm(s.phase);
          ctx.fillRect(sx, sy, s.size, s.size);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    },
    // It turns slowly; 20 frames a second look the same for less work.
    { maxFps: 20 }
  );
}
