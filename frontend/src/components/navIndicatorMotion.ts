import type { PillRect } from "./liquidJelly";

/**
 * Geometry and keyframes for the Dot and Focus nav indicators. They move
 * by transform only (the other styles animate left and width), each from
 * where it is on screen, so a click mid-move carries on smoothly.
 */

export interface Point {
  x: number;
  y: number;
}

export const DOT_SIZE = 5;
/**
 * The dot travels on a strong ease-in-out: the house ease-out covers the
 * trip in its first few frames, so the dot's stretch along the way never shows.
 */
export const DOT_EASE = "cubic-bezier(0.77, 0, 0.175, 1)";
/** Length of each Focus corner's arms. */
export const CORNER_ARM = 7;
/** How far the Focus corners overshoot before they lock on. */
const LOCK_GAP = 3;

/**
 * Centred under the item, a little above the bottom edge; in a stacked
 * menu, where items run the full width and the label sits at the left, a
 * bullet beside the label instead.
 */
export function dotPoint(item: PillRect, stacked = false): Point {
  if (stacked) {
    return { x: item.left + 6, y: item.top + (item.height - DOT_SIZE) / 2 };
  }
  return {
    x: item.left + item.width / 2 - DOT_SIZE / 2,
    y: item.top + item.height - DOT_SIZE - 3,
  };
}

/** Whether an item spans (nearly) its whole nav: a row of a stacked menu. */
export function isStackedRow(item: PillRect, navWidth: number): boolean {
  return navWidth > 0 && item.width > navWidth * 0.8;
}

export function dotTransform(p: Point, sx = 1, sy = 1): string {
  return `translate(${p.x}px, ${p.y}px) scale(${sx}, ${sy})`;
}

/**
 * The dot stretches along its path the further it goes, then squashes as
 * it lands and settles.
 */
export function dotKeyframes(from: Point, to: Point): Keyframe[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const stretch = Math.min(5, 1 + Math.hypot(dx, dy) / (DOT_SIZE * 4));
  const across = Math.abs(dx) >= Math.abs(dy);
  const mid = { x: from.x + dx / 2, y: from.y + dy / 2 };
  return [
    { offset: 0, transform: dotTransform(from) },
    {
      offset: 0.5,
      transform: across
        ? dotTransform(mid, stretch, 0.8)
        : dotTransform(mid, 0.8, stretch),
    },
    {
      offset: 0.82,
      transform: across
        ? dotTransform(to, 0.85, 1.15)
        : dotTransform(to, 1.15, 0.85),
    },
    { offset: 1, transform: dotTransform(to) },
  ];
}

/** Which way each corner points: top-left, top-right, bottom-left, bottom-right. */
export const CORNERS: readonly Point[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
];

/** Where each Focus corner sits on the item, in `CORNERS` order. */
export function focusCorners(item: PillRect): Point[] {
  const right = item.left + item.width - CORNER_ARM;
  const bottom = item.top + item.height - CORNER_ARM;
  return [
    { x: item.left, y: item.top },
    { x: right, y: item.top },
    { x: item.left, y: bottom },
    { x: right, y: bottom },
  ];
}

export function cornerTransform(p: Point): string {
  return `translate(${p.x}px, ${p.y}px)`;
}

/** A corner glides over, lands a touch wide, then tightens: a focus lock. */
export function cornerKeyframes(
  from: Point,
  to: Point,
  out: Point
): Keyframe[] {
  const wide = { x: to.x + out.x * LOCK_GAP, y: to.y + out.y * LOCK_GAP };
  return [
    { offset: 0, transform: cornerTransform(from) },
    { offset: 0.72, transform: cornerTransform(wide) },
    { offset: 1, transform: cornerTransform(to) },
  ];
}
