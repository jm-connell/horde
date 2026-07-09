import { Link, useNavigate } from "react-router-dom";
import { thumbnailUrl } from "../api";
import { usePlayback } from "../context/PlaybackContext";
import type { Video } from "../types";
import { formatDuration, formatResolution, formatViewCount } from "../utils";

export default function VideoCard({
  video,
  progress,
  hideQueueButton,
  showViewCount,
  selectable,
  selected,
  onSelect,
}: {
  video: Video;
  progress?: number;
  hideQueueButton?: boolean;
  showViewCount?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: number, e: React.MouseEvent) => void;
}) {
  const navigate = useNavigate();
  const { addToQueue } = usePlayback();
  const thumb = thumbnailUrl(video);
  const duration = formatDuration(video.duration_sec);
  const resolution = formatResolution(video.height_px);

  const handleClick = (e: React.MouseEvent) => {
    if (selectable) {
      e.preventDefault();
      onSelect?.(video.id, e);
    }
  };

  return (
    <Link
      to={`/watch/${video.id}`}
      onClick={handleClick}
      className={`ui-card group flex flex-col overflow-hidden rounded-xl bg-ink-900 ring-1 transition-all hover:ring-accent/60 ${
        selected ? "ring-accent" : "ring-ink-700"
      }`}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-ink-800">
        {thumb ? (
          <img
            src={thumb}
            alt={video.title}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-600">
            <span className="text-4xl">▶</span>
          </div>
        )}
        {duration && (
          <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-gray-100">
            {duration}
          </span>
        )}
        {progress !== undefined && progress > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div
              className="h-full bg-accent"
              style={{ width: `${Math.min(100, progress * 100)}%` }}
            />
          </div>
        )}
        {selectable ? (
          <div
            className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded border-2 transition-colors ${
              selected
                ? "border-accent bg-accent shadow-sm"
                : "border-white/80 bg-black/50 group-hover:border-accent"
            }`}
          >
            {selected && (
              <svg
                className="h-3 w-3 text-white"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden
              >
                <path
                  d="M2 6l3 3 5-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        ) : (
          <button
            onClick={(e) => {
              e.preventDefault();
              addToQueue(video);
            }}
            title="Add to queue"
            className={`absolute right-2 top-2 rounded bg-black/70 px-2 py-1 text-xs font-medium text-gray-100 transition-opacity hover:bg-accent hover:text-ink-950 ${
              hideQueueButton
                ? "hidden"
                : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
            }`}
          >
            + Queue
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1 p-3">
        <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold text-gray-100 group-hover:text-accent">
          {video.title}
        </h3>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {video.channel && (
              <span
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/?channel=${encodeURIComponent(video.channel!)}`);
                }}
                className="w-fit truncate text-xs text-gray-400 hover:text-accent"
              >
                {video.channel}
              </span>
            )}
            {showViewCount && video.view_count !== null && (
              <span className="text-xs text-gray-500">
                {formatViewCount(video.view_count)}
              </span>
            )}
          </div>
          {resolution && (
            <span className="shrink-0 text-[10px] font-medium text-gray-500">
              {resolution}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
