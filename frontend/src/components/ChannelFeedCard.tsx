import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, streamUrl } from "../api";
import { usePlayback } from "../context/PlaybackContext";
import { useCardPreview } from "../hooks/useCardPreview";
import { useCardCopyLayout } from "../hooks/useCardCopyLayout";
import { maxPresetLabel } from "../presets";
import type { ChannelFeedEntry } from "../types";
import {
  formatPublishedAt,
  formatDuration,
  formatLikeRatio,
  formatResolution,
  formatViewCount,
  youtubeThumbnailUrl,
} from "../utils";
import { enqueueYtPreview } from "../utils/ytPreviewQueue";
import { previewResumeFor } from "../utils/cardPreview";
import { setWatchResume } from "../utils/watchHandoff";
import CardPreviewVideo from "./CardPreviewVideo";
import CardTitle from "./CardTitle";
import MatchReasonBadge from "./MatchReasonBadge";
import { visibleMatchReasonTip } from "../pages/libraryCatalogProgress";

const maxResCache = new Map<string, string>();

function FeedChannelName({
  name,
  onChannelClick,
  className,
}: {
  name: string;
  onChannelClick?: () => void;
  className: string;
}) {
  if (!onChannelClick) {
    return <span className={className}>{name}</span>;
  }
  return (
    <span
      role="link"
      tabIndex={0}
      className={`${className} hover:text-accent`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChannelClick();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onChannelClick();
      }}
    >
      {name}
    </span>
  );
}

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
  stacked,
  onDownload,
  onChannelClick,
}: {
  channelName: string;
  entry: ChannelFeedEntry;
  maxRes: string;
  inLibrary: boolean;
  downloading?: boolean;
  stacked: boolean;
  onDownload: () => void;
  onChannelClick?: () => void;
}) {
  const dateLabel = formatPublishedAt(entry.published_at, entry.published_label);
  const secondary = (
    <>
      {dateLabel ? (
        <span className="shrink-0 text-xs leading-4 text-gray-500">{dateLabel}</span>
      ) : null}
      {entry.view_count != null ? (
        <span className="shrink-0 text-xs leading-4 text-gray-500">
          {formatViewCount(entry.view_count)}
        </span>
      ) : null}
      <LikeRatioBadge
        likes={entry.like_count}
        dislikes={entry.dislike_count}
      />
      {inLibrary ? (
        <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-emerald-500/40">
          Downloaded
        </span>
      ) : null}
    </>
  );
  const hasSecondary = Boolean(
    dateLabel ||
      entry.view_count != null ||
      (entry.like_count != null && entry.dislike_count != null) ||
      inLibrary
  );
  const actions = (
    <div className="flex shrink-0 items-center gap-2">
      {maxRes ? (
        <span className="text-[10px] font-medium text-gray-500">{maxRes}</span>
      ) : null}
      {!inLibrary ? (
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
      ) : null}
    </div>
  );

  if (stacked && hasSecondary) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 flex-nowrap items-center gap-x-2">
          {secondary}
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <FeedChannelName
            name={channelName}
            onChannelClick={onChannelClick}
            className="break-words text-xs leading-4 text-gray-400"
          />
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-x-2">
        <FeedChannelName
          name={channelName}
          onChannelClick={onChannelClick}
          className="shrink-0 whitespace-nowrap text-xs leading-4 text-gray-400"
        />
        {secondary}
      </div>
      {actions}
    </div>
  );
}

