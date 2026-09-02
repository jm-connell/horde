import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { SubtitleSize } from "../hooks/useSettings";
import {
  findCaptionLineIndex,
  parseVttLines,
  revealedWordCount,
  shouldHoldCaption,
  type CaptionLine,
} from "../utils/vtt";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  src: string;
  size: SubtitleSize;
  /** Horizontal position as % from the left of the player. */
  left: number;
  /** Vertical position as % from the bottom of the player. */
  offset: number;
  active: boolean;
  onPositionChange?: (left: number, offset: number) => void;
}

const SLIDE_MS = 250;

type ViewLine = {
  key: number;
  /** Full line text — sizes the row so width stays stable while words reveal. */
  fullText: string;
  /** Words to show; null means fully revealed (previous line). */
  words: string[] | null;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export default function SubtitleOverlay({
  videoRef,
  src,
  size,
  left,
  offset,
  active,
  onPositionChange,
}: Props) {
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [view, setView] = useState<ViewLine[]>([]);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const lineIndexRef = useRef(-1);
  const wordCountRef = useRef(0);
  const slidingRef = useRef(false);
  const slideGenRef = useRef(0);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startLeft: number;
    startOffset: number;
    parentW: number;
    parentH: number;
  } | null>(null);

  useEffect(() => {
    if (!active || !src) {
      setLines([]);
      setView([]);
      lineIndexRef.current = -1;
      wordCountRef.current = 0;
      return;
    }
    const controller = new AbortController();
    fetch(src, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`subtitle fetch ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (controller.signal.aborted) return;
        setLines(parseVttLines(text));
      })
      .catch(() => {
        if (!controller.signal.aborted) setLines([]);
      });
    return () => controller.abort();
  }, [src, active]);

  useLayoutEffect(() => {
    lineIndexRef.current = -1;
    wordCountRef.current = 0;
    slidingRef.current = false;
    slideGenRef.current += 1;
    setView([]);
    const stack = stackRef.current;
    if (stack) {
      stack.style.transition = "none";
      stack.style.transform = "translateY(0)";
    }
  }, [src]);

  // Drive rollup from committed DOM: 3 rows → slide, then 2 rows → snap
  // transform in the same layout pass so the old pair never flashes back.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;

    if (view.length <= 2) {
      if (slidingRef.current) {
        stack.style.transition = "none";
        stack.style.transform = "translateY(0)";
        slidingRef.current = false;
      }
      return;
    }

    const lineEl = stack.querySelector(
      ".subtitle-overlay-line"
    ) as HTMLElement | null;
    const lineH = lineEl?.offsetHeight ?? 0;
    if (lineH <= 0) {
      slidingRef.current = false;
      setView((prev) => (prev.length > 2 ? prev.slice(-2) : prev));
      return;
    }

    slidingRef.current = true;
    stack.style.transition = "none";
    stack.style.transform = "translateY(0)";
    void stack.offsetHeight;

    const gen = ++slideGenRef.current;
    const el = stack;
    let timer = 0;
    let raf = 0;
    let finished = false;
    const onEnd = (ev: TransitionEvent) => {
      if (ev.propertyName !== "transform") return;
      finish();
    };
    function finish() {
      if (finished || gen !== slideGenRef.current) return;
      finished = true;
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      setView((prev) => prev.slice(-2));
    }

    raf = requestAnimationFrame(() => {
      if (gen !== slideGenRef.current) return;
      el.style.transition = `transform ${SLIDE_MS}ms ease-out`;
      el.style.transform = `translateY(-${lineH}px)`;
      el.addEventListener("transitionend", onEnd);
      timer = window.setTimeout(finish, SLIDE_MS + 40);
    });

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      el.removeEventListener("transitionend", onEnd);
      slideGenRef.current += 1;
    };
  }, [view]);

  useEffect(() => {
    if (!active || lines.length === 0) {
      slidingRef.current = false;
      return;
    }
    let raf = 0;

    const snapStack = () => {
      const stack = stackRef.current;
      if (!stack) return;
      stack.style.transition = "none";
      stack.style.transform = "translateY(0)";
    };

    const tick = () => {
      const v = videoRef.current;
      if (v && !slidingRef.current) {
        const t = v.currentTime;
        const idx = findCaptionLineIndex(lines, t);
        const words = idx >= 0 ? revealedWordCount(lines[idx], t) : 0;
        const prevIdx = lineIndexRef.current;

        if (idx < 0) {
          if (prevIdx !== -1 && !shouldHoldCaption(lines, prevIdx, t)) {
            lineIndexRef.current = -1;
            wordCountRef.current = 0;
            setView([]);
            snapStack();
          }
        } else if (idx !== prevIdx) {
          const jumped = prevIdx < 0 || idx < prevIdx || idx - prevIdx > 1;
          lineIndexRef.current = idx;
          wordCountRef.current = words;

          if (jumped || prevIdx < 0) {
            // Seek / first cue — snap to previous + current.
            const nextView: ViewLine[] = [];
            if (idx > 0) {
              nextView.push({
                key: idx - 1,
                fullText: lines[idx - 1].text,
                words: null,
              });
            }
            const revealed = lines[idx].words
              .slice(0, words)
              .map((w) => w.text);
            nextView.push({
              key: idx,
              fullText: lines[idx].text,
              words: revealed,
            });
            setView(nextView);
            snapStack();
          } else {
            // Advance one line: append new line, then slide if we already
            // had a two-line stack (otherwise just grow to two lines).
            const revealed = lines[idx].words
              .slice(0, words)
              .map((w) => w.text);
            const shouldSlide = prevIdx > 0;
            setView((prev) => {
              const finalized = prev.map((row, i) =>
                i === prev.length - 1
                  ? {
                      key: row.key,
                      fullText: lines[prevIdx]?.text ?? row.fullText,
                      words: null as string[] | null,
                    }
                  : row
              );
              const next = [
                ...finalized,
                {
                  key: idx,
                  fullText: lines[idx].text,
                  words: revealed,
                },
              ];
              return shouldSlide ? next : next.slice(-2);
            });
            if (!shouldSlide) snapStack();
          }
        } else if (words !== wordCountRef.current) {
          wordCountRef.current = words;
          const revealed = lines[idx].words.slice(0, words).map((w) => w.text);
          setView((prev) => {
            if (prev.length === 0) return prev;
            const copy = prev.slice();
            const last = copy[copy.length - 1];
            if (last.key !== idx) return prev;
            copy[copy.length - 1] = {
              key: idx,
              fullText: lines[idx].text,
              words: revealed,
            };
            return copy;
          });
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, lines, videoRef]);

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onPositionChange || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const root = rootRef.current;
    const parent = root?.offsetParent as HTMLElement | null;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: left,
      startOffset: offset,
      parentW: rect.width,
      parentH: rect.height,
    };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !onPositionChange) return;
    e.stopPropagation();
    const root = rootRef.current;
    const boxW = root?.offsetWidth ?? 0;
    const boxH = root?.offsetHeight ?? 0;
    const maxLeft =
      drag.parentW > 0
        ? Math.max(0, ((drag.parentW - boxW) / drag.parentW) * 100)
        : 90;
    const maxBottom =
      drag.parentH > 0
        ? Math.max(0, ((drag.parentH - boxH) / drag.parentH) * 100)
        : 85;
    const dxPct = ((e.clientX - drag.startX) / drag.parentW) * 100;
    const dyPct = ((drag.startY - e.clientY) / drag.parentH) * 100;
    onPositionChange(
      clamp(Math.round(drag.startLeft + dxPct), 0, maxLeft),
      clamp(Math.round(drag.startOffset + dyPct), 0, maxBottom)
    );
  };

  if (!active || view.length === 0) return null;

  const canDrag = Boolean(onPositionChange);

  return (
    <div
      ref={rootRef}
      className={`subtitle-overlay subtitle-overlay-${size}${
        dragging ? " subtitle-overlay-dragging" : ""
      }${canDrag ? " subtitle-overlay-draggable" : ""}`}
      style={{
        left: `${clamp(left, 0, 90)}%`,
        bottom: `${clamp(offset, 0, 85)}%`,
      }}
      aria-hidden
      onPointerDown={canDrag ? onPointerDown : undefined}
      onPointerMove={canDrag ? onPointerMove : undefined}
      onPointerUp={canDrag ? endDrag : undefined}
      onPointerCancel={canDrag ? endDrag : undefined}
    >
      <div className="subtitle-overlay-clip">
        <div ref={stackRef} className="subtitle-overlay-stack">
          {view.map((row) => {
            const visible =
              row.words == null ? row.fullText : row.words.join(" ");
            return (
              <div key={row.key} className="subtitle-overlay-line">
                <span className="subtitle-overlay-text">
                  {/* Invisible full line sets width so the row stays put while words reveal. */}
                  <span className="subtitle-overlay-measure" aria-hidden>
                    {row.fullText}
                  </span>
                  <span className="subtitle-overlay-visible">{visible}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
