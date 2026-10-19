import { useCallback, useState, type RefObject } from "react";
import { spritesImageUrl } from "../../api";
import { formatDuration, formatTimestamp, type Chapter } from "../../utils";
import { scrubPositionFromClientX } from "../playerSeek";
import { isChapterActive } from "./useChapters";
import { useSeekSprites } from "./useSeekSprites";

interface Props {
  /** The pointer-handling track; the player also uses it to lift captions. */
  scrubberRef: RefObject<HTMLDivElement | null>;
  videoId?: number;
  current: number;
  duration: number;
  chapters: Chapter[];
  hoveredChapter: Chapter | null;
  onHoverChapter: (startSec: number | null) => void;
  seekTo: (sec: number) => void;
  /** Hover label for a position (default: its timestamp). */
  formatTime?: (sec: number) => string;
  /** Keep the control bar up while the pointer is dragging the thumb. */
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
}

/** Seek bar: pointer scrubbing, hover thumbnails and chapter markers. */
export default function ScrubBar({
  scrubberRef,
  videoId,
  current,
  duration,
  chapters,
  hoveredChapter,
  onHoverChapter,
  seekTo,
  formatTime = formatTimestamp,
  onInteractionStart,
  onInteractionEnd,
}: Props) {
  const spriteMeta = useSeekSprites(videoId);
  const [scrubHover, setScrubHover] = useState<{
    time: number;
    pct: number;
  } | null>(null);

  const scrubFromClientX = useCallback(
    (clientX: number, hoverOnly = false) => {
      const el = scrubberRef.current;
      if (!el) return;
      const pos = scrubPositionFromClientX(
        clientX,
        el.getBoundingClientRect(),
        duration
      );
      if (!pos) return;
      setScrubHover(pos);
      if (!hoverOnly) seekTo(pos.time);
    },
    [scrubberRef, duration, seekTo]
  );

  const onScrubPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      onInteractionStart();
      scrubFromClientX(e.clientX);
    },
    [onInteractionStart, scrubFromClientX]
  );

  const onScrubPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const dragging = e.currentTarget.hasPointerCapture(e.pointerId);
      scrubFromClientX(e.clientX, !dragging);
    },
    [scrubFromClientX]
  );

  const onScrubPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      onInteractionEnd();
    },
    [onInteractionEnd]
  );

  const onScrubPointerLeave = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) return;
      setScrubHover(null);
    },
    []
  );

  // The native step is 0.1 s; match the global shortcuts (5 s) for the keyboard.
  const onSeekKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const delta =
      e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : null;
    if (delta === null) return;
    e.preventDefault();
    seekTo(current + delta);
  };

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    seekTo(t);
    if (duration > 0) {
      setScrubHover({ time: t, pct: (t / duration) * 100 });
    }
  };

  const progressPct = duration > 0 ? (current / duration) * 100 : 0;

  const scrubPreview =
    scrubHover && duration > 0
      ? (() => {
          const { time, pct } = scrubHover;
          let tileStyle: React.CSSProperties | undefined;
          if (spriteMeta && videoId != null && spriteMeta.count > 0) {
            const idx = Math.min(
              spriteMeta.count - 1,
              Math.max(0, Math.floor(time / spriteMeta.interval_sec))
            );
            const col = idx % spriteMeta.columns;
            const row = Math.floor(idx / spriteMeta.columns);
            const rows = Math.max(
              1,
              Math.ceil(spriteMeta.count / spriteMeta.columns)
            );
            const sheetW = spriteMeta.columns * spriteMeta.tile_width;
            const sheetH = rows * spriteMeta.tile_height;
            tileStyle = {
              width: spriteMeta.tile_width,
              height: spriteMeta.tile_height,
              backgroundImage: `url(${spritesImageUrl(videoId)})`,
              backgroundRepeat: "no-repeat",
              backgroundSize: `${sheetW}px ${sheetH}px`,
              backgroundPosition: `-${col * spriteMeta.tile_width}px -${row * spriteMeta.tile_height}px`,
            };
          }
          return {
            time,
            pct: Math.min(92, Math.max(8, pct)),
            tileStyle,
          };
        })()
      : null;

  return (
    <div
      ref={scrubberRef}
      className="relative -my-1.5 flex h-4 cursor-pointer touch-none items-center"
      onPointerDown={onScrubPointerDown}
      onPointerMove={onScrubPointerMove}
      onPointerUp={onScrubPointerUp}
      onPointerCancel={onScrubPointerUp}
      onPointerLeave={onScrubPointerLeave}
    >
      {scrubPreview && (
        <div
          className="pointer-events-none absolute bottom-full z-30 mb-2 -translate-x-1/2"
          style={{ left: `${scrubPreview.pct}%` }}
        >
          <div className="flex flex-col items-center gap-1">
            {scrubPreview.tileStyle && (
              <div
                className="overflow-hidden rounded-lg border border-white/20 bg-black shadow-lg"
                style={scrubPreview.tileStyle}
              />
            )}
            <span
              className={`rounded bg-black/90 px-1.5 py-0.5 text-xs ${
                hoveredChapter
                  ? "max-w-[min(280px,70vw)] whitespace-normal text-center text-gray-100"
                  : "font-mono text-accent"
              }`}
            >
              {hoveredChapter ? (
                <>
                  <span className="font-mono text-accent">
                    {formatTimestamp(hoveredChapter.startSec)}
                  </span>{" "}
                  {hoveredChapter.title}
                </>
              ) : (
                formatTime(scrubPreview.time)
              )}
            </span>
          </div>
        </div>
      )}
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={current}
        onChange={onSeek}
        onKeyDown={onSeekKeyDown}
        className="pointer-events-none accent-scrubber w-full"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={duration || 0}
        aria-valuenow={current}
        aria-valuetext={`${formatDuration(current)} of ${formatDuration(duration)}`}
        style={{
          background: `linear-gradient(to right, rgb(var(--accent)) ${progressPct}%, rgb(var(--ink-600)) ${progressPct}%)`,
        }}
      />
      {/* Chapter markers */}
      {chapters.length > 0 && duration > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-full">
          {chapters.slice(1).map((ch, i) => {
            const chapterIndex = i + 1;
            const active = isChapterActive(chapters, chapterIndex, current);
            return (
              <button
                key={ch.startSec}
                type="button"
                className="group pointer-events-auto absolute top-1/2 z-10 h-4 w-3 -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${(ch.startSec / duration) * 100}%` }}
                onPointerEnter={() => onHoverChapter(ch.startSec)}
                onPointerLeave={() => onHoverChapter(null)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  seekTo(ch.startSec);
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                title={`${formatTimestamp(ch.startSec)} — ${ch.title}`}
                aria-label={`Chapter ${ch.title} at ${formatTimestamp(ch.startSec)}`}
              >
                <span
                  className={`absolute left-1/2 top-1/2 block h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
                    active ? "bg-accent" : "bg-white/50 group-hover:bg-accent"
                  }`}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
