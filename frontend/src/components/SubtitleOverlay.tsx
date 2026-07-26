import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
  offset: number;
  active: boolean;
}

const SLIDE_MS = 250;

type ViewLine = {
  key: number;
  /** Full line text — sizes the row so the centered block stays stable. */
  fullText: string;
  /** Words to show; null means fully revealed (previous line). */
  words: string[] | null;
};

export default function SubtitleOverlay({
  videoRef,
  src,
  size,
  offset,
  active,
}: Props) {
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [view, setView] = useState<ViewLine[]>([]);
  const stackRef = useRef<HTMLDivElement>(null);
  const lineIndexRef = useRef(-1);
  const wordCountRef = useRef(0);
  const slidingRef = useRef(false);

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

  if (!active || view.length === 0) return null;

  return (
    <div
      className={`subtitle-overlay subtitle-overlay-${size}`}
      style={{ bottom: `${Math.max(0, Math.min(40, offset))}%` }}
      aria-hidden
    >
      <div className="subtitle-overlay-clip">
        <div ref={stackRef} className="subtitle-overlay-stack">
          {view.map((row) => {
            const visible =
              row.words == null ? row.fullText : row.words.join(" ");
            return (
              <div key={row.key} className="subtitle-overlay-line">
                <span className="subtitle-overlay-text">
                  {/* Invisible full line sets width so the centered block stays put. */}
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
