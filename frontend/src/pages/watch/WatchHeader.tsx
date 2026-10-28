import { Link } from "react-router-dom";
import { usePlaybackLayout } from "../../context/PlaybackContext";
import {
  formatDate,
  formatDuration,
  formatResolution,
  formatSize,
  formatViewCount,
  safeHref,
  watchProcessingLabel,
} from "../../utils";
import { extractYouTubeId } from "../../hooks/useSponsorBlock";
import AddToPlaylist from "../../components/AddToPlaylist";
import StreamDownloadControl from "./StreamDownloadControl";
import type { StreamDownload } from "./useStreamDownload";
import type { WatchSource } from "./useWatchVideo";
import { ArrowIcon, ExternalIcon } from "../../components/icons";

/** Title, channel, size/date/resolution line and (for a stream) the download control. */
export default function WatchHeader({
  source,
  channelParam,
  streamDownload,
}: {
  source: WatchSource;
  channelParam: string;
  streamDownload: StreamDownload;
}) {
  const { activeStreamQuality } = usePlaybackLayout();
  const isLibrary = source.kind === "library";
  const isLive = !isLibrary && Boolean(source.meta.is_live);
  const title = isLibrary
    ? source.video.title
    : source.meta.title || "Untitled";
  const channelName = isLibrary
    ? source.video.channel
    : source.meta.channel || channelParam;
  // Live track quality for streams; file height for library.
  const resolution = isLibrary
    ? formatResolution(source.video.height_px)
    : formatResolution(activeStreamQuality);
  const processingLabel = isLibrary ? watchProcessingLabel(source.video) : null;
  const channelHref = channelName
    ? `/?channel=${encodeURIComponent(channelName)}`
    : "/";
  // Streams link back to the page they were opened from.
  const originalHref = isLibrary
    ? undefined
    : safeHref(source.meta.source_url ?? source.url);
  const originalLabel =
    originalHref && extractYouTubeId(originalHref, "") ? "YouTube" : "Source";
  const backHref = channelParam
    ? `/?channel=${encodeURIComponent(channelParam)}`
    : "/";

  return (
    <div className="mt-5">
      <div className="flex items-start justify-between gap-3">
        <h1 className="min-w-0 flex-1 text-xl font-bold text-gray-100">
          {title}
        </h1>
        {!isLibrary && (
          <Link
            to={backHref}
            className="inline-flex shrink-0 items-center gap-1 text-sm text-gray-400 hover:text-accent"
          >
            <ArrowIcon />
            Back
          </Link>
        )}
      </div>
      {/* Phones keep the details on one line (the channel name truncates)
          with the download control at its right end; wider screens let
          the items wrap with the control inline after them. */}
      <div className="mt-2 flex items-center gap-x-3 gap-y-1.5 text-sm text-gray-400 max-sm:gap-x-2 sm:flex-wrap">
        <div className="flex min-w-0 flex-1 items-center gap-x-2 overflow-hidden whitespace-nowrap text-xs sm:contents sm:whitespace-normal sm:text-sm">
          {channelName && (
            <Link
              to={channelHref}
              className="font-medium text-accent hover:underline max-sm:min-w-0 max-sm:truncate"
            >
              {channelName}
            </Link>
          )}
          {isLibrary && source.video.published_at && (
            <span>{formatDate(source.video.published_at)}</span>
          )}
          {isLibrary && <span>{formatSize(source.video.file_size)}</span>}
          {isLive && (
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-red-500/80"
              />
              Live
            </span>
          )}
          {!isLibrary && !isLive && source.meta.duration != null && (
            <span>{formatDuration(source.meta.duration)}</span>
          )}
          {!isLibrary && source.meta.view_count != null && (
            <span>{formatViewCount(source.meta.view_count)}</span>
          )}
          {resolution && (
            <span className="text-xs text-muted">{resolution}</span>
          )}
          {processingLabel && (
            <span
              className="inline-flex items-center gap-0.5 text-[11px] text-muted"
              role="status"
              aria-live="polite"
            >
              processing {processingLabel}
              <span className="horde-processing-ellipsis" aria-hidden>
                …
              </span>
            </span>
          )}
          {isLibrary &&
            source.video.frame_rate &&
            source.video.frame_rate > 60 && (
              <span className="text-xs text-muted">
                {Math.round(source.video.frame_rate)}fps
              </span>
            )}
        </div>
        {!isLibrary && (
          <div className="flex shrink-0 items-center gap-2">
            {originalHref && (
              <a
                href={originalHref}
                target="_blank"
                rel="noreferrer"
                title={`Open on ${originalLabel}`}
                className="inline-flex items-center gap-0.5 text-xs text-gray-400 hover:text-accent"
              >
                {originalLabel}
                <ExternalIcon />
              </a>
            )}
            {!isLive && (
              <>
                <AddToPlaylist
                  streamUrl={source.url}
                  buttonClassName="rounded-lg border border-ink-600 px-3 py-1 text-xs font-medium text-gray-300 hover:border-accent hover:text-accent"
                />
                <StreamDownloadControl download={streamDownload} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
