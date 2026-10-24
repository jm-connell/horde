import type { miniPlayerHostInsets } from "../../utils/miniPlayerLayout";
import type { MiniPlayerRect } from "../PlaybackContext";

export function applyMiniHostInsets(
  host: HTMLElement,
  insets: ReturnType<typeof miniPlayerHostInsets>
) {
  host.style.left = insets.left || "auto";
  host.style.top = insets.top || "auto";
  host.style.right = insets.right || "auto";
  host.style.bottom = insets.bottom || "auto";
}

const FLIP_DURATION_MS = 320;
const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

// Animate the player host jumping between the watch dock and the fullscreen
// (windowed/"fit") overlay. The host is reparented across the DOM (not just
// restyled), so a plain CSS transition can't interpolate the change — instead
// this replays a FLIP: snapshot the pre-move box, let the mutation happen,
// then transform from the old box back to the new one and let it settle.
export function flipHostTransition(host: HTMLElement, before: DOMRect) {
  if (before.width <= 0 || before.height <= 0) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const after = host.getBoundingClientRect();
  if (after.width <= 0 || after.height <= 0) return;
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  const sx = before.width / after.width;
  const sy = before.height / after.height;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
  if (
    Math.abs(dx) < 1 &&
    Math.abs(dy) < 1 &&
    Math.abs(sx - 1) < 0.01 &&
    Math.abs(sy - 1) < 0.01
  ) {
    return;
  }
  host.style.transition = "none";
  host.style.transformOrigin = "top left";
  host.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  // Force layout so the browser commits the starting transform before we
  // animate away from it on the next frame.
  void host.offsetWidth;
  requestAnimationFrame(() => {
    host.style.transition = `transform ${FLIP_DURATION_MS}ms ${FLIP_EASING}`;
    host.style.transform = "";
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== host || e.propertyName !== "transform") return;
      host.style.transition = "";
      host.removeEventListener("transitionend", onEnd);
    };
    host.addEventListener("transitionend", onEnd);
  });
}

export function miniRectFromHost(host: HTMLElement): MiniPlayerRect | null {
  const r = host.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.right,
    bottom: r.bottom,
  };
}
