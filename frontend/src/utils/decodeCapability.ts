/** Probe decode capability for preview DASH gating. */

export type DecodeSupport = {
  /** True when any AV1 ladder step reports MediaCapabilities.supported. */
  av1Supported: boolean;
  /** True when AV1 at some step also reports powerEfficient. */
  av1Efficient: boolean;
  /**
   * Highest height this device can decode (supported). Used as the Auto ABR
   * ceiling — playback health still downgrades if frames drop.
   */
  maxSupportedHeight: number;
  /** Highest height reported powerEfficient (informational / soft preference). */
  maxEfficientHeight: number;
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

// v2: supported≠powerEfficient split + height-appropriate AV1 codec strings.
const CACHE_KEY = "horde.decode-capability.v2";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Cached = DecodeSupport & { at: number };

function readCache(): DecodeSupport | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    if (!parsed || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return {
      av1Supported: Boolean(parsed.av1Supported),
      av1Efficient: Boolean(parsed.av1Efficient),
      maxSupportedHeight: Number(parsed.maxSupportedHeight) || 1080,
      maxEfficientHeight: Number(parsed.maxEfficientHeight) || 720,
    };
  } catch {
    return null;
  }
}

function writeCache(support: DecodeSupport): void {
  try {
    const payload: Cached = { ...support, at: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota / private mode
  }
}

async function canDecode(
  codec: string,
  height: number
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
        contentType: `video/mp4; codecs="${codec}"`,
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
  maxEfficientHeight: 1080,
};

/**
 * Probe decode support for AV1 and H.264 ladders.
 * Results are cached in localStorage for a week (v2 key).
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
  let maxAvcEfficient = 0;

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
      if (avc.powerEfficient) {
        maxAvcEfficient = Math.max(maxAvcEfficient, h);
      }
    }
  }

  // Floor: always allow at least 720p when MSE exists.
  const maxSupportedHeight = Math.max(maxAv1Supported, maxAvcSupported, 720);
  const maxEfficientHeight = Math.max(maxAv1Efficient, maxAvcEfficient, 720);
  const support: DecodeSupport = {
    av1Supported,
    av1Efficient,
    maxSupportedHeight,
    maxEfficientHeight,
  };
  writeCache(support);
  return support;
}

const DOWNGRADE_KEY = "horde.decode-downgrade.v1";
const DOWNGRADE_TTL_MS = 24 * 60 * 60 * 1000;

export type DowngradeRecord = {
  maxHeight: number;
  blacklistAv1: boolean;
  at: number;
};

export function readDowngrade(): DowngradeRecord | null {
  try {
    const raw = localStorage.getItem(DOWNGRADE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DowngradeRecord;
    if (!parsed || typeof parsed.maxHeight !== "number") return null;
    if (
      typeof parsed.at === "number" &&
      Date.now() - parsed.at > DOWNGRADE_TTL_MS
    ) {
      localStorage.removeItem(DOWNGRADE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeDowngrade(record: Omit<DowngradeRecord, "at">): void {
  try {
    localStorage.setItem(
      DOWNGRADE_KEY,
      JSON.stringify({ ...record, at: Date.now() })
    );
  } catch {
    // ignore
  }
}

/** Clear a persisted auto-downgrade (e.g. user explicitly picks 4K / AV1). */
export function clearDowngrade(): void {
  try {
    localStorage.removeItem(DOWNGRADE_KEY);
  } catch {
    // ignore
  }
}

const BW_KEY = "horde.abr-bandwidth.v1";

export function readBandwidthEstimate(): number | null {
  try {
    const raw = localStorage.getItem(BW_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 100_000 ? n : null;
  } catch {
    return null;
  }
}

export function writeBandwidthEstimate(bps: number): void {
  if (!Number.isFinite(bps) || bps < 100_000) return;
  try {
    localStorage.setItem(BW_KEY, String(Math.round(bps)));
  } catch {
    // ignore
  }
}
