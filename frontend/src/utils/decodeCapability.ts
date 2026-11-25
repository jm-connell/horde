/** Probe decode capability for preview DASH gating. */
import { getItem, getJson, setItem, setJson } from "../storage";

export type DecodeSupport = {
  /** True when any AV1 ladder step reports MediaCapabilities.supported. */
  av1Supported: boolean;
  /** True when AV1 at some step also reports powerEfficient. */
  av1Efficient: boolean;
  /**
   * Highest height this device can decode (supported). Auto never goes above
   * it; playback health still steps down if frames drop.
   */
  maxSupportedHeight: number;
  /** Highest AV1 height decoded in hardware (powerEfficient); 0 for none. */
  maxAv1Efficient: number;
  /** Highest VP9 height above 1080p decoded in hardware; 0 for none. */
  maxVp9Efficient: number;
};

const HEIGHTS = [2160, 1440, 1080, 720] as const;
const BW_ESTIMATE: Record<number, number> = {
  2160: 20_000_000,
  1440: 12_000_000,
  1080: 6_000_000,
  720: 3_000_000,
};
const WIDTH_FOR: Record<number, number> = {
  2160: 3840,
  1440: 2560,
  1080: 1920,
  720: 1280,
};

/** YouTube-typical AV1 codec strings by ladder step (Main profile tiers). */
const AV1_CODEC_FOR: Record<number, string> = {
  2160: "av01.0.12M.08",
  1440: "av01.0.12M.08",
  1080: "av01.0.08M.08",
  720: "av01.0.05M.08",
};

/** VP9 as YouTube serves live streams above 1080p (WebM, profile 0). */
const VP9_CODEC_FOR: Record<number, string> = {
  2160: "vp09.00.51.08",
  1440: "vp09.00.50.08",
};

/**
 * YouTube quality ladder: nominal "Xp" is keyed off the 16:9 long side, even
 * for 2:1 / ultrawide (e.g. 1920×960 → 1080p, not 960p) and portrait
 * (1080×1920 → 1080p).
 */
const QUALITY_BY_LONG_SIDE: { quality: number; longSide: number }[] = [
  { quality: 2160, longSide: 3840 },
  { quality: 1440, longSide: 2560 },
  { quality: 1080, longSide: 1920 },
  { quality: 720, longSide: 1280 },
  { quality: 480, longSide: 854 },
  { quality: 360, longSide: 640 },
  { quality: 240, longSide: 426 },
  { quality: 144, longSide: 256 },
];

/** Map a variant's pixel size to YouTube's format_note quality (1080, 720, …). */
export function trackQuality(t: {
  width?: number | null;
  height?: number | null;
}): number {
  const w = t.width ?? 0;
  const h = t.height ?? 0;
  if (w <= 0 && h <= 0) return 0;
  const longSide = Math.max(w, h);
  let bestQ = 0;
  let bestDist = Infinity;
  for (const { quality, longSide: ref } of QUALITY_BY_LONG_SIDE) {
    const dist = Math.abs(longSide - ref);
    if (dist < bestDist) {
      bestDist = dist;
      bestQ = quality;
    }
  }
  return bestQ;
}

// v3: AV1 and VP9 hardware decode heights (Auto's ceilings above 1080p).
const CACHE_KEY = "horde.decode-capability.v3";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Cached = DecodeSupport & { at: number };

function readCache(): DecodeSupport | null {
  const parsed = getJson<Cached | null>(
    CACHE_KEY,
    (v): v is Cached =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as Cached).at === "number",
    null
  );
  if (!parsed || Date.now() - parsed.at > CACHE_TTL_MS) return null;
  return {
    av1Supported: Boolean(parsed.av1Supported),
    av1Efficient: Boolean(parsed.av1Efficient),
    maxSupportedHeight: Number(parsed.maxSupportedHeight) || 1080,
    maxAv1Efficient: Number(parsed.maxAv1Efficient) || 0,
    maxVp9Efficient: Number(parsed.maxVp9Efficient) || 0,
  };
}

