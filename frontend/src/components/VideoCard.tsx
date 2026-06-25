import { Link } from "react-router-dom";
import { thumbnailUrl } from "../api";
import type { Video } from "../types";
import { formatDuration } from "../utils";

export default function VideoCard({ video }: { video: Video }) {
  const thumb = thumbnailUrl(video);
  const duration = formatDuration(video.duration_sec);

  return (
    <Link
      to={`/watch/${video.id}`}
      className="group flex flex-col overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700 transition-all hover:ring-accent/60"
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
      </div>
      <div className="flex flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm font-semibold text-gray-100 group-hover:text-accent">
          {video.title}
        </h3>
        {video.channel && (
          <p className="truncate text-xs text-gray-400">{video.channel}</p>
        )}
        {video.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {video.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-accent-soft"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
