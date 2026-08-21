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
} from "./api";
import type { Video } from "./types";

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
  });
});
