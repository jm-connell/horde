import { useEffect, useRef, useState } from "react";

/** Pull this far (after damping) and let go to refresh. */
const COMMIT_PX = 64;
/** The indicator stops following the finger here. */
const MAX_PX = 96;
/** Movement before a touch reads as a pull (down) or something else. */
const SLOP_PX = 10;
/** The finger moves this much further than the indicator. */
const DAMPING = 0.5;
/** A refresh shows its spinner at least this long, so it reads as done. */
const MIN_SPIN_MS = 500;

/** Only the installed app on a touch screen: a browser tab pulls to reload
 *  by itself, and the installed app turns that off (index.css). */
function isInstalledTouchApp(): boolean {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone && window.matchMedia?.("(pointer: coarse)").matches;
}

/** Touches that are not a pull on the page: dialogs, fields, fixed layers
 *  (mini player, sheets, bars) and anything scrolled inside itself. */
function blocksPull(target: EventTarget | null): boolean {
  if (document.querySelector('[aria-modal="true"]')) return true;
  for (
    let el = target instanceof Element ? target : null;
    el && el !== document.body;
    el = el.parentElement
  ) {
    if (el.matches("video, input, textarea, select, [role='slider']"))
      return true;
    if (el.scrollTop > 0) return true;
    if (getComputedStyle(el).position === "fixed") return true;
  }
  return false;
}

/**
 * Pull the page down from its top to refresh, as in a native app. Only in the
 * installed app on a phone or tablet; `onRefresh` runs on release past the
 * mark, and a spinner shows until it settles.
 */
export default function PullToRefresh({
  onRefresh,
}: {
  onRefresh: () => Promise<unknown> | void;
}) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const busy = useRef(false);

  useEffect(() => {
    if (!isInstalledTouchApp()) return;
    let start: { x: number; y: number; id: number } | null = null;
    let claimed = false;
    let dist = 0;

    const reset = () => {
      start = null;
      claimed = false;
      dist = 0;
      setPull(0);
    };

    const onStart = (e: TouchEvent) => {
      if (start) {
        reset(); // a second finger: not a pull
        return;
      }
      if (busy.current || e.touches.length !== 1 || window.scrollY > 0) return;
      if (blocksPull(e.target)) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, id: t.identifier };
    };

    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      if (e.touches.length !== 1 || t.identifier !== start.id) {
        reset();
        return;
      }
      const dy = t.clientY - start.y;
      const dx = t.clientX - start.x;
      if (!claimed) {
        if (Math.abs(dx) > SLOP_PX && Math.abs(dx) > Math.abs(dy)) {
          reset(); // a sideways swipe (a row, the edge swipe)
          return;
        }
        if (dy < SLOP_PX) {
          if (dy < -SLOP_PX) reset(); // scrolling down the page
          return;
        }
        claimed = true;
      }
      if (e.cancelable) e.preventDefault();
      dist = Math.min(MAX_PX, Math.max(0, (dy - SLOP_PX) * DAMPING));
      setPull(dist);
    };

    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const id = start.id;
      if (![...e.changedTouches].some((t) => t.identifier === id)) return;
      const commit = claimed && dist >= COMMIT_PX;
      reset();
      if (!commit) return;
      busy.current = true;
      setRefreshing(true);
      const started = Date.now();
      void Promise.resolve()
        .then(() => refreshRef.current())
        .catch(() => undefined)
        .then(
          () =>
            new Promise((r) =>
              window.setTimeout(r, MIN_SPIN_MS - (Date.now() - started))
            )
        )
        .finally(() => {
          busy.current = false;
          setRefreshing(false);
        });
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: a claimed pull must stop the page moving.
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", reset);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, []);

  if (!pull && !refreshing) return null;
  const progress = refreshing ? 1 : Math.min(pull / COMMIT_PX, 1);
  const ready = progress >= 1;
  return (
    <div
      role={refreshing ? "status" : undefined}
      aria-label={refreshing ? "Refreshing" : undefined}
      data-horde="pull-to-refresh"
      data-ready={ready ? "true" : undefined}
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center"
      style={{
        top: `calc(env(safe-area-inset-top, 0px) + ${refreshing ? 56 : 8 + pull * 0.6}px)`,
      }}
    >
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-full shadow-xl ring-1 transition-colors duration-150 ${
          ready
            ? "bg-accent text-on-accent ring-accent"
            : "bg-ink-800 text-gray-300 ring-ink-600"
        }`}
        style={{ opacity: 0.4 + 0.6 * progress }}
      >
        <svg
          viewBox="0 0 24 24"
          className={`h-5 w-5 ${refreshing ? "animate-spin" : ""}`}
          style={refreshing ? undefined : { rotate: `${progress * 270}deg` }}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 4v5h-5" />
        </svg>
      </span>
    </div>
  );
}
