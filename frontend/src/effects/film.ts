import { createFastNoise } from "./fastNoise";
import { BLACK, WHITE } from "./palette";
import {
  createCanvasLoop,
  rand,
  rgba,
  type EffectController,
  type Rgb,
} from "./shared";

/**
 * A projected film print: grain that changes every frame at film's 24 fps,
 * a soft vignette, the gate's faint flicker, a speck of dust now and then
 * and the occasional scratch running down the frame. The grain is a few
 * tiles made once and laid at random offsets, so a frame costs a fill
 * instead of a fresh screenful of random pixels.
 */

const TILE = 192;
const TILES = 6;

interface Scratch {
  x: number;
  top: number;
  bottom: number;
  life: number;
  age: number;
  alpha: number;
}

/** Light and dark grain both: white specks lift, black specks sink. */
function makeTile(): HTMLCanvasElement {
  const tile = document.createElement("canvas");
  tile.width = TILE;
  tile.height = TILE;
  const ctx = tile.getContext("2d");
  if (!ctx) return tile;
  const image = ctx.createImageData(TILE, TILE);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    // Roughly normal, centred on 0.
    const n = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    const v = n > 0 ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = Math.min(255, Math.abs(n) * 150);
  }
  ctx.putImageData(image, 0, 0);
  return tile;
}

export function createFilmEffect(canvas: HTMLCanvasElement): EffectController {
  let patterns: CanvasPattern[] = [];
  const vignette = document.createElement("canvas");
  let vignetteKey = "";
  let scratches: Scratch[] = [];
  const gate = createFastNoise();

  const drawVignette = (w: number, h: number, light: boolean) => {
    // An eighth of the screen: a smooth ramp scales up without steps.
    vignette.width = Math.max(1, Math.ceil(w / 8));
    vignette.height = Math.max(1, Math.ceil(h / 8));
    const ctx = vignette.getContext("2d");
    if (!ctx) return;
    const cw = vignette.width;
    const ch = vignette.height;
    const g = ctx.createRadialGradient(
      cw / 2,
      ch / 2,
      Math.min(cw, ch) * 0.3,
      cw / 2,
      ch / 2,
      Math.hypot(cw, ch) * 0.58
    );
    g.addColorStop(0, rgba(BLACK, 0));
    g.addColorStop(1, rgba(BLACK, light ? 0.2 : 0.5));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
  };

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, time, dt, size, isLight }) => {
      if (!patterns.length) {
        patterns = Array.from({ length: TILES }, makeTile)
          .map((tile) => ctx.createPattern(tile, "repeat"))
          .filter((p): p is CanvasPattern => p !== null);
      }
      const key = `${width}x${height}:${isLight}`;
      if (key !== vignetteKey) {
        vignetteKey = key;
        drawVignette(width, height, isLight);
      }
      ctx.clearRect(0, 0, width, height);

      // Grain: a random tile at a random offset each frame. Size coarsens it.
      const grain = Math.max(1, size);
      const pattern = patterns[Math.floor(Math.random() * patterns.length)];
      if (pattern) {
        ctx.save();
        ctx.globalAlpha = isLight ? 0.55 : 0.8;
        ctx.imageSmoothingEnabled = grain > 1;
        ctx.scale(grain, grain);
        const ox = Math.random() * TILE;
        const oy = Math.random() * TILE;
        ctx.translate(-ox, -oy);
        ctx.fillStyle = pattern;
        ctx.fillRect(ox, oy, width / grain, height / grain);
        ctx.restore();
      }

      ctx.drawImage(vignette, 0, 0, width, height);
      // The gate's flicker: the whole frame dims a touch, irregularly.
      ctx.fillStyle = rgba(BLACK, 0.05 * gate.noise(time * 11, 0.3));
      ctx.fillRect(0, 0, width, height);

      const speck: Rgb = isLight ? BLACK : WHITE;
      // Dust lasts a single frame, as it does on a print.
      if (Math.random() < 0.3) {
        const n = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < n; i++) {
          const x = Math.random() * width;
          const y = Math.random() * height;
          ctx.fillStyle = rgba(speck, rand(0.25, 0.55));
          ctx.strokeStyle = ctx.fillStyle;
          if (Math.random() < 0.7) {
            ctx.beginPath();
            ctx.ellipse(
              x,
              y,
              rand(0.6, 2.2),
              rand(0.6, 1.8),
              Math.random() * Math.PI,
              0,
              Math.PI * 2
            );
            ctx.fill();
          } else {
            // A hair: a short curl.
            const len = rand(6, 16);
            const a = Math.random() * Math.PI * 2;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.quadraticCurveTo(
              x + Math.cos(a + 1) * len * 0.6,
              y + Math.sin(a + 1) * len * 0.6,
              x + Math.cos(a) * len,
              y + Math.sin(a) * len
            );
            ctx.stroke();
          }
        }
      }

      // Scratches: rare, each running down the frame for a second or so.
      if (Math.random() < 0.006 && scratches.length < 2) {
        scratches.push({
          x: Math.random() * width,
          top: rand(-0.1, 0.3) * height,
          bottom: rand(0.6, 1.1) * height,
          life: rand(0.4, 1.4),
          age: 0,
          alpha: rand(0.1, 0.18),
        });
      }
      ctx.lineWidth = 1;
      scratches = scratches.filter((s) => {
        s.age += dt;
        if (s.age > s.life) return false;
        s.x += rand(-0.6, 0.6);
        ctx.strokeStyle = rgba(speck, s.alpha * rand(0.6, 1));
        ctx.beginPath();
        ctx.moveTo(s.x, s.top);
        ctx.lineTo(s.x + rand(-0.5, 0.5), s.bottom);
        ctx.stroke();
        return true;
      });
    },
    // Film runs at 24 frames a second; one canvas pixel per CSS pixel.
    { maxFps: 24, maxDpr: 1 }
  );
}
