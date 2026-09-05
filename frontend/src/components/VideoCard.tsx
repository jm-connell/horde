import { Link, useNavigate } from "react-router-dom";
import { streamUrl, thumbnailUrl } from "../api";
import { usePlayback } from "../context/PlaybackContext";
import { useCardPreview } from "../hooks/useCardPreview";
import { useSettings } from "../hooks/useSettings";
import { visibleMatchReasonTip } from "../pages/libraryCatalogProgress";
import type { Video } from "../types";
import {
  formatDate,
  formatDuration,
  formatResolution,
  formatViewCount,
} from "../utils";
import { previewResumeFor, previewStartSec } from "../utils/cardPreview";
import { setWatchResume } from "../utils/watchHandoff";
import CardPreviewVideo from "./CardPreviewVideo";
import MatchReasonBadge from "./MatchReasonBadge";

export default function VideoCard({
  video,
  progress,
  hideQueueButton,
  showViewCount,
  selectable,
  selected,
  onSelect,
  searchQuery = "",
  layout = "card",
}: {
  video: Video;
  progress?: number;
  hideQueueButton?: boolean;
  showViewCount?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: number, e: React.MouseEvent) => void;
  searchQuery?: string;
  /** `feed` drops the card chrome on small screens (YouTube-style home). */
  layout?: "card" | "feed";
}) {
  const navigate = useNavigate();
  const { addToQueue, current } = usePlayback();
  const [settings] = useSettings();
  const thumb = thumbnailUrl(video);
  const duration = formatDuration(video.duration_sec);
  const resolution = formatResolution(video.height_px);
  const canPreview = video.status === "ready";
  const { ref: previewRef, active: previewActive } = useCardPreview({
    enabled: canPreview,
    blocked: current?.id === video.id,
  });
  const clipStart = previewStartSec(
    video.last_position_sec,
    video.duration_sec
  );
  const dateLabel =
    settings.showCardDates && video.published_at
      ? formatDate(video.published_at)
      : "";
  const matchTip = visibleMatchReasonTip(video.match_reason, searchQuery);

  const handleClick = (e: React.MouseEvent) => {
    if (selectable) {
      e.preventDefault();
      onSelect?.(video.id, e);
      return;
    }
    const resumeAt = previewResumeFor(video.id);
    if (resumeAt != null) setWatchResume(video.id, resumeAt);
  };

  const feed = layout === "feed";
  const cardClass = feed
    ? [
        "ui-card video-card--feed group flex flex-col overflow-hidden transition-colors",
        "max-sm:rounded-none max-sm:bg-transparent max-sm:shadow-none max-sm:ring-0",
        "max-sm:border-b max-sm:border-ink-700 max-sm:last:border-b-0",
        "sm:rounded-xl sm:bg-ink-900 sm:ring-1",
        selected ? "sm:ring-accent" : "sm:ring-ink-700 sm:hover:ring-accent/60",
      ].join(" ")
    : `ui-card group flex flex-col overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700 transition-colors ${
        selected ? "ring-accent" : "hover:ring-accent/60"
      }`;

  return (
    <Link
      to={`/watch/${video.id}`}
      onClick={handleClick}
      className={cardClass}
      data-horde="video-card"
      data-preview-active={previewActive ? "true" : undefined}
      ref={previewRef}
    >
      <div className="relative aspect-video w-full overflow-hidden">
        {thumb ? (
          <img
            src={thumb}
            alt={video.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-600">
            <span className="text-4xl">▶</span>
          </div>
        )}
        {canPreview ? (
          <CardPreviewVideo
            videoId={video.id}
            src={streamUrl(video.id)}
            startSec={clipStart}
            active={previewActive}
          />
        ) : null}
        {duration && (
          <span className="pointer-events-none absolute bottom-2 right-2 z-10 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-gray-100">
            {duration}
          </span>
        )}
        {progress !== undefined && progress > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-1 bg-black/50">
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
            className={`absolute right-2 top-2 z-20 rounded bg-black/70 px-2 py-1 text-xs font-medium text-gray-100 transition-opacity hover:bg-accent hover:text-ink-950 ${
              hideQueueButton
                ? "hidden"
                : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
            }`}
          >
            + Queue
          </button>
        )}
        <MatchReasonBadge
          text={matchTip}
          className={
            selectable
              ? "absolute top-1.5 right-1.5 z-30"
              : "absolute top-1.5 left-1.5 z-30"
          }
        />
      </div>
      <div
        className={`relative flex flex-col gap-1 p-3 transition-colors duration-200 ${
          previewActive ? "max-sm:bg-accent/10" : ""
        }`}
      >
        <h3
          className={`line-clamp-2 overflow-hidden break-words text-sm font-semibold text-gray-100 group-hover:text-accent ${
            feed
              ? "max-sm:min-h-0 max-sm:pr-0 sm:min-h-[2.5rem] sm:pr-10"
              : "min-h-[2.5rem] pr-10"
          }`}
        >
          {video.title}
        </h3>
        <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 ${resolution ? "pr-10" : ""}`}>
          {video.channel && (
            <span
              role="link"
              tabIndex={0}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/?channel=${encodeURIComponent(video.channel!)}`);
              }}
              className="max-w-full truncate text-xs text-gray-400 hover:text-accent"
            >
              {video.channel}
            </span>
          )}
          {dateLabel && (
            <span className="text-xs text-gray-500">{dateLabel}</span>
          )}
          {showViewCount && video.view_count !== null && (
            <span className="text-xs text-gray-500">
              {formatViewCount(video.view_count)}
            </span>
          )}
        </div>
        {resolution && (
          <span className="absolute bottom-3 right-3 text-[10px] font-medium text-gray-500">
            {resolution}
          </span>
        )}
      </div>
    </Link>
  );
}
