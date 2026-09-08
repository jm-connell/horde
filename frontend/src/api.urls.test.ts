import { describe, expect, it } from "vitest";
import {
  deviceDownloadFileUrl,
  downloadFileUrl,
  previewManifestUrl,
  previewStreamUrl,
  previewSubtitleUrl,
  streamUrl,
  subtitleUrl,
  thumbnailUrl,
  listThumbnailUrl,
  playlistCoverUrl,
} from "./api";
import type { Playlist, Video } from "./types";

describe("media URL helpers", () => {
  it("builds library and preview paths", () => {
    expect(streamUrl(7)).toBe("/api/videos/7/stream");
    expect(downloadFileUrl(7)).toBe("/api/videos/7/file");
    expect(subtitleUrl(7, "en")).toBe("/api/videos/7/subtitles/en");
    expect(deviceDownloadFileUrl(3)).toBe("/api/downloads/3/file");
  });

  it("encodes preview URLs", () => {
    const src = "https://youtu.be/dQw4w9WgXcQ?t=12";
    expect(previewStreamUrl(src)).toBe(
      `/api/preview/stream?url=${encodeURIComponent(src)}`
    );
    expect(previewManifestUrl(src)).toContain("preview/manifest");
    expect(previewSubtitleUrl(src, "en-US")).toContain("lang=en-US");
  });

  it("thumbnailUrl is null without a cached thumb", () => {
    expect(
      thumbnailUrl({ id: 1, has_thumbnail: false } as Video)
    ).toBeNull();
    expect(
      thumbnailUrl({ id: 1, has_thumbnail: true } as Video)
    ).toBe("/api/thumbnails/1");
    expect(listThumbnailUrl(1)).toBe("/api/thumbnails/1?size=sm");
    expect(
      playlistCoverUrl({
        id: 4,
        has_thumbnail: false,
        has_custom_cover: false,
        thumbnail_video_id: null,
      } as Playlist)
    ).toBeNull();
    expect(
      playlistCoverUrl({
        id: 4,
        has_thumbnail: true,
        has_custom_cover: true,
        thumbnail_video_id: 9,
      } as Playlist)
    ).toBe("/api/playlists/4/thumbnail?v=c");
    expect(
      playlistCoverUrl({
        id: 4,
        has_thumbnail: true,
        has_custom_cover: false,
        thumbnail_video_id: 9,
      } as Playlist)
    ).toBe("/api/thumbnails/9?size=sm");
  });
});
