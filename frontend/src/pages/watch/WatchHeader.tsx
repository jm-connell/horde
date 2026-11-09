import { Link } from "react-router-dom";
import {
  formatDate,
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
import { ExternalIcon } from "../../components/icons";
import BackLink from "./BackLink";

/**
 * Title, channel, size/date/resolution line and (for a stream) the download
 * control. A stream shows no length or resolution here: the player and the
 * download control already show both.
 */
export default function WatchHeader({
  source,
  channelParam,
  streamDownload,
}: {
  source: WatchSource;
  channelParam: string;
  streamDownload: StreamDownload;
}) {
  const isLibrary = source.kind === "library";
  const isLive = !isLibrary && Boolean(source.meta.is_live);
  const title = isLibrary
    ? source.video.title
    : source.meta.title || "Untitled";
  const channelName = isLibrary
    ? source.video.channel
    : source.meta.channel || channelParam;
  const resolution = isLibrary
    ? formatResolution(source.video.height_px)
    : null;
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

  return (
    <div className="mt-5">
      <div className="flex items-start justify-between gap-3">
        <h1 className="min-w-0 flex-1 text-xl font-bold text-gray-100">
          {title}
        </h1>
        {!isLibrary && (
          <BackLink className="inline-flex shrink-0 items-center gap-1 text-sm text-gray-400 hover:text-accent" />
        )}
      </div>
      {/* The items wrap as they need to, the controls inline after them
          (at the right end on phones). The channel name is never cut short:
          a long one takes its own line and the rest follows on the next. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-gray-400 max-sm:gap-x-2">
        <div className="contents text-xs sm:text-sm">
          {channelName && (
            <Link
              to={channelHref}
              className="min-w-0 break-words font-medium text-accent hover:underline"
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
          <div className="flex shrink-0 items-center gap-2 max-sm:ml-auto">
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
