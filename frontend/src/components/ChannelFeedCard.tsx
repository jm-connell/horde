import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { maxPresetLabel } from "../presets";
import type { ChannelFeedEntry } from "../types";
import {
  formatDuration,
  formatResolution,
  formatViewCount,
  youtubeThumbnailUrl,
} from "../utils";

const maxResCache = new Map<string, string>();
const viewCountCache = new Map<string, number>();

function FeedMetaRow({
  channelName,
  entry,
  maxRes,
  inLibrary,
  videoId,
  downloading,
  onDownload,
}: {
  channelName: string;
  entry: ChannelFeedEntry;
  maxRes: string;
  inLibrary: boolean;
  videoId?: number;
  downloading?: boolean;
  onDownload: () => void;
}) {
  const action = inLibrary ? (
    videoId ? (
      <Link
        to={`/watch/${videoId}`}
        className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/40 hover:bg-emerald-500/25"
      >
        In Library
      </Link>
    ) : (
      <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/40">
        In Library
      </span>
    )
  ) : (
    <button
      type="button"
      onClick={onDownload}
      disabled={downloading}
      className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-60"
    >
      {downloading ? "Queued…" : "Download"}
    </button>
  );

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-x-2">
        <span className="truncate text-xs text-gray-400">{channelName}</span>
        {entry.view_count != null && (
          <span className="shrink-0 text-xs text-gray-500">
            {formatViewCount(entry.view_count)}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {maxRes && (
          <span className="text-[10px] font-medium text-gray-500">{maxRes}</span>
        )}
        {action}
      </div>
    </div>
  );
}

function ListActionColumn({
  maxRes,
  inLibrary,
  videoId,
  downloading,
  onDownload,
}: {
  maxRes: string;
  inLibrary: boolean;
  videoId?: number;
  downloading?: boolean;
  onDownload: () => void;
}) {
  const action = inLibrary ? (
    videoId ? (
      <Link
        to={`/watch/${videoId}`}
        className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-400 ring-1 ring-emerald-500/40 hover:bg-emerald-500/25"
      >
        In Library
      </Link>
    ) : (
      <span className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-400 ring-1 ring-emerald-500/40">
        In Library
      </span>
    )
  ) : (
    <button
      type="button"
      onClick={onDownload}
      disabled={downloading}
      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-60"
    >
      {downloading ? "Queued…" : "Download"}
    </button>
  );

  return (
    <div className="flex h-full min-h-[4.5rem] shrink-0 flex-col items-end justify-between py-0.5 pl-3">
      <div className="pt-0.5">{action}</div>
      {maxRes && (
        <span className="pb-0.5 text-[10px] font-medium text-gray-500">{maxRes}</span>
      )}
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
      {showDuration && duration && (
        <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-gray-100">
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
}: {
  entry: ChannelFeedEntry;
  channelName: string;
  layout: "grid" | "list";
  inLibrary: boolean;
  videoId?: number;
  onDownload: () => void;
  downloading?: boolean;
}) {
  const thumbSrc = youtubeThumbnailUrl(entry.id, entry.thumbnail_url);
  const duration = formatDuration(entry.duration);
  const cardRef = useRef<HTMLDivElement>(null);
  const [maxRes, setMaxRes] = useState(() => {
    if (entry.library_height_px) {
      return formatResolution(entry.library_height_px);
    }
    return maxResCache.get(entry.url) ?? "";
  });
  const [viewCount, setViewCount] = useState<number | null>(
    () => entry.view_count ?? viewCountCache.get(entry.url) ?? null
  );

  useEffect(() => {
    setViewCount(entry.view_count ?? viewCountCache.get(entry.url) ?? null);
  }, [entry.view_count, entry.url]);

  useEffect(() => {
    if (entry.library_height_px) {
      setMaxRes(formatResolution(entry.library_height_px));
    }
    const cachedRes = maxResCache.get(entry.url);
    if (cachedRes) setMaxRes(cachedRes);

    const needsPreview =
      !entry.library_height_px ||
      entry.view_count == null ||
      !maxResCache.has(entry.url);
    if (!needsPreview && entry.view_count != null) return;

    const el = cardRef.current;
    if (!el) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      ([hit]) => {
        if (!hit?.isIntersecting) return;
        observer.disconnect();
        api
          .previewDownload(entry.url)
          .then((preview) => {
            if (cancelled || preview.is_playlist) return;
            if (!entry.library_height_px) {
              const label = maxPresetLabel(preview.available_presets);
              if (label) {
                maxResCache.set(entry.url, label);
                setMaxRes(label);
              }
            }
            if (entry.view_count == null && preview.view_count != null) {
              viewCountCache.set(entry.url, preview.view_count);
              setViewCount(preview.view_count);
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
  }, [entry.url, entry.library_height_px, entry.view_count]);

  if (layout === "list") {
    return (
      <div
        ref={cardRef}
        className="group flex w-full gap-3 rounded-xl bg-ink-900 p-2.5 ring-1 ring-ink-700"
      >
        <FeedThumbnail
          thumbSrc={thumbSrc}
          duration={duration}
          showDuration={false}
          className="h-[4.5rem] w-32 shrink-0 rounded-lg"
        />
        <div className="relative flex min-w-0 flex-1 items-stretch">
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 pr-28">
            <h3 className="line-clamp-2 text-sm font-semibold text-gray-100 group-hover:text-accent">
              {entry.title || "Untitled"}
            </h3>
            <span className="truncate text-xs text-gray-400">{channelName}</span>
            <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-gray-500">
              {duration && <span>{duration}</span>}
              {duration && viewCount != null && (
                <span className="text-gray-600">·</span>
              )}
              {viewCount != null && <span>{formatViewCount(viewCount)}</span>}
            </div>
          </div>
          <ListActionColumn
            maxRes={maxRes}
            inLibrary={inLibrary}
            videoId={videoId}
            downloading={downloading}
            onDownload={onDownload}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      className="group flex flex-col overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700"
    >
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
          entry={{ ...entry, view_count: viewCount }}
          maxRes={maxRes}
          inLibrary={inLibrary}
          videoId={videoId}
          downloading={downloading}
          onDownload={onDownload}
        />
      </div>
    </div>
  );
}