function writeCache(support: DecodeSupport): void {
  const payload: Cached = { ...support, at: Date.now() };
  setJson(CACHE_KEY, payload);
}

async function canDecode(
  codec: string,
  height: number,
  container = "video/mp4"
): Promise<{ supported: boolean; powerEfficient: boolean }> {
  const mc = navigator.mediaCapabilities;
  if (!mc?.decodingInfo) {
    return { supported: false, powerEfficient: false };
  }
  const width = WIDTH_FOR[height] ?? 1920;
  const bitrate = BW_ESTIMATE[height] ?? 5_000_000;
  try {
    const result = await mc.decodingInfo({
      type: "media-source",
      video: {
        contentType: `${container}; codecs="${codec}"`,
        width,
        height,
        bitrate,
        framerate: 30,
      },
    });
    return {
      supported: Boolean(result.supported),
      powerEfficient: Boolean(result.powerEfficient),
    };
  } catch {
    return { supported: false, powerEfficient: false };
  }
}

/** Default when Media Capabilities API is unavailable: H.264 only, up to 1080p. */
export const DEFAULT_DECODE_SUPPORT: DecodeSupport = {
  av1Supported: false,
  av1Efficient: false,
  maxSupportedHeight: 1080,
  maxAv1Efficient: 0,
  maxVp9Efficient: 0,
};

/**
 * Probe decode support for the AV1 and H.264 ladders, and VP9 above 1080p.
 * Results are cached in localStorage for a week.
 */
export async function probeDecodeSupport(): Promise<DecodeSupport> {
  const cached = readCache();
  if (cached) return cached;

  if (
    typeof navigator === "undefined" ||
    !navigator.mediaCapabilities?.decodingInfo
  ) {
    return DEFAULT_DECODE_SUPPORT;
  }

  const avcCodec = "avc1.640028";

  let av1Supported = false;
  let av1Efficient = false;
  let maxAv1Supported = 0;
  let maxAv1Efficient = 0;
  let maxAvcSupported = 0;
  let maxVp9Supported = 0;
  let maxVp9Efficient = 0;

  for (const h of HEIGHTS) {
    const av1 = await canDecode(AV1_CODEC_FOR[h] ?? "av01.0.08M.08", h);
    if (av1.supported) {
      av1Supported = true;
      maxAv1Supported = Math.max(maxAv1Supported, h);
      if (av1.powerEfficient) {
        av1Efficient = true;
        maxAv1Efficient = Math.max(maxAv1Efficient, h);
      }
    }
    const avc = await canDecode(avcCodec, h);
    if (avc.supported) {
      maxAvcSupported = Math.max(maxAvcSupported, h);
    }
    const vp9Codec = VP9_CODEC_FOR[h];
    if (vp9Codec) {
      const vp9 = await canDecode(vp9Codec, h, "video/webm");
      if (vp9.supported) {
        maxVp9Supported = Math.max(maxVp9Supported, h);
        if (vp9.powerEfficient) {
          maxVp9Efficient = Math.max(maxVp9Efficient, h);
        }
      }
    }
  }

  // Floor: always allow at least 720p when MSE exists.
  const maxSupportedHeight = Math.max(
    maxAv1Supported,
    maxAvcSupported,
    maxVp9Supported,
    720
  );
  const support: DecodeSupport = {
    av1Supported,
    av1Efficient,
    maxSupportedHeight,
    maxAv1Efficient,
    maxVp9Efficient,
  };
  writeCache(support);
  return support;
}

const BW_KEY = "horde.abr-bandwidth.v1";

export function readBandwidthEstimate(): number | null {
  const raw = getItem(BW_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 100_000 ? n : null;
}

export function writeBandwidthEstimate(bps: number): void {
  if (!Number.isFinite(bps) || bps < 100_000) return;
  setItem(BW_KEY, String(Math.round(bps)));
}
