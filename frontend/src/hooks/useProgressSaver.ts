import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { undismissContinueWatching } from "./useContinueWatchingDismiss";

/** At most one save per this interval while playing. */
export const PROGRESS_SAVE_INTERVAL_MS = 5000;

interface Report {
  videoId: number;
  sec: number;
  durationSec: number | null | undefined;
}

/** What is stored for a position: from 90% on, the video counts as finished. */
export function positionToSave(
  sec: number,
  durationSec: number | null | undefined
): number {
  if (durationSec && durationSec > 0 && sec > 0 && sec >= durationSec * 0.9) {
    return 0;
  }
  return sec;
}

export interface SaverTimers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

const windowTimers: SaverTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

/**
 * Throttles position saves: the first report of an interval is saved at once,
 * the last one when the interval ends, so a pause or seek right after a save
 * is not lost. `flush` saves the position not saved yet now (page hidden or
 * closing); a report for another video flushes the previous video first.
 */
export class ProgressSaver {
  private pending: Report | null = null;
  private timer: number | null = null;

  constructor(
    private save: (
      videoId: number,
      positionSec: number,
      finished?: boolean
    ) => void,
    private timers: SaverTimers = windowTimers,
    private intervalMs = PROGRESS_SAVE_INTERVAL_MS
  ) {}

  /** The player reached `sec` in `videoId`. */
  report(videoId: number, sec: number, durationSec?: number | null): void {
    if (this.pending && this.pending.videoId !== videoId) this.flush();
    this.pending = { videoId, sec, durationSec };
    if (this.timer !== null) return;
    this.flush();
    this.startInterval();
  }

  /** Save the position not saved yet, if any, now. */
  flush = (): void => {
    const r = this.pending;
    this.pending = null;
    if (r) this.save(r.videoId, positionToSave(r.sec, r.durationSec));
  };

  /** The video ended: drop its unsaved position and record it as finished. */
  finish(videoId: number): void {
    if (this.pending?.videoId === videoId) this.pending = null;
    this.save(videoId, 0, true);
  }

  /** Stop the interval timer, saving what is left. */
  dispose(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.flush();
  }

  private startInterval(): void {
    this.timer = this.timers.set(() => {
      this.timer = null;
      // The interval's last position opens the next interval when saved.
      if (this.pending) {
        this.flush();
        this.startInterval();
      }
    }, this.intervalMs);
  }
}

/**
 * Saves the playing library video's position for the signed-in account, so
 * the account's other devices resume from it (see ProgressSaver). A position
 * not saved yet is sent when the page is hidden or unloaded; the request is
 * `keepalive`, so it outlives the page. `onSaved` hears of each save that
 * went through (or was queued to be sent later).
 */
export function useProgressSaver(
  onSaved?: (videoId: number, positionSec: number) => void
): ProgressSaver {
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const [saver] = useState(
    () =>
      new ProgressSaver((videoId, positionSec, finished) => {
        // Resuming watch (≥30s) brings the video back to Continue watching.
        if (positionSec >= 30) undismissContinueWatching(videoId);
        api
          .saveProgress(videoId, positionSec, finished)
          .then(() => onSavedRef.current?.(videoId, positionSec))
          .catch(() => undefined);
      })
  );
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") saver.flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", saver.flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", saver.flush);
      saver.dispose();
    };
  }, [saver]);
  return saver;
}
