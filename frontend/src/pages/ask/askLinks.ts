import type { AskChannel } from "../../types";
import { normalizeChannelUrl } from "../../utils/followUrl";

/**
 * Where an Ask reference opens: the library copy when it is downloaded,
 * otherwise the stream, at the moment it points to.
 */
export function askWatchPath(ref: {
  yt_id: string;
  start_sec: number;
  library_video_id?: number | null;
}): string {
  const t = Math.max(0, Math.floor(ref.start_sec));
  if (ref.library_video_id != null) {
    return `/watch/${ref.library_video_id}?t=${t}`;
  }
  const url = `https://www.youtube.com/watch?v=${ref.yt_id}`;
  return `/watch?url=${encodeURIComponent(url)}&t=${t}`;
}

const MARK_START = String.fromCharCode(2);
const MARK_END = String.fromCharCode(3);

/** Text split into plain and highlighted parts (search marks matches with \u0002…\u0003). */
export function snippetParts(
  snippet: string
): { text: string; mark: boolean }[] {
  const parts: { text: string; mark: boolean }[] = [];
  let rest = snippet;
  while (rest) {
    const start = rest.indexOf(MARK_START);
    const end = start < 0 ? -1 : rest.indexOf(MARK_END, start + 1);
    if (start < 0 || end < 0) {
      parts.push({ text: rest.split(MARK_START).join(""), mark: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), mark: false });
    parts.push({ text: rest.slice(start + 1, end), mark: true });
    rest = rest.slice(end + 1);
  }
  return parts;
}

/** "312 of 412 videos indexed · 20 without captions". */
export function askProgressText(c: AskChannel): string {
  if (c.videos === 0) return c.status === "error" ? "" : "No videos listed yet";
  const parts = [
    `${c.fetched.toLocaleString()} of ${c.videos.toLocaleString()} videos indexed`,
  ];
  if (c.no_captions)
    parts.push(`${c.no_captions.toLocaleString()} without captions`);
  if (c.unavailable)
    parts.push(`${c.unavailable.toLocaleString()} unavailable`);
  return parts.join(" · ");
}

/** The Ask channel for a library channel, by URL or, failing that, by name. */
export function findAskChannel(
  channels: AskChannel[],
  channelUrl: string | null | undefined,
  channelName: string | null | undefined
): AskChannel | null {
  const url = normalizeChannelUrl(channelUrl ?? "");
  const name = (channelName ?? "").trim().toLowerCase();
  return (
    channels.find((c) => url && normalizeChannelUrl(c.channel_url) === url) ??
    channels.find(
      (c) => name && (c.channel_name ?? "").trim().toLowerCase() === name
    ) ??
    null
  );
}
