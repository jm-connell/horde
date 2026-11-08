import { formatResolution, formatSize } from "./utils";

export const PRESET_ORDER = [
  "best",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "audio",
  "audio-160",
  "audio-128",
  "audio-64",
] as const;

export const PRESET_LABELS: Record<string, string> = {
  best: "Best available",
  "2160p": "4K",
  "1440p": "1440p",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
  audio: "Audio (best)",
  "audio-160": "Audio · 160 kbps",
  "audio-128": "Audio · 128 kbps",
  "audio-64": "Audio · 64 kbps",
};

/** Choices for the default download quality (Settings → Library, setup). */
export const DEFAULT_PRESET_OPTIONS = PRESET_ORDER.map((value) => ({
  value,
  label: PRESET_LABELS[value] ?? value,
}));

/**
 * The preset to preselect for a link, given the user's default and the presets
 * the link offers (best first). A video cap becomes the best tier at or under
 * it (else the lowest tier offered); an audio-only link always gets audio,
 * since a height cap matches none of its formats.
 */
export function defaultPresetFor(base: string, available: string[]): string {
  if (available.length === 0 || available.includes(base)) return base;
  const videoTiers = available.filter((p) => p !== "best" && !isAudioPreset(p));
  if (!isAudioPreset(base) && videoTiers.length > 0) {
    if (base === "best") return videoTiers[0]!;
    const cap = PRESET_ORDER.indexOf(base as (typeof PRESET_ORDER)[number]);
    const under = videoTiers.find(
      (p) => PRESET_ORDER.indexOf(p as (typeof PRESET_ORDER)[number]) >= cap
    );
    return under ?? videoTiers[videoTiers.length - 1]!;
  }
  if (available.includes("audio")) return "audio";
  return available.find(isAudioPreset) ?? available[0]!;
}

export function isAudioPreset(preset: string): boolean {
  return preset === "audio" || preset.startsWith("audio-");
}

export function formatApproxSize(bytes: number | undefined): string {
  const label = formatSize(bytes ?? null);
  return label ? `~${label}` : "";
}

export function presetOptionLabel(
  preset: string,
  sizes: Record<string, number> | undefined
): string {
  const base = PRESET_LABELS[preset] ?? preset;
  const approx = formatApproxSize(sizes?.[preset]);
  return approx ? `${base} (${approx})` : base;
}

export function mergePinnedPreset(
  available: string[],
  pinned: string
): string[] {
  if (pinned === "best" || available.includes(pinned)) return available;
  const merged = new Set([...available, pinned]);
  return PRESET_ORDER.filter((p) => merged.has(p));
}

export function maxPresetLabel(presets: string[]): string {
  const order = ["2160p", "1440p", "1080p", "720p", "480p"] as const;
  for (const p of order) {
    if (presets.includes(p)) {
      if (p === "2160p") return "4K";
      return p;
    }
  }
  if (presets.some((p) => isAudioPreset(p))) {
    return "Audio";
  }
  if (presets.includes("best")) return "Best";
  return "";
}

/** Map a requested "best" preset to the highest concrete tier in `available`. */
export function resolveQualityPreset(
  preset: string,
  available: string[]
): string {
  if (preset !== "best") return preset;
  for (const p of PRESET_ORDER) {
    if (p === "best" || isAudioPreset(p)) continue;
    if (available.includes(p)) return p;
  }
  if (available.includes("audio")) return "audio";
  for (const p of PRESET_ORDER) {
    if (isAudioPreset(p) && available.includes(p)) return p;
  }
  return "best";
}

/** Finished file label: probed height, never "Best available". */
export function finishedQualityLabel(
  preset: string | null | undefined,
  heightPx?: number | null,
  available: string[] = []
): string {
  const p = preset || "best";
  if (isAudioPreset(p)) return PRESET_LABELS[p] ?? "Audio";
  const fromFile = formatResolution(heightPx ?? null);
  if (fromFile) return fromFile;
  const resolved = resolveQualityPreset(p, available);
  if (resolved === "best") return "";
  return PRESET_LABELS[resolved] ?? resolved;
}

export function jobQualityOptions(
  available: string[] | undefined,
  current: string,
  fallback: string[]
): string[] {
  const list = available && available.length > 0 ? available : fallback;
  return mergePinnedPreset(list, current);
}
