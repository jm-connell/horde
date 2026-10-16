import { Link } from "react-router-dom";
import { thumbnailUrl } from "../../api";
import LoadingIndicator from "../../components/LoadingIndicator";
import PlaybackQueue from "../../components/PlaybackQueue";
import VideoCard from "../../components/VideoCard";
import { formatDuration } from "../../utils";
import type { RelatedFeed } from "./useRelatedFeed";

/** The right-hand column beside the player: the playback queue and "More like this". */
export function WatchSidebar({
  related,
  hasQueue,
}: {
  related: RelatedFeed;
  hasQueue: boolean;
}) {
  return (
    <aside className="hidden space-y-6 xl:block">
      {hasQueue && <PlaybackQueue className="sticky top-20" />}
      <div className={hasQueue ? "" : "sticky top-20"}>
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            More like this
          </h3>
          <div className="space-y-2">
            {related.videos.map((v) => {
              const thumb = thumbnailUrl(v);
              return (
                <Link
                  key={v.id}
                  to={`/watch/${v.id}`}
                  className="group flex gap-2 rounded-lg p-1 transition-colors hover:bg-ink-800"
                >
                  <div className="aspect-video w-40 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                    {thumb ? (
                      <img
                        decoding="async"
                        width={160}
                        height={90}
                        src={thumb}
                        alt={v.title}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-muted">
                        <span className="text-xl">▶</span>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 py-0.5">
                    <p className="line-clamp-2 text-sm font-medium text-gray-200 group-hover:text-accent">
                      {v.title}
                    </p>
                    {v.channel && (
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {v.channel}
                      </p>
                    )}
                    {v.duration_sec != null && (
                      <p className="mt-0.5 text-xs text-muted">
                        {formatDuration(v.duration_sec)}
                      </p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
          <div ref={related.sentinelRef} className="h-2" />
          {related.loadingMore && (
            <p className="text-xs text-muted">Loading more…</p>
          )}
        </div>
      </div>
    </aside>
  );
}

/** "More like this" as a card grid under the video, when there is no sidebar. */
export function RelatedGrid({ related }: { related: RelatedFeed }) {
  return (
    <div className="mt-6">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
        More like this
      </h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {related.videos.map((v) => (
          <VideoCard key={v.id} video={v} />
        ))}
      </div>
      <div ref={related.sentinelRef} className="h-4" />
      {related.loadingMore && <LoadingIndicator />}
    </div>
  );
}
