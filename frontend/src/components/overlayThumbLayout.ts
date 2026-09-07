export const OVERLAY_THUMB_INSET = 4;
export const OVERLAY_THUMB_MIN = 16;

export type OverlayThumbLayout = { top: number; height: number };

export function overlayThumbLayout(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  inset = OVERLAY_THUMB_INSET,
  minThumb = OVERLAY_THUMB_MIN
): OverlayThumbLayout | null {
  if (scrollHeight <= clientHeight + 1) return null;
  const track = Math.max(0, clientHeight - inset * 2);
  const height = Math.max(minThumb, (clientHeight / scrollHeight) * track);
  const maxTop = Math.max(0, track - height);
  const range = scrollHeight - clientHeight;
  const top = inset + (range <= 0 ? 0 : (scrollTop / range) * maxTop);
  return { top, height };
}
