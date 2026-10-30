import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

/** A swipe must start this close to the left edge… */
const EDGE_PX = 24;
/** …and travel this far right to go back. */
const COMMIT_PX = 80;
/** Movement before a touch reads as a swipe (right) or a scroll (vertical). */
const SLOP_PX = 10;

/** iOS sets `navigator.standalone` only in an app opened from the home
 *  screen, which, unlike Safari and Android, has no back gesture. */
function isIosHomeScreenApp(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** React Router records each entry's position in the session history. */
function canGoBack(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && idx > 0;
}

/** Touches the page would lose to a swipe: anything that takes horizontal
 *  drags itself (sliders, the scrub bar, resize handles and other surfaces
 *  that turn off panning with `touch-action`), a row scrolled away from its
 *  start, and fixed layers over the page (mini player, sheets, bars). A
 *  dialog or fullscreen covers the page that would be left. */
function blocksSwipe(target: EventTarget | null): boolean {
  if (document.fullscreenElement) return true;
  if (document.querySelector('[aria-modal="true"]')) return true;
  for (
    let el = target instanceof Element ? target : null;
    el && el !== document.body;
    el = el.parentElement
  ) {
    if (el.matches("video, input, textarea, select, [role='slider']")) {
      return true;
    }
    const style = getComputedStyle(el);
    const pan = style.touchAction;
    if (pan !== "auto" && pan !== "manipulation" && !pan.includes("pan-x")) {
      return true;
    }
    if (style.position === "fixed" || el.scrollLeft > 0) return true;
  }
  return false;
}

/**
 * Swipe right from the left edge to go back, as in a native iOS app. Only in
 * the installed iOS app; a chevron follows the finger and lights up once
 * letting go will go back.
 */
export default function EdgeSwipeBack() {
  const navigate = useNavigate();
  const [drag, setDrag] = useState<{ dx: number; y: number } | null>(null);

  useEffect(() => {
    if (!isIosHomeScreenApp()) return;
    let start: { x: number; y: number; id: number } | null = null;
    let claimed = false;
    let dx = 0;

    const reset = () => {
      start = null;
      claimed = false;
      dx = 0;
      setDrag(null);
    };

    const onStart = (e: TouchEvent) => {
      if (start) {
        reset(); // a second finger: not a swipe
        return;
      }
      const t = e.touches[0];
      if (e.touches.length !== 1 || t.clientX > EDGE_PX) return;
      if (!canGoBack() || blocksSwipe(e.target)) return;
      start = { x: t.clientX, y: t.clientY, id: t.identifier };
    };

    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      if (e.touches.length !== 1 || t.identifier !== start.id) {
        reset();
        return;
      }
      dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!claimed) {
        if (Math.abs(dy) > SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
          reset(); // a scroll that began at the edge
          return;
        }
        if (dx < SLOP_PX) return;
        claimed = true;
      }
      // The page stays put under a claimed swipe.
      if (e.cancelable) e.preventDefault();
      setDrag({ dx: Math.max(0, dx), y: t.clientY });
    };

    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const id = start.id;
      if (![...e.changedTouches].some((t) => t.identifier === id)) return;
      const commit = claimed && dx >= COMMIT_PX && e.touches.length === 0;
      reset();
      if (commit) navigate(-1);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: a claimed swipe must stop the page scrolling.
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", reset);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, [navigate]);

  if (!drag) return null;
  const progress = Math.min(drag.dx / COMMIT_PX, 1);
  const ready = progress >= 1;
  return (
    <div
      aria-hidden
      data-horde="edge-swipe-back"
      data-ready={ready ? "true" : undefined}
      className={`pointer-events-none fixed left-0 z-50 flex h-10 w-10 items-center justify-center rounded-full shadow-xl ring-1 transition-colors duration-150 ${
        ready
          ? "bg-accent text-on-accent ring-accent"
          : "bg-ink-800 text-gray-300 ring-ink-600"
      }`}
      style={{
        top: drag.y - 20,
        opacity: 0.4 + 0.6 * progress,
        transform: `translateX(${-40 + 52 * progress}px)`,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m15 18-6-6 6-6" />
      </svg>
    </div>
  );
}
