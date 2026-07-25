/** Probe hardware-efficient decode capability for preview DASH gating. */

export type DecodeSupport = {
  /** True when AV1 at 1080p+ reports supported && powerEfficient. */
  av1Efficient: boolean;
  /** Highest height this device can decode efficiently (AV1 or H.264). */
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

const CACHE_KEY = "horde.decode-capability.v1";
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
      av1Efficient: Boolean(parsed.av1Efficient),
      maxEfficientHeight: Number(parsed.maxEfficientHeight) || 1080,
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
  av1Efficient: false,
  maxEfficientHeight: 1080,
};

/**
 * Probe efficient decode support for AV1 and H.264 ladders.
 * Results are cached in localStorage for a week.
 */
export async function probeDecodeSupport(): Promise<DecodeSupport> {
  const cached = readCache();
  if (cached) return cached;

  if (typeof navigator === "undefined" || !navigator.mediaCapabilities?.decodingInfo) {
    return DEFAULT_DECODE_SUPPORT;
  }

  // Representative codec strings YouTube commonly serves.
  const av1Codec = "av01.0.08M.08";
  const avcCodec = "avc1.640028";

  let av1Efficient = false;
  let maxAv1 = 0;
  let maxAvc = 0;

  for (const h of HEIGHTS) {
    const av1 = await canDecode(av1Codec, h);
    if (av1.supported && av1.powerEfficient) {
      av1Efficient = true;
      maxAv1 = Math.max(maxAv1, h);
    }
    const avc = await canDecode(avcCodec, h);
    if (avc.supported && avc.powerEfficient) {
      maxAvc = Math.max(maxAvc, h);
    } else if (avc.supported && maxAvc === 0) {
      // Software H.264 is usually fine at 720p; allow at least that.
      maxAvc = Math.max(maxAvc, Math.min(h, 720));
    }
  }

  // If nothing reported efficient, still allow 720p H.264 (MSE isTypeSupported path).
  const maxEfficientHeight = Math.max(maxAv1, maxAvc, 720);
  const support: DecodeSupport = { av1Efficient, maxEfficientHeight };
  writeCache(support);
  return support;
}

const DOWNGRADE_KEY = "horde.decode-downgrade.v1";

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
