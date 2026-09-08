/** Seek-bar geometry helpers, including caption clearance while chrome is up. */

export type ClientBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export function scrubPositionFromClientX(
  clientX: number,
  rect: { left: number; width: number },
  duration: number
): { time: number; pct: number } | null {
  if (duration <= 0 || rect.width <= 0) return null;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return { time: ratio * duration, pct: ratio * 100 };
}

/** Breathing room between lifted captions and the seek bar. */
export const CAPTION_TIMELINE_GAP_PX = 8;

/** Lift only while chrome is up, not during a drag or right after placing. */
export function captionLiftActive(
  controlsVisible: boolean,
  dragging: boolean,
  holdOffUntilChromeHide: boolean
): boolean {
  return controlsVisible && !dragging && !holdOffUntilChromeHide;
}

/**
 * Pixels to translate captions up so they sit above the seek bar while chrome
 * is visible. Uses the resting (untransformed) caption box. Zero when the UI
 * is hidden, the user is placing captions, or they already clear the timeline.
 */
export function captionTimelineLiftPx(
  caption: ClientBox | null,
  timeline: Pick<ClientBox, "left" | "right" | "top"> | null,
  controlsVisible: boolean,
  gapPx = CAPTION_TIMELINE_GAP_PX
): number {
  if (!controlsVisible || !caption || !timeline) return 0;
  if (caption.right <= timeline.left || caption.left >= timeline.right) {
    return 0;
  }
  const overlap = caption.bottom - timeline.top;
  if (overlap <= 0) return 0;
  return Math.ceil(overlap + gapPx);
}

/** Layout box from offset* (ignores CSS transform, unlike getBoundingClientRect). */
export function layoutBoxFromOffsets(
  parentViewport: { left: number; top: number },
  parentClientLeft: number,
  parentClientTop: number,
  el: {
    offsetLeft: number;
    offsetTop: number;
    offsetWidth: number;
    offsetHeight: number;
  }
): ClientBox {
  const left = parentViewport.left + parentClientLeft + el.offsetLeft;
  const top = parentViewport.top + parentClientTop + el.offsetTop;
  return {
    left,
    right: left + el.offsetWidth,
    top,
    bottom: top + el.offsetHeight,
  };
}
