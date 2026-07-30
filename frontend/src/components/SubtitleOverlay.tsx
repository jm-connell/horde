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
    setView([]);
    const stack = stackRef.current;
    if (stack) {
      stack.style.transition = "none";
      stack.style.transform = "translateY(0)";
    }
  }, [src]);

  useEffect(() => {
    if (!active || lines.length === 0) return;
    let raf = 0;

    const snapStack = () => {
      const stack = stackRef.current;
      if (!stack) return;
      stack.style.transition = "none";
      stack.style.transform = "translateY(0)";
    };

    const slideUp = () => {
      const stack = stackRef.current;
      if (!stack || slidingRef.current) return;
      const lineEl = stack.querySelector(
        ".subtitle-overlay-line"
      ) as HTMLElement | null;
      const lineH = lineEl?.offsetHeight ?? 0;
      if (lineH <= 0) return;
      slidingRef.current = true;
      stack.style.transition = "none";
      stack.style.transform = "translateY(0)";
      void stack.offsetHeight;
      requestAnimationFrame(() => {
        const el = stackRef.current;
        if (!el) {
          slidingRef.current = false;
          return;
        }
        el.style.transition = `transform ${SLIDE_MS}ms ease-out`;
        el.style.transform = `translateY(-${lineH}px)`;
        window.setTimeout(() => {
          // After the slide, drop the top line and reset transform.
          setView((prev) => {
            if (prev.length <= 2) return prev;
            return prev.slice(prev.length - 2);
          });
          snapStack();
          slidingRef.current = false;
        }, SLIDE_MS);
      });
    };

    const tick = () => {
      const v = videoRef.current;
      if (v && !slidingRef.current) {
        const t = v.currentTime;
        const idx = findCaptionLineIndex(lines, t);
        const words = idx >= 0 ? revealedWordCount(lines[idx], t) : 0;
        const prevIdx = lineIndexRef.current;

        if (idx !== prevIdx) {
          const jumped = prevIdx < 0 || idx < prevIdx || idx - prevIdx > 1;
          lineIndexRef.current = idx;
          wordCountRef.current = words;

          if (idx < 0) {
            setView([]);
            snapStack();
          } else if (jumped || prevIdx < 0) {
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
              return [
                ...finalized,
                {
                  key: idx,
                  fullText: lines[idx].text,
                  words: revealed,
                },
              ];
            });
            requestAnimationFrame(() => {
              if (shouldSlide) {
                slideUp();
              } else {
                setView((prev) => prev.slice(-2));
                snapStack();
              }
            });
          }
        } else if (idx >= 0 && words !== wordCountRef.current) {
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
