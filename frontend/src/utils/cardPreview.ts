export const PREVIEW_HOVER_DELAY_MS = 400;
export const PREVIEW_RESUME_MIN_SEC = 5;
export const PREVIEW_CENTER_DELAY_MS = 300;
export const PREVIEW_UNLOAD_DELAY_MS = 300;

/** Ignore horizontal-row tiles (Continue Watching) that are not full-width. */
export const MIN_WIDTH_RATIO = 0.72;
/** Card center must sit within this fraction of viewport height from mid-screen. */
export const CENTER_BAND_RATIO = 0.22;
/** Winner must beat the runner-up by this many CSS pixels, or it is not unique. */
export const CENTER_MARGIN_PX = 40;

export type PreviewRect = {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
};

export type ViewportSize = {
  width: number;
  height: number;
};

export type PreviewMode = "hover" | "center" | "off";

export function resolvePreviewMode(opts: {
  previewOnHover: boolean;
  previewWhenCentered: boolean;
  hoverCapable: boolean;
  reducedMotion: boolean;
}): PreviewMode {
  if (opts.reducedMotion) return "off";
  if (opts.hoverCapable) return opts.previewOnHover ? "hover" : "off";
  return opts.previewWhenCentered ? "center" : "off";
}

export function previewStartSec(
  lastPositionSec: number | null | undefined,
  durationSec: number | null | undefined
): number {
  if (lastPositionSec == null || lastPositionSec <= 0) return 0;
  if (durationSec != null && durationSec > 0) {
    const remaining = durationSec - lastPositionSec;
    if (remaining < 3) return 0;
  }
  return lastPositionSec;
}

export function shouldHandoffPreview(
  startSec: number,
  currentTime: number,
  minWatched = PREVIEW_RESUME_MIN_SEC
): boolean {
  if (!Number.isFinite(currentTime) || currentTime <= 1) return false;
  return currentTime - startSec > minWatched;
}

type LivePreview = {
  videoId: number;
  startSec: number;
  currentTime: number;
};

let livePreview: LivePreview | null = null;

export function reportPreviewTime(
  videoId: number,
  startSec: number,
  currentTime: number
): void {
  livePreview = { videoId, startSec, currentTime };
}

export function previewResumeFor(videoId: number): number | null {
  if (livePreview?.videoId !== videoId) return null;
  if (!shouldHandoffPreview(livePreview.startSec, livePreview.currentTime)) {
    return null;
  }
  return livePreview.currentTime;
}

/**
 * Pick the card that is uniquely at the vertical (and horizontal) center
 * of the viewport. Returns null when no card is clearly the one in view.
 */
export function pickCenteredPreview(
  candidates: PreviewRect[],
  viewport: ViewportSize
): string | null {
  if (candidates.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const band = viewport.height * CENTER_BAND_RATIO;
  const minWidth = viewport.width * MIN_WIDTH_RATIO;

  const scored: { id: string; dist: number }[] = [];
  for (const card of candidates) {
    if (card.width < minWidth) continue;
    const cardCx = card.left + card.width / 2;
    const cardCy = card.top + card.height / 2;
    const dy = Math.abs(cardCy - cy);
    if (dy > band) continue;
    const dx = Math.abs(cardCx - cx);
    scored.push({ id: card.id, dist: Math.hypot(dx, dy) });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.dist - b.dist);
  if (scored.length === 1) return scored[0].id;
  if (scored[1].dist - scored[0].dist >= CENTER_MARGIN_PX) return scored[0].id;
  return null;
}
