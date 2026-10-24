import { listThumbnailUrl } from "../api";
import type { QueueEntry } from "../context/playbackQueue";
import type { PlaylistEntry } from "../types";
import { youtubeThumbnailUrl } from "../utils";

/** A playlist entry as its row shows it, downloaded or streamed. */
export interface PlaylistEntryView {
  id: number;
  href: string | null;
  title: string;
  channel: string | null;
  durationSec: number | null;
  thumb: string | null;
  downloaded: boolean;
  /** What "+ Queue" and "Play all" add; null when there is nothing to play. */
  queueEntry: QueueEntry | null;
}

export function playlistEntryView(entry: PlaylistEntry): PlaylistEntryView {
  const video = entry.video ?? null;
  if (video) {
    return {
      id: entry.id,
      href: `/watch/${video.id}`,
      title: video.title,
      channel: video.channel ?? null,
      durationSec: video.duration_sec ?? null,
      thumb: video.has_thumbnail ? listThumbnailUrl(video.id) : null,
      downloaded: true,
      queueEntry: video,
    };
  }
  const title = entry.title || "Untitled";
  const thumb = entry.youtube_id ? youtubeThumbnailUrl(entry.youtube_id) : null;
  const href = entry.url
    ? `/watch?${new URLSearchParams({
        url: entry.url,
        ...(entry.channel ? { channel: entry.channel } : {}),
      }).toString()}`
    : null;
  return {
    id: entry.id,
    href,
    title,
    channel: entry.channel ?? null,
    durationSec: entry.duration_sec ?? null,
    thumb,
    downloaded: false,
    queueEntry:
      entry.url && href
        ? {
            queue_kind: "stream",
            url: entry.url,
            href,
            title,
            channel: entry.channel ?? null,
            thumbnail: thumb,
            duration: entry.duration_sec ?? null,
          }
        : null,
  };
}
