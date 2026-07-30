import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { maxPresetLabel } from "../presets";
import type { ChannelFeedEntry } from "../types";
import {
  formatDate,
  formatDuration,
  formatLikeRatio,
  formatResolution,
  formatViewCount,
  youtubeThumbnailUrl,
} from "../utils";
import { enqueueYtPreview } from "../utils/ytPreviewQueue";

const maxResCache = new Map<string, string>();

function LikeRatioBadge({
  likes,
  dislikes,
}: {
  likes: number | null | undefined;
  dislikes: number | null | undefined;
}) {
  const label = formatLikeRatio(likes, dislikes);
  if (!label || likes == null || dislikes == null) return null;
  const total = likes + dislikes;
  const pct = total > 0 ? (likes / total) * 100 : 0;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-gray-500"
      title={`${likes.toLocaleString()} likes · ${dislikes.toLocaleString()} dislikes (YouTube)`}
    >
      <span
        className="inline-block h-1 w-8 overflow-hidden rounded-full bg-ink-700"
        aria-hidden
      >
        <span
          className="block h-full rounded-full bg-emerald-500/80"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span>{label}</span>
    </span>
  );
}

function watchHref(entry: ChannelFeedEntry, channelName: string): string | null {
  if (entry.in_library && entry.video_id != null) {
    return `/watch/${entry.video_id}`;
  }
  if (entry.url) {
    const qs = new URLSearchParams();
    qs.set("url", entry.url);
    if (channelName) qs.set("channel", channelName);
    return `/watch?${qs.toString()}`;
  }
  return null;
}

function FeedMetaRow({
  channelName,
  entry,
  maxRes,
  inLibrary,
  downloading,
  onDownload,
}: {
  channelName: string;
  entry: ChannelFeedEntry;
  maxRes: string;
  inLibrary: boolean;
  downloading?: boolean;
  onDownload: () => void;
}) {
  const dateLabel = entry.published_at ? formatDate(entry.published_at) : "";

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="truncate text-xs text-gray-400">{channelName}</span>
        {dateLabel && (
          <span className="shrink-0 text-xs text-gray-500">{dateLabel}</span>
        )}
        {entry.view_count != null && (
          <span className="shrink-0 text-xs text-gray-500">
            {formatViewCount(entry.view_count)}
          </span>
        )}
        <LikeRatioBadge
          likes={entry.like_count}
          dislikes={entry.dislike_count}
        />
        {inLibrary && (
          <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-emerald-500/40">
            Downloaded
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {maxRes && (
          <span className="text-[10px] font-medium text-gray-500">{maxRes}</span>
        )}
        {!inLibrary && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDownload();
            }}
            disabled={downloading}
            className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-60"
          >
            {downloading ? "Queued…" : "Download"}
          </button>
        )}
      </div>
    </div>
  );
}

