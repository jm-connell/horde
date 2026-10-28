import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { spritesImageUrl } from "../../api";
import { formatDuration, formatTimestamp, type Chapter } from "../../utils";
import { scrubPositionFromClientX } from "../playerSeek";
import type { Storyboard } from "../../types";
import type { ClipBarRange } from "./clipMarkers";
import { storyboardTileStyle } from "./storyboardTile";
import { isChapterActive } from "./useChapters";
import { useSeekSprites } from "./useSeekSprites";

interface Props {
  /** The pointer-handling track; the player also uses it to lift captions. */
  scrubberRef: RefObject<HTMLDivElement | null>;
  videoId?: number;
  /** A stream's YouTube storyboard, for previews when there are no sprites. */
  storyboard?: Storyboard | null;
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
  /** The clip being picked: its ends and the span between them. */
  clipRange?: ClipBarRange | null;
  /** A clip end was dragged to this position along the bar (no seek). */
  onClipMove?: (which: "start" | "end", sec: number) => void;
}

type ClipEnd = "start" | "end";

/**
 * The clip being picked: the span between its ends and a draggable handle on
 * each (arrow keys nudge a focused handle by 1 s, Shift by 10 s). Moving a
 * handle never seeks; `onMove` reports the new position along the bar.
 */
function ClipRangeMarks({
  range,
  duration,
  scrubberRef,
  formatTime,
  onMove,
  onDrag,
  onDragEnd,
}: {
  range: ClipBarRange;
  duration: number;
  scrubberRef: RefObject<HTMLDivElement | null>;
  formatTime: (sec: number) => string;
  onMove?: (which: ClipEnd, sec: number) => void;
  /** While dragging: where the handle is (shows the hover preview there). */
  onDrag: (pos: { time: number; pct: number }) => void;
  onDragEnd: () => void;
}) {
  const pct = (sec: number | null) =>
    sec == null || sec < 0 || sec > duration ? null : (sec / duration) * 100;
  const start = pct(range.start);
  const end = pct(range.end);
  // Where each end was last moved to. A held arrow key repeats faster than a
  // move comes back round through the clip panel as a new `range`.
  const latest = useRef(range);
  useEffect(() => {
    latest.current = range;
  }, [range]);

  const handle = (which: ClipEnd, sec: number | null, at: number | null) => {
    if (sec == null || at == null) return null;
    const label = which === "start" ? "Clip start" : "Clip end";
    const tick = (
      <span className="absolute left-1/2 top-1/2 block h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 group-hover:w-1 group-focus-visible:w-1" />
    );
    if (!onMove) {
      return (
        <span
          key={which}
          className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${at}%` }}
        >
          {tick}
        </span>
      );
    }
    const moveTo = (clientX: number) => {
      const el = scrubberRef.current;
      if (!el) return;
      const pos = scrubPositionFromClientX(
        clientX,
        el.getBoundingClientRect(),
        duration
      );
      if (!pos) return;
      onDrag(pos);
      onMove(which, pos.time);
    };
    return (
      <span
        key={which}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.round(sec)}
        aria-valuetext={formatTime(sec)}
        title={`${label}: drag to move`}
        className="group pointer-events-auto absolute top-1/2 z-20 h-6 w-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none outline-hidden"
        style={{ left: `${at}%` }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          moveTo(e.clientX);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          e.stopPropagation();
          moveTo(e.clientX);
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          onDragEnd();
        }}
        onPointerCancel={onDragEnd}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 1;
          const delta =
            e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
          if (!delta) return;
          // Not the player's seek shortcut: this moves the clip, not playback.
          e.preventDefault();
          e.stopPropagation();
          const from = latest.current[which] ?? sec;
          const to = Math.min(duration, Math.max(0, from + delta));
          latest.current = { ...latest.current, [which]: to };
          onMove(which, to);
        }}
      >
        {tick}
      </span>
    );
  };

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 h-full"
      data-testid="clip-range"
    >
      {start != null && end != null && end > start && (
        <span
          aria-hidden
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-amber-400/45"
          style={{ left: `${start}%`, width: `${end - start}%` }}
        />
      )}
      {handle("start", range.start, start)}
      {handle("end", range.end, end)}
    </div>
  );
}

/** Seek bar: pointer scrubbing, hover thumbnails and chapter markers. */
export default function ScrubBar({
  scrubberRef,
  videoId,
  storyboard = null,
  current,
  duration,
  chapters,
  hoveredChapter,
  onHoverChapter,
  seekTo,
  formatTime = formatTimestamp,
  onInteractionStart,
  onInteractionEnd,
  clipRange = null,
  onClipMove,
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
          } else if (storyboard) {
            tileStyle = storyboardTileStyle(storyboard, time) ?? undefined;
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
      {clipRange && duration > 0 && (
        <ClipRangeMarks
          range={clipRange}
          duration={duration}
          scrubberRef={scrubberRef}
          formatTime={formatTime}
          onMove={onClipMove}
          onDrag={(pos) => {
            onInteractionStart();
            setScrubHover(pos);
          }}
          onDragEnd={() => {
            onInteractionEnd();
            setScrubHover(null);
          }}
        />
      )}
      {/* Chapter markers */}
      {chapters.length > 0 && duration > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-full">
          {chapters.slice(1).map((ch, i) => {
            const chapterIndex = i + 1;
            // Chapter lists from metadata can outrun the file (a trimmed or
            // partial download); a marker past the end would be an invisible,
            // still focusable button.
            if (ch.startSec >= duration) return null;
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
