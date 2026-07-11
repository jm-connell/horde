import type { CSSProperties } from "react";
import type { MiniPlayerRect } from "../context/PlaybackContext";

const GAP = 16;
const PANEL_EST_H = 260;
const QUEUE_W = 416;

/** Fixed-position style that keeps a floating panel clear of the mini player. */
export function avoidMiniPlayerStyle(
  rect: MiniPlayerRect | null,
  opts?: {
    /** Extra lift when a bottom-docked queue is also present (no mini). */
    queueBottomLiftPx?: number;
    panelWidthRem?: number;
  }
): CSSProperties {
  const panelW = `${opts?.panelWidthRem ?? 22}rem`;
  const base: CSSProperties = {
    position: "fixed",
    zIndex: 50,
    width: panelW,
    maxWidth: "calc(100vw - 2rem)",
    pointerEvents: "none",
  };

  if (!rect) {
    const bottom = opts?.queueBottomLiftPx
      ? Math.max(GAP, opts.queueBottomLiftPx)
      : GAP;
    return { ...base, right: GAP, bottom };
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const miniOnRight = rect.left + rect.width / 2 >= vw / 2;
  const spaceAbove = rect.top - GAP;
  const spaceBelow = vh - rect.bottom - GAP;

  // Prefer sitting above the mini on the same horizontal side.
  if (spaceAbove >= PANEL_EST_H) {
    return {
      ...base,
      ...(miniOnRight
        ? { right: Math.max(GAP, vw - rect.right) }
        : { left: Math.max(GAP, rect.left) }),
      bottom: vh - rect.top + GAP,
    };
  }

  // Or below it if there's room.
  if (spaceBelow >= PANEL_EST_H) {
    return {
      ...base,
      ...(miniOnRight
        ? { right: Math.max(GAP, vw - rect.right) }
        : { left: Math.max(GAP, rect.left) }),
      top: rect.bottom + GAP,
    };
  }

  // Otherwise park on the opposite horizontal side at the bottom.
  return {
    ...base,
    ...(miniOnRight ? { left: GAP } : { right: GAP }),
    bottom: GAP,
  };
}

/** Bottom-docked queue placement opposite the mini player when present. */
export function queueDockStyle(rect: MiniPlayerRect | null): CSSProperties {
  const base: CSSProperties = {
    position: "fixed",
    bottom: 0,
    zIndex: 30,
    width: "26rem",
    padding: "0.75rem",
    pointerEvents: "none",
  };

  if (!rect) {
    return { ...base, right: 0 };
  }

  const miniOnRight = rect.left + rect.width / 2 >= window.innerWidth / 2;
  // Keep queue on the opposite side from the mini.
  if (miniOnRight) {
    return { ...base, left: 0 };
  }
  return { ...base, right: 0 };
}

export function queueDockAlignClass(rect: MiniPlayerRect | null): string {
  if (!rect) return "ml-auto";
  const miniOnRight = rect.left + rect.width / 2 >= window.innerWidth / 2;
  return miniOnRight ? "mr-auto" : "ml-auto";
}

export { QUEUE_W };
