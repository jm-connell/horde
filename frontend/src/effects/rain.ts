import {
  createCanvasLoop,
  rand,
  resizePool,
  rgba,
  type EffectController,
  type Rgb,
} from "./shared";

/**
 * Rain in three depths, all slanted by the same wind: far streaks are short,
 * dim and slow, near ones longer, brighter and quicker. Each streak is a soft
 * tail at least as long as the distance it falls in a frame, so consecutive
 * frames overlap and the eye sees a fall instead of a flicker.
 */

interface Drop {
  /** Position across the wind, -1..1 of the field's half width. */
  u: number;
  /** How far through its fall it is, 0..1. */
  fall: number;
  speed: number;
  len: number;
  alpha: number;
}

/** Fall speed in px/s, streak length and width in px. */
const LAYERS = [
  {
    share: 0.5,
    speed: [170, 230],
    len: [14, 24],
    width: 1,
    alpha: [0.16, 0.28],
  },
  {
    share: 0.33,
    speed: [270, 350],
    len: [28, 44],
    width: 1.25,
    alpha: [0.26, 0.42],
  },
  {
    share: 0.17,
    speed: [400, 500],
    len: [52, 80],
    width: 1.6,
    alpha: [0.36, 0.56],
  },
] as const;

/** A streak drawn once: clear at the tail, brightest just behind the tip. */
function streakSprite(color: Rgb): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = 4;
  sprite.height = 96;
  const ctx = sprite.getContext("2d");
  if (!ctx) return sprite;
  const g = ctx.createLinearGradient(0, 0, 0, sprite.height);
  g.addColorStop(0, rgba(color, 0));
  g.addColorStop(0.55, rgba(color, 0.35));
  g.addColorStop(0.92, rgba(color, 1));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, sprite.width, sprite.height);
  return sprite;
}

export function createRainEffect(canvas: HTMLCanvasElement): EffectController {
  const drops: Drop[][] = LAYERS.map(() => []);
  let sprite: HTMLCanvasElement | null = null;
  let spriteKey = "";

  const spawn = (layer: number): Drop => {
    const l = LAYERS[layer];
    return {
      u: rand(-1, 1),
      fall: Math.random(),
      speed: rand(l.speed[0], l.speed[1]),
      len: rand(l.len[0], l.len[1]),
      alpha: rand(l.alpha[0], l.alpha[1]),
    };
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, dt, size, options, isLight }) => {
      ctx.clearRect(0, 0, width, height);
      if (width <= 0 || height <= 0) return;

      const count = Math.max(40, Math.round(((width * height) / 6500) * size));
      for (let i = 0; i < LAYERS.length; i++) {
        resizePool(drops[i], Math.round(count * LAYERS[i].share), () =>
          spawn(i)
        );
      }

      const key = accent.join(",");
      if (!sprite || key !== spriteKey) {
        sprite = streakSprite(accent);
        spriteKey = key;
      }

      // Draw in a frame turned with the wind, where every drop falls straight
      // down. The field is the screen's bounding box in that frame, so drops
      // enter and leave off screen. Positions are fractions of the field, so
      // a resize or a new angle spreads the same drops over the new field.
      const angle = (options.angle * Math.PI) / 180;
      const sin = Math.abs(Math.sin(angle));
      const cos = Math.abs(Math.cos(angle));
      const halfAcross = (width * cos + height * sin) / 2;
      const halfAlong = (width * sin + height * cos) / 2;

      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(-angle);
      const dim = isLight ? 0.8 : 1;
      for (let i = 0; i < LAYERS.length; i++) {
        const w = LAYERS[i].width;
        for (const d of drops[i]) {
          const travel = d.speed * dt;
          // Never shorter than a frame's travel, whatever the frame rate or
          // the speed setting: that is what keeps the motion continuous.
          const len = Math.max(d.len, travel * 1.5);
          const path = halfAlong * 2 + len;
          d.fall += travel / path;
          if (d.fall >= 1) {
            d.fall -= Math.floor(d.fall);
            d.u = rand(-1, 1);
          }
          ctx.globalAlpha = d.alpha * dim;
          ctx.drawImage(
            sprite,
            d.u * halfAcross - w / 2,
            -halfAlong - len + d.fall * path,
            w,
            len
          );
        }
      }
      ctx.restore();
    },
    { maxFps: 60 }
  );
}
