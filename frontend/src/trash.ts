/** Wording for deleting videos and for the trash, shared by every delete action. */

import { parseApiDate } from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function videoCount(n: number): string {
  return plural(n, "video");
}

/**
 * How long the trash keeps a video, as a sentence. `undefined` (summary not
 * loaded yet) still says the trash is on, without a number.
 */
export function retentionSentence(retentionDays: number | undefined): string {
  if (retentionDays === undefined)
    return "Deleted videos are kept in the trash for a while.";
  return `Deleted videos are kept for ${plural(retentionDays, "day")}.`;
}

/** Trash off (`HORDE_TRASH_DAYS=0`): a delete erases the file at once. */
export function trashEnabled(retentionDays: number | undefined): boolean {
  return retentionDays !== 0;
}

export interface DeleteConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel: string;
}

/**
 * The confirm dialog for deleting videos: "Move to trash?" while the trash is
 * on, the permanent-delete wording when it is off.
 */
export function deleteConfirmCopy(
  retentionDays: number | undefined,
  subject: { count: number; title?: string }
): DeleteConfirmCopy {
  const one = subject.count === 1;
  const what = subject.title
    ? `“${subject.title}”`
    : one
      ? "This video"
      : "These videos";
  if (trashEnabled(retentionDays)) {
    return {
      title: one
        ? "Move to trash?"
        : `Move ${videoCount(subject.count)} to trash?`,
      body: `${what} will be removed from your library. ${retentionSentence(retentionDays)}`,
      confirmLabel: "Move to trash",
      busyLabel: "Moving…",
    };
  }
  return {
    title: one ? "Delete this video?" : `Delete ${videoCount(subject.count)}?`,
    body: `${what} will be removed from your library and ${
      one ? "the file" : "the files"
    } permanently deleted. This can't be undone.`,
    confirmLabel: "Delete",
    busyLabel: "Deleting…",
  };
}

/** Whole days until `expiresAt` is erased, rounded up; 0 once it is due. */
export function daysLeft(expiresAt: string, now = Date.now()): number {
  const ms = parseApiDate(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

export function daysLeftLabel(expiresAt: string, now = Date.now()): string {
  const days = daysLeft(expiresAt, now);
  if (days === 0) return "Erased soon";
  return `${plural(days, "day")} left`;
}

/** "deleted 2 days ago by jon" (or "deleted today"). */
export function deletedLabel(
  trashedAt: string,
  by: string | null | undefined,
  now = Date.now()
): string {
  const ms = now - parseApiDate(trashedAt).getTime();
  const days = Number.isFinite(ms) ? Math.floor(Math.max(0, ms) / DAY_MS) : 0;
  const when =
    days === 0
      ? "today"
      : days === 1
        ? "yesterday"
        : `${plural(days, "day")} ago`;
  return `Deleted ${when}${by ? ` by ${by}` : ""}`;
}

/** "12 videos · 8.4 GB · deleted videos are kept for 7 days". */
export function trashSummaryLine(
  summary: { count: number; total_bytes: number; retention_days: number },
  formatBytes: (bytes: number) => string
): string {
  const parts = [videoCount(summary.count)];
  if (summary.count) parts.push(formatBytes(summary.total_bytes) || "0 B");
  parts.push(
    trashEnabled(summary.retention_days)
      ? `deleted videos are kept for ${plural(summary.retention_days, "day")}`
      : "the trash is off, so deletes are permanent"
  );
  return parts.join(" · ");
}
