import { createFastNoise } from "./fastNoise";
import { BLACK, WHITE, mixRgb } from "./palette";
import {
  createCanvasLoop,
  rand,
  rgba,
  type EffectController,
  type Rgb,
} from "./shared";
import { createSpriteCache } from "./sprites";

/**
 * The screening room's projector beam: a cone of light fanning down from
 * above the page, streaked with rays that slowly shift and a faint flicker,
 * with dust drifting through the room that only glints where the beam
 * catches it.
 */

interface Mote {
  x: number;
  y: number;
  /** 0 far … 1 near: size and speed. */
  z: number;
  vx: number;
  vy: number;
  rate: number;
  phase: number;
}

/** Ray patterns the beam blends between, so it never visibly repeats. */
const PATTERNS = 3;

/** The beam's apex (the lens), above the top edge. */
function lens(w: number, h: number): [number, number] {
  return [w * 0.5, -h * 0.22];
}

/** Half the beam's spread in radians. */
function spread(size: number): number {
  return 0.36 * Math.pow(size, 0.35);
}

/** How lit a point is: 1 on the beam's axis near the lens, falling off. */
export function beamLight(
  x: number,
  y: number,
  w: number,
  h: number,
  half: number
): number {
  const [ax, ay] = lens(w, h);
  const dx = x - ax;
  const dy = y - ay;
  if (dy <= 0) return 0;
  const off = Math.atan2(dx, dy) / half;
  const reach = Math.hypot(w, h) * 1.2;
  const fade = 1 - Math.min(1, Math.hypot(dx, dy) / reach) * 0.75;
  return Math.exp(-off * off * 1.7) * fade;
}

function drawBeam(
  target: HTMLCanvasElement,
  w: number,
  h: number,
  color: Rgb,
  half: number,
  seed: number
) {
  // Half resolution: the beam is soft, and the upscale blurs it further.
  target.width = Math.max(1, Math.ceil(w / 2));
  target.height = Math.max(1, Math.ceil(h / 2));
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(0.5, 0, 0, 0.5, 0, 0);
  const [ax, ay] = lens(w, h);
  const reach = Math.hypot(w, h) * 1.3;
  const streaks = createFastNoise(seed);
  const rays = 120;
  const width = half * 2.1;
  const slice = (width * 2) / rays;
  for (let i = 0; i < rays; i++) {
    const a = -width + slice * (i + 0.5);
    const profile = Math.exp(-((a / half) ** 2) * 1.6);
    const streak = 0.35 + 0.65 * streaks.fbm(i * 0.16, 0.5, 3);
    ctx.fillStyle = rgba(color, profile * streak * 0.1);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(
      ax + Math.sin(a - slice * 0.6) * reach,
      ay + Math.cos(a - slice * 0.6) * reach
    );
    ctx.lineTo(
      ax + Math.sin(a + slice * 0.6) * reach,
      ay + Math.cos(a + slice * 0.6) * reach
    );
    ctx.closePath();
    ctx.fill();
  }
  // Brightest near the lens, thinning out across the room.
  ctx.globalCompositeOperation = "destination-in";
  const fade = ctx.createRadialGradient(ax, ay, 0, ax, ay, reach * 0.85);
  fade.addColorStop(0, "rgba(0,0,0,1)");
  fade.addColorStop(0.35, "rgba(0,0,0,0.8)");
  fade.addColorStop(1, "rgba(0,0,0,0.1)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
}

export function createProjectorEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const beams = Array.from({ length: PATTERNS }, () =>
    document.createElement("canvas")
  );
  let beamKey = "";
  let motes: Mote[] = [];
  let lastW = 0;
  let lastH = 0;
  let lastSize = 0;
  const air = createFastNoise();
  const sprite = createSpriteCache();

  const rebuild = (w: number, h: number, size: number) => {
    const count = Math.round(((w * h) / 9000) * (0.6 + 0.4 * size)) + 40;
    motes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random(),
      vx: 0,
      vy: 0,
      rate: rand(1.5, 5),
      phase: Math.random() * Math.PI * 2,
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
      const half = spread(size);
      const light = isLight
        ? mixRgb(accent, BLACK, 0.15)
        : mixRgb(accent, WHITE, 0.55);
      const key = `${width}x${height}:${size.toFixed(2)}:${light.join()}`;
      if (key !== beamKey) {
        beamKey = key;
        beams.forEach((b, i) =>
          drawBeam(b, width, height, light, half, 11 + i * 7)
        );
      }
      ctx.clearRect(0, 0, width, height);

      // Blend the ray patterns in a slow cycle; the weights always sum to 1.
      const flicker = 0.93 + 0.07 * air.noise(time * 9, 1.7);
      const strength = (isLight ? 0.55 : 1) * flicker;
      const turn = time * 0.35;
      for (let i = 0; i < PATTERNS; i++) {
        ctx.globalAlpha =
          strength *
          ((1 + Math.cos(turn - (i * Math.PI * 2) / PATTERNS)) / PATTERNS);
        ctx.drawImage(beams[i], 0, 0, width, height);
      }

      // Dust: drifting on slow air currents, rising a little.
      ctx.globalCompositeOperation = isLight ? "source-over" : "lighter";
      const mote = sprite(
        isLight ? mixRgb(accent, BLACK, 0.3) : mixRgb(accent, WHITE, 0.7),
        "core"
      );
      for (const m of motes) {
        const turnAt =
          air.noise(m.x * 0.003 + 40, m.y * 0.003 + time * 0.05) * Math.PI * 4;
        const drift = 5 + 7 * m.z;
        const ease = Math.min(1, dt * 0.6);
        m.vx += (Math.cos(turnAt) * drift - m.vx) * ease;
        m.vy += (Math.sin(turnAt) * drift - 3 - m.vy) * ease;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        if (m.x < -10) m.x = width + 10;
        if (m.x > width + 10) m.x = -10;
        if (m.y < -10) m.y = height + 10;
        if (m.y > height + 10) m.y = -10;

        const lit = beamLight(m.x, m.y, width, height, half);
        // Motes glint as they tumble through the light.
        const glint = Math.pow(
          0.5 + 0.5 * Math.sin(time * m.rate + m.phase),
          3
        );
        const alpha = 0.05 + lit * (0.45 + 0.9 * glint);
        if (alpha < 0.02) continue;
        const r = (1.6 + 3.2 * m.z) * Math.sqrt(size);
        ctx.globalAlpha = Math.min(1, alpha * flicker);
        ctx.drawImage(mote, m.x - r, m.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  );
}
