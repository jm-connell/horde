import { Link, useNavigate } from "react-router-dom";
import { streamUrl, thumbnailUrl } from "../api";
import { usePlaybackSession } from "../context/PlaybackContext";
import { useCardPreview } from "../hooks/useCardPreview";
import { useSettings } from "../hooks/useSettings";
import { visibleMatchReasonTip } from "../pages/libraryCatalogProgress";
import type { Video } from "../types";
import {
  formatDate,
  formatDuration,
  formatResolution,
  formatSize,
  formatViewCount,
} from "../utils";
import { previewResumeFor, previewStartSec } from "../utils/cardPreview";
import { setWatchResume } from "../utils/watchHandoff";
import CardCopy, { type CardFact } from "./CardCopy";
import CardPreviewVideo from "./CardPreviewVideo";
import FadeImage from "./FadeImage";
import MatchReasonBadge from "./MatchReasonBadge";
import QueueButton from "./QueueButton";
import { PlayIcon } from "./icons";

function CardChannelName({
  channel,
  className,
}: {
  channel: string;
  className: string;
}) {
  const navigate = useNavigate();
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={(e) => {
        e.preventDefault();
        navigate(`/?channel=${encodeURIComponent(channel)}`);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        navigate(`/?channel=${encodeURIComponent(channel)}`);
      }}
      className={className}
    >
      {channel}
    </span>
  );
}

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
  const { current } = usePlaybackSession();
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
  const viewLabel =
    video.view_count !== null ? formatViewCount(video.view_count) : "";
  // Always: the publish date (when card dates are on) and the views when the
  // list is about them. Optional, only to fill spare lines in a taller row
  // (see cardCopyPlan): the views, when it was added, its size.
  const facts: CardFact[] = [];
  if (dateLabel) facts.push({ text: dateLabel });
  if (viewLabel && showViewCount) facts.push({ text: viewLabel });
  const required = facts.length;
  if (viewLabel && !showViewCount) facts.push({ text: viewLabel });
  const added = settings.showCardDates ? formatDate(video.added_at) : "";
  if (added) facts.push({ text: `Added ${added}` });
  const size = formatSize(video.file_size);
  if (size) facts.push({ text: size });

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
        "ui-card ui-card-enter video-card--feed group flex flex-col overflow-hidden transition-colors",
        "max-sm:rounded-none max-sm:bg-transparent max-sm:shadow-none max-sm:ring-0",
        "max-sm:border-b max-sm:border-ink-700 max-sm:last:border-b-0",
        // Fill the grid cell, so cards in a row are one height.
        "sm:h-full sm:rounded-xl sm:bg-ink-900 sm:ring-1",
        selected ? "sm:ring-accent" : "sm:ring-ink-700 sm:hover:ring-accent/60",
      ].join(" ")
    : `ui-card ui-card-enter group flex h-full flex-col overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700 transition-colors ${
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
      <div className="relative aspect-video w-full overflow-hidden bg-ink-800/60">
        {thumb ? (
          <FadeImage
            decoding="async"
            width={320}
            height={180}
            src={thumb}
            alt={video.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted">
            <PlayIcon className="text-4xl" />
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
          <span
            className={`pointer-events-none absolute right-2 z-10 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-white ${
              previewActive ? "bottom-3.5" : "bottom-2"
            }`}
          >
            {duration}
          </span>
        )}
        {progress !== undefined && progress > 0 && !previewActive && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-2 h-1 bg-black/50">
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
                ? "border-accent bg-accent shadow-xs"
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
          !hideQueueButton && <QueueButton entry={video} />
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
      <CardCopy
        title={video.title}
        channel={video.channel}
        renderChannel={(className) =>
          video.channel ? (
            <CardChannelName channel={video.channel} className={className} />
          ) : null
        }
        facts={facts}
        required={required}
        trailing={
          resolution ? (
            <span className="text-[10px] font-medium text-muted">
              {resolution}
            </span>
          ) : null
        }
        className={`transition-colors duration-200 ${
          previewActive ? "max-sm:bg-accent/10" : ""
        }`}
      />
    </Link>
  );
}
