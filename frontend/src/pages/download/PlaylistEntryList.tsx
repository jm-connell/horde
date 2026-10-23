import type { PlaylistPreviewEntry } from "../../types";
import {
  formatDuration,
  formatViewCount,
  youtubeListThumbnailUrl,
} from "../../utils";
import type { PlaylistMode } from "./PlaylistModePicker";

/** The videos of a previewed playlist: tick the ones to import, or just list them. */
export default function PlaylistEntryList({
  entries,
  playlistMode,
  selectedUrls,
  onToggle,
}: {
  entries: PlaylistPreviewEntry[];
  playlistMode: PlaylistMode;
  selectedUrls: Set<string>;
  onToggle: (url: string) => void;
}) {
  return (
    <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-ink-700 bg-ink-950/50 p-2">
      {entries.map((entry) => {
        const thumbSrc = youtubeListThumbnailUrl(entry.id, entry.thumbnail_url);
        const rowClass =
          playlistMode === "subscribe"
            ? "flex items-start gap-3 rounded-lg p-2"
            : "flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-ink-900";
        const body = (
          <>
            {playlistMode !== "subscribe" && (
              <input
                type="checkbox"
                checked={selectedUrls.has(entry.url)}
                onChange={() => onToggle(entry.url)}
                className="mt-1 shrink-0 accent-accent"
              />
            )}
            <div className="h-14 w-24 shrink-0 overflow-hidden rounded-sm bg-ink-800">
              {thumbSrc ? (
                <img
                  decoding="async"
                  width={96}
                  height={56}
                  src={thumbSrc}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted">
                  No preview
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-sm text-gray-200">
                {entry.title ?? "Untitled"}
              </p>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                {entry.channel && <span>{entry.channel}</span>}
                {entry.view_count != null && (
                  <span>{formatViewCount(entry.view_count)}</span>
                )}
                {entry.duration != null && (
                  <span>{formatDuration(entry.duration)}</span>
                )}
              </div>
            </div>
          </>
        );
        return playlistMode === "subscribe" ? (
          <div key={entry.url} className={rowClass}>
            {body}
          </div>
        ) : (
          <label key={entry.url} className={rowClass}>
            {body}
          </label>
        );
      })}
    </div>
  );
}
