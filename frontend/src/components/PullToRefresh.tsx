import { useEffect, useState } from "react";
import { useInstalledApp } from "../hooks/useInstalledApp";
import { RefreshIcon } from "./icons";

/**
 * Fired on `window` when a pull is released. A page with its own idea of
 * refreshing (Recommended reshuffles its feed) calls `preventDefault()`;
 * otherwise the page reloads.
 */
export const PULL_REFRESH_EVENT = "horde:pull-refresh";

/** How far the finger travels for the indicator to arm. */
const COMMIT_PX = 110;
/** Movement before a touch reads as a pull (down) or something else. */
const SLOP_PX = 10;
/** The indicator moves this fraction of the finger's travel. */
const DAMPING = 0.5;

/** Touches that are not the page's to pull: anything that takes vertical
 *  drags itself (sliders, the scrub bar, `touch-action` surfaces), a list
 *  scrolled away from its top, and fixed layers over the page (mini player,
 *  sheets, panels) except the top bar. A dialog or fullscreen is not a page. */
function blocksPull(target: EventTarget | null): boolean {
  if (document.fullscreenElement) return true;
  if (document.querySelector('[aria-modal="true"]')) return true;
  for (
    let el = target instanceof Element ? target : null;
    el && el !== document.body;
    el = el.parentElement
  ) {
    if (el.matches("input, textarea, select, [role='slider']")) return true;
    const style = getComputedStyle(el);
    const pan = style.touchAction;
    if (pan !== "auto" && pan !== "manipulation" && !pan.includes("pan-y")) {
      return true;
    }
    if (el.scrollTop > 0) return true;
    if (style.position === "fixed" && el.getAttribute("data-horde") !== "nav") {
      return true;
    }
  }
  return false;
}

/**
 * Pull down from the top of a page to refresh, as in a native app. Only in
 * the installed app on a touch screen: there the browser's own pull to
 * refresh is off (index.css stops the page overscrolling) or, on iOS, never
 * existed. A refresh mark drops in under the top bar, turning with the pull,
 * and takes the accent once letting go will refresh.
 */
export default function PullToRefresh() {
  const installed = useInstalledApp();
  const [pull, setPull] = useState<{ dy: number; top: number } | null>(null);

  useEffect(() => {
    if (!installed) return;
    let start: { x: number; y: number; id: number; top: number } | null = null;
    let claimed = false;
    let dy = 0;

    const reset = () => {
      start = null;
      claimed = false;
      dy = 0;
      setPull(null);
    };

    const onStart = (e: TouchEvent) => {
      if (start) {
        reset(); // a second finger: a pinch, not a pull
        return;
      }
      if (e.touches.length !== 1) return;
      if (!window.matchMedia("(pointer: coarse)").matches) return;
      if ((document.scrollingElement?.scrollTop ?? 0) > 0) return;
      if (blocksPull(e.target)) return;
      const t = e.touches[0];
      const nav = document.querySelector('[data-horde="nav"]');
      const top = Math.max(0, nav?.getBoundingClientRect().bottom ?? 0);
      start = { x: t.clientX, y: t.clientY, id: t.identifier, top };
    };

    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      if (e.touches.length !== 1 || t.identifier !== start.id) {
        reset();
        return;
      }
      dy = t.clientY - start.y;
      const dx = t.clientX - start.x;
      if (!claimed) {
        if (dy < -SLOP_PX || Math.abs(dx) > Math.abs(dy) + SLOP_PX) {
          reset(); // a scroll up, or a sideways swipe
          return;
        }
        if (dy < SLOP_PX) return;
        claimed = true;
      }
      // The page stays put under a claimed pull.
      if (e.cancelable) e.preventDefault();
      setPull({ dy: Math.max(0, dy), top: start.top });
    };

    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const id = start.id;
      if (![...e.changedTouches].some((t) => t.identifier === id)) return;
      const commit = claimed && dy >= COMMIT_PX && e.touches.length === 0;
      reset();
      if (!commit) return;
      const event = new Event(PULL_REFRESH_EVENT, { cancelable: true });
      if (window.dispatchEvent(event)) window.location.reload();
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: a claimed pull must stop the page scrolling.
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", reset);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, [installed]);

  if (!pull) return null;
  const progress = Math.min(pull.dy / COMMIT_PX, 1);
  const ready = progress >= 1;
  const turn = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <div
      aria-hidden
      data-horde="pull-to-refresh"
      data-ready={ready ? "true" : undefined}
      // Glass over whatever is under the top bar; the accent only tints it.
      className={`pointer-events-none fixed left-1/2 z-50 flex h-10 w-10 items-center justify-center rounded-full shadow-lg ring-1 backdrop-blur-md transition-colors duration-150 ${
        ready
          ? "bg-accent/15 text-accent ring-accent/60"
          : "bg-ink-900/60 text-gray-300 ring-ink-600"
      }`}
      style={{
        top: pull.top,
        opacity: 0.4 + 0.6 * progress,
        transform: `translate(-50%, ${-40 + Math.min(pull.dy, COMMIT_PX * 1.4) * DAMPING}px)`,
      }}
    >
      <span
        className="flex"
        // The mark turns with the pull, unless motion is reduced.
        style={turn ? { transform: `rotate(${progress * 270}deg)` } : undefined}
      >
        <RefreshIcon className="text-xl" />
      </span>
    </div>
  );
}
