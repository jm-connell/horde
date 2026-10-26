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
  const [dragging, setDragging] = useState<number | null>(null);
  // Rows already queued when the panel mounted appear at once; only rows
  // added while it is on screen slide in.
  const [initialKeys] = useState(() => new Set(queue.map(queueKey)));

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
              className={`inline-block transition-transform duration-200 ease-out ${
                expanded ? "rotate-180" : ""
              }`}
            >
              ▼
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

      <Collapse open={!collapsible || expanded} durationClass="duration-200">
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
                  setDragging(index);
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
                className={`flex items-center gap-2 rounded-lg p-1 transition-[opacity,translate] duration-200 ease-out hover:bg-ink-800 ${
                  dragging === index ? "opacity-50" : ""
                } ${
                  initialKeys.has(key)
                    ? ""
                    : "starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0"
                }`}
              >
                <span
                  className="shrink-0 cursor-grab px-1 text-muted active:cursor-grabbing"
                  title="Drag to reorder"
                >
                  ⠿
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
                    <span className="line-clamp-2 text-sm leading-snug text-gray-200">
                      {v.title}
                    </span>
                    {stream && (
                      <span className="text-[11px] text-muted">
                        Not downloaded
                        {v.channel ? ` · ${v.channel}` : ""}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  onClick={() => removeFromQueue(queueKey(v))}
                  className="shrink-0 px-2 text-muted hover:text-accent"
                  title="Remove"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      </Collapse>
    </div>
  );
}
