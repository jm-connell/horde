import { describe, expect, it } from "vitest";
import { streamPlaybackTarget } from "./streamPlayback";

const url = "https://www.youtube.com/watch?v=e2elive0001";

describe("streamPlaybackTarget", () => {
  it("plays a livestream with no manifest as a seekable file", () => {
    const target = streamPlaybackTarget({
      url,
      live: true,
      liveManifest: null,
    });
    expect(target.streamType).toBe("file");
    expect(target.mimeType).toBe("video/mp4");
    expect(target.src).toContain("/api/preview/stream?");
    expect(target.src).toContain(encodeURIComponent(url));
  });

  it("keeps DASH for a livestream that has a manifest", () => {
    const target = streamPlaybackTarget({
      url,
      live: true,
      liveManifest: "dash",
    });
    expect(target.streamType).toBe("dash");
    expect(target.mimeType).toBe("application/dash+xml");
    expect(target.src).toContain("/api/preview/manifest?");
  });

  it("uses the HLS build only when the live manifest is HLS", () => {
    const target = streamPlaybackTarget({
      url,
      live: true,
      liveManifest: "hls",
    });
    expect(target.streamType).toBe("dash");
    expect(target.mimeType).toBe("application/vnd.apple.mpegurl");
  });

  it("leaves finished previews on DASH", () => {
    const target = streamPlaybackTarget({ url, live: false });
    expect(target.streamType).toBe("dash");
    expect(target.src).toContain("/api/preview/manifest?");
  });
});
