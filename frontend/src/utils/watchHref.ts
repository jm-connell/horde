import type { ChannelFeedEntry } from "../types";

/**
 * Where an entry of a channel feed (or a stream's related list) opens: the
 * library watch page when it is downloaded, else the stream watch page.
 */
export function watchHref(
  entry: ChannelFeedEntry,
  channelName: string
): string | null {
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
