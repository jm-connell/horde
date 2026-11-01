import type { MiniPlayerRect } from "../context/PlaybackContext";

export type HelpFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const MARGIN = 16;
const DEFAULT_W = 384;
const DEFAULT_H = 544;
export const MIN_W = 300;
export const MIN_H = 320;

/** Keep the panel inside the viewport, shrinking it first if it can't fit. */
export function clampHelpFrame(f: HelpFrame, vw: number, vh: number) {
  const width = Math.max(MIN_W, Math.min(f.width, vw - MARGIN));
  const height = Math.max(MIN_H, Math.min(f.height, vh - MARGIN));
  const left = Math.max(8, Math.min(f.left, vw - width - 8));
  const top = Math.max(8, Math.min(f.top, vh - height - 8));
  return { left, top, width, height };
}

function overlaps(a: HelpFrame, b: MiniPlayerRect): boolean {
  return (
    a.left < b.right &&
    a.left + a.width > b.left &&
    a.top < b.bottom &&
    a.top + a.height > b.top
  );
}

/**
 * Where the panel opens before it is dragged: the bottom-right corner, moved
 * above or beside the mini player when that is in the way.
 */
export function defaultHelpFrame(
  vw: number,
  vh: number,
  mini: MiniPlayerRect | null
): HelpFrame {
  const width = Math.min(DEFAULT_W, vw - 2 * MARGIN);
  const height = Math.min(DEFAULT_H, vh - 2 * MARGIN);
  const corner = {
    left: vw - width - MARGIN,
    top: vh - height - MARGIN,
    width,
    height,
  };
  if (!mini || !overlaps(corner, mini)) return corner;
  const above = mini.top - 2 * MARGIN;
  if (above >= MIN_H) {
    const h = Math.min(height, above);
    return { ...corner, top: mini.top - MARGIN - h, height: h };
  }
  const beside = mini.left - MARGIN;
  if (beside - MARGIN >= MIN_W) {
    const w = Math.min(width, beside - MARGIN);
    return { ...corner, left: beside - w, width: w };
  }
  return corner;
}

/** Resize from the top-left corner, keeping the bottom-right corner put. */
export function resizeFromTopLeft(
  start: HelpFrame,
  dx: number,
  dy: number,
  vw: number,
  vh: number
): HelpFrame {
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  const width = Math.max(MIN_W, Math.min(start.width - dx, right - 8, vw - 16));
  const height = Math.max(
    MIN_H,
    Math.min(start.height - dy, bottom - 8, vh - 16)
  );
  return { left: right - width, top: bottom - height, width, height };
}

/** Narrowest the docked chat can be dragged. */
export const DOCK_MIN_W = 320;
/** Room always left for the page beside the docked chat. */
const DOCK_PAGE_MIN = 480;

/**
 * The docked chat's width: the one the user dragged it to, else about 30% of
 * the window (360–520 px), never narrower than `DOCK_MIN_W` and never leaving
 * the page less than `DOCK_PAGE_MIN`.
 */
export function dockWidthFor(wanted: number | null, vw: number): number {
  const max = Math.max(DOCK_MIN_W, vw - DOCK_PAGE_MIN);
  const base = wanted ?? Math.min(520, Math.max(360, vw * 0.3));
  return Math.round(Math.min(max, Math.max(DOCK_MIN_W, base)));
}

/** Most the docked chat can be at this window width. */
export function dockMaxWidth(vw: number): number {
  return Math.max(DOCK_MIN_W, vw - DOCK_PAGE_MIN);
}