function FeedThumbnail({
  thumbSrc,
  duration,
  className,
  showDuration = true,
  matchTip,
  previewSrc,
  previewVideoId,
  previewActive,
}: {
  thumbSrc: string | null;
  duration: string;
  className: string;
  showDuration?: boolean;
  matchTip?: string | null;
  previewSrc?: string | null;
  previewVideoId?: number | null;
  previewActive: boolean;
}) {
  const previewing = previewActive && Boolean(previewSrc);

  return (
    <div className={`relative ${className}`}>
      <div className="relative h-full w-full overflow-hidden rounded-[inherit]">
        <div
          className={`relative h-full w-full transition-[transform,filter] duration-200 sm:group-hover:scale-105 ${
            previewing ? "" : "group-hover:brightness-[0.6]"
          }`}
        >
          {thumbSrc ? (
            <img
              src={thumbSrc}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-ink-600">
              <span className="text-4xl">▶</span>
            </div>
          )}
          {previewSrc && previewVideoId != null ? (
            <CardPreviewVideo
              videoId={previewVideoId}
              src={previewSrc}
              startSec={0}
              active={previewActive}
            />
          ) : null}
        </div>
        <div
          className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center transition-opacity ${
            previewing
              ? "opacity-0"
              : "opacity-0 group-hover:opacity-100"
          }`}
        >
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
      <MatchReasonBadge text={matchTip} />
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
  searchQuery = "",
  onChannelClick,
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
  searchQuery?: string;
  onChannelClick?: (hit: { name: string; url: string | null }) => void;
}) {
  const thumbSrc = youtubeThumbnailUrl(entry.id, entry.thumbnail_url);
  const duration = formatDuration(entry.duration);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const { current } = usePlayback();
  const libraryVideoId = videoId ?? entry.video_id ?? null;
  const previewSrc =
    inLibrary && libraryVideoId != null ? streamUrl(libraryVideoId) : null;
  const { ref: previewRef, active: previewActive } = useCardPreview({
    enabled: Boolean(previewSrc),
    blocked: libraryVideoId != null && current?.id === libraryVideoId,
  });
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      cardRef.current = node;
      previewRef(node);
    },
    [previewRef]
  );
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
  const dateLabel = formatPublishedAt(entry.published_at, entry.published_label);
  const href = watchHref(
    {
      ...entry,
      in_library: inLibrary || entry.in_library,
      video_id: videoId ?? entry.video_id,
    },
    channelName
  );
  const matchTip = visibleMatchReasonTip(entry.match_reason, searchQuery);
  const titleText = entry.title || "Untitled";
  const handleChannelClick = onChannelClick
    ? () =>
        onChannelClick({
          name: channelName,
          url: entry.channel_url ?? null,
        })
    : undefined;
  const likeLabel = formatLikeRatio(entry.like_count, entry.dislike_count);
  const hasSecondaryMeta = Boolean(
    dateLabel ||
      viewCount != null ||
      (entry.like_count != null && entry.dislike_count != null) ||
      inLibrary
  );
  const {
    detailsRef,
    sizerRef,
    combinedSizerRef,
    stacked,
    titleLines,
    titleNeeded,
  } = useCardCopyLayout(titleText, hasSecondaryMeta, layout === "grid");

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
          matchTip={matchTip}
          previewSrc={previewSrc}
          previewVideoId={libraryVideoId}
          previewActive={previewActive}
        />
        <div className="relative flex min-w-0 flex-1 items-stretch">
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 pr-24">
            <CardTitle
              text={titleText}
              className="line-clamp-2 text-sm font-semibold leading-5 text-gray-100 group-hover:text-accent"
            />
            <span className="break-words text-xs text-gray-400">
              <FeedChannelName
                name={channelName}
                onChannelClick={handleChannelClick}
                className="break-words text-xs leading-4 text-gray-400"
              />
            </span>
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
      <div className="ui-card video-card--feed group flex h-full flex-col overflow-hidden max-sm:rounded-none max-sm:bg-transparent max-sm:ring-0 sm:rounded-xl sm:bg-ink-900 sm:ring-1 sm:ring-ink-700">
        <FeedThumbnail
          thumbSrc={thumbSrc}
          duration={duration}
          className="aspect-video w-full"
          matchTip={matchTip}
          previewSrc={previewSrc}
          previewVideoId={libraryVideoId}
          previewActive={previewActive}
        />
        <div
          ref={detailsRef}
          className={`relative flex min-h-0 flex-1 flex-col gap-1 p-3 transition-colors duration-200 ${
            previewActive ? "max-sm:bg-accent/10" : ""
          }`}
        >
          <span
            ref={sizerRef}
            aria-hidden
            className="pointer-events-none invisible absolute inset-x-3 top-3 -z-10 break-words text-sm font-semibold leading-5"
          >
            {titleText}
          </span>
          <span
            ref={combinedSizerRef}
            aria-hidden
            className="pointer-events-none invisible absolute left-3 top-3 -z-10 flex w-max items-center gap-x-2 text-xs leading-4"
          >
            <span className="shrink-0 whitespace-nowrap">{channelName}</span>
            {dateLabel ? (
              <span className="shrink-0 whitespace-nowrap">{dateLabel}</span>
            ) : null}
            {viewCount != null ? (
              <span className="shrink-0 whitespace-nowrap">
                {formatViewCount(viewCount)}
              </span>
            ) : null}
            {likeLabel ? (
              <span className="shrink-0 whitespace-nowrap">{likeLabel}</span>
            ) : null}
            {inLibrary ? (
              <span className="shrink-0 whitespace-nowrap">Downloaded</span>
            ) : null}
            {maxRes ? (
              <span className="shrink-0 whitespace-nowrap text-[10px] font-medium">
                {maxRes}
              </span>
            ) : null}
            {!inLibrary ? (
              <span className="shrink-0 whitespace-nowrap">
                {downloading ? "Queued…" : "Download"}
              </span>
            ) : null}
          </span>
          <CardTitle
            text={titleText}
            truncated={titleNeeded > titleLines}
            className="min-h-0 flex-1 overflow-hidden break-words text-sm font-semibold leading-5 text-gray-100 group-hover:text-accent"
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: titleLines,
              minHeight: titleLines <= 1 ? "1.25rem" : "2.5rem",
            }}
          />
          <div className="shrink-0">
            <FeedMetaRow
              channelName={channelName}
              entry={entry}
              maxRes={maxRes}
              inLibrary={inLibrary}
              downloading={downloading}
              stacked={stacked}
              onDownload={onDownload}
              onChannelClick={handleChannelClick}
            />
          </div>
        </div>
      </div>
    );

  return (
    <div
      ref={setRootRef}
      data-horde="feed-card"
      data-preview-active={previewActive ? "true" : undefined}
      className={
        layout === "grid"
          ? "h-full max-sm:border-b max-sm:border-ink-700 max-sm:last:border-b-0"
          : undefined
      }
    >
      {href ? (
        <Link
          to={href}
          className="block h-full"
          onClick={() => {
            if (libraryVideoId == null) return;
            const resumeAt = previewResumeFor(libraryVideoId);
            if (resumeAt != null) setWatchResume(libraryVideoId, resumeAt);
          }}
        >
          {cardInner}
        </Link>
      ) : (
        cardInner
      )}
    </div>
  );
}
