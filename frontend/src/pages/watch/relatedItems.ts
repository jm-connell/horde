import { listThumbnailUrl, thumbnailUrl } from "../../api";
import type { ChannelFeedEntry, Video } from "../../types";
import { youtubeThumbnailUrl } from "../../utils";
import { watchHref } from "../../utils/watchHref";
import type { QueueEntry } from "../../context/playbackQueue";

/** One related video, library or stream, as the sidebar and grid show it. */
export interface RelatedItem {
  key: string;
  href: string;
  title: string;
  thumb: string | null;
  channel: string | null;
  durationSec: number | null;
  /** Set on the stream page, where related videos can be either. */
  downloaded?: boolean;
  /** A broadcast that is live now. */
  live?: boolean;
  /** What "+ Queue" adds: the library video, or the stream by its link. */
  queueEntry: QueueEntry | null;
}

export function libraryRelatedItems(videos: Video[]): RelatedItem[] {
  return videos.map((v) => ({
    key: `v${v.id}`,
    href: `/watch/${v.id}`,
    title: v.title,
    thumb: thumbnailUrl(v),
    channel: v.channel ?? null,
    durationSec: v.duration_sec ?? null,
    queueEntry: v,
  }));
}

/** Related entries of a stream; downloaded ones open in the library. */
export function streamRelatedItems(entries: ChannelFeedEntry[]): RelatedItem[] {
  const out: RelatedItem[] = [];
  for (const e of entries) {
    const href = watchHref(e, e.channel ?? "");
    if (!href) continue;
    const downloaded = e.in_library && e.video_id != null;
    const thumb = e.thumbnail_url
      ? youtubeThumbnailUrl(e.id, e.thumbnail_url)
      : downloaded && e.video_id != null
        ? listThumbnailUrl(e.video_id)
        : youtubeThumbnailUrl(e.id, null);
    out.push({
      key: `${e.id ?? e.url}`,
      href,
      title: e.title || "Untitled",
      thumb,
      channel: e.channel ?? null,
      durationSec: e.duration ?? null,
      downloaded,
      live: e.live_status === "is_live",
      queueEntry: e.url
        ? {
            queue_kind: "stream",
            url: e.url,
            href,
            title: e.title || "Untitled",
            channel: e.channel ?? null,
            thumbnail: thumb,
            duration: e.duration ?? null,
          }
        : null,
    });
  }
  return out;
}
