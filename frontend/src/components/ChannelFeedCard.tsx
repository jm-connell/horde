import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { Link } from "react-router-dom";
import { api, streamUrl } from "../api";
import { usePlaybackSession } from "../context/PlaybackContext";
import { useCardPreview } from "../hooks/useCardPreview";
import { maxPresetLabel } from "../presets";
import type { ChannelFeedEntry } from "../types";
import {
  formatPublishedAt,
  formatDuration,
  formatLikeRatio,
  formatResolution,
  formatViewCount,
  joinDotList,
  youtubeThumbnailUrl,
} from "../utils";
import { enqueueYtPreview } from "../utils/ytPreviewQueue";
import { previewResumeFor } from "../utils/cardPreview";
import { setWatchResume } from "../utils/watchHandoff";
import { watchHref } from "../utils/watchHref";
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

function likeRatioTitle(
  likes: number | null | undefined,
  dislikes: number | null | undefined
): string {
  if (likes == null || dislikes == null) return "";
  return `${likes.toLocaleString()} likes · ${dislikes.toLocaleString()} dislikes (YouTube)`;
}

function FeedMetaRow({
  channelName,
  entry,
  maxRes,
  inLibrary,
  downloading,
  onDownload,
  onChannelClick,
}: {
  channelName: string;
  entry: ChannelFeedEntry;
  maxRes: string;
  inLibrary: boolean;
  downloading?: boolean;
  onDownload: () => void;
  onChannelClick?: () => void;
}) {
  const { can } = useAuth();
  const dateLabel = formatPublishedAt(
    entry.published_at,
    entry.published_label
  );
  const views =
    entry.view_count != null ? formatViewCount(entry.view_count) : "";
  const likeLabel = formatLikeRatio(entry.like_count, entry.dislike_count);
  const stats = joinDotList([dateLabel, views, likeLabel]);
  const likeTip = likeRatioTitle(entry.like_count, entry.dislike_count);
  return (
    // Phones put the download button beside the channel and stats lines
    // instead of on a line of its own.
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 sm:grid-cols-1">
      <FeedChannelName
        name={channelName}
        onChannelClick={onChannelClick}
        className="min-w-0 truncate text-xs leading-4 text-gray-400"
      />
      <span
        className={`block min-h-4 min-w-0 truncate text-xs leading-4 text-muted ${
          stats ? "" : "max-sm:hidden"
        }`}
        title={
          likeTip
            ? `${stats}${stats ? " · " : ""}${likeTip}`
            : stats || undefined
        }
      >
        {stats || "\u00a0"}
      </span>
      <div className="flex h-6 min-w-0 items-center gap-2 max-sm:col-start-2 max-sm:row-span-2 max-sm:row-start-1 max-sm:self-center">
        {inLibrary ? (
          <span className="text-xs font-medium leading-none text-emerald-400">
            Downloaded
          </span>
        ) : can("download") ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDownload();
            }}
            disabled={downloading}
            className="h-6 shrink-0 rounded-sm bg-accent px-2.5 text-xs font-medium leading-none text-ink-950 hover:bg-accent-soft disabled:opacity-60"
          >
            {downloading ? "Downloading" : "Download"}
          </button>
        ) : null}
        {maxRes ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium text-muted max-sm:order-first">
            {maxRes}
          </span>
        ) : null}
      </div>
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
          className={`relative h-full w-full transition-[scale,filter] duration-200 sm:group-hover:scale-105 ${
            previewing ? "" : "group-hover:brightness-[0.6]"
          }`}
        >
          {thumbSrc ? (
            <img
              decoding="async"
              width={320}
              height={180}
              src={thumbSrc}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted">
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
            previewing ? "opacity-0" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <span className="rounded-full bg-black/70 px-3 py-1.5 text-sm font-semibold text-white ring-1 ring-white/20">
            ▶
          </span>
        </div>
        {showDuration && duration && (
          <span
            className={`pointer-events-none absolute right-2 z-20 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-white ${
              previewing ? "bottom-3.5" : "bottom-2"
            }`}
          >
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
  const { can } = useAuth();
  const thumbSrc = youtubeThumbnailUrl(entry.id, entry.thumbnail_url);
  const duration = formatDuration(entry.duration);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const { current } = usePlaybackSession();
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
  const dateLabel = formatPublishedAt(
    entry.published_at,
    entry.published_label
  );
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
  const listStats = joinDotList([
    duration,
    dateLabel,
    viewCount != null ? formatViewCount(viewCount) : "",
    formatLikeRatio(entry.like_count, entry.dislike_count),
  ]);
  const listLikeTip = likeRatioTitle(entry.like_count, entry.dislike_count);

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
          className="h-18 w-32 shrink-0 rounded-lg"
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
            <span className="wrap-break-word text-xs text-gray-400">
              <FeedChannelName
                name={channelName}
                onChannelClick={handleChannelClick}
                className="wrap-break-word text-xs leading-4 text-gray-400"
              />
            </span>
            <p
              className="truncate text-xs leading-4 text-muted"
              title={
                listLikeTip
                  ? `${listStats}${listStats ? " · " : ""}${listLikeTip}`
                  : listStats || undefined
              }
            >
              {listStats}
            </p>
          </div>
          <div className="flex h-full min-h-18 shrink-0 flex-col items-end justify-between py-0.5 pl-3">
            {!inLibrary ? (
              can("download") ? (
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
                  {downloading ? "Downloading" : "Download"}
                </button>
              ) : null
            ) : (
              <span className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-400 ring-1 ring-emerald-500/40">
                Downloaded
              </span>
            )}
            {maxRes && (
              <span className="pb-0.5 text-[10px] font-medium text-muted">
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
          className={`flex flex-col gap-1 p-3 transition-colors duration-200 ${
            previewActive ? "max-sm:bg-accent/10" : ""
          }`}
        >
          <CardTitle
            text={titleText}
            className="line-clamp-2 overflow-hidden sm:min-h-10 wrap-break-word text-sm font-semibold leading-5 text-gray-100 group-hover:text-accent"
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
            }}
          />
          <FeedMetaRow
            channelName={channelName}
            entry={entry}
            maxRes={maxRes}
            inLibrary={inLibrary}
            downloading={downloading}
            onDownload={onDownload}
            onChannelClick={handleChannelClick}
          />
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
