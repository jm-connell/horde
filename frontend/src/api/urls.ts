import type { Playlist, Video } from "../types";

/** HLS master playlist of a followed channel's live stream (by YouTube video id). */
export function liveMasterUrl(videoId: string): string {
  return `/api/live/${videoId}/master.m3u8`;
}

export function thumbnailUrl(video: Video): string | null {
  return video.has_thumbnail ? `/api/thumbnails/${video.id}` : null;
}

/** ~320px JPEG for download-list tiles; falls back to full size if missing. */
export function listThumbnailUrl(videoId: number): string {
  return `/api/thumbnails/${videoId}?size=sm`;
}

export function playlistCoverUrl(playlist: Playlist): string | null {
  if (!playlist.has_thumbnail) return null;
  if (playlist.has_custom_cover) {
    return `/api/playlists/${playlist.id}/thumbnail?v=c`;
  }
  if (playlist.thumbnail_video_id) {
    return listThumbnailUrl(playlist.thumbnail_video_id);
  }
  return null;
}

/** A profile picture; the version in the URL changes on every upload. */
export function avatarUrl(userId: number, version: number): string {
  return `/api/auth/avatar/${userId}?v=${version}`;
}

export function spritesMetaUrl(id: number): string {
  return `/api/videos/${id}/sprites/meta`;
}

export function spritesImageUrl(id: number): string {
  return `/api/videos/${id}/sprites`;
}

/**
 * Add a signed media token (`GET /api/videos/{id}/media-token`) to a media URL.
 * Only for URLs handed to a Cast or AirPlay receiver, which send no cookies; the
 * page's own `<video>` keeps using the cookie so offline cache keys do not change.
 */
export function withMediaToken(url: string, token: string): string {
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set("mt", token);
  return /^[a-z][a-z0-9+.-]*:/i.test(url)
    ? parsed.href
    : `${parsed.pathname}${parsed.search}`;
}

export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

export type Rendition = "original" | "compat";

export function streamUrl(
  id: number,
  rendition: Rendition = "original"
): string {
  return rendition === "compat"
    ? `/api/videos/${id}/stream?rendition=compat`
    : `/api/videos/${id}/stream`;
}

export function previewStreamUrl(url: string): string {
  return `/api/preview/stream?url=${encodeURIComponent(url)}`;
}

export function previewManifestUrl(url: string): string {
  return `/api/preview/manifest?url=${encodeURIComponent(url)}`;
}

export function previewSubtitleUrl(url: string, lang: string): string {
  return `/api/preview/subtitles?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}`;
}

export function downloadFileUrl(id: number): string {
  return `/api/videos/${id}/file`;
}

export function deviceDownloadFileUrl(jobId: number): string {
  return `/api/downloads/${jobId}/file`;
}

export function triggerBrowserDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function subtitleUrl(id: number, lang: string): string {
  return `/api/videos/${id}/subtitles/${encodeURIComponent(lang)}`;
}
