import { useEffect, useState, type MutableRefObject } from "react";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";

/** The seekable window of a live stream, in media time. */
export interface LiveWindow {
  start: number;
  end: number;
  /** False once the broadcast ended (the playlist closed). */
  isLive: boolean;
}

/** Within this many seconds of the edge counts as watching live. */
export const LIVE_EDGE_TOLERANCE_SEC = 12;

/**
 * Polls the Shaka seek range of a live stream once a second. The scrub bar maps
 * its 0..duration onto this window, which grows as the broadcast goes on (up
 * to the server's DVR window) so you can scrub back like on YouTube.
 */
export function useLiveWindow(
  shakaPlayerRef: MutableRefObject<ShakaPlayer | null>,
  enabled: boolean,
  shakaReady: boolean
): LiveWindow | null {
  const [win, setWin] = useState<LiveWindow | null>(null);

  useEffect(() => {
    if (!enabled || !shakaReady) {
      setWin(null);
      return;
    }
    const read = () => {
      const p = shakaPlayerRef.current;
      if (!p) return;
      try {
        const { start, end } = p.seekRange();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
          return;
        }
        const isLive = p.isLive();
        setWin((prev) =>
          prev &&
          Math.abs(prev.start - start) < 0.25 &&
          Math.abs(prev.end - end) < 0.25 &&
          prev.isLive === isLive
            ? prev
            : { start, end, isLive }
        );
      } catch (err) {
        console.warn("[live] could not read the seek range", err);
      }
    };
    read();
    const id = window.setInterval(read, 1000);
    return () => window.clearInterval(id);
  }, [enabled, shakaReady, shakaPlayerRef]);

  return win;
}

/** Seconds behind the live edge for a playhead at `currentTime`. */
export function behindLive(win: LiveWindow, currentTime: number): number {
  return Math.max(0, win.end - currentTime);
}
