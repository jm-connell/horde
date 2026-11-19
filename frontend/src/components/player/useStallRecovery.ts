import {
  useEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";
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
const CHECK_MS = 1000;
/** Checks further apart than this were suspended (page hidden, device asleep). */
const CHECK_GAP_MS = 3 * CHECK_MS;
/** Playing this far past a reload means it worked. */
const RECOVERED_AFTER_SEC = 10;

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
    const limit =
      s.buffering || s.bufferedAheadSec < 1
        ? STALL_STARVED_MS
        : STALL_BUFFERED_MS;
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
 * same position is what closing and reopening the video did by hand. After
 * `STALL_MAX_RELOADS` reloads that did not get it moving, `fallback` (the
 * progressive stream) takes over.
 */
export function useStallRecovery({
  enabled,
  videoRef,
  shakaPlayerRef,
  pendingSeekRef,
  reload,
  fallback,
  setMediaError,
}: {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  shakaPlayerRef: MutableRefObject<ShakaPlayer | null>;
  /** Where the reloaded stream starts. */
  pendingSeekRef: MutableRefObject<number>;
  /** Load the same stream again. */
  reload: () => void;
  /** Switch to the progressive stream; false when there is none. */
  fallback: () => boolean;
  setMediaError: (message: string | null) => void;
}): void {
  const reloadsRef = useRef({ count: 0, at: 0 });

  useEffect(() => {
    if (!enabled) return;
    const watch = new StallWatch();
    const id = window.setInterval(() => {
      const el = videoRef.current;
      if (!el) return;
      const time = el.currentTime;
      const reloads = reloadsRef.current;
      if (Math.abs(time - reloads.at) > RECOVERED_AFTER_SEC) reloads.count = 0;
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
      });
      if (!stalled) return;
      console.warn("[player] playback stalled", {
        time,
        readyState: el.readyState,
        reloads: reloads.count,
      });
      if (time > 1) pendingSeekRef.current = time;
      if (reloads.count >= STALL_MAX_RELOADS) {
        reloads.count = 0;
        if (!fallback()) {
          setMediaError("Playback stalled. Try again or reload the page.");
        }
        return;
      }
      reloads.count += 1;
      reloads.at = time;
      reload();
    }, CHECK_MS);
    return () => window.clearInterval(id);
  }, [
    enabled,
    videoRef,
    shakaPlayerRef,
    pendingSeekRef,
    reload,
    fallback,
    setMediaError,
  ]);
}
