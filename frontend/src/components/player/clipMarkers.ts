import type { ClipMark, ClipMarkers } from "../videoPlayerTypes";
import type { LiveWindow } from "./useLiveWindow";

/** Seek-bar positions (seconds along the bar) of the clip's ends, if on it. */
export interface ClipBarRange {
  start: number | null;
  end: number | null;
}

/**
 * Where each mark sits on the seek bar. A file or past stream's bar is its own
 * timeline. A live bar spans the DVR window (0 = its oldest segment), and the
 * live edge moves on one second per second, so a mark made `n` seconds ago
 * sits `n` seconds further back from the edge than it did then.
 */
export function clipBarRange(
  markers: ClipMarkers,
  liveWindow: LiveWindow | null,
  nowMs: number
): ClipBarRange {
  const at = (mark: ClipMark | null): number | null => {
    if (!mark) return null;
    if (mark.kind === "time") return mark.sec;
    if (!liveWindow) return null;
    const media = liveWindow.end - (nowMs - mark.atMs) / 1000;
    return media - liveWindow.start;
  };
  return { start: at(markers.start), end: at(markers.end) };
}
