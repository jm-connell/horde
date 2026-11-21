import { useEffect, type MutableRefObject, type RefObject } from "react";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";

/** Standing still this long with media buffered ahead: the decoder is stuck. */
export const STALL_BUFFERED_MS = 5000;
/**
 * Standing still this long while buffering, with no new media arriving: the
 * stream stopped loading. Longer than a slow segment takes to download.
 */
export const STALL_STARVED_MS = 20_000;
/** Reloads tried in a row before falling back to the progressive stream. */
export const STALL_MAX_RELOADS = 2;
/**
 * Standing still this long right after playback was resumed from a pause: the
 * stream did not come back. Short, because the viewer just pressed Play and is
 * watching nothing happen.
 */
export const STALL_RESUME_MS = 6000;
/** How long after a resume the short limit applies. */
const RESUME_WINDOW_MS = 30_000;
const CHECK_MS = 1000;
/** Checks further apart than this were suspended (page hidden, device asleep). */
const CHECK_GAP_MS = 3 * CHECK_MS;
/** Playing this far past a reload means it worked. */
const RECOVERED_AFTER_SEC = 10;

/**
 * How many times in a row a stream may be reloaded before giving up. Shared
 * by everything that reloads it (a stall, a network error), so the two cannot
 * loop between them. Playing well past the last reload starts a new count.
 */
export class ReloadBudget {
  private count = 0;
  private at = 0;

  /** The playhead of the last reload: where a reload that never played resumes. */
  get position(): number {
    return this.at;
  }

  /**
   * Take one reload at playhead `time`; false when they are used up. A
   * playhead at the start is a reload that never got going: it counts as
   * the same spot.
   */
  take(time: number): boolean {
    if (time <= 1) time = this.at;
    if (Math.abs(time - this.at) > RECOVERED_AFTER_SEC) this.count = 0;
    if (this.count >= STALL_MAX_RELOADS) {
      this.count = 0;
      return false;
    }
    this.count += 1;
    this.at = time;
    return true;
  }
}

export interface StallSample {
  now: number;
  /** The playhead (`currentTime`). */
  time: number;
  /** Not expected to move: paused, ended, hidden or offline. */
  idle: boolean;
  /** Seconds of media buffered past the playhead. */
  bufferedAheadSec: number;
  /** The player is waiting for media: rebuffering, or a seek under way. */
  buffering: boolean;
  /** Playback was resumed from a pause a moment ago. */
  resuming?: boolean;
}

/**
 * Tells when playback that should be moving has stood still too long. Fed a
 * sample every second; `check` answers true once per stall.
 */
export class StallWatch {
  private time = NaN;
  private loadedTo = NaN;
  private since = 0;
  private last = -Infinity;

  check(s: StallSample): boolean {
    const suspended = s.now - this.last > CHECK_GAP_MS;
    this.last = s.now;
    // Media still arriving (a slow connection filling the buffer) is progress.
    const loadedTo = s.time + s.bufferedAheadSec;
    const moved = s.time !== this.time || loadedTo > this.loadedTo;
    this.time = s.time;
    this.loadedTo = loadedTo;
    if (s.idle || suspended || moved) {
      this.since = s.now;
      return false;
    }
    const starved = s.buffering || s.bufferedAheadSec < 1;
    const limit = !starved
      ? STALL_BUFFERED_MS
      : s.resuming
        ? STALL_RESUME_MS
        : STALL_STARVED_MS;
    if (s.now - this.since < limit) return false;
    this.since = s.now;
    return true;
  }
}

function bufferedAheadSec(el: HTMLVideoElement): number {
  const t = el.currentTime;
  for (let i = 0; i < el.buffered.length; i++) {
    if (el.buffered.start(i) <= t && t <= el.buffered.end(i)) {
      return el.buffered.end(i) - t;
    }
  }
  return 0;
}

function isBuffering(player: ShakaPlayer | null): boolean {
  try {
    return player?.isBuffering() ?? false;
  } catch {
    return false; // The player may be mid-destroy.
  }
}

/**
 * Restarts an adaptive stream that froze. Safari can leave a MediaSource
 * stream stuck after the audio route changes (AirPods moving to another
 * device and back): the element says it is playing, the clock stands still,
 * no more media arrives, and Play does nothing. Reloading the stream at the
 * same position is what closing and reopening the video did by hand. The
 * same route change can also pause the video and leave it unable to resume:
 * Play then shows it buffering for good, so a resume that brings no media is
 * given up on sooner (`STALL_RESUME_MS`). After
 * `STALL_MAX_RELOADS` reloads that did not get it moving, `fallback` (the
 * progressive stream) takes over.
 */
export function useStallRecovery({
  enabled,
  videoRef,
  shakaPlayerRef,
  reload,
  fallback,
  setMediaError,
}: {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  shakaPlayerRef: MutableRefObject<ShakaPlayer | null>;
  /** Load the same stream again where it is; false when reloads are used up. */
  reload: () => boolean;
  /** Switch to the progressive stream; false when there is none. */
  fallback: () => boolean;
  setMediaError: (message: string | null) => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const watch = new StallWatch();
    // When playback last resumed from a pause (not the first play of a load).
    let pausedOnce = false;
    let resumedAt = -Infinity;
    const onPause = () => {
      pausedOnce = true;
    };
    const onPlay = () => {
      if (pausedOnce) resumedAt = Date.now();
    };
    const media = videoRef.current;
    media?.addEventListener("pause", onPause);
    media?.addEventListener("play", onPlay);
    const id = window.setInterval(() => {
      const el = videoRef.current;
      if (!el) return;
      const time = el.currentTime;
      const stalled = watch.check({
        now: Date.now(),
        time,
        idle:
          el.paused ||
          el.ended ||
          document.visibilityState === "hidden" ||
          !navigator.onLine,
        bufferedAheadSec: bufferedAheadSec(el),
        // A seek that never lands is a stall too, on the longer limit.
        buffering: el.seeking || isBuffering(shakaPlayerRef.current),
        resuming: Date.now() - resumedAt < RESUME_WINDOW_MS,
      });
      if (!stalled) return;
      console.warn("[player] playback stalled", {
        time,
        readyState: el.readyState,
      });
      if (!reload() && !fallback()) {
        setMediaError("Playback stalled. Try again or reload the page.");
      }
    }, CHECK_MS);
    return () => {
      window.clearInterval(id);
      media?.removeEventListener("pause", onPause);
      media?.removeEventListener("play", onPlay);
    };
  }, [enabled, videoRef, shakaPlayerRef, reload, fallback, setMediaError]);
}
