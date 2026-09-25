/** Seek window for a livestream DVR buffer. Times are media-timeline seconds. */

export interface SeekWindow {
  start: number;
  end: number;
}

export interface SeekableRanges {
  length: number;
  start(index: number): number;
  end(index: number): number;
}

/** Treat the playhead as "at live" when it is within this many seconds of the edge. */
export const LIVE_EDGE_SLACK_SEC = 8;

/** Stay slightly behind the manifest edge so the next segment can buffer. */
const LIVE_EDGE_HOLD_SEC = 0.75;

export function readSeekWindow(
  seekable: SeekableRanges | null | undefined
): SeekWindow | null {
  if (!seekable || seekable.length <= 0) return null;
  const start = seekable.start(0);
  const end = seekable.end(seekable.length - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end - start < 0.5) return null;
  return { start, end };
}

export function clampSeek(sec: number, window: SeekWindow | null): number {
  if (!window) return Math.max(0, sec);
  const max = Math.max(window.start, window.end - LIVE_EDGE_HOLD_SEC);
  return Math.min(max, Math.max(window.start, sec));
}

export function liveEdgeTarget(window: SeekWindow): number {
  return Math.max(window.start, window.end - LIVE_EDGE_HOLD_SEC);
}

export function timelineProgress(current: number, window: SeekWindow): number {
  const span = window.end - window.start;
  if (!(span > 0)) return 0;
  return Math.min(100, Math.max(0, ((current - window.start) / span) * 100));
}

export function atLiveEdge(
  current: number,
  window: SeekWindow,
  slack = LIVE_EDGE_SLACK_SEC
): boolean {
  return window.end - current <= slack;
}
