import { PRESET_LABELS } from "../../../presets";
import type { ChannelAutodownload, RetentionLimits } from "../../../types";
import { formatSize } from "../../../utils";

/** The sections of the channel settings sheet, in order. */
export type ChannelSettingsSection =
  "autodownload" | "retention" | "following" | "search" | "manage";

/** The DOM id of a section, for scrolling a chip's section into view. */
export const sectionId = (id: ChannelSettingsSection) =>
  `channel-settings-${id}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Auto-download on · 1080p", or null while it is off. */
export function autodownloadChipLabel(
  policy: Pick<ChannelAutodownload, "enabled" | "quality_preset"> | null
): string | null {
  if (!policy?.enabled) return null;
  const quality =
    PRESET_LABELS[policy.quality_preset] ?? policy.quality_preset ?? "";
  return quality ? `Auto-download on · ${quality}` : "Auto-download on";
}

/** "Keeps latest 20 · Removes after 30 days", or null without a limit. */
export function retentionChipLabel(
  rule: Partial<RetentionLimits> | null | undefined
): string | null {
  if (!rule) return null;
  const parts: string[] = [];
  if (rule.keep_latest != null) parts.push(`Keeps latest ${rule.keep_latest}`);
  if (rule.max_age_days != null)
    parts.push(`Removes after ${plural(rule.max_age_days, "day")}`);
  if (rule.remove_watched_after_days != null)
    parts.push(
      `Removes watched after ${plural(rule.remove_watched_after_days, "day")}`
    );
  return parts.length ? parts.join(" · ") : null;
}

/** The live preview line under the retention limits. */
export function retentionPreviewLine(preview: {
  count: number;
  total_bytes: number;
}): string {
  if (preview.count === 0)
    return "Right now this would move nothing to the trash.";
  const size = formatSize(preview.total_bytes);
  return `Right now this would move ${plural(preview.count, "video")}${
    size ? ` (${size})` : ""
  } to the trash.`;
}

/** A limit field's text as a whole number in [1, max], or null when blank or invalid. */
export function parseLimit(text: string, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= max ? n : null;
}

/** "@handle" from a YouTube channel URL, or null. */
export function channelHandle(url: string | null | undefined): string | null {
  const match = url?.match(/\/(@[\w.-]+)/);
  return match ? match[1] : null;
}
