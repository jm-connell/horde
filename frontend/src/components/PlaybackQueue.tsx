import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { thumbnailUrl } from "../api";
import {
  usePlaybackActions,
  usePlaybackSession,
} from "../context/PlaybackContext";
import {
  isQueuedStream,
  queueKey,
  type QueueEntry,
} from "../context/playbackQueue";
import Collapse from "./Collapse";
import { ChevronIcon, CloseIcon, GripIcon } from "./icons";

const EXIT_MS = 150;

interface Props {
  className?: string;
  onPlay?: () => void;
  collapsible?: boolean;
  listMaxHeightClass?: string;
}

export default function PlaybackQueue({
  className = "",
  onPlay,
  collapsible = false,
  listMaxHeightClass = "",
}: Props) {
  const navigate = useNavigate();
  const { queue } = usePlaybackSession();
  const { playVideo, removeFromQueue, reorderQueue, clearQueue } =
    usePlaybackActions();
  const dragIndex = useRef<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const prevLen = useRef(queue.length);
  const [expanded, setExpanded] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  // Rows already queued when the panel mounted appear at once; only rows
  // added while it is on screen slide in.
  const [initialKeys] = useState(() => new Set(queue.map(queueKey)));
  // Rows on their way out: they fade and slide for EXIT_MS, then leave the
  // queue, so a removal is seen rather than a row vanishing.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (queue.length > prevLen.current && listRef.current) {
      const el = listRef.current;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
    prevLen.current = queue.length;
  }, [queue.length]);

  if (queue.length === 0) return null;

  const play = (entry: QueueEntry) => {
    if (isQueuedStream(entry)) {
      // Not downloaded: its watch page loads and plays it.
      removeFromQueue(queueKey(entry));
      navigate(entry.href);
    } else {
      playVideo(entry);
      navigate(`/watch/${entry.id}`);
    }
    onPlay?.();
  };

  const scrollable = Boolean(collapsible && listMaxHeightClass);

  const remove = (key: string) => {
    setLeaving((s) => new Set(s).add(key));
    window.setTimeout(() => {
      removeFromQueue(key);
      setLeaving((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }, EXIT_MS);
  };

  const list = (
    <ul
      ref={listRef}
      className={`space-y-1 horde-scrollbar ${
        scrollable ? `${listMaxHeightClass} overflow-y-auto` : ""
      }`}
    >
      {queue.map((v, index) => {
        const stream = isQueuedStream(v);
        const thumb = stream ? v.thumbnail : thumbnailUrl(v);
        const key = queueKey(v);
        return (
          <li
            key={key}
            draggable
            onDragStart={() => {
              dragIndex.current = index;
              setDragging(key);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIndex.current !== null) {
                reorderQueue(dragIndex.current, index);
              }
              dragIndex.current = null;
            }}
            onDragEnd={() => {
              dragIndex.current = null;
              setDragging(null);
            }}
            className={`flex items-center gap-2 rounded-lg p-1 transition-[opacity,translate] ease-fluid hover:bg-ink-800 ${
              leaving.has(key)
                ? "pointer-events-none translate-x-2 opacity-0 duration-150 motion-reduce:translate-x-0"
                : "duration-200"
            } ${dragging === key ? "opacity-50" : ""} ${
              initialKeys.has(key)
                ? ""
                : "starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0"
            }`}
          >
            <span
              className="shrink-0 cursor-grab px-1 text-muted active:cursor-grabbing"
              title="Drag to reorder"
            >
              <GripIcon />
            </span>
            <button
              onClick={() => play(v)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <div className="h-10 w-16 shrink-0 overflow-hidden rounded-sm bg-ink-800">
                {thumb && (
                  <img
                    loading="lazy"
                    decoding="async"
                    width={64}
                    height={40}
                    src={thumb}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              <span className="min-w-0 flex-1">
                <span
                  className="line-clamp-2 wrap-break-word text-sm leading-snug text-gray-200"
                  title={v.title}
                >
                  {v.title}
                </span>
                {stream && (
                  <span className="block truncate text-[11px] text-muted">
                    Not downloaded
                    {v.channel ? ` · ${v.channel}` : ""}
                  </span>
                )}
              </span>
            </button>
            <button
              onClick={() => remove(key)}
              className="shrink-0 px-2 text-muted hover:text-accent"
              title="Remove"
            >
              <CloseIcon />
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div
      className={`ui-panel rounded-xl border border-ink-700 bg-ink-900 p-4 ring-1 ring-ink-700 ${className}`}
    >
      {collapsible ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex min-w-0 flex-1 items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
          >
            <span>Up next ({queue.length})</span>
            <span
              aria-hidden
              className={`inline-block transition-transform duration-200 ease-fluid ${
                expanded ? "rotate-180" : ""
              }`}
            >
              <ChevronIcon />
            </span>
          </button>
          <button
            onClick={clearQueue}
            className="shrink-0 text-xs text-muted hover:text-accent"
          >
            Clear
          </button>
        </div>
      ) : (
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Up next ({queue.length})
          </h3>
          <button
            onClick={clearQueue}
            className="text-xs text-muted hover:text-accent"
          >
            Clear
          </button>
        </div>
      )}

      {collapsible ? (
        <Collapse open={expanded} durationClass="duration-200">
          {list}
        </Collapse>
      ) : (
        list
      )}
    </div>
  );
}
