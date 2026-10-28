import type { Ref } from "react";
import { Link } from "react-router-dom";
import { LiveNowLabel } from "../../components/ChannelFeedCard";
import LoadingIndicator from "../../components/LoadingIndicator";
import PlaybackQueue from "../../components/PlaybackQueue";
import QueueButton from "../../components/QueueButton";
import VideoCard from "../../components/VideoCard";
import { formatDuration } from "../../utils";
import type { RelatedItem } from "./relatedItems";
import type { RelatedFeed } from "./useRelatedFeed";
import { PlayIcon } from "../../components/icons";

function DownloadedBadge() {
  return (
    <span className="text-xs font-medium leading-none text-success">
      Downloaded
    </span>
  );
}

const channelHref = (name: string) => `/?channel=${encodeURIComponent(name)}`;

/** The right-hand column beside the player: the playback queue and "More like this". */
export function WatchSidebar({
  items,
  sentinelRef,
  loadingMore = false,
  hasQueue,
}: {
  items: RelatedItem[];
  sentinelRef?: Ref<HTMLDivElement>;
  loadingMore?: boolean;
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
            {/* The title link stretches over the whole row; the channel name
                and queue button sit above it as their own targets. */}
            {items.map((v) => (
              <div
                key={v.key}
                data-horde="related-item"
                className="group relative flex gap-2 rounded-lg p-1 transition-colors hover:bg-ink-800"
              >
                <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                  {v.thumb ? (
                    <img
                      decoding="async"
                      width={160}
                      height={90}
                      src={v.thumb}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted">
                      <PlayIcon className="text-xl" />
                    </div>
                  )}
                  {v.queueEntry && (
                    <QueueButton
                      entry={v.queueEntry}
                      className="right-1 top-1 px-1.5 py-0.5 text-[11px]"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1 py-0.5">
                  <Link
                    to={v.href}
                    className="line-clamp-2 block text-sm font-medium text-gray-200 after:absolute after:inset-0 after:rounded-lg group-hover:text-accent"
                  >
                    {v.title}
                  </Link>
                  {v.channel && (
                    <Link
                      to={channelHref(v.channel)}
                      className="relative z-10 mt-0.5 block truncate text-xs text-muted hover:text-accent hover:underline"
                    >
                      {v.channel}
                    </Link>
                  )}
                  {v.durationSec != null && (
                    <p className="mt-0.5 text-xs text-muted">
                      {formatDuration(v.durationSec)}
                    </p>
                  )}
                  {v.live && (
                    <p className="mt-1">
                      <LiveNowLabel />
                    </p>
                  )}
                  {v.downloaded && (
                    <p className="mt-1">
                      <DownloadedBadge />
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {sentinelRef && <div ref={sentinelRef} className="h-2" />}
          {loadingMore && <p className="text-xs text-muted">Loading more…</p>}
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

/** "More like this" for a stream, as a grid under the video when there is no sidebar. */
export function StreamRelatedGrid({ items }: { items: RelatedItem[] }) {
  return (
    <div className="mt-6">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
        More like this
      </h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {items.map((v) => (
          <Link
            key={v.key}
            to={v.href}
            data-horde="related-item"
            className="group block min-w-0 rounded-lg transition-colors hover:bg-ink-800"
          >
            <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-ink-800">
              {v.queueEntry && <QueueButton entry={v.queueEntry} />}
              {v.thumb ? (
                <img
                  decoding="async"
                  src={v.thumb}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-muted">
                  <PlayIcon className="text-xl" />
                </div>
              )}
            </div>
            <div className="min-w-0 px-0.5 py-1.5">
              <p className="line-clamp-2 text-sm font-medium text-gray-200 group-hover:text-accent">
                {v.title}
              </p>
              {v.channel && (
                <p className="mt-0.5 truncate text-xs text-muted">
                  {v.channel}
                </p>
              )}
              <p className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                {v.durationSec != null && (
                  <span>{formatDuration(v.durationSec)}</span>
                )}
                {v.live && <LiveNowLabel />}
                {v.downloaded && <DownloadedBadge />}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
