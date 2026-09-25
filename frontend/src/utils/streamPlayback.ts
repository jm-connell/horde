import { previewManifestUrl, previewStreamUrl } from "../api";

export interface StreamPlaybackInput {
  url: string;
  live?: boolean;
  liveManifest?: "dash" | "hls" | null;
}

export interface StreamPlaybackTarget {
  src: string;
  streamType: "dash" | "file";
  mimeType: string;
}

/**
 * A livestream with a manifest plays through Shaka. With no manifest, the
 * progressive file still uses the live timeline (arrow keys, drag, LIVE).
 * Finished videos keep the DASH preview and its progressive fallback.
 */
export function streamPlaybackTarget(
  stream: StreamPlaybackInput
): StreamPlaybackTarget {
  if (stream.live && !stream.liveManifest) {
    return {
      src: previewStreamUrl(stream.url),
      streamType: "file",
      mimeType: "video/mp4",
    };
  }
  return {
    src: previewManifestUrl(stream.url),
    streamType: "dash",
    mimeType:
      stream.liveManifest === "hls"
        ? "application/vnd.apple.mpegurl"
        : "application/dash+xml",
  };
}
