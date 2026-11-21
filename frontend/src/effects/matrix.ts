import {
  createCanvasLoop,
  rand,
  resizePool,
  rgba,
  type EffectController,
} from "./shared";

interface Column {
  y: number;
  speed: number;
  /** Glyphs in the trail before the Trail length slider scales it. */
  trail: number;
  chars: string[];
}

const GLYPHS =
  "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEF<>{}[]/*+#";
const BASE_FONT = 14;
const MIN_TRAIL = 8;
const MAX_TRAIL = 22;
/** Longest trail the slider can ask for: every column holds this many. */
const MAX_GLYPHS = MAX_TRAIL * 2;

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
}

export function createMatrixEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const columns: Column[] = [];

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height, accent, dt, size, options }) => {
      // Size is the glyph size; columns sit one glyph apart, so a new size
      // spreads the same columns out instead of restarting them.
      const fs = BASE_FONT * Math.sqrt(size);
      resizePool(columns, Math.ceil(width / fs), () => ({
        y: rand(-height, height),
        speed: rand(40, 120),
        trail: Math.floor(rand(MIN_TRAIL, MAX_TRAIL)),
        chars: Array.from({ length: MAX_GLYPHS }, randomGlyph),
      }));

      ctx.clearRect(0, 0, width, height);
      ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = "top";
      ctx.fillStyle = rgba(accent, 1);

      for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        const trail = Math.round(col.trail * options.trail);
        col.y += col.speed * dt;
        if (col.y - trail * fs > height) {
          // Start again above the top edge.
          col.y = -fs - rand(0, height * 0.3);
          col.speed = rand(40, 120);
        }

        const x = c * fs;
        for (let i = 0; i < trail; i++) {
          if (Math.random() < 0.02) col.chars[i] = randomGlyph();
          const gy = col.y - i * fs;
          if (gy < -fs || gy > height) continue;
          // A bright head, then a tail that fades out to nothing.
          const left = 1 - i / trail;
          ctx.globalAlpha = i === 0 ? 0.85 : 0.5 * left * Math.sqrt(left);
          ctx.fillText(col.chars[i], x, gy);
        }
      }
      ctx.globalAlpha = 1;
    }
  );
}
