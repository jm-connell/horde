/**
 * Pick which stored file this device should play: the original (often AV1 /
 * VP9 at high resolution) or the ≤1080p H.264 sidecar.
 *
 * Uses MediaCapabilities with the file's real codec string from ffprobe, so an
 * M1 iPad (no AV1 decoder) gets the H.264 copy while a modern desktop keeps
 * the original 4K AV1.
 */
import type { Rendition } from "../api";
import type { Video } from "../types";

export type OriginalSupport =
  /** Decodes and MediaCapabilities says playback will be smooth. */
  | "smooth"
  /** Decodes, but may drop frames (e.g. 4K software AV1 on a weak CPU). */
  | "rough"
  | "unsupported"
  /** Not probed yet, or the browser cannot tell. */
  | "unknown";

export type RenditionChoice =
  | { rendition: Rendition }
  /** Nothing playable is stored for this device yet. */
  | { rendition: null };

function containerMime(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  // Chrome/Firefox treat Matroska like WebM for capability purposes.
  if (ext === "webm" || ext === "mkv") return "video/webm";
  return "video/mp4";
}

function codecLabel(
  video: Pick<Video, "vcodec" | "bit_depth" | "width_px" | "height_px">
): string {
  switch (video.vcodec) {
    case "av1":
      return "AV1";
    case "vp9":
      return "VP9";
    case "hevc":
      return "HEVC (H.265)";
    case "h264": {
      if ((video.bit_depth ?? 8) > 8) return "10-bit H.264";
      const short = Math.min(video.width_px ?? 0, video.height_px ?? 0);
      return short > 1080 ? "4K H.264" : "H.264";
    }
    default:
      return video.vcodec ? video.vcodec.toUpperCase() : "this";
  }
}

export { codecLabel };

const cache = new Map<string, OriginalSupport>();

function cacheKey(v: Video): string {
  return [
    v.codec_string,
    v.width_px,
    v.height_px,
    Math.round(v.frame_rate ?? 30),
    v.file_path.split(".").pop(),
  ].join("|");
}

/** Estimated bitrate from size/duration (MediaCapabilities wants a number). */
function bitrate(v: Video): number {
  if (v.file_size && v.duration_sec && v.duration_sec > 0) {
    return Math.round((v.file_size * 8) / v.duration_sec);
  }
  const short = Math.min(v.width_px ?? 1080, v.height_px ?? 1080);
  return short >= 2160 ? 20_000_000 : short >= 1440 ? 12_000_000 : 6_000_000;
}

export async function checkOriginalSupport(
  video: Video
): Promise<OriginalSupport> {
  if (!video.codec_string) return "unknown";
  const key = cacheKey(video);
  const hit = cache.get(key);
  if (hit) return hit;

  const contentType = `${containerMime(video.file_path)}; codecs="${video.codec_string}"`;
  let result: OriginalSupport = "unknown";
  const mc =
    typeof navigator !== "undefined" ? navigator.mediaCapabilities : undefined;
  if (mc?.decodingInfo) {
    try {
      const info = await mc.decodingInfo({
        type: "file",
        video: {
          contentType,
          width: video.width_px ?? 1920,
          height: video.height_px ?? 1080,
          bitrate: bitrate(video),
          framerate: video.frame_rate ?? 30,
        },
      });
      result = !info.supported
        ? "unsupported"
        : info.smooth
          ? "smooth"
          : "rough";
    } catch {
      result = "unknown";
    }
  }
  if (result === "unknown" && typeof document !== "undefined") {
    const answer = document.createElement("video").canPlayType(contentType);
    result =
      answer === ""
        ? "unsupported"
        : answer === "probably"
          ? "smooth"
          : "unknown";
  }
  cache.set(key, result);
  return result;
}

/** Decide original vs sidecar. ``forceOriginal`` = user chose "try anyway". */
export function chooseRendition(
  support: OriginalSupport,
  video: Pick<Video, "has_compat">,
  { forceOriginal = false }: { forceOriginal?: boolean } = {}
): RenditionChoice {
  if (forceOriginal) return { rendition: "original" };
  const hasCompat = Boolean(video.has_compat);
  if (support === "unsupported") {
    return hasCompat ? { rendition: "compat" } : { rendition: null };
  }
  // Prefer smooth 1080p over a stuttering 4K software decode.
  if (support === "rough" && hasCompat) return { rendition: "compat" };
  return { rendition: "original" };
}

/** Same ~1080p H.264 bitrate model as the server (for "adds ~X MB" copy). */
export function estimateCompatBytes(
  video: Pick<Video, "duration_sec" | "width_px" | "height_px">,
  cap = 1080
): number {
  const short = Math.min(
    Math.min(video.width_px ?? 1080, video.height_px ?? 1080),
    cap
  );
  const bps =
    short >= 2160
      ? 18_000_000
      : short >= 1440
        ? 9_000_000
        : short >= 1080
          ? 5_000_000
          : short >= 720
            ? 2_500_000
            : short >= 480
              ? 1_200_000
              : 700_000;
  return Math.round(((video.duration_sec ?? 0) * (bps + 160_000)) / 8);
}

/** Test hook. */
export function _resetSupportCache(): void {
  cache.clear();
}

/**
 * True on WebKit that cannot play Opus-in-MP4 or a late-`moov` file (Safari and
 * every iOS browser). Mirrors `apple_webkit_playback` in the backend.
 */
export function isAppleWebkit(
  userAgent: string = typeof navigator === "undefined"
    ? ""
    : navigator.userAgent
): boolean {
  const ua = userAgent.toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) {
    return true;
  }
  if (
    ua.includes("chrome") ||
    ua.includes("chromium") ||
    ua.includes("edg/") ||
    ua.includes("firefox")
  ) {
    return false;
  }
  return ua.includes("safari");
}
