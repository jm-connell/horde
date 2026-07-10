import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { thumbnailUrl } from "../api";
import { usePlayback } from "../context/PlaybackContext";

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
  const { queue, playVideo, removeFromQueue, reorderQueue, clearQueue } =
    usePlayback();
  const dragIndex = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(true);

  if (queue.length === 0) return null;

  const play = (video: (typeof queue)[number]) => {
    playVideo(video);
    navigate(`/watch/${video.id}`);
    onPlay?.();
  };

  const showList = !collapsible || expanded;

  return (
    <div
      className={`ui-panel ui-panel-legible rounded-xl border border-ink-700 bg-ink-900 p-4 ring-1 ring-ink-700 ${className}`}
    >
      {collapsible ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex min-w-0 flex-1 items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
          >
            <span>Up next ({queue.length})</span>
            <span>{expanded ? "▲" : "▼"}</span>
          </button>
          <button
            onClick={clearQueue}
            className="shrink-0 text-xs text-gray-500 hover:text-accent"
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
            className="text-xs text-gray-500 hover:text-accent"
          >
            Clear
          </button>
        </div>
      )}

      {showList && (
        <ul
          className={`space-y-1 ${collapsible && listMaxHeightClass ? `${listMaxHeightClass} overflow-y-auto` : ""}`}
        >
          {queue.map((v, index) => {
            const thumb = thumbnailUrl(v);
            return (
              <li
                key={v.id}
                draggable
                onDragStart={() => (dragIndex.current = index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex.current !== null) {
                    reorderQueue(dragIndex.current, index);
                  }
                  dragIndex.current = null;
                }}
                onDragEnd={() => (dragIndex.current = null)}
                className="flex items-center gap-2 rounded-lg p-1 hover:bg-ink-800"
              >
                <span
                  className="shrink-0 cursor-grab px-1 text-gray-600 active:cursor-grabbing"
                  title="Drag to reorder"
                >
                  ⠿
                </span>
                <button
                  onClick={() => play(v)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-ink-800">
                    {thumb && (
                      <img
                        src={thumb}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <span className="min-w-0 flex-1 line-clamp-2 text-sm leading-snug text-gray-200">
                    {v.title}
                  </span>
                </button>
                <button
                  onClick={() => removeFromQueue(v.id)}
                  className="shrink-0 px-2 text-gray-500 hover:text-accent"
                  title="Remove"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
