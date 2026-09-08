import { clipboardTextToUrl } from "../clipboard";
import { effectiveSourceUrl, youtubeVideoIdFromUrl } from "../utils";

export const PLAYLIST_ADD_RESULT_LIMIT = 8;

export type PlaylistAddLibraryHit = {
  id: number;
  title: string;
  channel: string | null;
  published_at: string | null;
  source_url: string | null;
  file_path: string;
  status?: string;
};

export type PlaylistAddSuggestion =
  | { kind: "video"; video: PlaylistAddLibraryHit }
  | { kind: "download"; url: string };

/** True when the field looks like a video URL rather than a title search. */
export function looksLikeDownloadUrl(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  const candidate = clipboardTextToUrl(text) || text;
  if (/^https?:\/\//i.test(candidate)) return true;
  try {
    const href = candidate.includes("://") ? candidate : `https://${candidate}`;
    const parsed = new URL(href);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (
      host !== "youtu.be" &&
      host !== "youtube.com" &&
      !host.endsWith(".youtube.com")
    ) {
      return false;
    }
    return parsed.pathname.length > 1 || parsed.searchParams.has("v");
  } catch {
    return false;
  }
}

export function findLibraryVideoForUrl<T extends PlaylistAddLibraryHit>(
  videos: T[],
  raw: string
): T | null {
  const url = (clipboardTextToUrl(raw) || raw).trim();
  if (!url) return null;
  const yt = youtubeVideoIdFromUrl(url);
  const normalized = url.replace(/\/+$/, "");
  for (const video of videos) {
    if (yt) {
      const id = youtubeVideoIdFromUrl(effectiveSourceUrl(video));
      if (id === yt) return video;
    }
    const source = video.source_url?.trim();
    if (source && (source === url || source.replace(/\/+$/, "") === normalized)) {
      return video;
    }
  }
  return null;
}

export function filterLibraryVideos<T extends PlaylistAddLibraryHit>(
  videos: T[],
  query: string,
  memberIds: Set<number>,
  limit = PLAYLIST_ADD_RESULT_LIMIT
): T[] {
  const raw = query.trim().toLowerCase();
  const compact = raw.replace(/\s+/g, "");
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: { video: T; score: number }[] = [];
  for (const video of videos) {
    if (memberIds.has(video.id)) continue;
    if (video.status && video.status !== "ready") continue;
    const title = video.title.toLowerCase();
    const channel = (video.channel ?? "").toLowerCase();
    const compactTitle = title.replace(/\s+/g, "");
    const compactChannel = channel.replace(/\s+/g, "");
    const channelPhrase =
      Boolean(channel) &&
      (channel.includes(raw) ||
        (compact.length >= 2 && compactChannel.includes(compact)));
    const titlePhrase =
      title.includes(raw) ||
      (compact.length >= 2 && compactTitle.includes(compact));
    const tokensOk = tokens.every(
      (token) =>
        title.includes(token) ||
        channel.includes(token) ||
        compactTitle.includes(token) ||
        compactChannel.includes(token)
    );
    if (!channelPhrase && !titlePhrase && !tokensOk) continue;

    let score = 0;
    if (channel === raw || (compact.length >= 2 && compactChannel === compact)) {
      score += 40;
    } else if (
      channel.startsWith(raw) ||
      (compact.length >= 2 && compactChannel.startsWith(compact))
    ) {
      score += 30;
    } else if (channelPhrase) {
      score += 20;
    }
    if (title.startsWith(raw)) score += 15;
    else if (titlePhrase) score += 8;
    scored.push({ video, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((row) => row.video);
}

export function playlistAddAlreadyInPlaylist(
  query: string,
  videos: PlaylistAddLibraryHit[],
  memberIds: Set<number>
): boolean {
  if (!looksLikeDownloadUrl(query)) return false;
  const match = findLibraryVideoForUrl(videos, query);
  return Boolean(match && memberIds.has(match.id));
}

export function playlistAddSuggestions(
  query: string,
  videos: PlaylistAddLibraryHit[],
  memberIds: Set<number>,
  limit = PLAYLIST_ADD_RESULT_LIMIT
): PlaylistAddSuggestion[] {
  const raw = query.trim();
  if (!raw) return [];
  if (looksLikeDownloadUrl(raw)) {
    const url = clipboardTextToUrl(raw) || raw;
    const match = findLibraryVideoForUrl(videos, url);
    if (match) {
      if (memberIds.has(match.id)) return [];
      return [{ kind: "video", video: match }];
    }
    return [{ kind: "download", url }];
  }
  return filterLibraryVideos(videos, raw, memberIds, limit).map((video) => ({
    kind: "video" as const,
    video,
  }));
}
