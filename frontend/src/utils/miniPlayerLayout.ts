import type { CSSProperties } from "react";
import type { MiniPlayerRect } from "../context/PlaybackContext";

const GAP = 16;
const PANEL_EST_H = 260;
const QUEUE_W = 416;
const DRAG_MARGIN = 8;

export type MiniPos = { left: number; top: number };

export type MiniHostInsets = {
  left: string;
  top: string;
  right: string;
  bottom: string;
};

export function miniPlayerCornerMargin(isMobile: boolean): number {
  return isMobile ? 12 : 16;
}

/** Keep a dragged mini player fully on-screen. */
export function clampMiniPos(
  left: number,
  top: number,
  width: number,
  height: number,
  vw?: number,
  vh?: number
): MiniPos {
  const viewW = vw ?? window.innerWidth;
  const viewH = vh ?? window.innerHeight;
  const maxLeft = Math.max(DRAG_MARGIN, viewW - width - DRAG_MARGIN);
  const maxTop = Math.max(DRAG_MARGIN, viewH - height - DRAG_MARGIN);
  return {
    left: Math.min(maxLeft, Math.max(DRAG_MARGIN, left)),
    top: Math.min(maxTop, Math.max(DRAG_MARGIN, top)),
  };
}

/**
 * CSS insets for the floating mini host. Undragged stays `right`/`bottom`
 * so it tracks viewport resize; dragged uses clamped `left`/`top`.
 */
export function miniPlayerHostInsets(
  pos: MiniPos | null,
  box: { width: number; height: number },
  isMobile: boolean,
  vw?: number,
  vh?: number
): MiniHostInsets {
  if (pos) {
    const clamped = clampMiniPos(
      pos.left,
      pos.top,
      box.width,
      box.height,
      vw,
      vh
    );
    return {
      left: `${clamped.left}px`,
      top: `${clamped.top}px`,
      right: "auto",
      bottom: "auto",
    };
  }
  const margin = miniPlayerCornerMargin(isMobile);
  return {
    left: "auto",
    top: "auto",
    right: `${margin}px`,
    bottom: `${margin}px`,
  };
}

function viewportSize(
  opts?: { viewportWidth?: number; viewportHeight?: number }
): { vw: number; vh: number } {
  return {
    vw: opts?.viewportWidth ?? window.innerWidth,
    vh: opts?.viewportHeight ?? window.innerHeight,
  };
}

/** Fixed-position style that keeps a floating panel clear of the mini player. */
export function avoidMiniPlayerStyle(
  rect: MiniPlayerRect | null,
  opts?: {
    /** Extra lift when a bottom-docked queue is also present (no mini). */
    queueBottomLiftPx?: number;
    panelWidthRem?: number;
    viewportWidth?: number;
    viewportHeight?: number;
    /**
     * Undragged mini player: pin with CSS `right` so a stale rect after
     * resize cannot flip this panel onto a baked `left`.
     */
    cornerAnchor?: boolean;
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

  const { vw, vh } = viewportSize(opts);
  const miniOnRight =
    opts?.cornerAnchor || rect.left + rect.width / 2 >= vw / 2;
  const spaceAbove = rect.top - GAP;
  const spaceBelow = vh - rect.bottom - GAP;
  const side = opts?.cornerAnchor
    ? { right: GAP }
    : miniOnRight
      ? { right: Math.max(GAP, vw - rect.right) }
      : { left: Math.max(GAP, rect.left) };

  // Prefer sitting above the mini on the same horizontal side.
  if (spaceAbove >= PANEL_EST_H) {
    return {
      ...base,
      ...side,
      bottom: vh - rect.top + GAP,
    };
  }

  // Or below it if there's room.
  if (spaceBelow >= PANEL_EST_H) {
    return {
      ...base,
      ...side,
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
export function queueDockStyle(
  rect: MiniPlayerRect | null,
  opts?: { viewportWidth?: number }
): CSSProperties {
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

  const vw = opts?.viewportWidth ?? window.innerWidth;
  const miniOnRight = rect.left + rect.width / 2 >= vw / 2;
  // Keep queue on the opposite side from the mini.
  if (miniOnRight) {
    return { ...base, left: 0 };
  }
  return { ...base, right: 0 };
}

export function queueDockAlignClass(
  rect: MiniPlayerRect | null,
  opts?: { viewportWidth?: number }
): string {
  if (!rect) return "ml-auto";
  const vw = opts?.viewportWidth ?? window.innerWidth;
  const miniOnRight = rect.left + rect.width / 2 >= vw / 2;
  return miniOnRight ? "mr-auto" : "ml-auto";
}

export type MiniPlayerBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * North-west resize: change width (height follows aspect) while keeping the
 * bottom-right corner fixed. Used by the mini player's top-left handle.
 */
export function miniFrameFromNorthWestResize(
  start: MiniPlayerBox,
  nextWidth: number
): MiniPlayerBox {
  const width = nextWidth;
  const height =
    start.width > 0 ? (start.height * nextWidth) / start.width : start.height;
  return {
    width,
    height,
    left: start.left + start.width - width,
    top: start.top + start.height - height,
  };
}

export { QUEUE_W };
