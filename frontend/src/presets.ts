import { formatSize } from "./utils";

export const PRESET_ORDER = [
  "best",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "audio",
] as const;

export const PRESET_LABELS: Record<string, string> = {
  best: "Best available",
  "2160p": "4K (2160p)",
  "1440p": "1440p (2K)",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
  audio: "Audio only",
};

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

export function mergePinnedPreset(available: string[], pinned: string): string[] {
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
  if (presets.includes("audio") && !presets.some((p) => order.includes(p as typeof order[number]))) {
    return "Audio";
  }
  if (presets.includes("best")) return "Best";
  return "";
}