function FeedThumbnail({
  thumbSrc,
  duration,
  className,
  showDuration = true,
}: {
  thumbSrc: string | null;
  duration: string;
  className: string;
  showDuration?: boolean;
}) {
  return (
    <div className={`relative overflow-hidden bg-ink-800 ${className}`}>
      {thumbSrc ? (
        <img
          src={thumbSrc}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-ink-600">
          <span className="text-4xl">▶</span>
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="rounded-full bg-black/70 px-3 py-1.5 text-sm font-semibold text-gray-100 ring-1 ring-white/20">
          ▶
        </span>
      </div>
      {showDuration && duration && (
        <span className="pointer-events-none absolute bottom-2 right-2 z-20 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-gray-100">
          {duration}
        </span>
      )}
    </div>
  );
}

export default function ChannelFeedCard({
  entry,
  channelName,
  layout,
  inLibrary,
  videoId,
  onDownload,
  downloading,
  skipRemotePreview = false,
}: {
  entry: ChannelFeedEntry;
  channelName: string;
  layout: "grid" | "list";
  inLibrary: boolean;
  videoId?: number;
  onDownload: () => void;
  downloading?: boolean;
  /** Skip yt-dlp max-res probes (catalog feeds already feel fast without them). */
  skipRemotePreview?: boolean;
}) {
  const thumbSrc = youtubeThumbnailUrl(entry.id, entry.thumbnail_url);
  const duration = formatDuration(entry.duration);
  const cardRef = useRef<HTMLDivElement>(null);
  const [maxRes, setMaxRes] = useState(() => {
    if (entry.library_height_px) {
      return formatResolution(entry.library_height_px);
    }
    if (entry.max_height) {
      return formatResolution(entry.max_height);
    }
    return maxResCache.get(entry.url) ?? "";
  });
  const viewCount = entry.view_count;
  const dateLabel = entry.published_at ? formatDate(entry.published_at) : "";
  const href = watchHref(
    {
      ...entry,
      in_library: inLibrary || entry.in_library,
      video_id: videoId ?? entry.video_id,
    },
    channelName
  );

  useEffect(() => {
    if (entry.library_height_px) {
      setMaxRes(formatResolution(entry.library_height_px));
      return;
    }
    if (entry.max_height) {
      setMaxRes(formatResolution(entry.max_height));
      return;
    }
    const cachedRes = maxResCache.get(entry.url);
    if (cachedRes) {
      setMaxRes(cachedRes);
      return;
    }
    if (skipRemotePreview || inLibrary) return;

    const el = cardRef.current;
    if (!el) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      ([hit]) => {
        if (!hit?.isIntersecting) return;
        observer.disconnect();
        enqueueYtPreview(() => api.previewDownload(entry.url))
          .then((preview) => {
            if (cancelled || preview.is_playlist) return;
            const label = maxPresetLabel(preview.available_presets);
            if (label) {
              maxResCache.set(entry.url, label);
              setMaxRes(label);
            }
          })
          .catch(() => undefined);
      },
      { rootMargin: "120px" }
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [
    entry.url,
    entry.library_height_px,
    entry.max_height,
    skipRemotePreview,
    inLibrary,
  ]);

  const cardInner =
    layout === "list" ? (
      <div className="group flex w-full gap-3 rounded-xl bg-ink-900 p-2.5 ring-1 ring-ink-700">
        <FeedThumbnail
          thumbSrc={thumbSrc}
          duration={duration}
          showDuration={false}
          className="h-[4.5rem] w-32 shrink-0 rounded-lg"
        />
        <div className="relative flex min-w-0 flex-1 items-stretch">
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 pr-24">
            <h3 className="line-clamp-2 text-sm font-semibold text-gray-100 group-hover:text-accent">
              {entry.title || "Untitled"}
            </h3>
            <span className="truncate text-xs text-gray-400">{channelName}</span>
            <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-gray-500">
              {duration && <span>{duration}</span>}
              {duration && dateLabel && (
                <span className="text-gray-600">·</span>
              )}
              {dateLabel && <span>{dateLabel}</span>}
              {(duration || dateLabel) && viewCount != null && (
                <span className="text-gray-600">·</span>
              )}
              {viewCount != null && <span>{formatViewCount(viewCount)}</span>}
              {(duration || dateLabel || viewCount != null) &&
                entry.like_count != null &&
                entry.dislike_count != null && (
                  <span className="text-gray-600">·</span>
                )}
              <LikeRatioBadge
                likes={entry.like_count}
                dislikes={entry.dislike_count}
              />
              {inLibrary && (
                <>
                  <span className="text-gray-600">·</span>
                  <span className="text-emerald-400">Downloaded</span>
                </>
              )}
            </div>
          </div>
          <div className="flex h-full min-h-[4.5rem] shrink-0 flex-col items-end justify-between py-0.5 pl-3">
            {!inLibrary ? (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDownload();
                }}
                disabled={downloading}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-60"
              >
                {downloading ? "Queued…" : "Download"}
              </button>
            ) : (
              <span className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-400 ring-1 ring-emerald-500/40">
                Downloaded
              </span>
            )}
            {maxRes && (
              <span className="pb-0.5 text-[10px] font-medium text-gray-500">
                {maxRes}
              </span>
            )}
          </div>
        </div>
      </div>
    ) : (
      <div className="ui-card group flex flex-col overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700">
        <FeedThumbnail
          thumbSrc={thumbSrc}
          duration={duration}
          className="aspect-video w-full"
        />
        <div className="flex flex-col gap-1 p-3">
          <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold text-gray-100 group-hover:text-accent">
            {entry.title || "Untitled"}
          </h3>
          <FeedMetaRow
            channelName={channelName}
            entry={entry}
            maxRes={maxRes}
            inLibrary={inLibrary}
            downloading={downloading}
            onDownload={onDownload}
          />
        </div>
      </div>
    );

  return (
    <div ref={cardRef}>
      {href ? (
        <Link to={href} className="block">
          {cardInner}
        </Link>
      ) : (
        cardInner
      )}
    </div>
  );
}
