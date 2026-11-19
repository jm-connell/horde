import { createFastNoise } from "./fastNoise";
import { BLACK, mixRgb } from "./palette";
import { createCanvasLoop, rgba, type EffectController } from "./shared";

/**
 * Contour lines of a landscape that slowly reshapes itself, every fifth line
 * a little heavier, as on a survey map. Traced with marching squares over a
 * coarse grid; the land moves slowly enough to redraw 15 times a second.
 */

/** Grid spacing in CSS pixels. */
const CELL = 14;
const FIRST_LEVEL = 0.2;
const LEVEL_STEP = 0.028;
const LEVELS = 22;

export function createContoursEffect(
  canvas: HTMLCanvasElement
): EffectController {
  const land = createFastNoise();
  let grid = new Float32Array(0);
  let cols = 0;
  let rows = 0;

  const height = (x: number, y: number, t: number, scale: number): number =>
    0.64 * land.fbm(x * scale + t * 0.012, y * scale - t * 0.008, 3) +
    0.36 *
      land.fbm(
        x * scale * 0.55 - t * 0.006 + 41.3,
        y * scale * 0.55 + t * 0.01 - 7.7,
        2
      );

  return createCanvasLoop(
    canvas,
    ({ ctx, width, height: h, accent, time, size, isLight }) => {
      const nextCols = Math.ceil(width / CELL) + 1;
      const nextRows = Math.ceil(h / CELL) + 1;
      if (nextCols !== cols || nextRows !== rows) {
        cols = nextCols;
        rows = nextRows;
        grid = new Float32Array((cols + 1) * (rows + 1));
      }
      const stride = cols + 1;
      const scale = 0.0021 / size;
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          grid[r * stride + c] = height(c * CELL, r * CELL, time, scale);
        }
      }

      const minor = new Path2D();
      const major = new Path2D();
      for (let r = 0; r < rows; r++) {
        const y0 = r * CELL;
        for (let c = 0; c < cols; c++) {
          const x0 = c * CELL;
          const tl = grid[r * stride + c];
          const tr = grid[r * stride + c + 1];
          const br = grid[(r + 1) * stride + c + 1];
          const bl = grid[(r + 1) * stride + c];
          const lo = Math.min(tl, tr, br, bl);
          const hi = Math.max(tl, tr, br, bl);
          const kFrom = Math.max(0, Math.ceil((lo - FIRST_LEVEL) / LEVEL_STEP));
          const kTo = Math.min(
            LEVELS - 1,
            Math.floor((hi - FIRST_LEVEL) / LEVEL_STEP)
          );
          for (let k = kFrom; k <= kTo; k++) {
            const level = FIRST_LEVEL + k * LEVEL_STEP;
            traceCell(
              k % 5 === 0 ? major : minor,
              x0,
              y0,
              tl,
              tr,
              br,
              bl,
              level
            );
          }
        }
      }

      ctx.clearRect(0, 0, width, h);
      const ink = isLight ? mixRgb(accent, BLACK, 0.3) : accent;
      ctx.lineCap = "round";
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(ink, isLight ? 0.22 : 0.2);
      ctx.stroke(minor);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = rgba(ink, isLight ? 0.4 : 0.38);
      ctx.stroke(major);
    },
    { maxFps: 15 }
  );
}

/** Cell edges: 0 top, 1 right, 2 bottom, 3 left. */
type Edge = 0 | 1 | 2 | 3;

/**
 * The edges each corner pattern's contour joins, in pairs. The pattern's
 * bits are top-left 8, top-right 4, bottom-right 2, bottom-left 1. The two
 * saddles (5, 10) depend on the middle and are handled below.
 */
const JOINS: Edge[][] = [
  [],
  [3, 2],
  [2, 1],
  [3, 1],
  [0, 1],
  [],
  [0, 2],
  [3, 0],
  [3, 0],
  [0, 2],
  [],
  [0, 1],
  [3, 1],
  [2, 1],
  [3, 2],
  [],
];
/** A saddle cuts off its two low corners when the middle is high. */
const SADDLE_5: Record<"high" | "low", Edge[]> = {
  high: [3, 0, 2, 1],
  low: [0, 1, 3, 2],
};
const SADDLE_10: Record<"high" | "low", Edge[]> = {
  high: [0, 1, 3, 2],
  low: [3, 0, 2, 1],
};

/**
 * Add the piece of the `level` contour inside the grid cell at `x`, `y`,
 * given its corner values, to `path`.
 */
export function traceCell(
  path: Path2D,
  x: number,
  y: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
  level: number
): void {
  const code =
    (tl > level ? 8 : 0) |
    (tr > level ? 4 : 0) |
    (br > level ? 2 : 0) |
    (bl > level ? 1 : 0);
  let joins = JOINS[code];
  if (code === 5 || code === 10) {
    const middle = (tl + tr + br + bl) / 4 > level ? "high" : "low";
    joins = (code === 5 ? SADDLE_5 : SADDLE_10)[middle];
  }
  for (let i = 0; i < joins.length; i++) {
    let px: number;
    let py: number;
    // Where the field crosses `level` along this edge.
    switch (joins[i]) {
      case 0:
        px = x + (CELL * (level - tl)) / (tr - tl);
        py = y;
        break;
      case 1:
        px = x + CELL;
        py = y + (CELL * (level - tr)) / (br - tr);
        break;
      case 2:
        px = x + (CELL * (level - bl)) / (br - bl);
        py = y + CELL;
        break;
      default:
        px = x;
        py = y + (CELL * (level - tl)) / (bl - tl);
    }
    if (i % 2 === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  }
}
