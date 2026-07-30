import type { StreamQuality } from "../hooks/useSettings";
import { trackQuality } from "../utils/decodeCapability";

export type QualityChoice = "auto" | number;

export function streamQualityToChoice(q: StreamQuality): QualityChoice {
  if (q === "auto") return "auto";
  const n = Number(q);
  return Number.isFinite(n) && n > 0 ? n : "auto";
}

export function qualityMenuLabel(choice: QualityChoice): string {
  if (choice === "auto") return "Auto";
  if (choice >= 2160) return "4K";
  return `${choice}p`;
}

export function distinctQualities(
  tracks: { width?: number | null; height?: number | null }[]
): number[] {
  const set = new Set<number>();
  for (const t of tracks) {
    const q = trackQuality(t);
    if (q > 0) set.add(q);
  }
  return [...set].sort((a, b) => b - a);
}

export function isPortraitLadder(
  tracks: { width?: number | null; height?: number | null }[]
): boolean {
  let best: { width: number; height: number } | null = null;
  let bestQ = 0;
  for (const t of tracks) {
    const w = t.width ?? 0;
    const h = t.height ?? 0;
    const q = trackQuality(t);
    if (q > bestQ && w > 0 && h > 0) {
      bestQ = q;
      best = { width: w, height: h };
    }
  }
  return best != null && best.height > best.width;
}

/** Cap ABR by the short side so portrait 1080×1920 is not blocked as "1920p". */
export function abrRestrictions(
  qualityCap: number,
  tracks: { width?: number | null; height?: number | null }[]
): { maxWidth: number; maxHeight: number } {
  if (isPortraitLadder(tracks)) {
    return { maxWidth: qualityCap, maxHeight: 8192 };
  }
  return { maxHeight: qualityCap, maxWidth: 8192 };
}
