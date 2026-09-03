/** Hit-testing helpers for the player seek bar vs. caption overlay. */

export function pointInClientRect(
  clientX: number,
  clientY: number,
  rect: { left: number; right: number; top: number; bottom: number }
): boolean {
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

export function scrubPositionFromClientX(
  clientX: number,
  rect: { left: number; width: number },
  duration: number
): { time: number; pct: number } | null {
  if (duration <= 0 || rect.width <= 0) return null;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return { time: ratio * duration, pct: ratio * 100 };
}

/** Captions sit above the chrome; only the seek strip should steal that click. */
export function shouldPassthroughSeek(
  clientX: number,
  clientY: number,
  seekRect: { left: number; right: number; top: number; bottom: number } | null,
  controlsVisible: boolean
): boolean {
  if (!controlsVisible || !seekRect) return false;
  return pointInClientRect(clientX, clientY, seekRect);
}
