/** Recent-download card: the library video was deleted or replaced. */
export function isLibraryVideoGone(
  isDeviceJob: boolean,
  videoMissing?: boolean,
  superseded?: boolean
): boolean {
  return !isDeviceJob && Boolean(videoMissing || superseded);
}

export function canEditDownloadJobNotes(
  isDeviceJob: boolean,
  failed: boolean,
  cancelled: boolean,
  videoGone: boolean,
  completed = false
): boolean {
  return !completed && !isDeviceJob && !failed && !cancelled && !videoGone;
}

/** Watch, delete from library, or add to a playlist on a finished library card. */
export function canManageCompletedLibraryVideo(
  completed: boolean,
  isDeviceJob: boolean,
  videoGone: boolean,
  videoId: number | null | undefined
): boolean {
  return Boolean(completed && !isDeviceJob && !videoGone && videoId);
}

/** Queue a new library copy from a history card whose video was deleted. */
export function canRedownloadRemovedJob(
  completed: boolean,
  isDeviceJob: boolean,
  failed: boolean,
  videoMissing?: boolean,
  superseded?: boolean
): boolean {
  return (
    completed &&
    !isDeviceJob &&
    !failed &&
    Boolean(videoMissing) &&
    !superseded
  );
}

/** Active queue cards can switch resolution (queued / downloading / processing). */
export function canChangeJobQuality(
  status: string,
  failed: boolean,
  cancelled: boolean,
  completed: boolean
): boolean {
  if (completed || failed || cancelled) return false;
  return (
    status === "queued" || status === "downloading" || status === "processing"
  );
}

/** Drop optional action-row chips until the row fits, in this order. */
export const ACTION_COLLAPSE_ORDER = [
  "done",
  "res",
  "size",
  "playlist",
] as const;

export type ActionCollapseKey = (typeof ACTION_COLLAPSE_ORDER)[number];

export function collapseOverflowKeys(
  available: number,
  gap: number,
  fixedWidths: number[],
  optionalWidths: Partial<Record<ActionCollapseKey, number>>
): Set<ActionCollapseKey> {
  const hidden = new Set<ActionCollapseKey>();
  const total = () => {
    const parts = [
      ...fixedWidths,
      ...ACTION_COLLAPSE_ORDER.filter(
        (key) => optionalWidths[key] != null && !hidden.has(key)
      ).map((key) => optionalWidths[key] as number),
    ];
    if (parts.length === 0) return 0;
    return parts.reduce((sum, w) => sum + w, 0) + gap * (parts.length - 1);
  };
  for (const key of ACTION_COLLAPSE_ORDER) {
    if (optionalWidths[key] == null) continue;
    if (total() <= available) break;
    hidden.add(key);
  }
  return hidden;
}

export function applyActionRowCollapse(row: HTMLElement): void {
  for (const key of ACTION_COLLAPSE_ORDER) {
    const el = row.querySelector<HTMLElement>(`[data-collapse="${key}"]`);
    if (el) el.hidden = false;
  }
  for (const key of ACTION_COLLAPSE_ORDER) {
    if (row.scrollWidth <= row.clientWidth + 1) break;
    const el = row.querySelector<HTMLElement>(`[data-collapse="${key}"]`);
    if (el) el.hidden = true;
  }
}
