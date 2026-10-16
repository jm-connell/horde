import { Link } from "react-router-dom";
import { usePlaybackLayout } from "../../context/PlaybackContext";
import {
  formatDate,
  formatDuration,
  formatResolution,
  formatSize,
  formatViewCount,
  watchProcessingLabel,
} from "../../utils";
import StreamDownloadControl from "./StreamDownloadControl";
import type { StreamDownload } from "./useStreamDownload";
import type { WatchSource } from "./useWatchVideo";

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
  const backHref = channelParam
    ? `/?channel=${encodeURIComponent(channelParam)}`
    : "/";

  return (
    <div className="mt-5 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-bold text-gray-100">{title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-gray-400">
          {channelName && (
            <Link
              to={channelHref}
              className="font-medium text-accent hover:underline"
            >
              {channelName}
            </Link>
          )}
          {isLibrary && source.video.published_at && (
            <span>{formatDate(source.video.published_at)}</span>
          )}
          {isLibrary && <span>{formatSize(source.video.file_size)}</span>}
          {!isLibrary && source.meta.duration != null && (
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
          {!isLibrary && <StreamDownloadControl download={streamDownload} />}
        </div>
      </div>
      {!isLibrary && (
        <Link
          to={backHref}
          className="shrink-0 text-sm text-gray-400 hover:text-accent"
        >
          ← Back
        </Link>
      )}
    </div>
  );
}
